import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { agentIdFor } from "../../shared/src/index";
import type { IdentityCommand } from "../../shared/src/m1";
import type { Artifacts } from "../src/artifacts";
import { managedWriteRoute } from "../src/managed-channel";
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

describe("managed artifact publication", () => {
  it("maps publication to an exact resource and commits attributed bytes with a permit", async () => {
    expect(managedWriteRoute("PUT", "/api/artifacts/guide")).toEqual({
      action: "channel.update.write",
      targetId: "artifacts/guide",
      operation: "artifact.publish",
    });
    const f = await fixture();
    const response = await nativeFetch(`/r/${f.repo}/api/artifacts/guide`, f.credential, {
      method: "PUT",
      body: JSON.stringify({ html: "<h1>Published</h1>", title: "Guide" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      published: true,
      artifact: { owner: "alice", publishedBy: { agent: f.targetId } },
    });
    await runInDurableObject(f.channel, (_object, state) => {
      const rows = state.storage.sql.exec<{ body: string }>("SELECT body FROM managed_outcome_outbox").toArray();
      expect(rows.map((row) => JSON.parse(row.body))).toContainEqual(
        expect.objectContaining({
          action: "channel.update.write",
          resource: expect.objectContaining({ targetId: "artifacts/guide", operation: "artifact.publish" }),
          outcome: "committed",
        }),
      );
    });
  });
  it("denies nonmembers foreign Workspaces stale generations revoked executions and wrong roles before publication", async () => {
    const f = await fixture();
    const check = async (token: string) => {
      for (const body of [{ html: "<h1>Denied</h1>", title: "Guide" }, {}]) {
        const response = await nativeFetch(`/r/${f.repo}/api/artifacts/guide`, token, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(404);
      }
    };
    const foreign = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "foreign");
    await check(foreign.token);
    const other = await f.org.mutate({
      actor: f.actor,
      key: "other-artifact",
      requestId: "other",
      command: { kind: "workspace.create", name: "Foreign", description: "", acceptManager: true },
    });
    if (!other.ok || !("id" in other.value)) throw new Error("missing Workspace");
    const otherId = other.value.id;
    for (const [workspace, generation] of [
      [otherId, 1],
      [f.workspaceId, 2],
    ] as const) {
      await runInDurableObject(f.channel, (object) =>
        Object.assign(object, {
          binding: { version: 1, generation, workspace, operation: "binding", state: "linked" },
        }),
      );
      await check(f.credential);
    }
    await runInDurableObject(f.channel, (object) =>
      Object.assign(object, {
        binding: { version: 1, generation: 1, workspace: f.workspaceId, operation: "binding", state: "linked" },
      }),
    );
    await runInDurableObject(f.org, (_object, state) => {
      const aggregate = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
      );
      aggregate.workspaceMembers[f.workspaceId][f.actor.personId].role = "viewer";
      state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
    });
    await check(f.credential);
    await runInDurableObject(f.org, (_object, state) => {
      const aggregate = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
      );
      aggregate.workspaceMembers[f.workspaceId][f.actor.personId].role = "manager";
      state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
    });
    expect((await f.mutate({ kind: "execution.revoke", executionId: f.execution.id })).ok).toBe(true);
    await check(f.credential);
    await runInDurableObject(f.channel, (_object, state) =>
      expect(state.storage.sql.exec("SELECT name FROM artifact_versions").toArray()).toHaveLength(0),
    );
  });
  it("rejects a binding change after permit acquisition without publishing or recording a commit", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (object, state) => {
      state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS managed_outcome_outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
      );
      const artifacts = (object as unknown as { artifacts: Artifacts }).artifacts;
      const original = artifacts.publish;
      artifacts.publish = (publisher, name, page, prepare, observed) =>
        original.call(
          artifacts,
          publisher,
          name,
          page,
          async () => {
            if (!prepare) throw new Error("missing managed preparation");
            const prepared = await prepare();
            Object.assign(object, {
              binding: { version: 1, generation: 2, workspace: f.workspaceId, operation: "binding", state: "linked" },
            });
            return prepared;
          },
          observed,
        );
      try {
        const response = await object.managedRequest(
          new Request(`https://switchboard.test/r/${f.repo}/api/artifacts/guide`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${f.credential}` },
            body: JSON.stringify({ html: "<h1>Fenced</h1>", title: "Guide" }),
          }),
          f.repo,
        );
        expect(response.status).toBe(404);
        expect(state.storage.sql.exec("SELECT name FROM artifact_versions").toArray()).toHaveLength(0);
        expect(state.storage.sql.exec("SELECT body FROM managed_outcome_outbox").toArray()).toHaveLength(0);
      } finally {
        artifacts.publish = original;
      }
    });
  });
  it("rolls publication bytes and outcome back together when the synchronous commit fails", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (object, state) => {
      state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS managed_outcome_outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
      );
      const artifacts = (object as unknown as { artifacts: Artifacts }).artifacts;
      const original = artifacts.publish;
      artifacts.publish = (publisher, name, page, prepare) =>
        original.call(artifacts, publisher, name, page, prepare, () => {
          throw new Error("private failure marker");
        });
      try {
        const response = await object.managedRequest(
          new Request(`https://switchboard.test/r/${f.repo}/api/artifacts/guide`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${f.credential}` },
            body: JSON.stringify({ html: "<h1>Rollback</h1>", title: "Guide" }),
          }),
          f.repo,
        );
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain("private failure marker");
        expect(state.storage.sql.exec("SELECT name FROM artifact_versions").toArray()).toHaveLength(0);
        expect(state.storage.sql.exec("SELECT name FROM artifact_chunks").toArray()).toHaveLength(0);
        expect(state.storage.sql.exec("SELECT body FROM managed_outcome_outbox").toArray()).toHaveLength(0);
      } finally {
        artifacts.publish = original;
      }
    });
  });
  it("retains target ownership and the librarian ceiling at publication", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (object) => {
      const artifacts = (object as unknown as { artifacts: Artifacts }).artifacts;
      expect((await artifacts.publish({ person: "bob" }, "guide", { html: "<h1>Owner</h1>", title: "Owner" })).ok).toBe(
        true,
      );
    });
    const publish = () =>
      nativeFetch(`/r/${f.repo}/api/artifacts/guide`, f.credential, {
        method: "PUT",
        body: JSON.stringify({ html: "<h1>Replacement</h1>", title: "Guide" }),
      });
    expect((await publish()).status).toBe(403);
    await runInDurableObject(f.channel, (_object, state) => {
      state.storage.sql.exec("UPDATE agents SET librarian='1' WHERE id=?", f.targetId);
    });
    expect((await publish()).status).toBe(404);
    await runInDurableObject(f.channel, (_object, state) => {
      expect(state.storage.sql.exec("SELECT owner, title FROM artifact_versions").toArray()).toEqual([
        { owner: "bob", title: "Owner" },
      ]);
    });
  });
});
