import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { agentIdFor } from "../../shared/src/index";
import type { IdentityCommand } from "../../shared/src/m1";
import { managedReadRoute } from "../src/managed-channel";
import type { Skills } from "../src/skills";
import { nativeFetch, nativeIdentity } from "./m1-helpers";
import { managedAuthorityFixture } from "./managed-helpers";

async function fixture() {
  const f = { ...(await managedAuthorityFixture()), targetId: agentIdFor("alice", "codex", "session") };
  let sequence = 0;
  const mutate = async (command: IdentityCommand) =>
    f.org.mutateIdentity({
      actor: f.actor,
      command,
      key: `memory-${++sequence}`,
      requestId: "memory-fixture",
      expectedRevision: (await f.org.metadata(f.actor))?.policyRevision,
    });
  const actions = ["channel.history.read", "channel.update.write", "agent.view", "channel.update.read"];
  for (const workspaceId of [undefined, f.workspaceId]) {
    const result = await mutate({ kind: "identity.policy", workspaceId, actions });
    if (!result.ok) throw new Error("fixture policy denied");
  }
  const created = await mutate({
    kind: "principal.create",
    sponsor: { kind: "person", id: f.actor.personId },
    displayName: "Memory writer",
    capabilities: [],
  });
  if (!created.ok || !created.value.principal) throw new Error("fixture principal denied");
  const principalId = created.value.principal.id;
  const grant = await mutate({
    kind: "grant.put",
    principalId,
    workspaceId: f.workspaceId,
    actions,
    constraints: {},
    expiresAt: Date.now() + 600000,
  });
  if (!grant.ok) throw new Error("fixture grant denied");
  const started = await mutate({
    kind: "execution.start",
    principalId,
    workspaceId: f.workspaceId,
    cli: "codex",
    registration: { agentId: f.targetId, sessionId: "session", channel: f.repo },
  });
  if (!started.ok || !started.value.execution || !started.value.secret) throw new Error("fixture execution denied");
  const execution = started.value.execution;
  const credential = started.value.secret;
  const channel = env.CHANNEL.getByName(f.repo);
  await runInDurableObject(channel, async (object, state) => {
    // Seed the existing roster through the legacy registration path before linking.
    const registered = await object.registerAgent("alice", {
      cli: "codex",
      sessionId: "session",
      resumed: false,
      cwd: "/repo",
    });
    if (!registered.ok) throw new Error("fixture roster denied");
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS m1_agent_executions (
      agent TEXT PRIMARY KEY, organizationId TEXT NOT NULL, executionId TEXT NOT NULL, active INTEGER NOT NULL)`);
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO m1_agent_executions VALUES(?,?,?,1)",
      f.targetId,
      f.organizationId,
      execution.id,
    );
    Object.assign(object, {
      binding: { version: 1, generation: 1, workspace: f.workspaceId, operation: "binding", state: "linked" },
    });
  });
  return { ...f, channel, execution, credential, principalId, mutate };
}

beforeEach(async () => {
  await reset();
});
const digest = "a".repeat(64);
async function read(repo: string, token: string) {
  return nativeFetch(`/r/${repo}/api/skill-files/read`, token, {
    method: "POST",
    body: JSON.stringify({ chunks: [{ digest, index: 0 }] }),
  });
}
async function seeded() {
  const f = await fixture();
  await runInDurableObject(f.channel, (_object, state) => {
    state.storage.sql.exec("INSERT INTO skill_blobs VALUES(?,3,1,1,NULL,?)", digest, new Date().toISOString());
    state.storage.sql.exec("INSERT INTO skill_entries VALUES('guide',1,'SKILL.md',?,3,'utf8')", digest);
    state.storage.sql.exec("INSERT INTO skill_chunks VALUES(?,0,?)", digest, new Uint8Array([0, 128, 255]));
  });
  return f;
}
describe("managed skill-file bytes", () => {
  it("authorizes exact chunk resources and releases published bytes only", async () => {
    expect(managedReadRoute("POST", "/api/skill-files/read")).toEqual({
      action: "channel.update.read",
      targetId: "skill-files",
      operation: "skill-files.read",
    });
    const f = await seeded();
    const response = await read(f.repo, f.credential);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ chunks: [{ digest, index: 0, data: "AID/" }] });
    await runInDurableObject(f.channel, (_object, state) => {
      state.storage.sql.exec("DELETE FROM skill_entries");
    });
    expect((await read(f.repo, f.credential)).status).toBe(404);
  });
  it("denies nonmembers foreign Workspaces wrong generations revoked and unauthorized executions", async () => {
    const f = await seeded();
    const foreign = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "foreign");
    expect((await read(f.repo, foreign.token)).status).toBe(404);
    const other = await f.org.mutate({
      actor: f.actor,
      key: "other",
      requestId: "other",
      command: { kind: "workspace.create", name: "Foreign", description: "", acceptManager: true },
    });
    if (!other.ok || !("id" in other.value)) throw new Error("missing Workspace");
    for (const [workspace, generation] of [
      [other.value.id, 1],
      [f.workspaceId, 2],
    ] as const) {
      await runInDurableObject(f.channel, (object) => {
        Object.assign(object, {
          binding: { version: 1, state: "linked", operation: "binding", workspace, generation },
        });
      });
      expect((await read(f.repo, f.credential)).status).toBe(404);
    }
    await runInDurableObject(f.channel, (object) => {
      Object.assign(object, {
        binding: { version: 1, state: "linked", operation: "binding", workspace: f.workspaceId, generation: 1 },
      });
    });
    expect((await f.mutate({ kind: "identity.policy", workspaceId: f.workspaceId, actions: [] })).ok).toBe(true);
    expect((await read(f.repo, f.credential)).status).toBe(404);
    expect(
      (
        await f.mutate({
          kind: "identity.policy",
          workspaceId: f.workspaceId,
          actions: ["channel.history.read", "channel.update.write", "agent.view", "channel.update.read"],
        })
      ).ok,
    ).toBe(true);
    expect((await read(f.repo, f.credential)).status).toBe(200);
    expect((await f.mutate({ kind: "execution.revoke", executionId: f.execution.id })).ok).toBe(true);
    expect((await read(f.repo, f.credential)).status).toBe(404);
  });
  it("drops prepared bytes when the binding changes before release", async () => {
    const f = await seeded();
    await runInDurableObject(f.channel, async (object) => {
      const skills = (object as unknown as { skills: Skills }).skills;
      const original = skills.readChunks;
      skills.readChunks = (wanted) => {
        const result = original.call(skills, wanted);
        Object.assign(object, {
          binding: { version: 1, state: "linked", operation: "binding", workspace: f.workspaceId, generation: 2 },
        });
        return result;
      };
      try {
        const response = await object.managedRequest(
          new Request(`https://switchboard.test/r/${f.repo}/api/skill-files/read`, {
            method: "POST",
            headers: { Authorization: `Bearer ${f.credential}` },
            body: JSON.stringify({ chunks: [{ digest, index: 0 }] }),
          }),
          f.repo,
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
      } finally {
        skills.readChunks = original;
      }
    });
  });
});
