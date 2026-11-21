import { describe, expect, it } from "vitest";
import type { PersonActor, PolicyResource } from "../../shared/src/m1";
import { decide, type PolicyContext } from "../src/policy";
import { managedAuthorityFixture } from "./managed-helpers";

const organizationId = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const workspaceId = `${organizationId}:33333333-3333-4333-8333-333333333333`;
const actor: PersonActor = { kind: "person", personId: owner, githubId: "123" };
const resource: PolicyResource = {
  kind: "workspace",
  id: workspaceId,
  organizationId,
  targetId: "target",
  ownerPersonId: owner,
  hostId: "host",
  operation: "consent.issue",
};
function facts(): PolicyContext {
  return {
    available: true,
    managedPolicy: true,
    organizationId,
    policyRevision: 1,
    workspaceActive: true,
    organizationMembership: { personId: owner, role: "member", status: "active", grantedBy: owner, grantedAt: 0 },
    workspaceMembership: {
      personId: owner,
      workspaceId,
      role: "contributor",
      status: "active",
      grantedBy: owner,
      grantedAt: 0,
      reason: "fixture",
    },
    consentIssuance: {
      kind: "terminal_control",
      hostId: "host",
      hostOwnerPersonId: owner,
      targetId: "target",
      targetOwnerPersonId: owner,
    },
  };
}

describe("Host-owner consent issuance policy", () => {
  it("admits only the exact authority-resolved Host owner and target", () => {
    expect(decide(actor, "workspace.read", resource, facts()).decision).toBe("allow");
    expect(decide(actor, "workspace.read", { ...resource, hostId: "other" }, facts()).decision).toBe("deny");
    expect(decide(actor, "workspace.read", { ...resource, targetId: "other" }, facts()).decision).toBe("deny");
    expect(decide(actor, "workspace.read", { ...resource, ownerPersonId: "other" }, facts()).decision).toBe("deny");
  });
  it("does not let viewer ownership authorize approval control", () => {
    const context = facts();
    const control = { ...resource, operation: "agent.approval.deny" };
    expect(decide(actor, "channel.update.write", control, context).decision).toBe("allow");
    if (context.workspaceMembership) context.workspaceMembership.role = "viewer";
    expect(decide(actor, "channel.update.write", control, context).decision).toBe("deny");
  });
  it("does not turn ordinary read authority into consent issuance authority", () => {
    const context = facts();
    delete context.consentIssuance;
    expect(decide(actor, "workspace.read", resource, context).decision).toBe("deny");
    expect(decide(actor, "channel.update.write", resource, facts()).decision).toBe("deny");
    const other = facts();
    if (other.consentIssuance) other.consentIssuance.hostOwnerPersonId = "other";
    expect(decide(actor, "workspace.read", resource, other).decision).toBe("deny");
  });
  it("requires current Organization and Workspace membership even for metadata administrators", () => {
    for (const missing of ["organizationMembership", "workspaceMembership"] as const) {
      const context = facts();
      context.metadataOnly = true;
      if (context.organizationMembership) context.organizationMembership.role = "admin";
      delete context[missing];
      expect(decide(actor, "workspace.read", resource, context).decision).toBe("deny");
    }
    const context = facts();
    if (context.workspaceMembership) context.workspaceMembership.status = "revoked";
    expect(decide(actor, "workspace.read", resource, context).decision).toBe("deny");
  });
  it("denies foreign Workspaces, unavailable authority and non-Person issuers", () => {
    expect(
      decide(
        actor,
        "workspace.read",
        { ...resource, id: `${organizationId}:44444444-4444-4444-8444-444444444444` },
        facts(),
      ).decision,
    ).toBe("deny");
    expect(decide(actor, "workspace.read", resource, { ...facts(), available: false }).decision).toBe("deny");
    expect(decide({ kind: "execution", executionId: "execution" }, "workspace.read", resource, facts()).decision).toBe(
      "deny",
    );
  });
});

import { runInDurableObject } from "cloudflare:test";

describe("Host consent issuance handler without verified completion", () => {
  it("denies an execution owner's advisory Host and creates no enrollment or consent", async () => {
    const f = await managedAuthorityFixture();
    const result = await f.org.mutateConsent({
      actor: f.actor,
      workspaceId: f.workspaceId,
      key: "advisory-host",
      requestId: "advisory-host",
      remove: false,
      body: {
        targetId: f.targetId,
        action: "terminal_control",
        recipient: f.recipient.personId,
        hostId: "alice/laptop",
        expiresAt: Date.now() + 60_000,
      },
    });
    expect(result.ok).toBe(false);
    await runInDurableObject(f.org, (_object, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM owner_consents").one().n).toBe(0);
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='host_enrollments'").toArray()).toEqual(
        [],
      );
    });
  });
  it("denies a different Person and a foreign Workspace without writing a consent", async () => {
    const f = await managedAuthorityFixture();
    for (const [issuer, workspace] of [
      [f.recipient, f.workspaceId],
      [f.actor, workspaceId],
    ] as const) {
      const result = await f.org.mutateConsent({
        actor: issuer,
        workspaceId: workspace,
        key: `denied-${workspace}`,
        requestId: "denied",
        remove: false,
        body: {
          targetId: f.targetId,
          action: "terminal_control",
          recipient: f.recipient.personId,
          hostId: "alice/laptop",
          expiresAt: Date.now() + 60_000,
        },
      });
      expect(result.ok).toBe(false);
    }
    await runInDurableObject(f.org, (_object, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM owner_consents").one().n).toBe(0);
    });
  });
});
