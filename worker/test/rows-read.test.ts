// What the Channel's hot paths cost in rows read, on a Channel with a long history.
// Durable Objects bill every row a query reads, against a daily allowance, and a
// Channel's tables only grow: Events forever, Agents with every session, Tasks with
// every Issue. So each call that runs per tool call, per heartbeat or per Relay
// decision must read a bounded number of rows however big the Channel gets. A
// query that scans one of those tables shows up here as thousands of rows.
//
// Rows written are billed the same way, each index row too, so what runs on every
// heartbeat, sign of life or timer writes nothing when nothing changed.

import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AccountsResponse,
  AgentContext,
  AgentId,
  AgentResponse,
  AgentSummary,
  ChannelEvent,
  HeartbeatRequest,
  HookEvent,
  MemoryNote,
  MemoryResponse,
  PostUpdateResponse,
  ReportedUsage,
  StreamMessage,
  Task,
  TaskResponse,
} from "../../shared/src/index";
import {
  agentPath,
  BRIEF_HISTORY,
  MAX_ACCOUNT_HISTORY,
  MAX_BRIEF_PAGES,
  nicknamePath,
  SUMMARY_MAX_FILES,
  summaryPath,
} from "../../shared/src/index";
import type { AgentRoster } from "../src/agents";
import { Channel } from "../src/channel";
import { installGitHub, installGitHubApp } from "../src/github/index";
import { sealSecretKey } from "../src/langfuse";
import { signAccess } from "../src/mcp/tokens";
import { installJev } from "../src/relay/jev";
import { lastUpdate } from "../src/status-comment";
import { BASE, bearer, channelStub, forgetTokens, REPO, remember, SESSION_SECRET, streamQuery, url } from "./client";
import { FakeGitHub } from "./fake-github";
import { FakeGitHubApi } from "./fake-github-api";
import { FakeJev } from "./fake-jev";
import { FakeLangfuse, LANGFUSE_HOST, PROJECT, PUBLIC_KEY, SECRET_KEY } from "./fake-langfuse";

/**
 * The history the Channel is given before anything is measured: Events from Agents
 * and People, each followed by the Relay's Verdicts about it for the other live
 * Agents, one Event per Agent, as a Channel kept them before ADR 0030, when most of
 * its rows were Verdicts.
 */
const SOURCES = 10_000;
const VERDICTS_PER_EVENT = 2;
const EVENTS = SOURCES * (1 + VERDICTS_PER_EVENT);
const GONE_AGENTS = 3000;
const TASKS = 200;
/**
 * Tasks finished long ago, after the open ones. A done Task keeps its Claim, so each
 * still names the Agent that held it, as Tasks a Channel's Agents finished do.
 */
const FINISHED_TASKS = 3000;
/** Files each live Agent has edited. */
const TOUCHED_FILES = 100;
/** Notes Agents wrote (ADR 0019), every one with the word "progress". */
const NOTES = 3000;

/** Generous for what each call needs, far below one scan of any seeded table. */
const BUDGET = 150;

type Cursor = { rowsRead: number; rowsWritten: number };
/** A query the Channel ran, and the table it writes to, if it writes. */
type Metered = { cursor: Cursor; table: string | null };
type Meter = { cursors: Metered[]; paused: boolean };
const meter = (globalThis as unknown as { rowsMeter?: Meter }).rowsMeter ?? { cursors: [], paused: true };
(globalThis as unknown as { rowsMeter: Meter }).rowsMeter = meter;

/** The table a statement writes to: what Durable Objects bill it under, with its index rows. */
function writesTo(query: unknown): string | null {
  const match = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i.exec(
    String(query),
  );
  return match?.[1] ?? null;
}

/**
 * Counts what every query of the Channel's SqlStorage reads and writes from now on.
 * The test and the Durable Object share one isolate, so the cursors land in `meter`.
 */
async function meterChannel(): Promise<void> {
  await runInDurableObject(channelStub(), (_channel, state) => {
    const sql = state.storage.sql as unknown as { exec: (...args: unknown[]) => Cursor };
    const exec = sql.exec.bind(sql);
    sql.exec = (...args: unknown[]) => {
      const cursor = exec(...args);
      if (!meter.paused) meter.cursors.push({ cursor, table: writesTo(args[0]) });
      return cursor;
    };
  });
}

/** Waits until `check` holds. */
async function settled(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** What a piece of work cost: rows read, and rows written to each table. */
interface Rows {
  read: number;
  written: number;
  writtenTo: Record<string, number>;
}

/** Rows read and written by everything `work` makes the Channel do, its background work included once `until` holds. */
async function rows(work: () => Promise<unknown>, until?: () => Promise<boolean>): Promise<Rows> {
  meter.cursors = [];
  meter.paused = false;
  await work();
  // `until` reads without being counted (see `unmetered`), so the background work it waits for still is.
  if (until !== undefined) await settled(until);
  meter.paused = true;
  const writtenTo: Record<string, number> = {};
  for (const { cursor, table } of meter.cursors) {
    if (cursor.rowsWritten > 0) writtenTo[table ?? "other"] = (writtenTo[table ?? "other"] ?? 0) + cursor.rowsWritten;
  }
  return {
    read: meter.cursors.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
    written: meter.cursors.reduce((sum, { cursor }) => sum + cursor.rowsWritten, 0),
    writtenTo,
  };
}

/** Rows read by everything `work` makes the Channel do, its background work included once `until` holds. */
async function rowsRead(work: () => Promise<unknown>, until?: () => Promise<boolean>): Promise<number> {
  return (await rows(work, until)).read;
}

function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(url(path), init));
}

let nextId = 0;
function hook(type: HookEvent["type"], payload: unknown): HookEvent {
  nextId += 1;
  return { id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`, type, payload } as HookEvent;
}

async function register(sessionId: string): Promise<AgentId> {
  const response = await call("/api/agents", {
    method: "POST",
    headers: { Authorization: await bearer("shlok") },
    body: JSON.stringify({ cli: "claude-code", sessionId, resumed: false, cwd: "/repo" }),
  });
  expect(response.status).toBe(200);
  return remember(await response.json<AgentResponse>()).agent.id;
}

async function heartbeat(
  agent: AgentId,
  presence: "live" | "idle",
  reading: Omit<HeartbeatRequest, "presence"> = {},
): Promise<AgentResponse> {
  const response = await call(`${agentPath(agent)}/heartbeat`, {
    method: "POST",
    headers: { Authorization: await bearer({ person: "shlok", agent }) },
    body: JSON.stringify({ presence, ...reading }),
  });
  expect(response.status).toBe(200);
  return response.json<AgentResponse>();
}

function task(number: number, holder?: AgentId): Task {
  return {
    number,
    title: `Task ${number}`,
    description: "",
    labels: [],
    blockedBy: [],
    subtasks: [],
    subtasksDone: 0,
    steps: [],
    stepsDone: 0,
    url: `https://github.com/shlok1806/switchboard/issues/${number}`,
    status: holder === undefined ? "open" : "claimed",
    ...(holder === undefined
      ? {}
      : {
          claim: {
            task: number,
            holder: { kind: "agent", agentId: holder },
            claimedAt: new Date().toISOString(),
            stale: false,
          },
        }),
    updatedAt: new Date().toISOString(),
  };
}

/** Gives the Channel a long history: Events of every common kind, Gone Agents, and Tasks, some held. */
async function seed(live: AgentId[]): Promise<void> {
  await runInDurableObject(channelStub(), (channel, state) => {
    const sql = state.storage.sql;
    const types = ["tool.call", "command", "file.edit", "turn.end", "presence", "proxy.digest", "update"];
    let row = 0;
    const insert = (
      type: string,
      actor: { kind: string; agentId?: string; person?: string },
      task: number | null,
      payload: unknown,
    ) => {
      // An older Channel's history, from before `seq` became the time (ADR 0037): seq 1 to EVENTS.
      sql.exec(
        `INSERT INTO events (seq, id, at, type, actor, capture, task, turn, payload, actor_kind, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row + 1,
        `seed-${row}`,
        new Date(Date.now() - (EVENTS - row) * 1000).toISOString(),
        type,
        JSON.stringify(actor),
        actor.kind === "agent" && type !== "push" ? "hook" : null,
        task,
        null,
        JSON.stringify(payload),
        actor.kind,
        actor.agentId ?? actor.person ?? null,
      );
      row += 1;
    };
    for (let i = 0; i < SOURCES; i++) {
      const id = `seed-${row}`;
      const agent = (i % 2 === 0 ? `shlok/claude/g${i % GONE_AGENTS}` : live[i % live.length]) as string;
      // An Agent holding a Task tags its Events with it, as a third of them do here.
      const task = i % 3 === 0 ? (i % TASKS) + 1 : null;
      if (i % 200 === 0)
        insert("directive", { kind: "person", person: "shlok" }, task, { to: measured, text: "Rebase." });
      else if (i % 1000 === 1)
        insert("agent.rename", { kind: "person", person: "shlok" }, null, { agent: measured, nickname: `n${i}` });
      else if (i % 300 === 2) insert("wake", { kind: "relay" }, task, { agent, events: [] });
      else {
        // A few pushes, spread thin, as a busy Channel has.
        const type = i % 500 === 3 ? "push" : (types[i % types.length] as string);
        insert(type, { kind: "agent", agentId: agent }, type === "update" ? (i % TASKS) + 1 : task, {
          text: "progress",
          files: [{ path: "src/app.ts", additions: 1, deletions: 0, hunks: [] }],
        });
      }
      for (let v = 0; v < VERDICTS_PER_EVENT; v++) {
        insert("verdict", { kind: "relay" }, task, { event: id, agent: live[v], delivered: "drop", overlap: [] });
      }
    }
    const template = sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM agents LIMIT 1").one();
    const goneAt = Date.now() - 8 * 86_400_000;
    for (let k = 0; k < GONE_AGENTS; k++) {
      const row: Record<string, SqlStorageValue> = {
        ...template,
        id: `shlok/claude/g${k}`,
        session_id: `gone-${k}`,
        last_seen_at: goneAt,
        presence: "gone",
        nickname: null,
      };
      const columns = Object.keys(row);
      sql.exec(
        `INSERT INTO agents (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ...columns.map((c) => row[c]),
      );
    }
    for (const agent of live) {
      for (let f = 0; f < TOUCHED_FILES; f++) {
        sql.exec(
          `INSERT INTO touched_files (agent, path, edits, first_edited_at, last_edited_at, last_seq)
           VALUES (?, ?, 1, ?, ?, ?)`,
          agent,
          `src/file-${f}.ts`,
          new Date().toISOString(),
          new Date().toISOString(),
          f,
        );
      }
    }
    for (let n = 0; n < NOTES; n++) {
      const seq = EVENTS + 1000 + n;
      const author = n % 2 === 0 ? `shlok/claude/g${n % GONE_AGENTS}` : (live[n % live.length] as AgentId);
      const tag = (["decision", "fact", "dead-end", "question", "files"] as const)[n % 5];
      const text = `Note ${n}: progress on word${n}`;
      const note = { seq, id: `note-${n}`, at: new Date().toISOString(), author, person: "shlok", tags: [tag], text };
      sql.exec(
        "INSERT INTO memory_notes (seq, author, task, note) VALUES (?, ?, ?, ?)",
        seq,
        author,
        (n % TASKS) + 1,
        JSON.stringify(note),
      );
      sql.exec("INSERT INTO memory_tags (tag, seq) VALUES (?, ?)", tag, seq);
      sql.exec("INSERT INTO memory_fts (rowid, text, files) VALUES (?, ?, '')", seq, text);
    }
    const tasks = (channel as unknown as { tasks: { write(task: Task): void } }).tasks;
    for (let n = 1; n <= TASKS; n++) tasks.write(task(n, n % 40 === 0 ? live[n % live.length] : undefined));
    for (let n = TASKS + 1; n <= TASKS + FINISHED_TASKS; n++) {
      tasks.write({ ...task(n, live[n % live.length]), status: "done" });
    }
  });
}

let live: AgentId[];
/** The Agent whose calls are measured. */
let measured: AgentId;

beforeEach(async () => {
  installJev(new FakeJev({ drop: 0, queue: 1, interrupt: 0 }));
  live = [];
  for (const prefix of ["7f3a", "7f3b", "7f3c"]) live.push(await register(`${prefix}0000-0000-4000-8000-000000000000`));
  for (const agent of live) await heartbeat(agent, "live");
  measured = live[0] as AgentId;
  await seed(live);
  await listenForVerdicts();
  await meterChannel();
});

afterEach(async () => {
  vi.useRealTimers();
  installJev(null);
  installGitHub(null);
  forgetTokens();
  await reset();
});

/** Sends `frame` over Agent `agent`'s WebSocket, as its wrapper does, and waits for the `ack`. */
async function sendFrame(agent: AgentId, frame: Record<string, unknown>, ack: string): Promise<void> {
  const response = await call(`/api/stream?${await streamQuery({ person: "shlok", agent })}`, {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error("No WebSocket in the upgrade response");
  socket.accept();
  const acked = new Promise<void>((resolve) => {
    socket.addEventListener("message", (message) => {
      if (String(message.data).includes(`"${ack}"`)) resolve();
    });
  });
  meter.paused = false;
  socket.send(JSON.stringify(frame));
  await acked;
  socket.close();
}

/** Sends Hook Events over Agent `agent`'s WebSocket, as its wrapper does, and waits for the ack. */
function sendHooks(agent: AgentId, events: HookEvent[]): Promise<void> {
  return sendFrame(agent, { type: "hook", agent, events }, "hook.ack");
}

/**
 * Reads the Channel's storage without counting it. The read runs in one synchronous
 * turn of the Durable Object, so none of the Channel's own work lands in the pause.
 */
function unmetered<T>(read: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(channelStub(), (_channel, state) => {
    const paused = meter.paused;
    meter.paused = true;
    try {
      return read(state.storage.sql);
    } finally {
      meter.paused = paused;
    }
  });
}

/** The Events whose Verdicts the Relay broadcast, heard on a Dashboard's stream. */
const verdictsHeard = new Set<string>();

/** Opens a Dashboard's stream, which hears every Verdict the Relay gives, stored or not (ADR 0037). */
async function listenForVerdicts(): Promise<void> {
  verdictsHeard.clear();
  const response = await call(`/api/stream?${await streamQuery("shlok")}`, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new Error("No WebSocket in the upgrade response");
  socket.accept();
  socket.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data)) as { type: string; event?: ChannelEvent };
    if (frame.type === "event" && frame.event?.type === "verdict") verdictsHeard.add(frame.event.payload.event);
  });
}

/** Whether the Relay has given a Verdict about Event `id`; reads nothing. */
async function verdictsAbout(id: string): Promise<boolean> {
  return verdictsHeard.has(id);
}

it("a Hook Event reads a bounded number of rows", async () => {
  const read = await rowsRead(async () => {
    meter.paused = true;
    await sendHooks(measured, [hook("tool.call", { tool: "Bash", arg: "npm test", ok: true })]);
  });
  expect(read).toBeLessThan(BUDGET);
});

it("a heartbeat that changes Presence reads a bounded number of rows", async () => {
  expect(await rowsRead(() => heartbeat(measured, "idle"))).toBeLessThan(BUDGET);
});

it("an edit the Relay considers for every live Agent reads a bounded number of rows", async () => {
  // The first Event the Relay considers after the Channel wakes reads each Agent's touched files once.
  const first = hook("file.edit", { path: "src/app.ts", additions: 1, deletions: 0 });
  await sendHooks(measured, [first]);
  await settled(() => verdictsAbout(first.id));
  // Another Agent edits meanwhile, as they do.
  await sendHooks(live[1] as AgentId, [hook("file.edit", { path: "src/other.ts", additions: 1, deletions: 0 })]);
  const edit = hook("file.edit", { path: "src/app.ts", additions: 3, deletions: 1 });
  const read = await rowsRead(
    async () => {
      meter.paused = true;
      await sendHooks(measured, [edit]);
    },
    () => verdictsAbout(edit.id),
  );
  expect(read).toBeLessThan(BUDGET);
});

it("a holder's last Update is found without scanning its other Updates", async () => {
  // The slowest case: a holder with many Updates on other Tasks, none on this one, and
  // none since it claimed this one.
  const holder = live[1] as AgentId;
  const read = await rowsRead(() =>
    runInDurableObject(channelStub(), (_channel, state) => {
      const since = new Date(Date.now() + 60_000).toISOString();
      expect(lastUpdate(state.storage.sql, { kind: "agent", agentId: holder }, TASKS + 1, since)).toBeUndefined();
    }),
  );
  const updates = await runInDurableObject(channelStub(), (_channel, state) =>
    state.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM events WHERE type = 'update' AND actor_id = ?", holder)
      .one(),
  );
  expect(updates.n).toBeGreaterThan(BUDGET);
  expect(read).toBeLessThan(10);
});

it("reading the Channel's latest Events reads only those Events", async () => {
  const read = await rowsRead(async () => {
    const response = await call(`/api/events?after=${EVENTS - 50}`, {
      headers: { Authorization: await bearer("shlok") },
    });
    expect(((await response.json()) as { events: ChannelEvent[] }).events.length).toBeGreaterThan(0);
  });
  expect(read).toBeLessThan(BUDGET);
});

it("paging back through older Events reads only that page", async () => {
  const auth = { Authorization: await bearer("shlok") };
  const read = await rowsRead(async () => {
    const response = await call("/api/events?tail=100&before=5001", { headers: auth });
    const { events } = (await response.json()) as { events: ChannelEvent[] };
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => 4901 + i));
  });
  expect(read).toBeLessThan(BUDGET);
});

async function memory(query: string, agent?: AgentId): Promise<MemoryNote[]> {
  const response = await call(`/api/memory${query}`, {
    headers: { Authorization: await bearer(agent === undefined ? "shlok" : { person: "shlok", agent }) },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as MemoryResponse).notes;
}

it("writing a note reads a bounded number of rows", async () => {
  const read = await rowsRead(async () => {
    const response = await call("/api/memory", {
      method: "POST",
      headers: { Authorization: await bearer({ person: "shlok", agent: measured }) },
      body: JSON.stringify({ text: "The cache key includes the tenant.", tags: ["decision"] }),
    });
    expect(response.status).toBe(201);
  });
  expect(read).toBeLessThan(BUDGET);
});

it("reading notes, latest or narrowed or caught up, reads only the notes it answers with", async () => {
  const author = live[1] as AgentId;
  // Task 7's notes are all facts, among the Channel's hundreds of facts.
  const queries = ["", "?tag=question", `?author=${encodeURIComponent(author)}`, "?task=7", "?task=7&tag=fact"];
  for (const query of [...queries, `?after=${EVENTS}`]) {
    const read = await rowsRead(async () => {
      expect((await memory(`${query}${query === "" ? "?" : "&"}limit=50`, measured)).length).toBeGreaterThan(0);
    });
    expect(read, query).toBeLessThan(BUDGET);
  }
});

it("searching notes reads a bounded number of rows, for a word one note has or every note has", async () => {
  const one = await rowsRead(async () => {
    expect((await memory("?q=word1234")).map((n) => n.text)).toEqual(["Note 1234: progress on word1234"]);
  });
  expect(one).toBeLessThan(BUDGET);
  const every = await rowsRead(async () => {
    expect(await memory("?q=progress&limit=5")).toHaveLength(5);
  });
  expect(every).toBeLessThan(BUDGET);
});

it("an Agent's or a Task's latest Events read only that page", async () => {
  const auth = { Authorization: await bearer("shlok") };
  const read = await rowsRead(async () => {
    const mine = await call(`/api/events?tail=100&agent=${encodeURIComponent(measured)}`, { headers: auth });
    const { events } = (await mine.json()) as { events: ChannelEvent[] };
    expect(events).toHaveLength(100);
    // Its own Events, the Directives to it and its renames by others; none of the Relay's Verdicts.
    expect(
      events.every(
        (e) =>
          (e.actor.kind === "agent" && e.actor.agentId === measured) ||
          (e.type === "directive" && (e.payload as { to: string }).to === measured) ||
          (e.type === "agent.rename" && (e.payload as { agent: string }).agent === measured),
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "directive")).toBe(true);
  });
  // Three index reads of at most a page each.
  expect(read).toBeLessThan(3 * 100 + 10);
  const onTask = await rowsRead(async () => {
    const response = await call("/api/events?tail=20&task=7", { headers: auth });
    const { events } = (await response.json()) as { events: ChannelEvent[] };
    expect(events).toHaveLength(20);
    expect(events.every((e) => e.task === 7 && e.type !== "verdict")).toBe(true);
  });
  // Only the page: the index skips the Task's Verdicts, two for each of its Events.
  expect(onTask).toBeLessThan(30);
});

it("Events by ID and the Wakes after an Event read only what they return", async () => {
  const auth = { Authorization: await bearer("shlok") };
  const byId = await rowsRead(async () => {
    const response = await call("/api/events?ids=seed-10,seed-20,seed-30", { headers: auth });
    expect(((await response.json()) as { events: ChannelEvent[] }).events).toHaveLength(3);
  });
  expect(byId).toBeLessThan(20);
  const wakes = await rowsRead(async () => {
    const response = await call("/api/events?type=wake&after=100&limit=20", { headers: auth });
    const { events } = (await response.json()) as { events: ChannelEvent[] };
    expect(events).toHaveLength(20);
    expect(events.every((e) => e.type === "wake")).toBe(true);
  });
  expect(wakes).toBeLessThan(25);
});

/** The rows one `channel` call of the read-only connector may read (ADR 0040). */
const ASK_BUDGET = 400;

it("the connector's channel tool reads a bounded number of rows, plain or narrowed", async () => {
  const endpoint = `${BASE}/r/${REPO}/mcp`;
  // A signed-in app's grant, which each call checks is still live.
  await runInDurableObject(channelStub(), (channel: Channel) => {
    channel.startMcpGrant("rows-read-grant", "shlok", "rows-read-client", Date.now() + 86_400_000);
  });
  const token = await signAccess(SESSION_SECRET, "shlok", REPO, "rows-read-grant", endpoint);
  const ask = async (args: Record<string, string>) => {
    const response = await call(`/r/${REPO}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "channel", arguments: args },
      }),
    });
    const { result } = (await response.json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(result.isError, JSON.stringify(args)).toBe(false);
    return result.content[0]?.text ?? "";
  };
  // A Channel's Tasks are mostly open Issues nobody holds: far more than the seed's.
  await runInDurableObject(channelStub(), (channel) => {
    const tasks = (channel as unknown as { tasks: { write(task: Task): void } }).tasks;
    for (let n = TASKS + 1; n <= TASKS + 2000; n++) tasks.write(task(n));
  });
  // Membership is checked, and cached, by a first call, as by any caller's.
  await ask({});
  const cases: [Record<string, string>, string][] = [
    [{}, "Update"],
    [{ since: "30d" }, "Update"],
    [{ about: "#40" }, "Task #40"],
    [{ about: measured }, measured],
    [{ about: "shlok" }, "the Person shlok"],
    [{ about: "progress" }, "progress"],
  ];
  for (const [args, mentions] of cases) {
    const read = await rowsRead(async () => expect(await ask(args)).toContain(mentions));
    expect(read, JSON.stringify(args)).toBeLessThan(ASK_BUDGET);
  }
});

it("the connector's github tool reads only what admitting the call reads: GitHub answers it", async () => {
  const endpoint = `${BASE}/r/${REPO}/mcp`;
  const api = new FakeGitHubApi();
  api.listen();
  installGitHubApp(await api.app());
  api.files.set("docs/adr/0040-ask-the-channel.md", "# Ask the Channel\n");
  api.issues.push({ number: 1, title: "Task 1", author: "shlok", createdAt: new Date().toISOString() });
  try {
    await runInDurableObject(channelStub(), (channel: Channel) => {
      channel.startMcpGrant("rows-read-github", "shlok", "rows-read-client", Date.now() + 86_400_000);
    });
    const token = await signAccess(SESSION_SECRET, "shlok", REPO, "rows-read-github", endpoint);
    const send = async (message: Record<string, unknown>) => {
      const response = await call(`/r/${REPO}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
      });
      return (await response.json()) as { result: { isError?: boolean } };
    };
    const ask = async (args: Record<string, string>) => {
      const { result } = await send({ method: "tools/call", params: { name: "github", arguments: args } });
      expect(result.isError, JSON.stringify(args)).toBe(false);
    };
    // Membership is checked, and cached, by a first call, as by any caller's.
    await ask({});
    // What every call reads to be let in: its grant and its Person's Membership, by key.
    const admitting = await rowsRead(() => send({ method: "ping" }));
    expect(admitting).toBeLessThan(10);
    const questions: Record<string, string>[] = [
      {},
      { about: "#1" },
      { about: "docs/adr" },
      { about: "ask the channel" },
    ];
    for (const args of questions) {
      expect(await rowsRead(() => ask(args)), JSON.stringify(args)).toBe(admitting);
    }
  } finally {
    installGitHubApp(null);
    vi.restoreAllMocks();
  }
});

it("the connector's brief tool reads one row per page for the overview, and one for an area (ADR 0042)", async () => {
  const endpoint = `${BASE}/r/${REPO}/mcp`;
  // A full Brief, every page with its kept earlier versions.
  await runInDurableObject(channelStub(), (channel: Channel, state) => {
    channel.startMcpGrant("rows-read-brief", "shlok", "rows-read-client", Date.now() + 86_400_000);
    const author = JSON.stringify({ agent: measured, person: "shlok" });
    const at = new Date().toISOString();
    const pages = ["overview", "stuck", ...Array.from({ length: MAX_BRIEF_PAGES - 2 }, (_, n) => `area-${n}`)];
    for (const page of pages) {
      const text = `# ${page}\n\n${"Where it stands, with #12 and ADR 0040. ".repeat(150)}`;
      const earlier = Array.from({ length: BRIEF_HISTORY }, (_, n) => ({
        page,
        title: page,
        version: BRIEF_HISTORY - n,
        text,
        author: JSON.parse(author),
        updatedAt: at,
      }));
      state.storage.sql.exec(
        "INSERT INTO brief_pages (page, title, version, text, author, updated_at, earlier) VALUES (?, ?, ?, ?, ?, ?, ?)",
        page,
        page,
        BRIEF_HISTORY + 1,
        text,
        author,
        at,
        JSON.stringify(earlier),
      );
    }
  });
  const token = await signAccess(SESSION_SECRET, "shlok", REPO, "rows-read-brief", endpoint);
  const send = async (message: Record<string, unknown>) => {
    const response = await call(`/r/${REPO}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
    });
    return (await response.json()) as { result: { isError?: boolean; content?: { text: string }[] } };
  };
  const ask = async (args: Record<string, string>) => {
    const { result } = await send({ method: "tools/call", params: { name: "brief", arguments: args } });
    expect(result.isError, JSON.stringify(args)).toBe(false);
    return result.content?.[0]?.text ?? "";
  };
  // Membership is checked, and cached, by a first call, as by any caller's.
  await ask({});
  const admitting = await rowsRead(() => send({ method: "ping" }));
  expect(await rowsRead(async () => expect(await ask({})).toContain('"area-21"'))).toBe(admitting + MAX_BRIEF_PAGES);
  expect(await rowsRead(async () => expect(await ask({ area: "area-3" })).toContain("## area-3"))).toBe(admitting + 1);
  // The Dashboard's read of every page reads each page's row once.
  const dashboard = await rowsRead(async () => {
    const response = await call("/api/brief", { headers: { Authorization: await bearer("shlok") } });
    expect(response.status).toBe(200);
  });
  expect(dashboard).toBeLessThan(MAX_BRIEF_PAGES + 10);
});

it("the connector's costs tool reads the Channel's one Langfuse row besides what admits the call (ADR 0044)", async () => {
  const endpoint = `${BASE}/r/${REPO}/mcp`;
  const langfuse = new FakeLangfuse();
  langfuse.listen();
  langfuse.observations.push({
    type: "GENERATION",
    traceName: "verifier turn",
    model: "claude-opus-4-1",
    environment: "production",
    startTime: new Date(Date.now() - 86_400_000).toISOString(),
    latencyMs: 3_000,
    cost: 0.5,
  });
  try {
    const secretSealed = await sealSecretKey(SESSION_SECRET, REPO, SECRET_KEY);
    await runInDurableObject(channelStub(), (channel: Channel) => {
      channel.startMcpGrant("rows-read-costs", "shlok", "rows-read-client", Date.now() + 86_400_000);
      channel.setLangfuseProject({
        host: LANGFUSE_HOST,
        publicKey: PUBLIC_KEY,
        secretSealed,
        project: PROJECT,
        connectedBy: "shlok",
        connectedAt: new Date().toISOString(),
      });
    });
    const token = await signAccess(SESSION_SECRET, "shlok", REPO, "rows-read-costs", endpoint);
    const send = async (message: Record<string, unknown>) => {
      const response = await call(`/r/${REPO}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
      });
      return (await response.json()) as { result: { isError?: boolean; content?: { text: string }[] } };
    };
    const ask = async (args: Record<string, string>) => {
      const { result } = await send({ method: "tools/call", params: { name: "costs", arguments: args } });
      expect(result.isError, JSON.stringify(args)).toBe(false);
      expect(result.content?.[0]?.text).toContain("$0.50");
    };
    // Membership is checked, and cached, by a first call, as by any caller's.
    await ask({});
    const admitting = await rowsRead(() => send({ method: "ping" }));
    for (const args of [{}, { by: "trace" }, { by: "day", period: "7d" }] as Record<string, string>[]) {
      expect(await rowsRead(() => ask(args)), JSON.stringify(args)).toBe(admitting + 1);
    }
  } finally {
    vi.restoreAllMocks();
  }
});

/** What starting the Channel's Durable Object again reads, as after an eviction or a deploy. */
function restart(): Promise<number> {
  return rowsRead(() =>
    runInDurableObject(channelStub(), (_channel, state) => {
      new Channel(state, env);
    }),
  );
}

it("a Durable Object that starts again reads a bounded number of rows, its history indexes built or not", async () => {
  expect(await restart()).toBeLessThan(BUDGET);
  // An index still missing is counted once a day, by the first start: not by every start.
  await runInDurableObject(channelStub(), (_channel, state) => {
    state.storage.sql.exec("DROP INDEX events_by_agent");
    state.storage.sql.exec("DELETE FROM index_builds");
    state.storage.sql.exec(
      "INSERT INTO index_builds (day, rows) VALUES (?, ?)",
      new Date().toISOString().slice(0, 10),
      25_000,
    );
  });
  expect(await restart()).toBeGreaterThan(EVENTS);
  expect(await restart()).toBeLessThan(BUDGET);
});

/** What the wrapper reads of its session (ADR 0012), stamped when it read it, as it is every heartbeat. */
function context(): AgentContext {
  return {
    readAt: new Date().toISOString(),
    tokens: 120_000,
    window: 1_000_000,
    task: "Add retries",
    activity: "Tool: Edit",
    cwd: "/repo",
  };
}

/** A Codex account's limits as its wrapper reads them from the session, the same reading until the next turn. */
const CODEX_USAGE = {
  accountId: "Codex · shlok · work",
  plan: "plus",
  limits: {
    readAt: new Date(Date.now() - 60_000).toISOString(),
    session: { percent: 32, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    week: { percent: 51, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
    models: [],
  },
} satisfies ReportedUsage;

const ACCOUNTS = [CODEX_USAGE.accountId, "shlokthakkar1806@gmail.com"];

/** The day of readings before CODEX_USAGE for each account, one every heartbeat, each saying something new. */
async function seedReadings(): Promise<void> {
  await runInDurableObject(channelStub(), (_channel, state) => {
    const latest = Date.parse(CODEX_USAGE.limits.readAt);
    for (const account of ACCOUNTS) {
      for (let i = 1; i < 2880; i++) {
        const at = latest - i * 30_000;
        const limits = { ...CODEX_USAGE.limits, readAt: new Date(at).toISOString(), session: { percent: i % 100 } };
        state.storage.sql.exec(
          "INSERT INTO account_usage (email, read_at, plan, limits) VALUES (?, ?, ?, ?)",
          account,
          at,
          "plus",
          JSON.stringify(limits),
        );
      }
    }
  });
}

it("a heartbeat that changes nothing writes no row, the quietest Agent's included", async () => {
  await heartbeat(measured, "live", { context: context() });
  // The same context with a newer stamp, as a wrapper sends it.
  expect((await rows(() => heartbeat(measured, "live", { context: context() }))).written).toBe(0);
  // The Agent heard from longest ago: its heartbeat does not move the silence check later.
  expect((await rows(() => heartbeat(live[1] as AgentId, "live"))).written).toBe(0);
});

it("a Hook Event's or a Proxy Event's sign of life writes no Agent row", async () => {
  const hooked = await rows(async () => {
    meter.paused = true;
    await sendHooks(measured, [hook("tool.call", { tool: "Bash", arg: "npm test", ok: true })]);
  });
  expect(hooked.writtenTo.agents ?? 0).toBe(0);
  const turn = hook("tool.call", {});
  const proxied = await rows(async () => {
    meter.paused = true;
    await sendFrame(
      measured,
      {
        type: "proxy",
        agent: measured,
        event: {
          id: turn.id,
          type: "proxy.digest",
          payload: {
            model: "gpt-5.5-codex",
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            reply: "Done.",
            toolCalls: [],
            maskedSecrets: 0,
          },
        },
      },
      "proxy.ack",
    );
  });
  expect(proxied.writtenTo.agents ?? 0).toBe(0);
});

it("a Codex heartbeat writes nothing for a usage reading the Channel has, and reads a bounded number of rows", async () => {
  await seedReadings();
  await heartbeat(measured, "live", { context: context(), usage: CODEX_USAGE });
  const again = await rows(() => heartbeat(measured, "live", { context: context(), usage: CODEX_USAGE }));
  expect(again.written).toBe(0);
  expect(again.read).toBeLessThan(BUDGET);

  const next = { ...CODEX_USAGE, limits: { ...CODEX_USAGE.limits, readAt: new Date().toISOString() } };
  // A new reading of the same limits is not one more row in the account's history either.
  expect(
    (await rows(() => heartbeat(measured, "live", { context: context(), usage: next }))).writtenTo.account_usage ?? 0,
  ).toBe(0);
  const moved = { ...next, limits: { ...next.limits, session: { percent: 40 } } };
  const changed = await rows(() => heartbeat(measured, "live", { context: context(), usage: moved }));
  expect(changed.writtenTo.account_usage).toBeGreaterThan(0);
  expect(changed.read).toBeLessThan(BUDGET);
});

it("serving every account reads a bounded number of rows, after a day of readings", async () => {
  await seedReadings();
  const read = await rowsRead(async () => {
    const response = await call("/api/accounts", { headers: { Authorization: await bearer("shlok") } });
    const { accounts } = await response.json<AccountsResponse>();
    expect(accounts.map((a) => a.email).sort()).toEqual([...ACCOUNTS].sort());
    for (const account of accounts) {
      expect(account.history).toHaveLength(MAX_ACCOUNT_HISTORY);
      expect(account.history.at(-1)?.at).toBe(account.limits.readAt);
    }
  });
  expect(read).toBeLessThan(BUDGET);
});

it("an idle Task reconcile reads and writes a bounded number of rows", async () => {
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  const github = new FakeGitHub();
  for (let n = 1; n <= TASKS; n++) github.open({ title: `Task ${n}` });
  installGitHub(github);
  // Listing the Tasks runs the first reconcile, which brings the seeded Tasks in line with GitHub;
  // the next one finds nothing to change.
  expect((await call("/api/tasks", { headers: { Authorization: await bearer("shlok") } })).status).toBe(200);
  vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
  await runDurableObjectAlarm(channelStub());
  // The Agents stay Live meanwhile, so none goes Gone and leaves its Claim Stale.
  for (const agent of live) await heartbeat(agent, "live");
  vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
  const idle = await rows(() => runDurableObjectAlarm(channelStub()));
  expect(idle.read).toBeLessThan(BUDGET);
  expect(idle.writtenTo.tasks ?? 0).toBe(0);
  expect(idle.writtenTo.task_sync ?? 0).toBe(0);

  // A missed change is still found, on the same schedule.
  github.edit(7, { title: "Task 7, renamed on GitHub" });
  vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
  await runDurableObjectAlarm(channelStub());
  const response = await call("/api/tasks/7", { headers: { Authorization: await bearer("shlok") } });
  expect((await response.json<TaskResponse>()).task.title).toBe("Task 7, renamed on GitHub");
});

it("a member re-check that finds the same answer asks GitHub, and writes no members row", async () => {
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  const github = new FakeGitHub();
  installGitHub(github);
  // An open stream has its Person's access re-checked every 5 minutes.
  const response = await call(`/api/stream?${await streamQuery("shlok")}`, { headers: { Upgrade: "websocket" } });
  response.webSocket?.accept();
  const checks = github.permissionChecks;
  vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
  const recheck = await rows(() => runDurableObjectAlarm(channelStub()));
  expect(github.permissionChecks).toBe(checks + 1);
  expect(recheck.writtenTo.members ?? 0).toBe(0);
  response.webSocket?.close();
});

/** What `work` cost, with the Relay's Verdicts about the Event it returns the ID of, and how many Events it stored. */
async function relayed(work: () => Promise<string>): Promise<Rows & { events: number }> {
  // `seq` is a time (ADR 0037), so count the Events stored after the last one.
  const last = () => unmetered((sql) => sql.exec<{ seq: number }>("SELECT max(seq) AS seq FROM events").one().seq);
  const before = await last();
  const since = () =>
    unmetered((sql) => sql.exec<{ n: number }>("SELECT count(*) AS n FROM events WHERE seq > ?", before).one().n);
  let id = "";
  const cost = await rows(
    async () => {
      id = await work();
    },
    () => verdictsAbout(id),
  );
  return { ...cost, events: await since() };
}

it("an Update that overlaps no other Agent writes itself and one verdict row, however many Agents it Drops, and a file edit neither", async () => {
  const edit = () =>
    relayed(async () => {
      const event = hook("file.edit", { path: `src/solo-${nextId}.ts`, additions: 1, deletions: 0 });
      meter.paused = true;
      await sendHooks(measured, [event]);
      return event.id;
    });
  const update = () =>
    relayed(async () => {
      const response = await call("/api/updates", {
        method: "POST",
        headers: { Authorization: await bearer({ person: "shlok", agent: measured }) },
        body: JSON.stringify({ text: "Tidying the README" }),
      });
      return (await response.json<PostUpdateResponse>()).event.id;
    });
  const two = { edit: await edit(), update: await update() };
  for (const prefix of ["7f3d", "7f3e"])
    await heartbeat(await register(`${prefix}0000-0000-4000-8000-000000000000`), "live");
  const four = { edit: await edit(), update: await update() };

  // A file edit and its rule Drops are Local Events, kept on the Agent's machine (ADR 0037).
  expect(two.edit.events).toBe(0);
  expect(four.edit.events).toBe(0);
  expect(four.edit.writtenTo.events ?? 0).toBe(0);
  // The Update, and one verdict Event naming the 4 Agents it Dropped by rule.
  expect(four.update.events).toBe(2);
  // Each with its own index rows, as many as with 2 other Agents: nothing is written per Agent.
  expect(four.update.writtenTo.events).toBe(two.update.writtenTo.events);
  const dropped = await unmetered((sql) =>
    sql
      .exec<{ payload: string }>("SELECT payload FROM events WHERE type = 'verdict' ORDER BY seq DESC LIMIT 1")
      .toArray()
      .map((row) => (JSON.parse(row.payload) as { agents?: AgentId[] }).agents),
  );
  expect(dropped[0]).toHaveLength(4);
});

it("retention listings and stream open read bounded rows", async () => {
  const auth = { Authorization: await bearer("shlok") };
  for (const path of ["/api/agents"]) {
    const cost = await rows(async () => {
      expect((await call(path, { headers: auth })).status).toBe(200);
    });
    expect(cost.read, path).toBeLessThan(BUDGET);
    expect(cost.written, path).toBeLessThan(BUDGET);
  }
  const cost = await rows(async () => {
    const response = await call(`/api/stream?${await streamQuery("shlok")}`, { headers: { Upgrade: "websocket" } });
    response.webSocket?.accept();
    response.webSocket?.close();
  });
  expect(cost.read).toBeLessThan(BUDGET);
  expect(cost.written).toBeLessThan(BUDGET);
});

it("one retention alarm pass has bounded row costs", async () => {
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  await unmetered((sql) => {
    sql.exec("DELETE FROM alarm_deadlines");
    sql.exec("INSERT INTO alarm_deadlines VALUES ('retention', 0)");
  });
  const cost = await rows(() => runDurableObjectAlarm(channelStub()));
  expect(cost.read).toBeLessThan(400);
  expect(cost.written).toBeLessThan(400);
  expect(
    await unmetered(
      (sql) => sql.exec<{ n: number }>("SELECT count(*) AS n FROM agents WHERE presence = 'gone'").one().n,
    ),
  ).toBe(GONE_AGENTS - 10);
  expect(
    await unmetered(
      (sql) => sql.exec<{ at: number }>("SELECT at FROM alarm_deadlines WHERE job = 'retention'").one().at,
    ),
  ).toBe(Date.now() + 60_000);
  vi.setSystemTime(Date.now() + 60_000);
  const followup = await rows(() => runDurableObjectAlarm(channelStub()));
  expect(followup.read).toBeLessThan(400);
  expect(followup.written).toBeLessThan(400);
  expect(
    await unmetered(
      (sql) => sql.exec<{ n: number }>("SELECT count(*) AS n FROM agents WHERE presence = 'gone'").one().n,
    ),
  ).toBe(GONE_AGENTS - 20);

  // A late page must seek through the index, rather than reading past all earlier rows.
  await unmetered((sql) => {
    const cursor = sql
      .exec<{ seen: number; id: string }>(`
      SELECT COALESCE(gone_at, last_seen_at) AS seen, id FROM agents
      WHERE presence = 'gone' ORDER BY COALESCE(gone_at, last_seen_at) DESC, id DESC LIMIT 1 OFFSET 20
    `)
      .one();
    sql.exec("INSERT OR REPLACE INTO agent_prune_cursor VALUES (1, ?, ?)", cursor.seen, cursor.id);
    sql.exec("INSERT OR REPLACE INTO alarm_deadlines VALUES ('retention', 0)");
  });
  const late = await rows(() => runDurableObjectAlarm(channelStub()));
  expect(late.read).toBeLessThan(400);
  expect(late.written).toBeLessThan(400);
});

it("retention keeps Claims, recent Agents and referenced hand-offs, and leaves pruned Events", async () => {
  const held = "shlok/claude/g0" as AgentId;
  const recent = "shlok/claude/g1" as AgentId;
  const predecessor = "shlok/claude/g10" as AgentId;
  const removed = "shlok/claude/g4" as AgentId;
  const lead = "shlok/claude/g5" as AgentId;
  const parent = "shlok/claude/g6" as AgentId;
  await runInDurableObject(channelStub(), (channel, state) => {
    const sql = state.storage.sql;
    // Put every protected row and the cleanup candidate inside the first batch.
    for (const id of [held, predecessor, removed, lead, parent])
      sql.exec("UPDATE agents SET last_seen_at = 1 WHERE id = ?", id);
    sql.exec("UPDATE tasks SET holder_agent = ? WHERE number = 1", held);
    sql.exec("UPDATE agents SET last_seen_at = ? WHERE id = ?", Date.now(), recent);
    sql.exec("UPDATE agents SET continues = ?, parent = ? WHERE id = ?", predecessor, parent, measured);
    sql.exec("UPDATE agents SET role = 'lead' WHERE id = ?", lead);
    sql.exec("INSERT INTO touched_files VALUES (?, 'old.ts', 1, 'now', 'now', 1)", removed);
    expect(channel.touchedFiles(removed)).toHaveLength(1);
    sql.exec("INSERT INTO agent_tokens (hash, agent, person, issued_at) VALUES ('expired', ?, 'shlok', 0)", removed);
    sql.exec("DELETE FROM alarm_deadlines");
    sql.exec("INSERT INTO alarm_deadlines VALUES ('retention', 0)");
  });
  await runDurableObjectAlarm(channelStub());
  await runInDurableObject(channelStub(), (channel, state) => {
    const sql = state.storage.sql;
    for (const id of [held, recent, predecessor, lead, parent])
      expect(sql.exec("SELECT id FROM agents WHERE id = ?", id).toArray()).toHaveLength(1);
    expect(channel.touchedFiles(removed)).toBeNull();
    expect(sql.exec("SELECT * FROM touched_files WHERE agent = ?", removed).toArray()).toHaveLength(0);
    expect(sql.exec("SELECT * FROM agent_tokens WHERE agent = ?", removed).toArray()).toHaveLength(0);
  });
  const auth = { Authorization: await bearer("shlok") };
  const history = await call(`/api/events?agent=${encodeURIComponent(removed)}&tail=20`, { headers: auth });
  expect((await history.json<{ events: ChannelEvent[] }>()).events.length).toBeGreaterThan(0);
  const successor = await call("/api/agents", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      cli: "claude-code",
      sessionId: "abcd0000-0000-4000-8000-000000000000",
      resumed: false,
      cwd: "/repo",
      continues: predecessor,
    }),
  });
  expect(successor.status).toBe(200);
  expect((await successor.json<AgentResponse>()).agent.continues).toBe(predecessor);
});

it("historical lookup includes every retained Gone Agent", async () => {
  const cost = await rows(async () => {
    const response = await call("/api/agents?include=gone", { headers: { Authorization: await bearer("shlok") } });
    expect((await response.json<{ agents: unknown[] }>()).agents).toHaveLength(GONE_AGENTS + live.length);
  });
  expect(cost.read).toBeGreaterThanOrEqual(GONE_AGENTS);
  expect(cost.written).toBe(0);
});

it("an idle Channel with only recent Gone Agents schedules no retention alarm within a day, including restarts", async () => {
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  const started = Date.now();
  await unmetered((sql) => {
    sql.exec("UPDATE agents SET gone_at = ? WHERE presence = 'gone'", started);
    sql.exec("DELETE FROM alarm_deadlines");
    sql.exec("DELETE FROM channel_meta WHERE key = 'retention_started'");
  });
  const bootstrap = await rows(() =>
    runInDurableObject(channelStub(), (_channel, state) => {
      new Channel(state, env);
    }),
  );
  expect(bootstrap.read).toBeLessThan(BUDGET);
  expect(bootstrap.written).toBeLessThan(20);
  const deadline = started + 7 * 86_400_000;
  expect(
    await unmetered(
      (sql) => sql.exec<{ at: number }>("SELECT at FROM alarm_deadlines WHERE job = 'retention'").one().at,
    ),
  ).toBe(deadline);
  for (let hour = 1; hour <= 24; hour++) {
    vi.setSystemTime(started + hour * 3_600_000);
    // No alarm fires in production before this deadline. The test helper would
    // force an early alarm, so inspect the actual scheduled alarm instead.
    const idle = await rows(() =>
      runInDurableObject(channelStub(), async (_channel, state) => {
        expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      }),
    );
    expect(idle.read).toBe(0);
    expect(idle.written).toBe(0);
  }
  const restarted = await rows(() =>
    runInDurableObject(channelStub(), (_channel, state) => {
      new Channel(state, env);
    }),
  );
  expect(restarted.read).toBeLessThan(BUDGET);
  expect(restarted.writtenTo.alarm_deadlines ?? 0).toBe(0);
  expect(
    await unmetered(
      (sql) => sql.exec<{ at: number }>("SELECT at FROM alarm_deadlines WHERE job = 'retention'").one().at,
    ),
  ).toBe(deadline);
});

it("retention clears with no Gone Agents and going Gone schedules it again", async () => {
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  await unmetered((sql) => {
    sql.exec("DELETE FROM agents WHERE presence = 'gone'");
    sql.exec("DELETE FROM alarm_deadlines");
    sql.exec("INSERT INTO alarm_deadlines VALUES ('retention', 0)");
  });
  const empty = await rows(() => runDurableObjectAlarm(channelStub()));
  expect(empty.read).toBeLessThan(BUDGET);
  expect(empty.written).toBeLessThan(20);
  await runInDurableObject(channelStub(), async (_channel, state) => {
    expect(await state.storage.getAlarm()).toBeNull();
  });
  const restarted = await rows(() =>
    runInDurableObject(channelStub(), (_channel, state) => {
      new Channel(state, env);
    }),
  );
  expect(restarted.read).toBeLessThan(BUDGET);
  expect(restarted.writtenTo.alarm_deadlines ?? 0).toBe(0);
  await runInDurableObject(channelStub(), async (_channel, state) => {
    expect(await state.storage.getAlarm()).toBeNull();
  });
  expect(
    (
      await call(`${agentPath(measured)}/end`, {
        method: "POST",
        headers: { Authorization: await bearer("shlok") },
        body: "{}",
      })
    ).status,
  ).toBe(200);
  const scheduled = await unmetered(
    (sql) => sql.exec<{ at: number }>("SELECT at FROM alarm_deadlines WHERE job = 'retention'").one().at,
  );
  expect(scheduled).toBe(Date.now() + 7 * 86_400_000);
});

it("a short retention pass waits at least six hours for the next expiry", async () => {
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  await unmetered((sql) => {
    sql.exec("DELETE FROM agents WHERE presence = 'gone' AND id != 'shlok/claude/g0' AND id != 'shlok/claude/g1'");
    sql.exec("UPDATE agents SET role = 'lead' WHERE id = 'shlok/claude/g0'");
    sql.exec("UPDATE agents SET gone_at = ? WHERE id = 'shlok/claude/g1'", Date.now() - 7 * 86_400_000 + 3_600_000);
    sql.exec("DELETE FROM alarm_deadlines");
    sql.exec("INSERT INTO alarm_deadlines VALUES ('retention', 0)");
  });
  const cost = await rows(() => runDurableObjectAlarm(channelStub()));
  expect(cost.read).toBeLessThan(BUDGET);
  expect(cost.written).toBeLessThan(20);
  expect(
    await unmetered(
      (sql) => sql.exec<{ at: number }>("SELECT at FROM alarm_deadlines WHERE job = 'retention'").one().at,
    ),
  ).toBe(Date.now() + 6 * 3_600_000);
});

/** Lost Claims waiting for Agents that never came back, as Takeovers of Gone Agents' Claims leave them. */
const LOST_CLAIMS = 5000;

it("a heartbeat hands over the Agent's lost Claims, reading only its own among thousands", async () => {
  await unmetered((sql) => {
    const lose = (n: number, agent: string) =>
      sql.exec(
        "INSERT INTO lost_claims (event, agent, seq, data) VALUES (?, ?, ?, ?)",
        `lost-${n}`,
        agent,
        n,
        JSON.stringify({ task: n, title: `Task ${n}`, by: "shlok", to: { kind: "person", person: "shlok" } }),
      );
    for (let n = 0; n < LOST_CLAIMS; n++) lose(n, `shlok/claude/g${n % GONE_AGENTS}`);
    lose(LOST_CLAIMS + 1, measured);
    lose(LOST_CLAIMS, measured);
  });
  let answer: AgentResponse | undefined;
  const read = await rowsRead(async () => {
    answer = await heartbeat(measured, "live");
  });
  expect(read).toBeLessThan(BUDGET);
  expect(answer?.lostClaims?.map((claim) => claim.task)).toEqual([LOST_CLAIMS, LOST_CLAIMS + 1]);
  expect((await heartbeat(measured, "live")).lostClaims).toBeUndefined();
});

/** Opens the Dashboard's stream from `after`: what that read, and what it sent before the Agents, its replay. */
async function streamFrom(after: number): Promise<{ read: number; sent: StreamMessage[] }> {
  let response: Response | undefined;
  const read = await rowsRead(async () => {
    response = await call(`/api/stream?${await streamQuery("shlok", { after: String(after) })}`, {
      headers: { Upgrade: "websocket" },
    });
  });
  const socket = response?.webSocket;
  if (!socket) throw new Error("No WebSocket in the upgrade response");
  const sent: StreamMessage[] = [];
  socket.addEventListener("message", (message) => sent.push(JSON.parse(String(message.data)) as StreamMessage));
  socket.accept();
  await settled(async () => sent.some((m) => m.type === "agent"));
  socket.close();
  return {
    read,
    sent: sent.slice(
      0,
      sent.findIndex((m) => m.type === "agent"),
    ),
  };
}

it("a stream far behind is told to reload instead of replaying, and one a little behind replays what it missed", async () => {
  // `seq` is a time (ADR 0037): the cursor 50 Events back is the seq of the 51st newest.
  const latest = await unmetered((sql) =>
    sql
      .exec<{ seq: number }>("SELECT seq FROM events ORDER BY seq DESC LIMIT 51")
      .toArray()
      .map((row) => row.seq)
      .reverse(),
  );
  const far = await streamFrom(0);
  expect(far.read).toBeLessThan(BUDGET);
  expect(far.sent).toEqual([{ type: "reload" }]);
  const near = await streamFrom(latest[0] as number);
  expect(near.read).toBeLessThan(50 + BUDGET);
  expect(near.sent.map((m) => (m.type === "event" ? m.event.seq : m.type))).toEqual(latest.slice(1));
});

it("a Nickname is checked for a clash without reading every named Agent, and a clash is still refused", async () => {
  await runInDurableObject(channelStub(), (channel) => {
    const roster = (channel as unknown as { agents: AgentRoster }).agents;
    const by = { actor: { kind: "person" as const, person: "shlok" }, capture: null };
    for (let k = 0; k < GONE_AGENTS; k++) roster.rename(`shlok/claude/g${k}` as AgentId, `Gone-${k}`, by);
  });
  const rename = async (id: AgentId, nickname: string) =>
    call(nicknamePath(id), {
      method: "POST",
      headers: { Authorization: await bearer("shlok") },
      body: JSON.stringify({ nickname }),
    });
  const registered = await rows(async () => {
    const response = await call("/api/agents", {
      method: "POST",
      headers: { Authorization: await bearer("shlok") },
      body: JSON.stringify({
        cli: "claude-code",
        sessionId: "7f3d0000-0000-4000-8000-000000000000",
        resumed: false,
        cwd: "/repo",
        nickname: "scout",
      }),
    });
    expect((await response.json<AgentResponse>()).agent.nickname).toBe("scout");
  });
  expect(registered.read).toBeLessThan(BUDGET);
  // A Gone Agent's name is free to take, whatever its case.
  const taken = await rows(async () => expect((await rename(live[1] as AgentId, "gone-7")).status).toBe(200));
  expect(taken.read).toBeLessThan(BUDGET);
  const refused = await rows(async () => expect((await rename(live[2] as AgentId, "GONE-7")).status).toBe(409));
  expect(refused.read).toBeLessThan(BUDGET);
});

it("an Agent Summary reads a bounded number of rows, and only the files it shows however many its Agent edited", async () => {
  const summary = async () => {
    let files: string[] = [];
    const read = await rowsRead(async () => {
      const response = await call(summaryPath(measured), { headers: { Authorization: await bearer("shlok") } });
      files = (await response.json<AgentSummary>()).files;
    });
    return { read, files };
  };
  const hundred = await summary();
  await unmetered((sql) => {
    for (let f = TOUCHED_FILES; f < 1000; f++) {
      sql.exec(
        `INSERT INTO touched_files (agent, path, edits, first_edited_at, last_edited_at, last_seq)
         VALUES (?, ?, 1, ?, ?, ?)`,
        measured,
        `src/more-${f}.ts`,
        new Date().toISOString(),
        new Date().toISOString(),
        f,
      );
    }
  });
  const thousand = await summary();
  // Its Task's open questions and dead ends are looked for among that Task's notes, not every note so tagged.
  expect(hundred.read).toBeLessThan(BUDGET);
  expect(thousand.read).toBe(hundred.read);
  expect(thousand.files).toEqual(Array.from({ length: SUMMARY_MAX_FILES }, (_, i) => `src/more-${999 - i}.ts`));
});

/** The most Deliveries the Relay keeps for one Agent. */
const MAX_PENDING_DELIVERIES = 200;

it("a Queue for an Agent whose backlog is full reads a bounded number of rows, and keeps its newest", async () => {
  // Its wrapper is gone, so nothing it was Queued is taken or acknowledged.
  const waiting = live[1] as AgentId;
  await unmetered((sql) => {
    for (let i = 1; i <= MAX_PENDING_DELIVERIES; i++) {
      sql.exec(
        "INSERT INTO deliveries (id, agent, seq, data, place) VALUES (?, ?, ?, '{}', ?)",
        `queued-${i}`,
        waiting,
        i,
        i,
      );
    }
  });
  const verdicts = (id: string) =>
    unmetered(
      (sql) =>
        sql
          .exec<{ payload: string }>("SELECT payload FROM events WHERE type = 'verdict' ORDER BY seq DESC LIMIT 10")
          .toArray()
          .filter((row) => row.payload.includes(id)).length,
    );
  // The first Event the Relay considers reads each Agent's touched files once.
  const first = hook("file.edit", { path: "src/file-1.ts", additions: 1, deletions: 0 });
  await sendHooks(measured, [first]);
  await settled(async () => (await verdicts(first.id)) === 2);
  const edit = hook("file.edit", { path: "src/file-2.ts", additions: 1, deletions: 0 });
  const read = await rowsRead(
    async () => {
      meter.paused = true;
      await sendHooks(measured, [edit]);
    },
    async () => (await verdicts(edit.id)) === 2,
  );
  expect(read).toBeLessThan(BUDGET);
  const backlog = await unmetered((sql) =>
    sql
      .exec<{ n: number; oldest: number }>(
        "SELECT count(*) AS n, min(seq) AS oldest FROM deliveries WHERE agent = ?",
        waiting,
      )
      .one(),
  );
  // The two it was Queued now, and the newest of the rest.
  expect(backlog).toEqual({ n: MAX_PENDING_DELIVERIES, oldest: 3 });
});

it("retention clears a pruned Agent's queued rows, over passes that stay bounded", async () => {
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  const removed = "shlok/claude/g4" as AgentId;
  const QUEUED = 150;
  await unmetered((sql) => {
    sql.exec("DELETE FROM agents WHERE presence = 'gone' AND id != ?", removed);
    for (let i = 1; i <= QUEUED; i++) {
      sql.exec(
        "INSERT INTO deliveries (id, agent, seq, data, place) VALUES (?, ?, ?, '{}', ?)",
        `d-${i}`,
        removed,
        i,
        i,
      );
      sql.exec("INSERT INTO directive_deliveries (id, agent, seq, data) VALUES (?, ?, ?, '{}')", `dd-${i}`, removed, i);
      sql.exec("INSERT INTO lost_claims (event, agent, seq, data) VALUES (?, ?, ?, '{}')", `lc-${i}`, removed, i);
    }
    sql.exec("INSERT INTO interrupts (agent, at) VALUES (?, 0)", removed);
    sql.exec("DELETE FROM alarm_deadlines");
    sql.exec("INSERT INTO alarm_deadlines VALUES ('retention', 0)");
  });
  const kept = () =>
    unmetered((sql) =>
      ["deliveries", "directive_deliveries", "lost_claims", "interrupts"]
        .map((table) => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE agent = ?`, removed).one().n)
        .concat(sql.exec<{ n: number }>("SELECT count(*) AS n FROM agents WHERE id = ?", removed).one().n),
    );
  for (let pass = 0; pass < 20 && (await kept()).some((n) => n > 0); pass++) {
    const cost = await rows(() => runDurableObjectAlarm(channelStub()));
    expect(cost.read).toBeLessThan(400);
    expect(cost.written).toBeLessThan(400);
    // The next pass, when the Agent is still there to prune.
    const next = await unmetered(
      (sql) => sql.exec<{ at: number }>("SELECT at FROM alarm_deadlines WHERE job = 'retention'").toArray()[0]?.at,
    );
    if (next !== undefined) vi.setSystemTime(next);
  }
  expect(await kept()).toEqual([0, 0, 0, 0, 0]);
});
