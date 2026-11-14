import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentExecution,
  AgentGrant,
  AgentPrincipal,
  PersonActor,
  PolicyResource,
  VerifiedExecution,
} from "../../shared/src/m1";
import { safeAgent } from "../src/managed-projection";
import { decide, type PolicyContext, PRIVATE_ACTIONS } from "../src/policy";
import { authorityRequest, LocalMutationPermits, type MutationPermit } from "../src/policy-permits";
import { CONTRIBUTOR_ACTIONS, type IdentityAuthority } from "../src/principals";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("missing fixture value");
  return value;
}
const orgId = "11111111-1111-4111-8111-111111111111";
const personId = "22222222-2222-4222-8222-222222222222";
const workspaceId = `${orgId}:33333333-3333-4333-8333-333333333333`;
const person: PersonActor = { kind: "person", personId, githubId: "12" };
const resource: PolicyResource = { kind: "workspace", organizationId: orgId, id: workspaceId };
function context(): PolicyContext {
  return {
    available: true,
    managedPolicy: true,
    identityPolicy: true,
    organizationId: orgId,
    policyRevision: 2,
    workspaceActive: true,
    now: 1000,
    organizationMembership: { personId, role: "member", status: "active", grantedBy: personId, grantedAt: 0 },
    workspaceMembership: {
      personId,
      workspaceId,
      role: "contributor",
      status: "active",
      grantedBy: personId,
      grantedAt: 0,
      reason: "fixture",
    },
  };
}
function executionContext() {
  const ctx = context();
  const state: IdentityAuthority = {
    organization: { id: orgId, name: "org", status: "active", createdAt: 0, policyRevision: 2 },
    members: { [personId]: required(ctx.organizationMembership) },
    workspaces: {
      [workspaceId]: {
        id: workspaceId,
        organizationId: orgId,
        name: "ws",
        description: "",
        visibility: "private",
        status: "active",
        createdAt: 0,
      },
    },
    workspaceMembers: { [workspaceId]: { [personId]: required(ctx.workspaceMembership) } },
  };
  const principal: AgentPrincipal = {
    id: `${orgId}:44444444-4444-4444-8444-444444444444`,
    organizationId: orgId,
    sponsor: { kind: "person", id: personId },
    displayName: "agent",
    capabilities: [],
    status: "active",
    createdBy: personId,
    createdAt: 0,
  };
  const execution: AgentExecution = {
    id: `${orgId}:55555555-5555-4555-8555-555555555555`,
    principalId: principal.id,
    workspaceId,
    ownerPersonId: personId,
    cli: "codex",
    startedAt: 0,
    lastSeen: 0,
    status: "active",
    credentialGeneration: 1,
  };
  const grant: AgentGrant = {
    principalId: principal.id,
    workspaceId,
    actions: [...CONTRIBUTOR_ACTIONS],
    constraints: {},
    grantedBy: personId,
    expiresAt: 5000,
    policyRevision: 2,
  };
  const actor: VerifiedExecution = {
    kind: "execution",
    principalId: principal.id,
    executionId: execution.id,
    workspaceId,
    actions: [...CONTRIBUTOR_ACTIONS],
  };
  ctx.verifiedExecution = actor;
  ctx.executionAuthority = {
    state,
    principal,
    grant,
    execution,
    organizationCeiling: [...CONTRIBUTOR_ACTIONS],
    workspacePolicy: [...CONTRIBUTOR_ACTIONS],
    constraints: {},
    credentialExpiresAt: 4000,
  };
  return { ctx, actor, facts: ctx.executionAuthority };
}
describe("managed policy", () => {
  it("denies unknown actors actions parents inactive memberships and unavailable authority", () => {
    const ctx = context();
    expect(decide(person, "task.read", resource, ctx).decision).toBe("allow");
    for (const [actor, action, target, c] of [
      [undefined, "task.read", resource, ctx],
      [person, "unknown", resource, ctx],
      [person, "task.read", { ...resource, id: `${personId}:${personId}` }, ctx],
      [person, "task.read", resource, { ...ctx, available: false }],
      [person, "task.read", resource, { ...ctx, workspaceMembership: undefined }],
      [
        person,
        "task.read",
        resource,
        { ...ctx, organizationMembership: { ...ctx.organizationMembership, status: "revoked" } },
      ],
    ] as const)
      expect(decide(actor, action, target, c as PolicyContext).decision).toBe("deny");
  });
  it("intersects grants ceilings execution constraints and current sponsor authority", () => {
    for (const field of ["organizationCeiling", "workspacePolicy"] as const) {
      const { ctx, actor, facts } = executionContext();
      expect(decide(actor, "task.claim", resource, ctx).decision).toBe("allow");
      facts[field] = ["task.read"];
      expect(decide(actor, "task.claim", resource, ctx).decision).toBe("deny");
    }
    const { ctx, actor, facts } = executionContext();
    facts.constraints = { actions: ["task.read"] };
    expect(decide(actor, "task.claim", resource, ctx).decision).toBe("deny");
    facts.constraints = {};
    facts.grant.actions = ["task.read"];
    expect(decide(actor, "task.claim", resource, ctx).decision).toBe("deny");
    ctx.now = 5000;
    expect(decide(actor, "task.read", resource, ctx).decision).toBe("deny");
  });
  it("Bob cannot grant what Bob lacks", () => {
    const { ctx, actor, facts } = executionContext();
    required(required(facts.state.workspaceMembers[workspaceId])[personId]).role = "viewer";
    expect(decide(actor, "task.claim", resource, ctx).decision).toBe("deny");
  });
  it("sponsor demotion removes authority", () => {
    const { ctx, actor, facts } = executionContext();
    expect(decide(actor, "task.claim", resource, ctx).decision).toBe("allow");
    required(required(facts.state.workspaceMembers[workspaceId])[personId]).role = "viewer";
    expect(decide(actor, "task.claim", resource, ctx).decision).toBe("deny");
    required(facts.state.members[personId]).status = "revoked";
    expect(decide(actor, "task.claim", resource, ctx).decision).toBe("deny");
  });
  it("org admin has no private rights", () => {
    const ctx = context();
    required(ctx.organizationMembership).role = "admin";
    for (const action of PRIVATE_ACTIONS) {
      const target = { ...resource, ownerPersonId: "someone-else", targetId: "target" };
      expect(decide(person, action, target, ctx).decision).toBe("deny");
      ctx.consent = {
        ownerPersonId: "someone-else",
        personId,
        workspaceId,
        targetId: "target",
        action,
        expiresAt: 1001,
      };
      expect(decide(person, action, target, ctx).decision).toBe("allow");
      expect(decide(person, action, target, { ...ctx, now: 1001 }).decision).toBe("deny");
      expect(decide(person, action, target, { ...ctx, workspaceMembership: undefined }).decision).toBe("deny");
      if (action === "agent.directive.send" || action === "agent.handoff.cross_owner") {
        required(ctx.workspaceMembership).role = "viewer";
        expect(decide(person, action, target, ctx).decision).toBe("deny");
        required(ctx.workspaceMembership).role = "contributor";
      }
      ctx.consent = undefined;
    }
  });
  it("uses explicit role actions for all contract operations and scopes admin exceptions to metadata", () => {
    for (const role of ["viewer", "contributor", "manager"] as const) {
      const ctx = context();
      required(ctx.workspaceMembership).role = role;
      for (const action of [
        "workspace.read",
        "agent.view",
        "task.read",
        "channel.update.read",
        "channel.history.read",
        "channel.subscribe",
      ])
        expect(decide(person, action, resource, ctx).decision).toBe("allow");
      for (const action of ["task.claim", "task.update", "channel.update.write"])
        expect(decide(person, action, resource, ctx).decision).toBe(role === "viewer" ? "deny" : "allow");
      for (const action of [
        "workspace.manage",
        "workspace.member.manage",
        "agent.register",
        "agent.grant.manage",
        "agent.execution.start",
        "agent.execution.revoke",
      ])
        expect(decide(person, action, resource, ctx).decision).toBe(role === "manager" ? "allow" : "deny");
    }
    const ctx = context();
    required(ctx.organizationMembership).role = "admin";
    ctx.workspaceMembership = undefined;
    expect(decide(person, "workspace.manage", resource, ctx).decision).toBe("allow");
    expect(decide(person, "workspace.read", resource, ctx).decision).toBe("deny");
    expect(decide(person, "workspace.read", resource, { ...ctx, metadataOnly: true }).decision).toBe("allow");
    expect(decide(person, "task.read", resource, ctx).decision).toBe("deny");
    const orgResource = { kind: "organization", id: orgId, organizationId: orgId } as const;
    for (const action of ["organization.manage", "organization.member.manage", "workspace.create"])
      expect(decide(person, action, orgResource, ctx).decision).toBe("allow");
  });
  it("denies stale missing and restricted execution facts despite a previously verified action list", () => {
    const { ctx, actor, facts } = executionContext();
    expect(decide(actor, "task.read", resource, { ...ctx, executionAuthority: undefined }).decision).toBe("deny");
    expect(decide(actor, "task.read", resource, { ...ctx, policyRevision: 3 }).decision).toBe("deny");
    expect(decide(actor, "task.read", resource, { ...ctx, restrictionsSatisfied: false }).decision).toBe("deny");
    facts.execution.status = "revoked";
    expect(decide(actor, "task.read", resource, ctx).decision).toBe("deny");
  });
  it("constructs shared agents by allowlist", () => {
    const projected = safeAgent(
      {
        id: "test/codex/1234",
        cli: "codex",
        presence: "active",
        startedAt: "now",
        lastSeenAt: "now",
        context: { secret: "private" },
        account: "private",
        usage: { secret: "private" },
      } as never,
      { principalId: "p", executionId: "e", ownerPersonId: personId },
    );
    expect(Object.keys(projected).sort()).toEqual(
      ["id", "principalId", "executionId", "ownerPersonId", "cli", "presence", "startedAt", "lastSeenAt"].sort(),
    );
    expect(JSON.stringify(projected)).not.toContain("private");
  });
  it("consumes exact-resource permits once and rejects expiry generation revision and request mismatch", async () => {
    await runInDurableObject(env.CHANNEL.getByName("test/permits"), (_channel, state) => {
      const permits = new LocalMutationPermits(state.storage.sql);
      const permit: MutationPermit = {
        id: "permit",
        actor: person,
        action: "task.claim",
        resource: { ...resource, channel: "test/permits", targetId: "task:1", operation: "claim" },
        requestId: "request",
        generation: 2,
        policyRevision: 2,
        issuedAt: 1000,
        expiresAt: 3000,
      };
      permits.install(permit);
      for (const mismatch of [
        { actor: { ...person, githubId: "13" } },
        { generation: 3 },
        { policyRevision: 3 },
        { requestId: "other" },
        { resource: { ...permit.resource, targetId: "other" } },
        { action: "task.update" },
      ])
        expect(permits.consume(permit.id, { ...permit, ...mismatch }, 1001)).toBe(false);
      expect(permits.consume(permit.id, permit, 999)).toBe(false);
      expect(permits.consume(permit.id, permit, 3000)).toBe(false);
      state.storage.transactionSync(() => expect(permits.consume(permit.id, permit, 2999)).toBe(true));
      permits.install(permit);
      expect(permits.consume(permit.id, permit, 2999)).toBe(false);
      permits.install({ ...permit, id: "cancelled" });
      permits.invalidate();
      expect(permits.consume("cancelled", permit, 1001)).toBe(false);
    });
  });
  it("issues permits only for a current exact binding and cancels outstanding permits on authority change", async () => {
    const id = crypto.randomUUID();
    const authority = env.ORGANIZATION.getByName(id);
    expect((await authority.initialize(id, "Permit org", person, "init")).ok).toBe(true);
    const created = await authority.mutate({
      actor: person,
      key: "ws",
      requestId: "ws",
      command: { kind: "workspace.create", name: "Workspace", description: "", acceptManager: true },
    });
    if (!created.ok || !("id" in created.value)) throw new Error("missing workspace");
    const ws = created.value.id;
    // Seed an already-completed binding journal; workspace-binding.test.ts covers the link protocol.
    await runInDurableObject(authority, (_object, state) => {
      const aggregate = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
      );
      aggregate.workspaces[ws].channel = "test/permit";
      state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
      state.storage.sql.exec(
        "INSERT INTO binding_operations VALUES(?,?,?)",
        "binding",
        "binding",
        JSON.stringify({
          id: "binding",
          actor: person,
          workspaceId: ws,
          repo: "test/permit",
          mode: "bind",
          phase: "done",
          generation: 0,
          key: "binding",
        }),
      );
    });
    const request = {
      actor: person,
      action: "task.claim",
      resource: {
        kind: "workspace",
        organizationId: id,
        id: ws,
        channel: "test/permit",
        targetId: "task:1",
        operation: "claim",
      } as PolicyResource,
      generation: 1,
      requestId: "claim",
    };
    const permit = await authority.issueMutationPermit(request);
    expect(permit.ok).toBe(true);
    if (!permit.ok) throw new Error(permit.reason);
    expect(permit.value.expiresAt - permit.value.issuedAt).toBeLessThanOrEqual(2000);
    expect(permit.value.resource).toEqual(request.resource);
    expect(await authority.issueMutationPermit({ ...request, generation: 0 })).toMatchObject({ ok: false });
    expect(
      await authority.issueMutationPermit({ ...request, resource: { ...request.resource, targetId: undefined } }),
    ).toMatchObject({ ok: false });
    expect(await authority.issueMutationPermit({ ...request, action: "task.read" })).toMatchObject({ ok: false });
    const revoked = await authority.mutate({
      actor: person,
      key: "revoke",
      requestId: "revoke",
      expectedRevision: permit.value.policyRevision,
      command: {
        kind: "workspace.member",
        workspaceId: ws,
        personId,
        role: "viewer",
        status: "active",
        reason: "demotion",
      },
    });
    expect(revoked).toMatchObject({ ok: true, value: { role: "viewer", status: "active" } });
    expect(await authority.issueMutationPermit(request)).toMatchObject({ ok: false });
    expect(
      await runInDurableObject(authority, (_object, state) =>
        state.storage.sql.exec("SELECT id FROM mutation_permits").toArray(),
      ),
    ).toEqual([]);
  });
  it("bounds unavailable authority to 503", async () => {
    vi.useFakeTimers();
    try {
      const request = authorityRequest(() => new Promise<never>(() => {}), 9000);
      const assertion = expect(request).rejects.toMatchObject({ status: 503 });
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      await expect(
        authorityRequest(async () => {
          throw new Error("private error");
        }),
      ).rejects.toMatchObject({ status: 503, message: "authority_unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });
});
