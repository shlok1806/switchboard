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

/** The history the Channel is given before anything is measured. */
const EVENTS = 20_000;
const GONE_AGENTS = 300;
const TASKS = 200;

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

/** Rows read by everything `work` makes the Channel do, its background work included once `until` holds. */
async function rowsRead(work: () => Promise<unknown>, until?: () => Promise<boolean>): Promise<number> {
  meter.cursors = [];
  meter.paused = false;
  await work();
  if (until !== undefined) {
    const deadline = Date.now() + 4000;
    meter.paused = true;
    while (!(await until())) {
      if (Date.now() > deadline) throw new Error("Timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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
    for (let i = 0; i < EVENTS; i++) {
      const agent = i % 2 === 0 ? `shlok/claude/g${i % GONE_AGENTS}` : live[i % live.length];
      // A few pushes, spread thin, as a busy Channel has.
      const type = i % 500 === 0 ? "push" : types[i % types.length];
      sql.exec(
        `INSERT INTO events (id, at, type, actor, capture, task, turn, payload, actor_kind, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?)`,
        `seed-${i}`,
        new Date(Date.now() - (EVENTS - i) * 1000).toISOString(),
        type,
        JSON.stringify({ kind: "agent", agentId: agent }),
        type === "push" ? null : "hook",
        type === "update" ? (i % TASKS) + 1 : null,
        null,
        JSON.stringify({ text: "progress", files: [{ path: "src/app.ts", additions: 1, deletions: 0, hunks: [] }] }),
        agent,
      );
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

it("a holder's last Update is found without scanning the history", async () => {
  const read = await rowsRead(() =>
    runInDurableObject(channelStub(), (_channel, state) => {
      // A Task no Update names, by a holder with no Update since it claimed: the slowest case.
      lastUpdate(
        state.storage.sql,
        { kind: "agent", agentId: "shlok/claude/none" },
        TASKS + 1,
        new Date(0).toISOString(),
      );
    }),
  );
  expect(read).toBeLessThan(BUDGET);
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
