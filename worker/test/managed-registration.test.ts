import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResponse, RegisterAgentRequest } from "../../shared/src/index";
import type { IdentityCommand, NativeResult } from "../../shared/src/m1";
import { GitHubApp, installGitHub, installGitHubApp, RestGitHub } from "../src/github/index";
import { CONTRIBUTOR_ACTIONS } from "../src/principals";
import { signSession } from "../src/session";
import { FakeGitHub } from "./fake-github";
import { M1_ORIGIN, M1_SECRET, nativeFetch, nativeIdentity } from "./m1-helpers";

const registration: RegisterAgentRequest = {
  cli: "codex",
  sessionId: "12345678-1234-4234-8234-123456789012",
  resumed: false,
  cwd: "/repo",
};
function value<T>(result: NativeResult<T>): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
beforeEach(() => reset());
afterEach(() => {
  installGitHub(null);
  installGitHubApp(null);
  vi.restoreAllMocks();
});
async function fixture() {
  const { actor, token } = await nativeIdentity();
  const organization = value(
    await env.IDENTITY_DIRECTORY.getByName("directory-v1").createOrganization(actor, "Org", "org", "fixture"),
  );
  const org = env.ORGANIZATION.getByName(organization.id);
  const workspace = value(
    await org.mutate({
      actor,
      key: "workspace",
      requestId: "fixture",
      command: {
        kind: "workspace.create",
        name: "Managed",
        description: "",
        acceptManager: true,
      },
    }),
  );
  if (!("id" in workspace)) throw new Error("Missing workspace");
  const github = new FakeGitHub();
  github.permissions.set("native-human", "admin");
  installGitHub(github);
  const reader = new RestGitHub({ token: async () => "fixture", invalidate: () => {} }, github.repo);
  vi.spyOn(reader, "call").mockImplementation(async () => Response.json({ permission: "admin", user: { id: 900 } }));
  const app = new GitHubApp({ appId: "fixture", privateKey: "fixture", clientId: "fixture", clientSecret: "fixture" });
  vi.spyOn(app, "repo").mockReturnValue(reader);
  installGitHubApp(app);
  let sequence = 0;
  const mutate = async (command: IdentityCommand) =>
    value(
      await org.mutateIdentity({
        actor,
        key: `identity-${++sequence}`,
        requestId: "fixture",
        expectedRevision: (await org.metadata(actor))?.policyRevision,
        command,
      }),
    );
  await mutate({ kind: "identity.policy", actions: CONTRIBUTOR_ACTIONS });
  await mutate({ kind: "identity.policy", workspaceId: workspace.id, actions: CONTRIBUTOR_ACTIONS });
  const principal = (
    await mutate({
      kind: "principal.create",
      displayName: "Helper",
      capabilities: [],
      sponsor: { kind: "person", id: actor.personId },
    })
  ).principal;
  if (!principal) throw new Error("No principal");
  await mutate({
    kind: "grant.put",
    principalId: principal.id,
    workspaceId: workspace.id,
    actions: CONTRIBUTOR_ACTIONS,
    constraints: {},
    expiresAt: Date.now() + 3600000,
  });
  const channel = env.CHANNEL.getByName(github.repo);
  const bind = await nativeFetch(`/api/m1/workspaces/${workspace.id}/channel`, token, {
    method: "POST",
    headers: { "Idempotency-Key": "bind", "If-Match": String((await org.metadata(actor))?.policyRevision) },
    body: JSON.stringify({ repo: github.repo }),
  });
  expect(bind.status).toBe(200);
  const intent = { principalId: principal.id, workspaceId: workspace.id };
  const request = (bearer = token, key = `registration-${++sequence}`) =>
    new Request(`${M1_ORIGIN}/r/${github.repo}/api/agents`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Idempotency-Key": key },
    });
  return { actor, org, channel, intent, request, github };
}
describe("managed registration compatibility", () => {
  it("preserves legacy registration heartbeat session IDs AgentId and Host behavior", async () => {
    const channel = env.CHANNEL.getByName("legacy/registration");
    const first = await channel.registerAgent("alice", registration);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const id = first.agent.id;
    expect(id).toBe("alice/codex/9012");
    expect(first.token).toBeDefined();
    expect((await channel.heartbeat("alice", id, "idle")).ok).toBe(true);
    await channel.endSession("alice", id);
    const resumed = await channel.registerAgent("alice", { ...registration, resumed: true });
    expect(resumed.ok && resumed.agent.id).toBe(id);
    expect(await channel.registerAgent("alice", { ...registration, host: "missing" })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(
      await runInDurableObject(channel, (_object, state) =>
        state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='m1_agent_executions'").toArray(),
      ),
    ).toEqual([]);
  });
  it("links only human authorized intent and rejects legacy token exchange", async () => {
    const f = await fixture();
    const legacy = await signSession(M1_SECRET, "native-human");
    expect((await f.channel.registerManagedAgent(f.request(legacy), registration, f.intent)).status).toBe(401);
    expect((await f.channel.registerManagedAgent(f.request("agent_planted"), registration, f.intent)).status).toBe(401);
    expect(
      (await f.channel.registerManagedAgent(f.request(), registration, { ...f.intent, owner: "other" })).status,
    ).toBe(400);
    const response = await f.channel.registerManagedAgent(f.request(), registration, f.intent);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const answer = (await response.json()) as AgentResponse;
    expect(answer.execution).toMatchObject({
      ownerPersonId: f.actor.personId,
      legacyAgentId: answer.agent.id,
      sessionReference: registration.sessionId,
      principalId: f.intent.principalId,
    });
    expect(await f.org.verifyExecution(answer.token ?? "")).toMatchObject({ executionId: answer.execution?.id });
    const stored = await runInDurableObject(f.channel, async (_object, state) => ({
      sql: state.storage.sql.exec("SELECT * FROM m1_agent_executions").toArray(),
      kv: [...(await state.storage.list()).entries()],
    }));
    expect(JSON.stringify(stored)).not.toContain(answer.token);
    expect((await nativeFetch(`/r/${f.github.repo}/api/agents`, legacy)).status).toBe(403);
  });
  it("ends managed execution on Gone and resumes with a fresh execution", async () => {
    const f = await fixture();
    const first = (await (
      await f.channel.registerManagedAgent(f.request(), registration, f.intent)
    ).json()) as AgentResponse;
    expect(first.execution).toBeDefined();
    await f.channel.heartbeat("native-human", first.agent.id, "idle");
    await f.channel.endSession("native-human", first.agent.id);
    expect(await f.org.verifyExecution(first.token ?? "")).toBeNull();
    const second = (await (
      await f.channel.registerManagedAgent(f.request(), { ...registration, resumed: true }, f.intent)
    ).json()) as AgentResponse;
    expect(second.execution?.id).not.toBe(first.execution?.id);
    expect(second.execution?.principalId).toBe(first.execution?.principalId);
    expect(second.agent.id).toBe(first.agent.id);
    expect(await f.org.verifyExecution(second.token ?? "")).not.toBeNull();
    expect(await f.org.verifyExecution(first.token ?? "")).toBeNull();
    const rows = await runInDurableObject(f.org, (_object, state) =>
      state.storage.sql.exec<{ body: string }>("SELECT body FROM executions").toArray(),
    );
    expect(rows.map((row) => JSON.parse(row.body))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: first.execution?.id, status: "ended" })]),
    );
  });
  it("denies unlinked intent without registration and never replays a managed secret", async () => {
    const f = await fixture();
    const unlinked = env.CHANNEL.getByName("unlinked/intent");
    expect((await unlinked.registerManagedAgent(f.request(), registration, f.intent)).status).toBe(403);
    expect(await unlinked.listAgents(true)).toEqual([]);
    const key = "once-only";
    const first = await f.channel.registerManagedAgent(f.request(undefined, key), registration, f.intent);
    expect(first.status).toBe(200);
    const answer = (await first.json()) as AgentResponse;
    const retry = await f.channel.registerManagedAgent(f.request(undefined, key), registration, f.intent);
    expect(retry.status).toBe(409);
    expect(await retry.text()).not.toContain(answer.token);
    expect(await f.org.verifyExecution(answer.token ?? "")).not.toBeNull();
    const failed = await f.channel.registerManagedAgent(f.request(), { ...registration, host: "missing" }, f.intent);
    expect(failed.status).toBe(409);
    const executions = await runInDurableObject(f.org, (_object, state) =>
      state.storage.sql.exec<{ body: string }>("SELECT body FROM executions").toArray(),
    );
    expect(executions.map((row) => JSON.parse(row.body))).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "ended" })]),
    );
  });
  it("denies Gone credentials while retrying a failed execution end notification", async () => {
    const f = await fixture();
    const response = await f.channel.registerManagedAgent(f.request(), registration, f.intent);
    expect(response.status).toBe(200);
    const answer = (await response.json()) as AgentResponse;
    await runInDurableObject(f.org, (_object, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fail_execution_end BEFORE UPDATE ON executions BEGIN SELECT RAISE(ABORT, 'end unavailable'); END",
      );
    });
    await f.channel.endSession("native-human", answer.agent.id);
    expect(await f.org.verifyExecution(answer.token ?? "")).toBeNull();
    await vi.waitFor(async () => {
      expect(
        await runInDurableObject(f.channel, (_object, state) =>
          state.storage.sql.exec("SELECT * FROM m1_agent_execution_ends").toArray(),
        ),
      ).toHaveLength(1);
    });
    expect(await f.org.endRegisteredExecution(answer.execution?.id ?? "", answer.agent.id)).toBe(false);
    await runInDurableObject(f.org, (_object, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_execution_end");
    });
    await runInDurableObject(f.channel, (_object, state) => {
      state.storage.sql.exec("UPDATE alarm_deadlines SET at=0 WHERE job='executions'");
    });
    await runDurableObjectAlarm(f.channel);
    const rows = await runInDurableObject(f.org, (_object, state) =>
      state.storage.sql.exec<{ body: string }>("SELECT body FROM executions").toArray(),
    );
    expect(rows.map((row) => JSON.parse(row.body))).toEqual([expect.objectContaining({ status: "ended" })]);
  });
  it("serializes competing registrations without reviving the replaced execution", async () => {
    const f = await fixture();
    const responses = await Promise.all([
      f.channel.registerManagedAgent(f.request(), registration, f.intent),
      f.channel.registerManagedAgent(f.request(), registration, f.intent),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const first = (await responses[0].json()) as AgentResponse;
    const second = (await responses[1].json()) as AgentResponse;
    const verified = await Promise.all([
      f.org.verifyExecution(first.token ?? ""),
      f.org.verifyExecution(second.token ?? ""),
    ]);
    expect(verified.filter(Boolean)).toHaveLength(1);
    const rows = await runInDurableObject(f.org, (_object, state) =>
      state.storage.sql.exec<{ body: string }>("SELECT body FROM executions").toArray(),
    );
    expect(rows.map((row) => JSON.parse(row.body).status).sort()).toEqual(["active", "ended"]);
  });
});
