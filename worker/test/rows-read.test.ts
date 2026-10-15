// What the Channel's hot paths cost in rows read, on a Channel with a long history.
// Durable Objects bill every row a query reads, against a daily allowance, and a
// Channel's tables only grow: Events forever, Agents with every session, Tasks with
// every Issue. So each call that runs per tool call, per heartbeat or per Relay
// decision must read a bounded number of rows however big the Channel gets. A
// query that scans one of those tables shows up here as thousands of rows.

import { reset, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentId, AgentResponse, ChannelEvent, HookEvent, Task } from "../../shared/src/index";
import { agentPath } from "../../shared/src/index";
import { installJev } from "../src/relay/jev";
import { lastUpdate } from "../src/status-comment";
import { bearer, channelStub, forgetTokens, remember, streamQuery, url } from "./client";
import { FakeJev } from "./fake-jev";

/**
 * The history the Channel is given before anything is measured: Events from Agents
 * and People, each followed by the Relay's Verdicts about it for the other live
 * Agents, as on a real Channel, where most rows are Verdicts.
 */
const SOURCES = 10_000;
const VERDICTS_PER_EVENT = 2;
const EVENTS = SOURCES * (1 + VERDICTS_PER_EVENT);
const GONE_AGENTS = 300;
const TASKS = 200;
/** Files each live Agent has edited. */
const TOUCHED_FILES = 100;

/** Generous for what each call needs, far below one scan of any seeded table. */
const BUDGET = 150;

type Cursor = { rowsRead: number };
type Meter = { cursors: Cursor[]; paused: boolean };
const meter = (globalThis as unknown as { rowsReadMeter?: Meter }).rowsReadMeter ?? { cursors: [], paused: true };
(globalThis as unknown as { rowsReadMeter: Meter }).rowsReadMeter = meter;

/**
 * Counts what every query of the Channel's SqlStorage reads from now on. The test
 * and the Durable Object share one isolate, so the cursors land in `meter`.
 */
async function meterChannel(): Promise<void> {
  await runInDurableObject(channelStub(), (_channel, state) => {
    const sql = state.storage.sql as unknown as { exec: (...args: unknown[]) => Cursor };
    const exec = sql.exec.bind(sql);
    sql.exec = (...args: unknown[]) => {
      const cursor = exec(...args);
      if (!meter.paused) meter.cursors.push(cursor);
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

/** Rows read by everything `work` makes the Channel do, its background work included once `until` holds. */
async function rowsRead(work: () => Promise<unknown>, until?: () => Promise<boolean>): Promise<number> {
  meter.cursors = [];
  meter.paused = false;
  await work();
  if (until !== undefined) {
    meter.paused = true;
    await settled(until);
  }
  meter.paused = true;
  return meter.cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
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

async function heartbeat(agent: AgentId, presence: "live" | "idle"): Promise<void> {
  const response = await call(`${agentPath(agent)}/heartbeat`, {
    method: "POST",
    headers: { Authorization: await bearer({ person: "shlok", agent }) },
    body: JSON.stringify({ presence }),
  });
  expect(response.status).toBe(200);
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
      sql.exec(
        `INSERT INTO events (id, at, type, actor, capture, task, turn, payload, actor_kind, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    for (let k = 0; k < GONE_AGENTS; k++) {
      const row: Record<string, SqlStorageValue> = {
        ...template,
        id: `shlok/claude/g${k}`,
        session_id: `gone-${k}`,
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
    const tasks = (channel as unknown as { tasks: { write(task: Task): void } }).tasks;
    for (let n = 1; n <= TASKS; n++) tasks.write(task(n, n % 40 === 0 ? live[n % live.length] : undefined));
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
  await meterChannel();
});

afterEach(async () => {
  installJev(null);
  forgetTokens();
  await reset();
});

/** Sends Hook Events over Agent `agent`'s WebSocket, as its wrapper does, and waits for the ack. */
async function sendHooks(agent: AgentId, events: HookEvent[]): Promise<void> {
  const response = await call(`/api/stream?${await streamQuery({ person: "shlok", agent })}`, {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error("No WebSocket in the upgrade response");
  socket.accept();
  const acked = new Promise<void>((resolve) => {
    socket.addEventListener("message", (message) => {
      if (String(message.data).includes('"hook.ack"')) resolve();
    });
  });
  meter.paused = false;
  socket.send(JSON.stringify({ type: "hook", agent, events }));
  await acked;
  socket.close();
}

/** The Relay's Verdicts about Event `id`, read without being counted. */
async function verdictsAbout(id: string): Promise<boolean> {
  return runInDurableObject(channelStub(), (_channel, state) =>
    state.storage.sql
      .exec<{ payload: string }>("SELECT payload FROM events WHERE type = 'verdict' ORDER BY seq DESC LIMIT 10")
      .toArray()
      .some((row) => JSON.stringify(row.payload).includes(id)),
  );
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
