import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SUMMARY_MAX_NOTES } from "../../shared/src/index";
import type { ChannelAuthorization } from "../src/organization";
import { bareChannel } from "./managed-helpers";
import { composedQuerySurfaces, queryDenials } from "./managed-query-cases";

const target = "alice/codex/session";
const successor = "bob/codex/next";
const timestamp = new Date(Date.now() - 24 * 3600000).toISOString();
function fixture(
  options: {
    denial?: string;
    release?: boolean;
    denyScope?: string;
    denyAuthor?: string;
    revokeAuthor?: string;
    hidden?: boolean;
    cursor?: number;
    privateOnly?: boolean;
    floor?: boolean;
    binding?: boolean;
    revision?: boolean;
    replace?: boolean;
    outage?: boolean;
    expiredDeadline?: boolean;
    hung?: boolean;
    richChanges?: boolean;
    unclaimed?: boolean;
    changes?: number;
    sparse?: number;
    notes?: number;
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
  const reads: string[] = [];
  const eventReads: string[] = [];
  const counts = new Map<string, number>();
  let floor = 0;
  let finished = false;
  let execution = "execution";
  const agent = (id: string) => ({
    id,
    cli: "codex",
    presence: "live",
    startedAt: timestamp,
    lastSeenAt: timestamp,
    sessionId: "private-marker",
    person: "legacy-login",
    nickname: "private-marker",
    account: "private-marker",
  });
  const task = {
    number: 1,
    title: "Public task",
    description: "Work",
    labels: [],
    blockedBy: [],
    subtasks: [],
    subtasksDone: 0,
    steps: [{ index: 0, text: "Do it", done: false }],
    stepsDone: 0,
    url: "https://github.com/owner/repo/issues/1",
    status: "claimed",
    claim: {
      task: 1,
      holder: { kind: "agent", agentId: target, person: "private-marker" },
      claimedAt: timestamp,
      stale: false,
    },
    updatedAt: timestamp,
    privateExtra: "private-marker",
  };
  if (options.unclaimed) Object.assign(task, { claim: undefined, status: "open" });
  const event = (seq: number, type: string, payload: unknown, agentId = target, taskNumber: number | null = 1) => ({
    seq,
    id: `event-${seq}`,
    at: timestamp,
    type,
    actor: JSON.stringify({ kind: "agent", agentId }),
    payload: JSON.stringify(payload),
    task: taskNumber,
    turn: "private-marker",
    capture: "private-marker",
  });
  const events = [
    event(1, "update", { text: "Public update" }),
    event(2, "memory.note", { text: "Public note", tags: ["decision"], nickname: "private-marker" }),
    event(3, "task.create", { title: "Public task" }),
  ];
  if (options.richChanges) {
    events.push(
      event(10, "merge", { pr: 9, branch: "work", into: "main", files: [{ path: "docs/adr/decision.md" }] }),
      event(11, "task.done", { pr: 9 }),
      event(12, "task.reopen", {}),
      event(13, "task.remove", {}),
      event(14, "claim.stale", { holder: { kind: "agent", agentId: successor } }),
      event(15, "claim.recovered", { holder: { kind: "agent", agentId: successor } }),
      event(16, "claim.stale", { holder: { kind: "person", person: "private-marker" } }),
    );
  }
  if (options.notes) {
    for (let index = 0; index < options.notes; index++)
      events.push(
        event(
          index + 10,
          "memory.note",
          { text: `Note ${index}`, tags: ["question"], nickname: "private-marker" },
          successor,
        ),
      );
  }
  if (options.changes)
    for (let index = 0; index < options.changes; index++)
      events.push(event(index + 10, "task.create", { title: `Task change ${index}` }));
  if (options.hidden || options.privateOnly) {
    const privateEvents = [
      event(100, "directive", { text: "private-marker" }),
      event(101, "update", { text: "private-marker", to: [target] }),
      event(102, "terminal", { text: "private-marker" }),
      event(103, "memory.note", { text: "private-marker", tags: ["decision"] }, "unverifiable"),
    ];
    if (options.privateOnly) events.splice(0, events.length, ...privateEvents);
    else events.push(...privateEvents);
  }
  if (options.sparse)
    for (let index = 0; index < options.sparse; index++)
      events.push(event(1000 + index, "update", { text: "private-marker", to: [target] }));
  const recordRead = (source: string) => {
    reads.push(source);
    if (options.floor) floor = 2;
    if (options.binding) binding.operation = "replacement";
    if (options.replace && source === "events") execution = "replacement";
  };
  Object.assign(channel, {
    quietAfterMs: 4 * 3600000,
    ctx: {
      id: env.CHANNEL.idFromName(repo),
      storage: {
        sql: {
          exec: (sql: string, ...args: unknown[]) => {
            if (sql.includes("managed_policy_floor") && sql.startsWith("SELECT"))
              return { toArray: () => [{ revision: floor }] };
            if (sql.includes("managed_")) return { toArray: () => [] };
            if (sql.includes("m1_agent_executions"))
              return {
                toArray: () =>
                  args[0] === "unverifiable" ? [] : [{ active: 1, executionId: execution, organizationId }],
              };
            let rows: unknown[] = [];
            if (sql.includes("FROM agents")) {
              recordRead("agents");
              rows = [target, successor]
                .sort()
                .filter((id) => id > String(args[2]))
                .slice(0, Number(args[3]))
                .map((id) => ({ id }));
            } else if (sql.includes("FROM tasks")) {
              recordRead("tasks");
              const position = Number(sql.includes("holder_agent") ? args[1] : args[0]);
              rows = position < 1 ? [{ number: 1, data: JSON.stringify(task) }] : [];
            } else if (sql.includes("FROM brief_pages")) {
              recordRead("brief");
              rows = String(args[0]) < "overview" ? [{ page: "overview" }] : [];
            } else if (sql.includes("FROM librarian_cursor")) {
              recordRead("cursor");
              rows = options.cursor === undefined ? [] : [{ seq: options.cursor, quiet: "[1,999]" }];
            } else if (sql.includes("FROM events")) {
              recordRead("events");
              eventReads.push(sql.includes("type = ?") ? String(args[0]) : "all");
              if (sql.includes("type = ?"))
                rows = events
                  .filter((event) => event.type === args[0] && event.seq < Number(args[1]))
                  .sort((a, b) => b.seq - a.seq)
                  .slice(0, Number(args[2]));
              else
                rows = events
                  .filter((event) => event.seq > Number(args[0]))
                  .sort((a, b) => a.seq - b.seq)
                  .slice(0, Number(args[1]));
              if (!(rows as unknown[]).length) finished = true;
            } else throw new Error(`unexpected source ${sql}`);
            return { toArray: () => rows };
          },
        },
      },
    },
    agents: { find: (id: string) => (id === "unverifiable" ? null : agent(id)) },
    brief: {
      budget: () => {
        recordRead("budget");
        return { perDay: 80, librarianPerDay: 60, writesToday: 2, librarianToday: 1 };
      },
    },
    env: {
      CHANNEL: env.CHANNEL,
      ORGANIZATION: {
        getByName: () => ({
          authorizeChannelRead: async (input: ChannelAuthorization) => {
            calls.push(input);
            if (options.hung) return new Promise(() => {});
            if (options.outage) throw new Error("private-marker");
            const key = JSON.stringify([input.action, input.resource.targetId, input.resource.operation]);
            const count = (counts.get(key) ?? 0) + 1;
            counts.set(key, count);
            if (
              (options.denial &&
                (!options.release || count > 1) &&
                (!options.denyScope || options.denyScope === input.resource.targetId)) ||
              input.resource.targetId === options.denyAuthor ||
              (finished && input.resource.targetId === options.revokeAuthor)
            )
              return { ok: false, status: 403, reason: options.denial ?? "denied", policyRevision: 1 };
            return {
              ok: true,
              policyRevision: options.revision && reads.length > 0 ? 2 : 1,
              value: {
                deadline: Date.now() + (options.expiredDeadline ? 0 : 60000),
                target: { principalId: "principal", executionId: execution, ownerPersonId: "native-owner" },
              },
            };
          },
        }),
      },
    },
  });
  return {
    calls,
    reads,
    eventReads,
    request: (path: string) =>
      channel.managedRequest(
        new Request(`https://switchboard.test/r/${repo}${path}`, { headers: { Authorization: "Bearer m1.fixture" } }),
        repo,
      ),
  };
}

describe("B1q2 shared summary/feed handler matrix", () => {
  for (const surface of composedQuerySurfaces) {
    it(`admits ${surface.id} with the exact outer action, target and constituent scopes`, async () => {
      const f = fixture();
      const response = await f.request(surface.path(target));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const text = await response.text();
      expect(text).not.toMatch(/private-marker|legacy-login|nickname|policyRevision|sessionId/);
      expect(f.calls[0]).toMatchObject({
        actor: { token: "m1.fixture" },
        action: surface.action,
        resource: { targetId: surface.target(target), operation: surface.operation },
        generation: 1,
      });
      const body = JSON.parse(text);
      if (surface.id === "summary") {
        expect(body.agent.id).toBe(target);
        expect(body.successors).toMatchObject([
          { id: successor, executionId: "execution", ownerPersonId: "native-owner" },
        ]);
        expect(body.tasks).toMatchObject([{ number: 1, claim: { holder: { kind: "agent", agentId: target } } }]);
        expect(body.updates).toEqual([{ seq: 1, at: timestamp, text: "Public update", task: 1 }]);
        expect(body.notes).toEqual([
          {
            seq: 2,
            id: "event-2",
            at: timestamp,
            author: { kind: "agent", agentId: target },
            task: 1,
            tags: ["decision"],
            text: "Public note",
          },
        ]);
        expect(body.files).toEqual([]);
        expect(body.historyUnavailable).toBe("managed_local_history_unavailable");
        expect(body.activity).toBeUndefined();
      } else {
        expect(body).toMatchObject({
          cursor: null,
          through: 3,
          more: false,
          changes: [],
          quiet: [{ task: 1, title: "Public task", holder: target, since: timestamp }],
          quietStarted: [1],
          quietEnded: [],
          brief: { pages: 1, writesToday: 2, librarianToday: 1 },
        });
      }
      for (const action of ["agent.view", "task.read", "channel.update.read", "channel.history.read"])
        expect(
          f.calls.some((call) => call.action === action),
          action,
        ).toBe(true);
    });
    for (const denial of queryDenials)
      for (const release of [false, true]) {
        it(`denies ${surface.id}: ${denial} at ${release ? "release" : "admission"} without content`, async () => {
          const f = fixture({ denial, release });
          const response = await f.request(surface.path(target));
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
          if (!release) expect(f.reads).toEqual([]);
        });
      }
    for (const fault of ["floor", "binding", "revision", "replace", "outage", "expiredDeadline"] as const) {
      it(`fences ${surface.id} on ${fault} without releasing prepared bytes`, async () => {
        const f = fixture({ [fault]: true });
        const response = await f.request(surface.path(target));
        expect(response.status).toBe(fault === "outage" ? 503 : 404);
        expect(await response.text()).not.toMatch(/Public|cursor|quiet|notes|tasks|private-marker/);
      });
    }
    it(`keeps ${surface.id} bytes and relational metadata invariant under private insertion`, async () => {
      const visible = await fixture({ cursor: 1 }).request(surface.path(target));
      const hidden = await fixture({ cursor: 1, hidden: true }).request(surface.path(target));
      expect(visible.status).toBe(200);
      expect(hidden.status).toBe(200);
      expect(await hidden.text()).toBe(await visible.text());
    });
    it(`bounds ${surface.id} authority stalls before any content access`, async () => {
      vi.useFakeTimers();
      try {
        const f = fixture({ hung: true });
        const pending = f.request(surface.path(target));
        await vi.advanceTimersByTimeAsync(2000);
        expect((await pending).status).toBe(503);
        expect(f.reads).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  }
  for (const [id, scopes] of [
    ["summary", ["events", "tasks", "updates", "memory"]],
    ["librarian", ["tasks", "brief", "events"]],
  ] as const)
    for (const scope of scopes)
      for (const release of [false, true]) {
        it(`requires ${id} constituent ${scope} at ${release ? "release" : "admission"}`, async () => {
          const surface = composedQuerySurfaces.find((surface) => surface.id === id);
          if (!surface) throw new Error("surface missing");
          const f = fixture({ denial: "scope_denied", denyScope: scope, release });
          const response = await f.request(surface.path(target));
          expect(response.status).toBe(404);
          expect(await response.text()).not.toMatch(/Public|quiet|notes|tasks/);
          if (!release) {
            const source = scope === "memory" || scope === "updates" ? "events" : scope;
            // Summary HR is an independent empty scope and must precede every source.
            if (id === "summary" && scope === "events") expect(f.reads).toEqual([]);
            else if (scope !== "memory") expect(f.reads).not.toContain(source);
            if (id === "summary" && (scope === "memory" || scope === "updates"))
              expect(f.eventReads).not.toContain(scope === "memory" ? "memory.note" : "update");
          }
        });
      }
  it("omits an unauthorized successor and never retains its release checks", async () => {
    const f = fixture({ denyAuthor: successor });
    const response = await f.request(composedQuerySurfaces[0].path(target));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { successors: unknown[] }).successors).toEqual([]);
    expect(f.calls.filter((call) => call.resource.targetId === successor)).toHaveLength(1);
  });
  it("denies the complete summary when a retained successor loses authority", async () => {
    const response = await fixture({ revokeAuthor: successor }).request(composedQuerySurfaces[0].path(target));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Public");
  });
  it("selects task question notes with native attribution and caps notes after visibility", async () => {
    const response = await fixture({ notes: 80 }).request(composedQuerySurfaces[0].path(target));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { notes: { author: unknown; seq: number }[] };
    expect(body.notes).toHaveLength(SUMMARY_MAX_NOTES);
    expect(body.notes[0]).toMatchObject({ author: { kind: "agent", agentId: successor }, seq: 89 });
    expect(JSON.stringify(body)).not.toMatch(/nickname|private-marker|legacy-login/);
  });
  it("derives subsequent feed changes and through from admitted rows only", async () => {
    const response = await fixture({ cursor: 1, hidden: true }).request("/api/librarian");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cursor: 1,
      through: 3,
      more: false,
      changes: [
        { seq: 2, kind: "decision", by: target, text: "Public note" },
        { seq: 3, kind: "task-opened", task: 1, title: "Public task" },
      ],
      quietStarted: [],
      quietEnded: [],
    });
  });
  it("proves feed more using an additional admitted change and returns only the visible boundary", async () => {
    const response = await fixture({ cursor: 3, changes: 501, hidden: true }).request("/api/librarian");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changes: { seq: number }[]; through: number; more: boolean };
    expect(body.more).toBe(true);
    expect(body.changes).toHaveLength(500);
    expect(body.through).toBe(body.changes.at(-1)?.seq);
    expect(body.through).toBe(509);
  });
  it("projects every supported shared change without legacy holder attribution", async () => {
    const response = await fixture({ cursor: 3, richChanges: true }).request("/api/librarian");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changes: { kind: string }[]; through: number };
    expect(body.changes.map((item) => item.kind)).toEqual([
      "merge",
      "task-closed",
      "task-reopened",
      "task-removed",
      "claim-stale",
      "claim-recovered",
    ]);
    expect(body.through).toBe(15);
    expect(JSON.stringify(body)).not.toMatch(/private-marker|nickname|person/);
  });
  it("reports ended quiet claims only for currently authorized Tasks", async () => {
    const response = await fixture({ cursor: 1, unclaimed: true }).request("/api/librarian");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ quiet: [], quietStarted: [], quietEnded: [1] });
  });
  for (const release of [false, true])
    it(`withholds Brief budget and counts on exact-page denial at ${release ? "release" : "admission"}`, async () => {
      const f = fixture({ denial: "page_denied", denyScope: "brief/overview", release });
      const response = await f.request("/api/librarian");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
    });
  it("never reveals a legacy private cursor or invisible quiet-task IDs", async () => {
    const response = await fixture({ cursor: 999, privateOnly: true }).request("/api/librarian");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ cursor: 0, through: 0, more: false, changes: [], quietEnded: [] });
    expect(JSON.stringify(body)).not.toMatch(/999|private-marker/);
  });
  it("continues sparse summary windows before limiting visible Updates", async () => {
    const response = await fixture({ sparse: 1001 }).request(composedQuerySurfaces[0].path(target));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ updates: [{ seq: 1, text: "Public update" }] });
  });
  it("fails a composed read at the shared candidate ceiling without partial metadata", async () => {
    const response = await fixture({ sparse: 10000 }).request("/api/librarian");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, reason: "managed_read_unavailable" });
  });
});
