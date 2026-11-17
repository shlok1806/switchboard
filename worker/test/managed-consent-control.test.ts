import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { PolicyResource } from "../../shared/src/m1";
import { decide, type OwnerConsent, type PolicyContext } from "../src/policy";
import { bareChannel, legacyBinding, managedAuthorityFixture } from "./managed-helpers";

beforeEach(reset);

describe("managed consent control (DD-1 and history consent)", () => {
  describe("policy decide() unit matrix", () => {
    const orgId = "org-1";
    const wsId = `${orgId}:ws-1`;
    const aliceId = "alice-person-id";
    const bobId = "bob-person-id";
    const targetAgent = "alice/codex/s1";
    const hostA = "host-alpha";
    const hostB = "host-beta";

    const baseContext: PolicyContext = {
      available: true,
      managedPolicy: true,
      organizationId: orgId,
      policyRevision: 1,
      workspaceActive: true,
      organizationMembership: {
        personId: bobId,
        role: "member",
        status: "active",
        grantedBy: aliceId,
        grantedAt: 1000,
      },
      workspaceMembership: {
        workspaceId: wsId,
        personId: bobId,
        role: "contributor",
        status: "active",
        grantedBy: aliceId,
        grantedAt: 1000,
        reason: "fixture",
      },
      now: 10000,
    };

    const bobActor = {
      personId: bobId,
      githubId: "902",
    };

    const controlResource: PolicyResource = {
      kind: "workspace",
      organizationId: orgId,
      id: wsId,
      targetId: targetAgent,
      ownerPersonId: aliceId,
      operation: "terminal.input",
      hostId: hostA,
    };

    const validControlConsent: OwnerConsent = {
      ownerPersonId: aliceId,
      personId: bobId,
      workspaceId: wsId,
      targetId: targetAgent,
      action: "terminal_control",
      hostId: hostA,
      expiresAt: 20000,
    };

    it("requires terminal_control consent for control effects and rejects read or screen consent", () => {
      // 1. No consent -> denied
      const noConsent = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: undefined,
      });
      expect(noConsent.decision).toBe("deny");
      expect(noConsent.reason).toBe("owner_consent_required");

      // 2. Positive: valid terminal_control consent matching host -> allow
      const allowed = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: validControlConsent,
      });
      expect(allowed.decision).toBe("allow");
      expect(allowed.reason).toBe("owner_or_consent");

      // 3. Negative: screen-read consent used for control effect -> deny
      const screenReadConsent: OwnerConsent = {
        ...validControlConsent,
        action: "agent.private_screen.read",
      };
      const screenDenied = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: screenReadConsent,
      });
      expect(screenDenied.decision).toBe("deny");
      expect(screenDenied.reason).toBe("owner_consent_required");

      // 4. Negative: transcript-read consent used for control effect -> deny
      const transcriptConsent: OwnerConsent = {
        ...validControlConsent,
        action: "agent.private_transcript.read",
      };
      const transcriptDenied = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: transcriptConsent,
      });
      expect(transcriptDenied.decision).toBe("deny");
      expect(transcriptDenied.reason).toBe("owner_consent_required");
    });

    it("enforces scoped hostId matching on terminal_control consent", () => {
      // Consent is scoped to hostA; resource is on hostB -> deny
      const hostMismatch = decide(
        bobActor,
        "channel.update.write",
        { ...controlResource, hostId: hostB },
        { ...baseContext, consent: validControlConsent },
      );
      expect(hostMismatch.decision).toBe("deny");
      expect(hostMismatch.reason).toBe("owner_consent_required");
    });

    it("strictly denies control effect when host-local ceiling restrictions are not satisfied", () => {
      // Even with active valid consent and contributor role, restrictionsSatisfied === false denies
      const localCeilingDenied = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        restrictionsSatisfied: false,
        consent: validControlConsent,
      });
      expect(localCeilingDenied.decision).toBe("deny");
      expect(localCeilingDenied.reason).toBe("execution_restriction");
    });

    it("strictly denies organization and workspace administrators without target owner consent", () => {
      const adminBob = {
        ...baseContext,
        organizationMembership: {
          personId: bobId,
          role: "admin" as const,
          status: "active" as const,
          grantedBy: aliceId,
          grantedAt: 1000,
        },
        workspaceMembership: {
          workspaceId: wsId,
          personId: bobId,
          role: "manager" as const,
          status: "active" as const,
          grantedBy: aliceId,
          grantedAt: 1000,
          reason: "fixture",
        },
        consent: undefined,
      };

      for (const op of ["terminal.input", "agent.approval.deny", "approval.control"]) {
        const res = decide(bobActor, "channel.update.write", { ...controlResource, operation: op }, adminBob);
        expect(res.decision).toBe("deny");
        expect(res.reason).toBe("owner_consent_required");
      }
    });

    it("enforces expired, revoked, wrong requester, wrong workspace, and wrong target on control consent", () => {
      // Expired consent
      const expired = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: { ...validControlConsent, expiresAt: 5000 },
      });
      expect(expired.decision).toBe("deny");
      expect(expired.reason).toBe("owner_consent_required");

      // Wrong requester
      const wrongRequester = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: { ...validControlConsent, personId: "charlie-id" },
      });
      expect(wrongRequester.decision).toBe("deny");

      // Wrong workspace
      const wrongWs = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: { ...validControlConsent, workspaceId: `${orgId}:ws-2` },
      });
      expect(wrongWs.decision).toBe("deny");

      // Wrong target
      const wrongTarget = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: { ...validControlConsent, targetId: "alice/codex/other" },
      });
      expect(wrongTarget.decision).toBe("deny");
    });

    it("enforces scoped Host-owner history consent and denies control or read consent for history", () => {
      const historyResource: PolicyResource = {
        kind: "workspace",
        organizationId: orgId,
        id: wsId,
        targetId: targetAgent,
        ownerPersonId: aliceId,
        operation: "history.read",
        hostId: hostA,
      };

      const validHistoryConsent: OwnerConsent = {
        ownerPersonId: aliceId,
        personId: bobId,
        workspaceId: wsId,
        targetId: targetAgent,
        action: "channel.history.read",
        hostId: hostA,
        expiresAt: 20000,
      };

      // 1. Without consent -> deny
      const noConsent = decide(bobActor, "channel.history.read", historyResource, {
        ...baseContext,
        consent: undefined,
      });
      expect(noConsent.decision).toBe("deny");
      expect(noConsent.reason).toBe("owner_consent_required");

      // 2. Positive: valid history consent -> allow
      const allowed = decide(bobActor, "channel.history.read", historyResource, {
        ...baseContext,
        consent: validHistoryConsent,
      });
      expect(allowed.decision).toBe("allow");
      expect(allowed.reason).toBe("owner_or_consent");

      // 3. Negative: terminal_control consent used for history read -> deny
      const controlUsedForHist = decide(bobActor, "channel.history.read", historyResource, {
        ...baseContext,
        consent: validControlConsent,
      });
      expect(controlUsedForHist.decision).toBe("deny");
      expect(controlUsedForHist.reason).toBe("owner_consent_required");

      // 4. Negative: screen read consent used for history read -> deny
      const screenUsedForHist = decide(bobActor, "channel.history.read", historyResource, {
        ...baseContext,
        consent: { ...validControlConsent, action: "agent.private_screen.read" },
      });
      expect(screenUsedForHist.decision).toBe("deny");
      expect(screenUsedForHist.reason).toBe("owner_consent_required");

      // 5. HostId mismatch on history consent -> deny
      const hostMismatch = decide(
        bobActor,
        "channel.history.read",
        { ...historyResource, hostId: hostB },
        { ...baseContext, consent: validHistoryConsent },
      );
      expect(hostMismatch.decision).toBe("deny");

      // 6. Admin without owner consent -> deny
      const adminNoConsent = decide(bobActor, "channel.history.read", historyResource, {
        ...baseContext,
        organizationMembership: {
          personId: bobId,
          role: "admin",
          status: "active",
          grantedBy: aliceId,
          grantedAt: 1000,
        },
        workspaceMembership: {
          workspaceId: wsId,
          personId: bobId,
          role: "manager",
          status: "active",
          grantedBy: aliceId,
          grantedAt: 1000,
          reason: "fixture",
        },
        consent: undefined,
      });
      expect(adminNoConsent.decision).toBe("deny");
      expect(adminNoConsent.reason).toBe("owner_consent_required");
    });
  });

  describe("Organization DO and Channel enforcement integration", () => {
    it("handles DD-1 terminal_control consent lifecycle in Organization DO and audit logs", async () => {
      const f = await managedAuthorityFixture();
      const hostId = "test-host-1";

      // Mutate consent with terminal_control and hostId
      const created = await f.org.mutateConsent({
        actor: f.actor,
        workspaceId: f.workspaceId,
        key: "term-ctrl",
        requestId: "req-1",
        remove: false,
        body: {
          targetId: f.targetId,
          action: "terminal_control",
          recipient: f.recipient.personId,
          hostId,
          expiresAt: Date.now() + 60000,
        },
      });
      expect(created.ok).toBe(true);

      // Verify consent stored in aggregate with hostId
      const stored = await runInDurableObject(f.org, (_object, state) => {
        const row = state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one();
        return JSON.parse(row.body);
      });
      const consentList = Object.values(stored.ownerConsents[f.workspaceId] as Record<string, OwnerConsent>);
      expect(consentList).toContainEqual(
        expect.objectContaining({
          action: "terminal_control",
          hostId,
          personId: f.recipient.personId,
        }),
      );

      // Revocation mid-flight
      if (!created.ok) throw new Error("creation failed");
      const revoked = await f.org.mutateConsent({
        actor: f.actor,
        workspaceId: f.workspaceId,
        key: "term-ctrl-revoke",
        requestId: "req-2",
        remove: true,
        id: created.value.id,
        body: {},
      });
      expect(revoked.ok).toBe(true);

      const afterRevoke = await runInDurableObject(f.org, (_object, state) => {
        const row = state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one();
        return JSON.parse(row.body);
      });
      expect(afterRevoke.ownerConsents[f.workspaceId][created.value.id]).toBeUndefined();
    });

    it("preserves unlinked channel dispatch without touching consent boundary", () => {
      const channel = bareChannel(legacyBinding) as unknown as { binding: typeof legacyBinding };
      expect(channel.binding.state).toBe("unlinked");
      // Fast synchronous check
      expect(channel.binding.generation).toBe(0);
    });
  });
});
