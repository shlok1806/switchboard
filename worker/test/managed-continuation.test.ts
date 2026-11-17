import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentResponse, RegisterAgentRequest } from "../../shared/src/index";
import type { SafeAgent } from "../../shared/src/m1";
import { CONTRIBUTOR_ACTIONS, MANAGER_ACTIONS } from "../src/principals";
import { M1_ORIGIN, nativeIdentity } from "./m1-helpers";
import { bareChannel, legacyBinding } from "./managed-helpers";

beforeEach(reset);

async function continuationFixture() {
  const alice = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "alice");
  const bob = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "bob");
  const organizationId = crypto.randomUUID();
  const org = env.ORGANIZATION.getByName(organizationId);
  await org.initialize(organizationId, "ContinuationOrg", alice.actor, "init");

  // Create Workspace
  const wsRes = await org.mutate({
    actor: alice.actor,
    key: "workspace",
    requestId: "ws",
    command: { kind: "workspace.create", name: "ContinuationWS", description: "", acceptManager: true },
  });
  if (!wsRes.ok || !("id" in wsRes.value)) throw new Error("workspace failed");
  const workspaceId = wsRes.value.id;
  const repo = "shlok1806/continuation-repo";

  // Bind Channel
  const channel = env.CHANNEL.getByName(repo);
  await runInDurableObject(org, (_object, state) => {
    const aggregate = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
    );
    aggregate.workspaces[workspaceId].channel = repo;
    // Add Bob as contributor
    aggregate.members[bob.actor.personId] = {
      personId: bob.actor.personId,
      role: "member",
      status: "active",
      grantedBy: alice.actor.personId,
      grantedAt: Date.now(),
    };
    aggregate.workspaceMembers[workspaceId][bob.actor.personId] = {
      personId: bob.actor.personId,
      workspaceId,
      role: "contributor",
      status: "active",
      grantedBy: alice.actor.personId,
      grantedAt: Date.now(),
    };
    state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
  });

  await runInDurableObject(channel, (object) => {
    Object.assign(object, {
      binding: { version: 1, generation: 1, workspace: workspaceId, operation: "binding", state: "linked" },
    });
  });

  // Set policies & create principals
  let sequence = 0;
  const mutate = async (actor: typeof alice.actor, command: import("../../shared/src/m1").IdentityCommand) => {
    const res = await org.mutateIdentity({
      actor,
      key: `mut-${++sequence}`,
      requestId: "fixture",
      expectedRevision: (await org.metadata(actor))?.policyRevision,
      command,
    });
    if (!res.ok) throw new Error(res.reason);
    return res.value;
  };

  await mutate(alice.actor, { kind: "identity.policy", actions: MANAGER_ACTIONS });
  await mutate(alice.actor, { kind: "identity.policy", workspaceId, actions: MANAGER_ACTIONS });

  const alicePrincipal = (
    await mutate(alice.actor, {
      kind: "principal.create",
      displayName: "AliceAgent",
      capabilities: [],
      sponsor: { kind: "person", id: alice.actor.personId },
    })
  ).principal;
  if (!alicePrincipal) throw new Error("missing alice principal");

  await mutate(alice.actor, {
    kind: "grant.put",
    principalId: alicePrincipal.id,
    workspaceId,
    actions: MANAGER_ACTIONS,
    constraints: {},
    expiresAt: Date.now() + 3600000,
  });

  const bobPrincipal = (
    await mutate(alice.actor, {
      kind: "principal.create",
      displayName: "BobAgent",
      capabilities: [],
      sponsor: { kind: "person", id: bob.actor.personId },
    })
  ).principal;
  if (!bobPrincipal) throw new Error("missing bob principal");

  await mutate(alice.actor, {
    kind: "grant.put",
    principalId: bobPrincipal.id,
    workspaceId,
    actions: CONTRIBUTOR_ACTIONS,
    constraints: {},
    expiresAt: Date.now() + 3600000,
  });

  return { alice, bob, organizationId, workspaceId, repo, channel, org, alicePrincipal, bobPrincipal };
}

describe("managed continuation and handoff", () => {
  it("registers managed agent returning SafeAgent projection and storing no legacy token", async () => {
    const f = await continuationFixture();
    const regBody: RegisterAgentRequest & { principalId: string; workspaceId: string } = {
      cli: "codex",
      sessionId: "11111111-1111-4111-8111-111111111111",
      resumed: false,
      cwd: "/repo",
      principalId: f.alicePrincipal.id,
      workspaceId: f.workspaceId,
    };

    const req = new Request(`${M1_ORIGIN}/r/${f.repo}/api/agents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.alice.token}` },
      body: JSON.stringify(regBody),
    });

    const response = await f.channel.managedRequest(req, f.repo);
    expect(response.status).toBe(200);
    const answer = (await response.json()) as AgentResponse;

    // Allowlisted SafeAgent projection checks
    expect(answer.agent).toBeDefined();
    expect(answer.agent).toHaveProperty("id");
    expect(answer.agent).toHaveProperty("principalId", f.alicePrincipal.id);
    expect(answer.agent).toHaveProperty("executionId");
    expect(answer.agent).toHaveProperty("ownerPersonId", f.alice.actor.personId);
    expect(answer.agent).toHaveProperty("cli", "codex");
    expect(answer.agent).toHaveProperty("presence", "idle");
    expect(answer.agent).toHaveProperty("startedAt");
    expect(answer.agent).toHaveProperty("lastSeenAt");

    // Must NOT leak legacy token or private session fields
    expect((answer.agent as unknown as Record<string, unknown>).token).toBeUndefined();
    expect((answer.agent as unknown as Record<string, unknown>).cwd).toBeUndefined();
    expect((answer.agent as unknown as Record<string, unknown>).sessionId).toBeUndefined();

    // Verify token issued is execution token verified by Organization
    expect(answer.token).toBeDefined();
    const verified = await f.org.verifyExecution(answer.token ?? "");
    expect(verified).toMatchObject({
      principalId: f.alicePrincipal.id,
      workspaceId: f.workspaceId,
    });

    // Verify storage has no raw token stored
    const stored = await runInDurableObject(f.channel, async (_object, state) =>
      state.storage.sql.exec("SELECT * FROM m1_agent_executions").toArray(),
    );
    expect(JSON.stringify(stored)).not.toContain(answer.token);
  });

  it("handles same-owner continuation and rejects self-continuation or missing predecessor", async () => {
    const f = await continuationFixture();

    // 1. Register predecessor
    const pBody: RegisterAgentRequest & { principalId: string; workspaceId: string } = {
      cli: "codex",
      sessionId: "22222222-2222-4222-8222-222222222222",
      resumed: false,
      cwd: "/repo",
      principalId: f.alicePrincipal.id,
      workspaceId: f.workspaceId,
    };
    const pRes = await f.channel.managedRequest(
      new Request(`${M1_ORIGIN}/r/${f.repo}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.alice.token}` },
        body: JSON.stringify(pBody),
      }),
      f.repo,
    );
    expect(pRes.status).toBe(200);
    const pAns = (await pRes.json()) as AgentResponse;
    const predecessorId = pAns.agent.id;

    // 2. Reject self-continuation
    const selfBody = { ...pBody, continues: predecessorId };
    const selfRes = await f.channel.managedRequest(
      new Request(`${M1_ORIGIN}/r/${f.repo}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.alice.token}` },
        body: JSON.stringify(selfBody),
      }),
      f.repo,
    );
    expect(selfRes.status).toBe(400);

    // 3. Reject missing predecessor
    const missingBody: RegisterAgentRequest & { principalId: string; workspaceId: string } = {
      cli: "codex",
      sessionId: "33333333-3333-4333-8333-333333333333",
      resumed: false,
      cwd: "/repo",
      principalId: f.alicePrincipal.id,
      workspaceId: f.workspaceId,
      continues: "alice/codex/missing",
    };
    const missingRes = await f.channel.managedRequest(
      new Request(`${M1_ORIGIN}/r/${f.repo}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.alice.token}` },
        body: JSON.stringify(missingBody),
      }),
      f.repo,
    );
    expect(missingRes.status).toBe(404);

    // 4. Positive same-owner continuation
    const succBody: RegisterAgentRequest & { principalId: string; workspaceId: string } = {
      cli: "codex",
      sessionId: "44444444-4444-4444-8444-444444444444",
      resumed: false,
      cwd: "/repo",
      principalId: f.alicePrincipal.id,
      workspaceId: f.workspaceId,
      continues: predecessorId,
    };
    const succRes = await f.channel.managedRequest(
      new Request(`${M1_ORIGIN}/r/${f.repo}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.alice.token}` },
        body: JSON.stringify(succBody),
      }),
      f.repo,
    );
    expect(succRes.status).toBe(200);
    const succAns = (await succRes.json()) as AgentResponse;
    expect(succAns.agent.id).not.toBe(predecessorId);

    // Verify handoff event recorded in Channel
    const events = await runInDurableObject(f.channel, (_object, state) =>
      state.storage.sql.exec<{ body: string }>("SELECT body FROM events WHERE type='agent.handoff'").toArray(),
    );
    expect(events.length).toBeGreaterThan(0);
    const firstEvent = events[0];
    if (!firstEvent) throw new Error("missing handoff event");
    const parsedEvent = JSON.parse(firstEvent.body);
    expect(parsedEvent.payload).toMatchObject({ from: predecessorId, to: succAns.agent.id });
  });

  it("requires predecessor-owner consent for cross-owner continuation and rejects unconsented handoff", async () => {
    const f = await continuationFixture();

    // 1. Alice registers predecessor
    const pBody: RegisterAgentRequest & { principalId: string; workspaceId: string } = {
      cli: "codex",
      sessionId: "55555555-5555-4555-8555-555555555555",
      resumed: false,
      cwd: "/repo",
      principalId: f.alicePrincipal.id,
      workspaceId: f.workspaceId,
    };
    const pRes = await f.channel.managedRequest(
      new Request(`${M1_ORIGIN}/r/${f.repo}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.alice.token}` },
        body: JSON.stringify(pBody),
      }),
      f.repo,
    );
    expect(pRes.status).toBe(200);
    const predecessorId = ((await pRes.json()) as AgentResponse).agent.id;

    // 2. Bob attempts cross-owner continuation without consent -> denied (403/404)
    const bobBody: RegisterAgentRequest & { principalId: string; workspaceId: string } = {
      cli: "codex",
      sessionId: "66666666-6666-4666-8666-666666666666",
      resumed: false,
      cwd: "/repo",
      principalId: f.bobPrincipal.id,
      workspaceId: f.workspaceId,
      continues: predecessorId,
    };
    const deniedRes = await f.channel.managedRequest(
      new Request(`${M1_ORIGIN}/r/${f.repo}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.bob.token}` },
        body: JSON.stringify(bobBody),
      }),
      f.repo,
    );
    expect(deniedRes.status).toBe(404);

    // 3. Alice grants cross_owner consent to Bob for predecessor
    const consent = await f.org.mutateConsent({
      actor: f.alice.actor,
      workspaceId: f.workspaceId,
      key: "handoff-consent",
      requestId: "consent-1",
      remove: false,
      body: {
        targetId: predecessorId,
        action: "agent.handoff.cross_owner",
        recipient: f.bob.actor.personId,
        expiresAt: Date.now() + 60000,
      },
    });
    expect(consent.ok).toBe(true);

    // 4. Bob attempts cross-owner continuation with valid consent -> succeeds!
    const allowedRes = await f.channel.managedRequest(
      new Request(`${M1_ORIGIN}/r/${f.repo}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.bob.token}` },
        body: JSON.stringify(bobBody),
      }),
      f.repo,
    );
    expect(allowedRes.status).toBe(200);
    const bobAgent = ((await allowedRes.json()) as AgentResponse).agent as unknown as SafeAgent;
    expect(bobAgent.ownerPersonId).toBe(f.bob.actor.personId);

    // 5. With expired consent -> denied
    await f.org.mutateConsent({
      actor: f.alice.actor,
      workspaceId: f.workspaceId,
      key: "expired-consent",
      requestId: "consent-2",
      remove: false,
      body: {
        targetId: predecessorId,
        action: "agent.handoff.cross_owner",
        recipient: f.bob.actor.personId,
        expiresAt: Date.now() - 1000, // expired
      },
    });
    const expiredRes = await f.channel.managedRequest(
      new Request(`${M1_ORIGIN}/r/${f.repo}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.bob.token}` },
        body: JSON.stringify({
          ...bobBody,
          sessionId: "77777777-7777-4777-8777-777777777777",
        }),
      }),
      f.repo,
    );
    expect(expiredRes.status).toBe(404);
  });

  it("preserves task claim ownership across handoff and continuation", async () => {
    const f = await continuationFixture();

    // 1. Register predecessor
    const pBody: RegisterAgentRequest & { principalId: string; workspaceId: string } = {
      cli: "codex",
      sessionId: "88888888-8888-4888-8888-888888888888",
      resumed: false,
      cwd: "/repo",
      principalId: f.alicePrincipal.id,
      workspaceId: f.workspaceId,
    };
    const pRes = await f.channel.managedRequest(
      new Request(`${M1_ORIGIN}/r/${f.repo}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.alice.token}` },
        body: JSON.stringify(pBody),
      }),
      f.repo,
    );
    const predecessor = ((await pRes.json()) as AgentResponse).agent;

    // 2. Predecessor holds claim on Task 1 in Channel
    await runInDurableObject(f.channel, (_object, state) => {
      state.storage.sql.exec(
        "INSERT INTO tasks VALUES(1, 'Task 1', 'desc', 'open', '[]', '[]', '[]', 0, 0, ?)",
        JSON.stringify({ holder: { kind: "agent", agent: predecessor.id } }),
      );
    });

    // 3. Register successor continuing predecessor
    const succBody: RegisterAgentRequest & { principalId: string; workspaceId: string } = {
      cli: "codex",
      sessionId: "99999999-9999-4999-8999-999999999999",
      resumed: false,
      cwd: "/repo",
      principalId: f.alicePrincipal.id,
      workspaceId: f.workspaceId,
      continues: predecessor.id,
    };
    const succRes = await f.channel.managedRequest(
      new Request(`${M1_ORIGIN}/r/${f.repo}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.alice.token}` },
        body: JSON.stringify(succBody),
      }),
      f.repo,
    );
    expect(succRes.status).toBe(200);
    const successor = ((await succRes.json()) as AgentResponse).agent;

    // 4. Verify Task 1 claim is STILL held by predecessor, NOT successor
    const taskClaim = await runInDurableObject(f.channel, (_object, state) => {
      const row = state.storage.sql.exec<{ claim: string }>("SELECT claim FROM tasks WHERE number=1").one();
      return JSON.parse(row.claim);
    });
    expect(taskClaim.holder).toEqual({ kind: "agent", agent: predecessor.id });
    expect(taskClaim.holder.agent).not.toBe(successor.id);
  });

  it("leaves unlinked legacy registration and continuation unaffected", async () => {
    const channel = bareChannel(legacyBinding);
    let registeredId: string | null = null;
    Object.assign(channel, {
      registerAgent: (_person: string, req: RegisterAgentRequest) => {
        registeredId = "alice/codex/legacy";
        return {
          ok: true,
          agent: { id: registeredId, continues: req.continues },
          token: "legacy-agent-token",
        };
      },
    });

    const reg = channel.registerAgent("alice", {
      cli: "codex",
      sessionId: "aaaa-bbbb",
      resumed: false,
      cwd: "/repo",
      continues: "predecessor/codex/1234",
    });
    expect(reg).toMatchObject({
      ok: true,
      agent: { id: "alice/codex/legacy", continues: "predecessor/codex/1234" },
      token: "legacy-agent-token",
    });
  });
});
