import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { agentIdFor } from "../../shared/src/index";
import type { IdentityCommand } from "../../shared/src/m1";
import type { Brief } from "../src/brief";
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

async function write(repo: string, token: string, text = "managed page") {
  return nativeFetch(`/r/${repo}/api/brief/guide`, token, {
    method: "PUT",
    body: JSON.stringify({ text }),
  });
}

describe("managed Brief writes", () => {
  it("maps exact pages to policy and commits an attributed page with a consumed permit", async () => {
    expect(managedWriteRoute("PUT", "/api/brief/guide")).toEqual({
      action: "channel.update.write",
      targetId: "brief/guide",
      operation: "brief.write",
    });
    const f = await fixture();
    const response = await write(f.repo, f.credential);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true,
      written: true,
      page: { text: "managed page", author: { agent: f.targetId, person: "alice" } },
    });
    await runInDurableObject(f.channel, (_object, state) => {
      expect(
        state.storage.sql.exec("SELECT id FROM managed_permits WHERE json_extract(body, '$.used')=1").toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql
          .exec("SELECT id FROM managed_outcome_outbox WHERE json_extract(body, '$.outcome')='committed'")
          .toArray(),
      ).toHaveLength(1);
      expect(
        state.storage.sql.exec("SELECT job FROM alarm_deadlines WHERE job='managed-outcomes'").toArray(),
      ).toHaveLength(1);
    });
    expect((await write(f.repo, f.credential)).status).toBe(200);
  });

  it("denies nonmembers foreign Organizations foreign Workspaces stale generations and revoked executions", async () => {
    const f = await fixture();
    const foreign = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "foreign");
    expect((await write(f.repo, foreign.token)).status).toBe(404);
    const other = await f.org.mutate({
      actor: f.actor,
      key: "other",
      requestId: "other",
      command: { kind: "workspace.create", name: "Foreign", description: "", acceptManager: true },
    });
    if (!other.ok || !("id" in other.value)) throw new Error("missing Workspace");
    for (const [workspace, generation] of [
      [`${crypto.randomUUID()}:${crypto.randomUUID()}`, 1],
      [other.value.id, 1],
      [f.workspaceId, 2],
    ] as const) {
      await runInDurableObject(f.channel, (object) => {
        Object.assign(object, {
          binding: { version: 1, state: "linked", operation: "binding", workspace, generation },
        });
      });
      expect((await write(f.repo, f.credential)).status).toBe(404);
    }
    await runInDurableObject(f.channel, (object) => {
      Object.assign(object, {
        binding: { version: 1, state: "linked", operation: "binding", workspace: f.workspaceId, generation: 1 },
      });
    });
    expect((await f.mutate({ kind: "execution.revoke", executionId: f.execution.id })).ok).toBe(true);
    expect((await write(f.repo, f.credential)).status).toBe(404);
    await runInDurableObject(f.channel, (_object, state) => {
      expect(state.storage.sql.exec("SELECT page FROM brief_pages").toArray()).toHaveLength(0);
    });
  });

  it("retains Agent-only writing and denies removed authority and read-only grants", async () => {
    const f = await fixture();
    expect((await write(f.repo, f.token)).status).toBe(403);
    expect(
      (
        await f.mutate({
          kind: "grant.put",
          principalId: f.principalId,
          workspaceId: f.workspaceId,
          actions: ["channel.update.read"],
          constraints: {},
          expiresAt: Date.now() + 600000,
        })
      ).ok,
    ).toBe(true);
    expect((await write(f.repo, f.credential)).status).toBe(404);
    expect((await f.mutate({ kind: "identity.policy", workspaceId: f.workspaceId, actions: [] })).ok).toBe(true);
    expect((await write(f.repo, f.credential)).status).toBe(404);
    await runInDurableObject(f.org, (_object, state) => {
      const aggregate = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
      );
      aggregate.workspaceMembers[f.workspaceId][f.actor.personId].role = "viewer";
      state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
    });
    expect((await write(f.repo, f.token)).status).toBe(404);
  });

  it("denies an expired grant and a generation change after permit issuance before committing", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (object, state) => {
      const originalEnv = (object as unknown as { env: Env }).env;
      // RPC stubs must be created in the Channel callback's I/O context.
      const org = originalEnv.ORGANIZATION.getByName(f.organizationId);
      Object.assign(object, {
        env: {
          ...originalEnv,
          ORGANIZATION: {
            getByName: () => ({
              verifyExecution: (token: string) => org.verifyExecution(token),
              authorizeChannelRead: (input: Parameters<typeof f.org.authorizeChannelRead>[0]) =>
                org.authorizeChannelRead(input),
              issueMutationPermit: async (input: Parameters<typeof f.org.issueMutationPermit>[0]) => {
                const result = await org.issueMutationPermit(input);
                Object.assign(object, {
                  binding: {
                    version: 1,
                    state: "linked",
                    operation: "binding",
                    workspace: f.workspaceId,
                    generation: 2,
                  },
                });
                return result;
              },
            }),
          },
        },
      });
      try {
        const response = await object.managedRequest(
          new Request(`https://switchboard.test/r/${f.repo}/api/brief/guide`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${f.credential}` },
            body: JSON.stringify({ text: "must not commit" }),
          }),
          f.repo,
        );
        expect(response.status).toBe(404);
        expect(state.storage.sql.exec("SELECT page FROM brief_pages").toArray()).toHaveLength(0);
      } finally {
        Object.assign(object, {
          env: originalEnv,
          binding: { version: 1, state: "linked", operation: "binding", workspace: f.workspaceId, generation: 1 },
        });
      }
    });
    await runInDurableObject(f.org, (_object, state) => {
      state.storage.sql.exec(
        "UPDATE grants SET body=json_set(body, '$.expiresAt', ?) WHERE json_extract(body, '$.principalId')=?",
        Date.now() - 1,
        f.principalId,
      );
    });
    expect((await write(f.repo, f.credential)).status).toBe(404);
  });

  it("rechecks authority before releasing committed page content", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (object) => {
      const originalEnv = (object as unknown as { env: Env }).env;
      // RPC stubs must be created in the Channel callback's I/O context.
      const org = originalEnv.ORGANIZATION.getByName(f.organizationId);
      let reads = 0;
      Object.assign(object, {
        env: {
          ...originalEnv,
          ORGANIZATION: {
            getByName: () => ({
              verifyExecution: (token: string) => org.verifyExecution(token),
              issueMutationPermit: (input: Parameters<typeof f.org.issueMutationPermit>[0]) =>
                org.issueMutationPermit(input),
              authorizeChannelRead: async (input: Parameters<typeof f.org.authorizeChannelRead>[0]) => {
                if (++reads === 2) return { ok: false, status: 403, reason: "revoked", policyRevision: 1 };
                return await org.authorizeChannelRead(input);
              },
            }),
          },
        },
      });
      try {
        const response = await object.managedRequest(
          new Request(`https://switchboard.test/r/${f.repo}/api/brief/guide`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${f.credential}` },
            body: JSON.stringify({ text: "PRIVATE_RESPONSE_MARKER" }),
          }),
          f.repo,
        );
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("PRIVATE_RESPONSE_MARKER");
        expect(reads).toBe(2);
      } finally {
        Object.assign(object, { env: originalEnv });
      }
    });
  });

  it("drops a page response when its binding changes after commit", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (object) => {
      const brief = (object as unknown as { brief: Brief }).brief;
      const original = brief.write;
      brief.write = (...args) => {
        const result = original.apply(brief, args);
        Object.assign(object, {
          binding: { version: 1, state: "linked", operation: "binding", workspace: f.workspaceId, generation: 2 },
        });
        return result;
      };
      try {
        const response = await object.managedRequest(
          new Request(`https://switchboard.test/r/${f.repo}/api/brief/guide`, {
            method: "PUT",
            headers: { Authorization: `Bearer ${f.credential}` },
            body: JSON.stringify({ text: "PRIVATE_RESPONSE_MARKER" }),
          }),
          f.repo,
        );
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("PRIVATE_RESPONSE_MARKER");
      } finally {
        brief.write = original;
      }
    });
  });
});
