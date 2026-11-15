import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { IdentityCommand } from "../../shared/src/m1";
import type { ChannelAuthorization } from "../src/organization";
import { bareChannel, managedAuthorityFixture } from "./managed-helpers";

function stored(id = "shared", seq = 2, type = "update", payload: unknown = { text: "shared-marker" }) {
  return {
    id,
    seq,
    type,
    payload: JSON.stringify(payload),
    at: new Date().toISOString(),
    actor: JSON.stringify({ kind: "agent", agentId: "alice/codex/session" }),
    capture: JSON.stringify({ private: "capture-secret" }),
    task: null,
    turn: "turn-secret",
  };
}

function fixture(
  options: {
    deny?: string;
    release?: boolean;
    action?: string;
    outage?: boolean;
    hung?: boolean;
    changeGeneration?: boolean;
    authorDenied?: boolean;
    authorReleaseDenied?: boolean;
    inactive?: boolean;
  } = {},
) {
  const repo = "shlok1806/other";
  const organizationId = crypto.randomUUID();
  const binding = {
    version: 1,
    generation: 1,
    workspace: `${organizationId}:${crypto.randomUUID()}`,
    operation: "binding",
    state: "linked",
  };
  const channel = bareChannel(binding);
  const calls: ChannelAuthorization[] = [];
  const rows = [
    stored("private", 1, "directive", { text: "directive-secret", to: "alice/codex/session" }),
    stored(),
    stored("directed", 3, "update", { text: "directed-secret", to: ["alice/codex/session"] }),
    stored("wake", 4, "wake", {
      events: ["event-secret"],
      directives: ["directive-secret"],
      verdicts: ["verdict-secret"],
    }),
    { ...stored("person", 5), actor: JSON.stringify({ kind: "person", person: "historical-login-secret" }) },
  ];
  const reads: string[] = [];
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      if (query.includes("m1_agent_executions"))
        return { toArray: () => [{ organizationId, executionId: "execution", active: options.inactive ? 0 : 1 }] };
      reads.push(query);
      if (options.changeGeneration) binding.generation++;
      const result = query.includes("WHERE id =")
        ? rows.filter((row) => row.id === args[0])
        : rows.filter((row) => row.seq > Number(args[0]));
      return { toArray: () => result };
    },
  };
  Object.assign(channel, {
    ctx: { id: env.CHANNEL.idFromName(repo), storage: { sql } },
    env: {
      CHANNEL: env.CHANNEL,
      ORGANIZATION: {
        getByName: () => ({
          authorizeChannelRead: async (input: ChannelAuthorization) => {
            calls.push(input);
            if (options.hung) return new Promise(() => {});
            if (options.outage) throw new Error("authority-secret");
            const occurrences = calls.filter(
              (call) =>
                call.action === input.action &&
                call.resource.operation === input.resource.operation &&
                call.resource.targetId === input.resource.targetId,
            ).length;
            if (
              options.deny &&
              (!options.action || options.action === input.action) &&
              (!options.release || occurrences === 2)
            )
              return { ok: false, status: 403, reason: options.deny, policyRevision: 1 };
            if (
              input.resource.operation === "history.author" &&
              (options.authorDenied || (options.authorReleaseDenied && occurrences === 2))
            )
              return { ok: false, status: 403, reason: "historical_enrollment_required", policyRevision: 1 };
            return { ok: true, value: {}, policyRevision: 1 };
          },
        }),
      },
    },
  });
  return {
    calls,
    reads,
    rows,
    request: (query = "after=0&limit=10") =>
      channel.managedRequest(
        new Request(`https://switchboard.test/r/${repo}/api/events?${query}`, {
          headers: { Authorization: "Bearer m1.synthetic-authority-stub" },
        }),
        repo,
      ),
  };
}

const variants = ["after=0&limit=10", "ids=private,shared,wake,missing", "type=wake", "ids=shared"];
describe("managed stored history real handler", () => {
  for (const query of variants) {
    it(`admits ${query} through HR, UR and AV with exact enrolled-author release checks`, async () => {
      const f = fixture();
      const response = await f.request(query);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const result = await response.json<{ events: { id: string; payload: unknown }[]; cursor: number }>();
      expect(result.events.map((event) => event.id)).toEqual(
        query === "type=wake" ? ["wake"] : query === "ids=shared" ? ["shared"] : ["shared", "wake"],
      );
      expect(result.cursor).toBe(query === "ids=shared" ? 2 : 4);
      expect(JSON.stringify(result)).not.toMatch(/secret|capture|turn|directed|historical-login/);
      if (query !== "ids=shared")
        expect(result.events.at(-1)?.payload).toEqual({ verdicts: [], events: [], directives: [] });
      expect(f.calls[0]).toMatchObject({
        action: "channel.history.read",
        generation: 1,
        resource: { operation: "history.read", targetId: "events", channel: "shlok1806/other" },
      });
      for (const action of ["channel.history.read", "channel.update.read", "agent.view"])
        expect(f.calls.filter((call) => call.action === action).length).toBeGreaterThanOrEqual(2);
      const authors = f.calls.filter((call) => call.resource.operation === "history.author");
      expect(authors.length).toBeGreaterThanOrEqual(2);
      for (const author of authors)
        expect(author).toMatchObject({
          targetExecutionId: "execution",
          eventAt: expect.any(Number),
          resource: { targetId: "alice/codex/session" },
        });
    });
    for (const deny of [
      "non_member",
      "foreign_organization",
      "foreign_workspace",
      "revoked_execution",
      "expired_execution",
      "wrong_generation",
      "insufficient_role",
      "insufficient_scope",
    ]) {
      for (const release of [false, true]) {
        it(`withholds bytes counts and cursors for ${query}: ${deny} at ${release ? "release" : "admission"}`, async () => {
          const f = fixture({ deny, release, action: "channel.history.read" });
          const response = await f.request(query);
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
          if (!release) expect(f.reads).toHaveLength(0);
        });
      }
    }
  }
  for (const action of ["channel.update.read", "agent.view"]) {
    it(`requires constituent ${action} before SQL and again at release`, async () => {
      const initial = fixture({ deny: "scope_denied", action });
      expect((await initial.request()).status).toBe(404);
      expect(initial.reads).toHaveLength(0);
      const release = fixture({ deny: "revoked", action, release: true });
      const result = await release.request();
      expect(result.status).toBe(404);
      expect(await result.json()).toEqual({ ok: false, reason: "resource_denied" });
    });
  }
  it("drops historical or inactive authors before counting and cursor construction", async () => {
    for (const options of [{ authorDenied: true }, { inactive: true }]) {
      const f = fixture(options);
      const response = await f.request();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ events: [], cursor: 0 });
    }
  });
  it("discards the complete page on author release denial", async () => {
    const f = fixture({ authorReleaseDenied: true });
    const response = await f.request("ids=shared");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
  });
  it("fences a binding change after the SQL read", async () => {
    const f = fixture({ changeGeneration: true });
    const response = await f.request();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("shared-marker");
  });
  it("redacts authority failures before any SQL read", async () => {
    const f = fixture({ outage: true });
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("authority-secret");
    expect(f.reads).toHaveLength(0);
  });
  for (const query of [
    "tail=10",
    "agent=alice",
    "task=1",
    "before=3",
    "after=-1",
    "limit=0",
    "type=directive",
    "ids=",
    "ids=shared&tail=1",
    "limit=1&limit=2",
  ]) {
    it(`denies unsupported or invalid ${query} without reading candidates`, async () => {
      const f = fixture();
      expect((await f.request(query)).status).toBe(404);
      expect(f.reads).toHaveLength(0);
    });
  }
  it("projects before applying the page limit", async () => {
    const f = fixture();
    const response = await f.request("limit=1");
    expect(await response.json()).toMatchObject({ events: [{ id: "shared" }], cursor: 2 });
  });
  it("bounds authority waits without querying history", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ hung: true });
      const pending = f.request();
      await vi.advanceTimersByTimeAsync(2000);
      expect((await pending).status).toBe(503);
      expect(f.reads).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Stored history handler with real Organization policy", () => {
  for (const denial of [
    "none",
    "non_member",
    "foreign_organization",
    "foreign_workspace",
    "revoked_execution",
    "expired_execution",
    "wrong_generation",
    "insufficient_scope",
    "historical_author",
  ] as const) {
    it(`uses decide and withholds history access for ${denial}`, async () => {
      const f = await managedAuthorityFixture();
      // The base fixture seeds a placeholder target for private-read tests. This
      // handler uses a real granted execution; remove the placeholder to avoid
      // same-millisecond ordering between two registrations of one legacy ID.
      await runInDurableObject(f.org, (_object, state) => {
        state.storage.sql.exec("DELETE FROM executions WHERE id=?", f.executionId);
      });
      let sequence = 0;
      const mutate = async (command: IdentityCommand) =>
        f.org.mutateIdentity({
          actor: f.actor,
          command,
          key: `history-${++sequence}`,
          requestId: "history-fixture",
          expectedRevision: (await f.org.metadata(f.actor))?.policyRevision,
        });
      const actions = ["channel.history.read", "channel.update.read", "agent.view", "channel.update.write"];
      for (const workspaceId of [undefined, f.workspaceId]) {
        expect((await mutate({ kind: "identity.policy", workspaceId, actions })).ok).toBe(true);
      }
      const created = await mutate({
        kind: "principal.create",
        sponsor: { kind: "person", id: f.actor.personId },
        displayName: "History reader",
        capabilities: [],
      });
      if (!created.ok || !created.value.principal) throw new Error("fixture principal denied");
      const principalId = created.value.principal.id;
      expect(
        (
          await mutate({
            kind: "grant.put",
            principalId,
            workspaceId: f.workspaceId,
            actions,
            constraints: {},
            expiresAt: Date.now() + 600000,
          })
        ).ok,
      ).toBe(true);
      const started = await mutate({
        kind: "execution.start",
        principalId,
        workspaceId: f.workspaceId,
        cli: "codex",
        registration: { agentId: f.targetId, sessionId: "session", channel: f.repo },
      });
      if (!started.ok || !started.value.execution || !started.value.secret) throw new Error("fixture execution denied");
      const executionId = started.value.execution.id;
      const credential = started.value.secret;
      await runInDurableObject(f.org, (_object, state) => {
        if (denial === "non_member") {
          const row = JSON.parse(
            state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
          );
          delete row.workspaceMembers[f.workspaceId][f.actor.personId];
          state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(row));
        }
        if (denial === "revoked_execution" || denial === "expired_execution") {
          state.storage.sql.exec(
            "UPDATE executions SET body=json_set(body, '$.status', 'revoked') WHERE id=? AND ?='revoked_execution'",
            executionId,
            denial,
          );
          state.storage.sql.exec(
            "UPDATE execution_credentials SET body=json_set(body, '$.expiresAt', 0) WHERE json_extract(body, '$.executionId')=? AND ?='expired_execution'",
            executionId,
            denial,
          );
        }
        if (denial === "insufficient_scope") {
          state.storage.sql.exec(
            "UPDATE grants SET body=json_set(body, '$.actions', json(?)) WHERE json_extract(body, '$.principalId')=?",
            JSON.stringify(["channel.update.write"]),
            principalId,
          );
        }
      });
      let reads = 0;
      const row = stored();
      if (denial === "historical_author") row.at = new Date(0).toISOString();
      const sql = {
        exec: (query: string) => {
          if (query.includes("m1_agent_executions"))
            return { toArray: () => [{ organizationId: f.organizationId, executionId, active: 1 }] };
          reads++;
          return { toArray: () => [row] };
        },
      };
      const workspace =
        denial === "foreign_organization"
          ? `${crypto.randomUUID()}:${crypto.randomUUID()}`
          : denial === "foreign_workspace"
            ? `${f.organizationId}:${crypto.randomUUID()}`
            : f.workspaceId;
      const channel = bareChannel({
        version: 1,
        generation: denial === "wrong_generation" ? 2 : 1,
        workspace,
        operation: "binding",
        state: "linked",
      });
      Object.assign(channel, { ctx: { id: env.CHANNEL.idFromName(f.repo), storage: { sql } }, env });
      const response = await channel.managedRequest(
        new Request(`https://switchboard.test/r/${f.repo}/api/events?ids=shared`, {
          headers: { Authorization: `Bearer ${credential}` },
        }),
        f.repo,
      );
      expect(response.status).toBe(denial === "none" || denial === "historical_author" ? 200 : 404);
      expect(reads).toBe(denial === "none" || denial === "historical_author" ? 1 : 0);
      if (denial === "none") expect(await response.text()).toContain("shared-marker");
      else if (denial === "historical_author") expect(await response.json()).toEqual({ events: [], cursor: 0 });
      else expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
    });
  }
});
