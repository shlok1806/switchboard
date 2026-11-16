import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GitHubApp, installGitHubApp } from "../src/github/index";
import type { ChannelAuthorization } from "../src/organization";
import { bareChannel } from "./managed-helpers";
import { preparationScopes, preparationSurfaces, queryDenials, querySurfaces } from "./managed-query-cases";

function fixture(
  options: {
    deny?: string;
    denyAction?: string;
    release?: boolean;
    denyOnRelease?: boolean;
    floor?: boolean;
    revision?: boolean;
    binding?: boolean;
    expiredDeadline?: boolean;
    rows?: number;
    hidden?: boolean;
    omitAuthor?: boolean;
    outage?: boolean;
    hungSource?: boolean;
    authorityFault?: { at: number; kind: "floor" | "revision" | "binding" | "deadline" | "outage" | "timeout" };
  } = {},
) {
  const repo = "shlok1806/other";
  const organizationId = crypto.randomUUID();
  const binding = {
    version: 1,
    state: "linked",
    generation: 1,
    workspace: `${organizationId}:${crypto.randomUUID()}`,
    operation: "binding",
  };
  const channel = bareChannel(binding);
  let reads = 0;
  let floor = 0;
  const calls: ChannelAuthorization[] = [];
  const agentId = "alice/codex/session";
  const agent = {
    id: agentId,
    cli: "codex",
    presence: "live",
    startedAt: "now",
    lastSeenAt: "now",
    session: "private-marker",
  };
  const rows = Array.from({ length: options.rows ?? 1 }, (_, i) => {
    const visible = i === (options.rows ?? 1) - 1;
    return {
      id: visible ? "visible" : `hidden-${i}`,
      seq: i + 1,
      at: "2026-11-15T00:00:00.000Z",
      actor: JSON.stringify({ kind: "agent", agentId }),
      type: visible ? "wake" : "directive",
      payload: JSON.stringify(visible ? { verdicts: [], events: [], directives: [] } : { text: "private-marker" }),
      capture: null,
      turn: null,
      task: null,
    };
  });
  if (options.hidden && rows[0])
    rows.unshift({
      ...rows[0],
      id: "extra-private",
      seq: 0,
      type: "directive",
      payload: JSON.stringify({ text: "private-marker" }),
    });
  const contentRead = () => {
    reads++;
    if (options.floor) floor = 2;
    if (options.binding) binding.operation = "replacement";
  };
  installGitHubApp({
    repo: () => ({
      call: async () => {
        contentRead();
        if (options.hungSource) return new Promise<Response>(() => {});
        return Response.json({
          data: {
            repository: {
              url: `https://github.com/${repo}`,
              defaultBranchRef: { name: "main", target: null },
              object: { __typename: "Blob", text: "visible", byteSize: 7, isBinary: false, isTruncated: false },
            },
          },
        });
      },
    }),
  } as unknown as GitHubApp);
  Object.assign(channel, {
    ctx: {
      id: env.CHANNEL.idFromName(repo),
      storage: {
        sql: {
          exec: (sql: string, ...args: unknown[]) => {
            if (sql.includes("managed_policy_floor") && sql.startsWith("SELECT"))
              return { toArray: () => [{ revision: floor }] };
            if (sql.includes("managed_")) return { toArray: () => [] };
            if (sql.includes("m1_agent_executions"))
              return { toArray: () => [{ organizationId, executionId: "execution", active: 1 }] };
            contentRead();
            if (sql.includes("brief_pages") || sql.includes("FROM tasks")) return { toArray: () => [] };
            const selected = sql.includes("WHERE id =")
              ? rows.filter((row) => row.id === args[0])
              : rows.filter((row) => row.seq > Number(args[0])).slice(0, Number(args[1]));
            return { toArray: () => selected };
          },
        },
      },
    },
    agents: {
      list: () => {
        contentRead();
        return [agent];
      },
      find: () => agent,
    },
    env: {
      CHANNEL: env.CHANNEL,
      ORGANIZATION: {
        getByName: () => ({
          authorizeChannelRead: async (input: ChannelAuthorization) => {
            calls.push(input);
            const fault = options.authorityFault?.at === calls.length ? options.authorityFault.kind : undefined;
            if (fault === "binding") binding.operation = "replacement";
            if (fault === "floor") floor = 2;
            if (fault === "timeout") return new Promise(() => {});
            if (fault === "outage") throw new Error("private-marker");
            if (options.outage) throw new Error("private-marker");
            if (
              (options.deny &&
                (!options.denyAction || options.denyAction === input.action) &&
                (!options.release ||
                  (!options.denyOnRelease && reads > 0) ||
                  calls.filter(
                    (call) =>
                      call.action === input.action &&
                      call.resource.operation === input.resource.operation &&
                      call.resource.targetId === input.resource.targetId,
                  ).length > 1)) ||
              (options.omitAuthor && input.resource.operation === "history.author")
            )
              return { ok: false, status: 403, reason: options.deny ?? "denied", policyRevision: 1 };
            return {
              ok: true,
              policyRevision: fault === "revision" || (options.revision && reads > 0) ? 2 : 1,
              value: {
                deadline: Date.now() + (fault === "deadline" || options.expiredDeadline ? 0 : 60000),
                target: { principalId: "principal", executionId: "execution", ownerPersonId: "owner" },
              },
            };
          },
          readChannelPersons: async () => {
            contentRead();
            return { ok: true, value: { persons: [{ personId: "native-person" }] }, policyRevision: 1 };
          },
        }),
      },
    },
  });
  return {
    rawPrepare: (input: unknown) => channel.prepareManagedQuery(repo, input as never),
    prepare: (surface: (typeof preparationSurfaces)[number], actor = true) =>
      channel.prepareManagedQuery(repo, {
        id: surface.id,
        actor: actor ? { token: "m1.query-fixture" } : (undefined as never),
        generation: 1,
        selectors: surface.selectors,
      }),
    reads: () => reads,
    calls,
    request: (path: string) =>
      channel.managedRequest(
        new Request(`https://switchboard.test/r/${repo}${path}`, {
          headers: { Authorization: "Bearer m1.query-fixture" },
        }),
        repo,
      ),
  };
}
afterEach(() => installGitHubApp(null));

describe("shared managed query handler matrix", () => {
  it("denies unknown plans and malformed internal actor/selector contexts without reads", async () => {
    for (const input of [
      { id: "unknown", actor: { token: "m1.query-fixture" }, generation: 1 },
      { id: "stream.event", actor: "forged", generation: 1 },
      { id: "connector.channel", actor: { kind: "execution" }, generation: 1 },
      { id: "connector.brief", actor: { kind: "person", personId: "owner", githubId: "1" }, generation: 1 },
      {
        id: "connector.brief",
        actor: { kind: "person", personId: "owner", githubId: "1" },
        generation: 1,
        credentialExpiresAt: 0,
      },
      { id: "connector.channel", actor: { token: "m1.query-fixture" }, generation: 1, selectors: {} },
    ]) {
      const f = fixture();
      expect((await f.rawPrepare(input)).status).toBe(404);
      expect(f.calls).toHaveLength(0);
      expect(f.reads()).toBe(0);
    }
  });
  for (const surface of preparationSurfaces) {
    it(`prepares ${surface.id} through the typed RPC and exact registered scope`, async () => {
      const f = fixture();
      const response = await f.prepare(surface);
      expect(response.status).toBe(200);
      expect(f.calls[0]).toMatchObject({
        action: surface.action,
        resource: { targetId: surface.target, operation: surface.id },
      });
      expect(await response.text()).not.toMatch(/private-marker|policyRevision|sessionId|deadline/);
      for (const action of preparationScopes[surface.id]) expect(f.calls.map((call) => call.action)).toContain(action);
    });
    for (const action of preparationScopes[surface.id])
      for (const release of [false, true]) {
        it(`requires ${surface.id} constituent ${action} at ${release ? "release" : "admission"}`, async () => {
          const f = fixture({ deny: "scope_denied", denyAction: action, release, denyOnRelease: true });
          const response = await f.prepare(surface);
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
          if (!release && action === surface.action) expect(f.reads()).toBe(0);
        });
      }
    for (const kind of ["floor", "revision", "binding", "deadline", "outage"] as const) {
      it(`fences ${surface.id} at every awaited authority boundary on ${kind}`, async () => {
        const baseline = fixture();
        expect((await baseline.prepare(surface)).status).toBe(200);
        for (let at = 1; at <= baseline.calls.length; at++) {
          const f = fixture({ authorityFault: { at, kind } });
          const response = await f.prepare(surface);
          expect(response.status, `authority await ${at}`).toBe(kind === "outage" ? 503 : 404);
          expect(await response.json()).toEqual({
            ok: false,
            reason: kind === "outage" ? "authority_unavailable" : "resource_denied",
          });
        }
      });
    }
    it(`bounds ${surface.id} authority timeout before any source access`, async () => {
      vi.useFakeTimers();
      try {
        const f = fixture({ authorityFault: { at: 1, kind: "timeout" } });
        const pending = f.prepare(surface);
        await vi.advanceTimersByTimeAsync(2000);
        const response = await pending;
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ ok: false, reason: "authority_unavailable" });
        expect(f.reads()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
    it(`rejects actor-free ${surface.id} before source access`, async () => {
      const f = fixture();
      expect((await f.prepare(surface, false)).status).toBe(404);
      expect(f.reads()).toBe(0);
      expect(f.calls).toHaveLength(0);
    });
    for (const failure of ["floor", "revision", "binding", "expiredDeadline", "outage"] as const) {
      if (surface.id !== "local.history" || failure === "expiredDeadline" || failure === "outage")
        it(`fences internal ${surface.id} on ${failure}`, async () => {
          const f = fixture({ [failure]: true });
          const response = await f.prepare(surface);
          expect(response.status).toBe(failure === "outage" ? 503 : 404);
          expect(await response.json()).toEqual({
            ok: false,
            reason: failure === "outage" ? "authority_unavailable" : "resource_denied",
          });
        });
    }
    it(`keeps ${surface.id} unchanged by private insertion`, async () => {
      const a = await fixture().prepare(surface);
      const b = await fixture({ hidden: true }).prepare(surface);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(await a.text()).toBe(await b.text());
    });
    for (const release of [false, true]) {
      it(`denies internal ${surface.id} at ${release ? "release" : "admission"}`, async () => {
        const f = fixture({ deny: "revoked", release });
        const response = await f.prepare(surface);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
        if (!release) expect(f.reads()).toBe(0);
      });
    }
  }
  for (const surface of querySurfaces) {
    it(`admits ${surface.id} through the real handler and preserves its schema`, async () => {
      const f = fixture();
      const response = await f.request(surface.path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(f.calls[0]).toMatchObject({
        action: surface.action,
        generation: 1,
        resource: { targetId: surface.target },
      });
      const text = await response.text();
      expect(text).not.toMatch(/private-marker|policyRevision|deadline|envelope/);
      expect(JSON.parse(text)).toHaveProperty(
        surface.id === "ids" || surface.id === "wakes" || surface.id === "history"
          ? "events"
          : surface.id === "github"
            ? "text"
            : surface.id,
      );
      expect(f.reads()).toBeGreaterThan(0);
    });
    for (const deny of queryDenials)
      for (const release of [false, true]) {
        it(`denies ${surface.id}: ${deny} at ${release ? "release" : "admission"} without prepared bytes`, async () => {
          const f = fixture({ deny, release });
          const response = await f.request(surface.path);
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
          if (!release) expect(f.reads()).toBe(0);
        });
      }
    for (const failure of ["floor", "revision", "binding", "expiredDeadline", "outage"] as const) {
      it(`fences ${surface.id} on ${failure}`, async () => {
        const f = fixture({ [failure]: true });
        const response = await f.request(surface.path);
        expect(response.status).toBe(failure === "outage" ? 503 : 404);
        expect(await response.text()).not.toMatch(/visible|native-person|private-marker|cursor|agents/);
      });
    }
  }
  for (const action of ["channel.update.read", "agent.view"])
    for (const release of [false, true]) {
      it(`requires independent history constituent ${action} at ${release ? "release" : "admission"}`, async () => {
        const f = fixture({ deny: "scope_denied", denyAction: action, release });
        const response = await f.request("/api/events");
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
        if (!release) expect(f.reads()).toBe(0);
      });
    }
  it("returns identical empty ID pages for missing and inaccessible rows", async () => {
    const missing = await fixture().request("/api/events?ids=missing");
    const privateOnly = await fixture({ rows: 2 }).request("/api/events?ids=hidden-0");
    expect(await missing.text()).toBe(await privateOnly.text());
  });
  it("keeps the input forward cursor when no admitted row remains", async () => {
    const response = await fixture().request("/api/events?after=100");
    expect(await response.json()).toEqual({ events: [], cursor: 100 });
  });
  it("continues sparse stored history beyond a thousand private candidates", async () => {
    const f = fixture({ rows: 1002 });
    const response = await f.request("/api/events?limit=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ events: [{ id: "visible" }], cursor: 1002 });
  });
  it("fails the entire query at the candidate cap without partial end-of-history metadata", async () => {
    const f = fixture({ rows: 10001 });
    const response = await f.request("/api/events?limit=1");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, reason: "managed_read_unavailable" });
  });
  it("accepts an admitted row at the exact candidate cap", async () => {
    const f = fixture({ rows: 10000 });
    const response = await f.request("/api/events?limit=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cursor: 10000, events: [{ id: "visible" }] });
  });
  it("omits denied authors without retaining their release dependencies", async () => {
    const f = fixture({ omitAuthor: true });
    const response = await f.request("/api/events");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [], cursor: 0 });
    expect(f.calls.filter((call) => call.resource.operation === "history.author")).toHaveLength(1);
  });
  it("keeps visible bytes and cursors unchanged when a private row is inserted", async () => {
    const first = await fixture().request("/api/events?ids=visible,extra-private");
    const second = await fixture({ hidden: true }).request("/api/events?ids=visible,extra-private");
    expect(await first.text()).toBe(await second.text());
  });
  it("bounds a hung source with the absolute preparation deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ hungSource: true });
      const pending = f.request("/api/github?about=README.md");
      await vi.advanceTimersByTimeAsync(10000);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, reason: "query_unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });
});
