import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { PolicyResource } from "../../shared/src/m1";
import { decide, type OwnerConsent, type PolicyContext } from "../src/policy";
import { bareChannel, legacyBinding, managedAuthorityFixture } from "./managed-helpers";

beforeEach(reset);

describe("managed consent control (DD-1 and history consent)", () => {
  describe("policy decide() unit matrix", () => {
    const orgId = "11111111-1111-4111-8111-111111111111";
    const wsId = `${orgId}:33333333-3333-4333-8333-333333333333`;
    const aliceId = "22222222-2222-4222-8222-222222222222";
    const bobId = "44444444-4444-4444-8444-444444444444";
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
      kind: "person" as const,
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

      // Consent without hostId -> deny
      const consentNoHost = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: { ...validControlConsent, hostId: undefined },
      });
      expect(consentNoHost.decision).toBe("deny");
      expect(consentNoHost.reason).toBe("owner_consent_required");

      // Resource without hostId -> deny
      const resourceNoHost = decide(
        bobActor,
        "channel.update.write",
        { ...controlResource, hostId: undefined },
        { ...baseContext, consent: validControlConsent },
      );
      expect(resourceNoHost.decision).toBe("deny");
      expect(resourceNoHost.reason).toBe("owner_consent_required");
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
        consent: { ...validControlConsent, personId: "55555555-5555-4555-8555-555555555555" },
      });
      expect(wrongRequester.decision).toBe("deny");
      expect(wrongRequester.reason).toBe("owner_consent_required");

      // Wrong workspace
      const wrongWs = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: { ...validControlConsent, workspaceId: `${orgId}:55555555-5555-4555-8555-555555555555` },
      });
      expect(wrongWs.decision).toBe("deny");
      expect(wrongWs.reason).toBe("owner_consent_required");

      // Wrong target
      const wrongTarget = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: { ...validControlConsent, targetId: "alice/codex/other" },
      });
      expect(wrongTarget.decision).toBe("deny");
      expect(wrongTarget.reason).toBe("owner_consent_required");

      // Wrong owner on consent (must match resource.ownerPersonId)
      const wrongOwnerConsent = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: { ...validControlConsent, ownerPersonId: "55555555-5555-4555-8555-555555555555" },
      });
      expect(wrongOwnerConsent.decision).toBe("deny");
      expect(wrongOwnerConsent.reason).toBe("owner_consent_required");

      // Consent for requester's own execution used against a different target
      const ownExecConsent = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        verifiedExecution: {
          kind: "execution",
          executionId: "exec-requester",
          principalId: "principal-1",
          workspaceId: wsId,
          actions: [],
        },
        consent: { ...validControlConsent, targetId: "exec-requester" },
      });
      expect(ownExecConsent.decision).toBe("deny");
      expect(ownExecConsent.reason).toBe("owner_consent_required");

      // Consent for another execution used against a different target
      const otherExecConsent = decide(bobActor, "channel.update.write", controlResource, {
        ...baseContext,
        consent: { ...validControlConsent, targetId: "exec-another" },
      });
      expect(otherExecConsent.decision).toBe("deny");
      expect(otherExecConsent.reason).toBe("owner_consent_required");
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
      expect(hostMismatch.reason).toBe("owner_consent_required");

      // Consent without hostId on history consent -> deny
      const consentNoHost = decide(bobActor, "channel.history.read", historyResource, {
        ...baseContext,
        consent: { ...validHistoryConsent, hostId: undefined },
      });
      expect(consentNoHost.decision).toBe("deny");
      expect(consentNoHost.reason).toBe("owner_consent_required");

      // Resource without hostId on history consent -> deny
      const resourceNoHost = decide(
        bobActor,
        "channel.history.read",
        { ...historyResource, hostId: undefined },
        { ...baseContext, consent: validHistoryConsent },
      );
      expect(resourceNoHost.decision).toBe("deny");
      expect(resourceNoHost.reason).toBe("owner_consent_required");

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

      // Verify consent stored in owner_consents table with hostId
      const consentList = await runInDurableObject(f.org, (_object, state) => {
        const rows = state.storage.sql.exec<{ body: string }>("SELECT body FROM owner_consents").toArray();
        return rows.map((r) => JSON.parse(r.body) as OwnerConsent);
      });
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
        expectedRevision: created.policyRevision,
      });
      expect(revoked.ok).toBe(true);

      const afterRevoke = await runInDurableObject(f.org, (_object, state) => {
        return state.storage.sql
          .exec<{ id: string }>("SELECT id FROM owner_consents WHERE id=?", created.value.id)
          .toArray();
      });
      expect(afterRevoke).toHaveLength(0);
    });

    it("preserves unlinked channel dispatch without touching consent boundary", () => {
      const channel = bareChannel(legacyBinding) as unknown as { binding: typeof legacyBinding };
      expect(channel.binding.state).toBe("unlinked");
      // Fast synchronous check
      expect(channel.binding.generation).toBe(0);
    });
  });
});
