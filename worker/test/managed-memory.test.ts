import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { agentIdFor } from "../../shared/src/index";
import type { IdentityCommand } from "../../shared/src/m1";
import { managedReadRoute, managedWriteRoute } from "../src/managed-channel";
import type { Memory } from "../src/memory";
import { nativeFetch, nativeIdentity } from "./m1-helpers";
import { bareChannel, managedAuthorityFixture } from "./managed-helpers";

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
  const actions = ["channel.history.read", "channel.update.write", "agent.view"];
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

describe("managed Memory", () => {
  it("maps reads and writes to exact Memory resources and policy actions", () => {
    expect(managedReadRoute("GET", "/api/memory")).toEqual({
      action: "channel.history.read",
      targetId: "memory",
      operation: "memory.read",
    });
    expect(managedWriteRoute("POST", "/api/memory")).toEqual({
      action: "channel.update.write",
      targetId: "memory",
      operation: "memory.write",
    });
    expect(managedWriteRoute("PUT", "/api/memory")).toBeNull();
  });
  it("commits an attributed note with a permit and filters ineligible authors before search limits and more", async () => {
    const f = await fixture();
    const posted = await nativeFetch(`/r/${f.repo}/api/memory`, f.credential, {
      method: "POST",
      body: JSON.stringify({ text: "visible memory", tags: ["decision"] }),
    });
    expect(posted.status).toBe(201);
    expect(await posted.json()).toMatchObject({ ok: true, note: { author: f.targetId, text: "visible memory" } });
    await runInDurableObject(f.channel, (_object, state) => {
      // Newer un-enrolled authors must not consume the limit or disclose `more`.
      for (const seq of [999, 1000]) {
        state.storage.sql.exec(
          "INSERT INTO memory_notes VALUES(?,?,NULL,?)",
          seq,
          "foreign/codex/private",
          JSON.stringify({ seq, author: "foreign/codex/private", text: "hidden memory", tags: ["decision"] }),
        );
        state.storage.sql.exec("INSERT INTO memory_fts(rowid,text,files) VALUES(?,?,'')", seq, "hidden memory");
      }
      const rows = state.storage.sql.exec<{ body: string }>("SELECT body FROM managed_outcome_outbox").toArray();
      expect(
        rows.some((row) => {
          const outcome = JSON.parse(row.body);
          return (
            outcome.action === "channel.update.write" &&
            outcome.resource.targetId === "memory" &&
            outcome.resource.operation === "memory.write" &&
            outcome.outcome === "committed"
          );
        }),
      ).toBe(true);
    });
    for (const query of ["limit=1", "q=memory&limit=1", "author=foreign%2Fcodex%2Fprivate"]) {
      const response = await nativeFetch(`/r/${f.repo}/api/memory?${query}`, f.credential);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { notes: { text: string }[]; more?: boolean };
      expect(body.notes).toHaveLength(query.startsWith("author") ? 0 : 1);
      expect(body.more).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("hidden");
    }
  });
  it("denies nonmembers foreign Workspaces revoked executions and wrong binding generations without appending", async () => {
    const f = await fixture();
    const foreign = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "foreign");
    const check = async (token: string) => {
      for (const method of ["GET", "POST"]) {
        const response = await nativeFetch(`/r/${f.repo}/api/memory?q=hidden`, token, {
          method,
          ...(method === "POST" ? { body: JSON.stringify({ text: "must not append", tags: ["decision"] }) } : {}),
        });
        expect(response.status).toBe(404);
      }
    };
    await check(foreign.token);
    const other = await f.org.mutate({
      actor: f.actor,
      key: "other",
      requestId: "other",
      command: { kind: "workspace.create", name: "Foreign", description: "", acceptManager: true },
    });
    if (!other.ok || !("id" in other.value)) throw new Error("missing other Workspace");
    const otherId = other.value.id;
    await runInDurableObject(f.channel, (object) =>
      Object.assign(object, {
        binding: { version: 1, generation: 1, workspace: otherId, operation: "binding", state: "linked" },
      }),
    );
    await check(f.credential);
    await runInDurableObject(f.channel, (object) =>
      Object.assign(object, {
        binding: { version: 1, generation: 2, workspace: f.workspaceId, operation: "binding", state: "linked" },
      }),
    );
    await check(f.credential);
    await runInDurableObject(f.channel, (object) =>
      Object.assign(object, {
        binding: { version: 1, generation: 1, workspace: f.workspaceId, operation: "binding", state: "linked" },
      }),
    );
    expect((await f.mutate({ kind: "execution.revoke", executionId: f.execution.id })).ok).toBe(true);
    await check(f.credential);
    await runInDurableObject(f.channel, (_object, state) =>
      expect(state.storage.sql.exec("SELECT seq FROM memory_notes").toArray()).toHaveLength(0),
    );
  });
  it("discards a prepared Memory result when the binding changes before release", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (object) => {
      const memory = (object as unknown as { memory: Memory }).memory;
      const read = memory.read;
      memory.read = () => {
        Object.assign(object, {
          binding: { version: 1, generation: 2, workspace: f.workspaceId, operation: "binding", state: "linked" },
        });
        return { ok: true, notes: [], more: true };
      };
      try {
        const response = await object.managedRequest(
          new Request(`https://switchboard.test/r/${f.repo}/api/memory`, {
            headers: { Authorization: `Bearer ${f.token}` },
          }),
          f.repo,
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
      } finally {
        memory.read = read;
      }
    });
  });
  it("denies a Memory release assembled across different policy revisions", async () => {
    const organizationId = crypto.randomUUID();
    const workspaceId = `${organizationId}:${crypto.randomUUID()}`;
    const repo = "shlok1806/other";
    const channel = bareChannel({
      version: 1,
      generation: 1,
      workspace: workspaceId,
      operation: "binding",
      state: "linked",
    });
    const id = env.CHANNEL.idFromName(repo);
    let calls = 0;
    Object.assign(channel, {
      ctx: { id, storage: { sql: { exec: () => ({ toArray: () => [{ active: 1, executionId: "execution" }] }) } } },
      env: {
        CHANNEL: env.CHANNEL,
        ORGANIZATION: {
          getByName: () => ({
            authorizeChannelRead: async () => ({ ok: true, value: {}, policyRevision: ++calls === 4 ? 2 : 1 }),
          }),
        },
      },
      agents: { list: () => [{ id: "alice/codex/1234" }] },
      memory: { read: () => ({ ok: true, notes: [], more: true }) },
    });
    const response = await channel.managedRequest(
      new Request(`https://switchboard.test/r/${repo}/api/memory`, {
        headers: { Authorization: "Bearer m1.synthetic-for-authority-stub" },
      }),
      repo,
    );
    expect(calls).toBe(4);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
  });
  it("rechecks the librarian ceiling at the note commit", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, (_object, state) => {
      state.storage.sql.exec("UPDATE agents SET librarian='1' WHERE id=?", f.targetId);
    });
    const response = await nativeFetch(`/r/${f.repo}/api/memory`, f.credential, {
      method: "POST",
      body: JSON.stringify({ text: "librarian must not append", tags: ["decision"] }),
    });
    expect(response.status).toBe(403);
    await runInDurableObject(f.channel, (_object, state) => {
      expect(state.storage.sql.exec("SELECT seq FROM memory_notes").toArray()).toHaveLength(0);
      expect(state.storage.sql.exec("SELECT seq FROM events WHERE type='memory.note'").toArray()).toHaveLength(0);
    });
  });
  it("retains the Agent-only writer restriction and denies a viewer write grant", async () => {
    const f = await fixture();
    const response = await nativeFetch(`/r/${f.repo}/api/memory`, f.token, {
      method: "POST",
      body: JSON.stringify({ text: "human", tags: ["decision"] }),
    });
    expect(response.status).toBe(403);
    await runInDurableObject(f.org, (_object, state) => {
      const aggregate = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
      );
      aggregate.workspaceMembers[f.workspaceId][f.actor.personId].role = "viewer";
      state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
    });
    const denied = await nativeFetch(`/r/${f.repo}/api/memory`, f.credential, {
      method: "POST",
      body: JSON.stringify({ text: "viewer", tags: ["decision"] }),
    });
    expect(denied.status).toBe(404);
  });
});
