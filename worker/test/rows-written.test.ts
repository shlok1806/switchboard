// What one hour of an actively coding Agent costs the Channel in rows written. The
// free plan allows 100,000 rows written a day for the whole Cloudflare account, so
// this is the meter that decides how many Agent-hours a day the hosted Worker serves.
//
// The hour is the one the storage research measured: 360 tool calls (60 of them
// shell commands), 60 file edits on 20 files, 30 turns, 390 model requests and 120
// heartbeats, with 4 other live Agents and no overlap between them. Its tenth is
// played here through the wrapper's own WebSocket and HTTP calls, and multiplied by 10.
//
// Measured on main before ADR 0037: 7,190 rows. After it, the per-call Events stay on
// their machine and the Channel writes only shared state: Presence heartbeats, the
// silence alarm and one touched-files row per file per Agent.

import { reset, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentId, AgentResponse, HookEvent } from "../../shared/src/index";
import { agentPath } from "../../shared/src/index";
import { installJev } from "../src/relay/jev";
import { bearer, channelStub, forgetTokens, remember, streamQuery, url } from "./client";
import { FakeJev } from "./fake-jev";

type Cursor = { rowsWritten: number };
type Meter = { cursors: Cursor[]; paused: boolean };
const meter = (globalThis as unknown as { rowsWrittenMeter?: Meter }).rowsWrittenMeter ?? {
  cursors: [],
  paused: true,
};
(globalThis as unknown as { rowsWrittenMeter: Meter }).rowsWrittenMeter = meter;

/** Counts what every query of the Channel's SqlStorage writes from now on. */
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

function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(url(path), init));
}

let nextId = 0;
function uuid(): string {
  nextId += 1;
  return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
}

function hook(type: HookEvent["type"], payload: unknown): HookEvent {
  return { id: uuid(), type, payload } as HookEvent;
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

async function heartbeat(agent: AgentId): Promise<void> {
  const response = await call(`${agentPath(agent)}/heartbeat`, {
    method: "POST",
    headers: { Authorization: await bearer({ person: "shlok", agent }) },
    body: JSON.stringify({ presence: "live" }),
  });
  expect(response.status).toBe(200);
}

/** Agent `agent`'s wrapper socket: sends one frame and waits for the Channel's ack. */
async function wrapperSocket(agent: AgentId): Promise<{ send: (frame: object) => Promise<void>; close: () => void }> {
  const response = await call(`/api/stream?${await streamQuery({ person: "shlok", agent })}`, {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error("No WebSocket in the upgrade response");
  socket.accept();
  let waiting: (() => void) | null = null;
  socket.addEventListener("message", (message) => {
    const text = String(message.data);
    if (text.includes('"hook.ack"') || text.includes('"proxy.ack"')) waiting?.();
  });
  return {
    send: (frame) =>
      new Promise<void>((resolve) => {
        waiting = resolve;
        socket.send(JSON.stringify(frame));
      }),
    close: () => socket.close(),
  };
}

/** A tenth of an Agent-hour, as `measured`'s wrapper sends it. */
async function tenthOfAnHour(measured: AgentId): Promise<void> {
  const socket = await wrapperSocket(measured);
  const send = (events: HookEvent[]) => socket.send({ type: "hook", agent: measured, events });
  for (let call = 0; call < 36; call++) {
    if (call % 6 === 0) {
      // A command the shell ran, and the call that ran it.
      await send([
        hook("tool.call", { tool: "Bash", arg: "npm test", ok: true }),
        hook("command", { command: "npm test", exitCode: 0 }),
      ]);
    } else if (call % 6 === 1) {
      // An edit: 6 in all, on 2 files, as an Agent comes back to the files it works on.
      await send([
        hook("tool.call", { tool: "Edit", arg: `src/part-${call % 2}.ts`, ok: true }),
        hook("file.edit", { path: `src/part-${call % 2}.ts`, additions: 3, deletions: 1 }),
      ]);
    } else {
      await send([hook("tool.call", { tool: "Read", arg: `src/read-${call}.ts`, ok: true })]);
    }
  }
  for (let turn = 0; turn < 3; turn++) await send([hook("turn.end", { turn })]);
  for (let request = 0; request < 39; request++) {
    await socket.send({
      type: "proxy",
      agent: measured,
      event: {
        id: uuid(),
        type: "proxy.digest",
        payload: {
          model: "claude-opus",
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reply: "Done.",
          toolCalls: [{ name: "Read", arg: "src/a.ts" }],
          maskedSecrets: 0,
        },
      },
    });
  }
  for (let beat = 0; beat < 12; beat++) await heartbeat(measured);
  socket.close();
}

/** What an Agent-hour may cost, in rows written: room for 200 Agent-hours a day under the free plan's 100,000. */
const ROWS_PER_AGENT_HOUR = 500;

let live: AgentId[];

beforeEach(async () => {
  installJev(new FakeJev({ drop: 1, queue: 0, interrupt: 0 }));
  live = [];
  for (const prefix of ["7f3a", "7f3b", "7f3c", "7f3d", "7f3e"]) {
    live.push(await register(`${prefix}0000-0000-4000-8000-000000000000`));
  }
  for (const agent of live) await heartbeat(agent);
  await meterChannel();
});

afterEach(async () => {
  installJev(null);
  forgetTokens();
  await reset();
});

it("an actively coding Agent writes a bounded number of rows an hour", async () => {
  const measured = live[0] as AgentId;
  meter.cursors = [];
  meter.paused = false;
  await tenthOfAnHour(measured);
  // The Relay's Verdicts are written after the requests that stored their Events.
  await new Promise((resolve) => setTimeout(resolve, 300));
  meter.paused = true;
  const perHour = 10 * meter.cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0);
  expect(perHour).toBeLessThanOrEqual(ROWS_PER_AGENT_HOUR);
});

/**
 * A typical day of the Brief (ADR 0042): a librarian Agent rewrites the overview, six
 * area pages and the stuck page four times each, and a quarter of its writes find the
 * page already says the same.
 */
const BRIEF_PAGES = ["overview", "vm-engine", "verifier", "companion", "release", "site", "bench", "stuck"];
const BRIEF_REWRITES = 4;
/** What one page write may cost: its page's row and the day's count of writes. */
const ROWS_PER_BRIEF_WRITE = 2;

it("a day of typical Brief updates writes two rows per changed page, and none for an unchanged one", async () => {
  const librarian = live[0] as AgentId;
  const put = async (page: string, text: string): Promise<boolean> => {
    const response = await call(`/api/brief/${page}`, {
      method: "PUT",
      headers: { Authorization: await bearer({ person: "shlok", agent: librarian }) },
      body: JSON.stringify({ text }),
    });
    expect(response.status, page).toBeLessThan(300);
    return response.status === 201;
  };
  let changed = 0;
  meter.cursors = [];
  meter.paused = false;
  for (let round = 1; round <= BRIEF_REWRITES; round++) {
    for (const [i, page] of BRIEF_PAGES.entries()) {
      // Every fourth write is the librarian finding nothing new on that page.
      const same = round > 1 && (round + i) % 4 === 0;
      const text = `# ${page}\n\nWhere ${page} stands, pass ${same ? round - 1 : round}. See #${100 + i} and ADR 0042.`;
      if (await put(page, text)) changed += 1;
    }
  }
  meter.paused = true;
  const rows = meter.cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0);
  expect(changed).toBeGreaterThan(BRIEF_PAGES.length * (BRIEF_REWRITES - 1));
  expect(changed).toBeLessThan(BRIEF_PAGES.length * BRIEF_REWRITES);
  expect(rows).toBeLessThanOrEqual(ROWS_PER_BRIEF_WRITE * changed);
});
