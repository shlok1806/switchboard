// Agents carrying context to each other (ADR 0024), through the Channel API the way the
// MCP tools, the wrappers and the Dashboard use it: an Agent's summary, a session that
// continues another, and a read of an Agent's screen through its wrapper.

import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  AgentResponse,
  AgentSummary,
  ChannelEvent,
  ErrorResponse,
  HistoryResponse,
  TerminalReadRequestMessage,
  TerminalReadResponse,
  TouchedFilesResponse,
} from "../../shared/src/index";
import { claimPath, summaryPath, terminalReadPath } from "../../shared/src/index";
import { installGitHub } from "../src/github/index";
import { bearer, forgetTokens, remember, streamQuery, url } from "./client";
import { FakeGitHub } from "./fake-github";

let github: FakeGitHub;
let sessions = 0;
const sockets: WebSocket[] = [];

async function call(path: string, person: string, agent?: AgentId, body?: unknown): Promise<Response> {
  const response = await exports.default.fetch(
    new Request(url(path), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: await bearer({ person, ...(agent === undefined ? {} : { agent }) }),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  if (path === "/api/agents" && response.ok) remember(await response.clone().json<AgentResponse>());
  return response;
}

function sessionId(n: number): string {
  return `${n.toString(16).padStart(4, "0")}dddd-0000-4000-8000-000000000000`;
}

async function registerAs(person: string, body: Record<string, unknown> = {}): Promise<Response> {
  sessions += 1;
  return call("/api/agents", person, undefined, {
    cli: "claude-code",
    sessionId: sessionId(sessions),
    resumed: false,
    cwd: "/r",
    ...body,
  });
}

async function register(person: string, body: Record<string, unknown> = {}): Promise<AgentId> {
  const response = await registerAs(person, body);
  expect(response.status).toBe(200);
  return (await response.json<AgentResponse>()).agent.id;
}

async function summary(id: AgentId, person = "bob", agent?: AgentId): Promise<AgentSummary> {
  const response = await call(summaryPath(id), person, agent);
  expect(response.status).toBe(200);
  return response.json<AgentSummary>();
}

async function events(): Promise<ChannelEvent[]> {
  return (await (await call("/api/events", "dashboard")).json<HistoryResponse>()).events;
}

async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Agent `agent`'s wrapper on its socket: it answers each screen read with
 * `answer(request)`, or never when that returns undefined.
 */
async function wrapper(
  person: string,
  agent: AgentId,
  answer: (request: TerminalReadRequestMessage) => unknown = () => undefined,
): Promise<TerminalReadRequestMessage[] & { send: (frame: unknown) => void }> {
  const query = await streamQuery({ person, agent });
  const response = await exports.default.fetch(
    new Request(url(`/api/stream?${query}`), { headers: { Upgrade: "websocket" } }),
  );
  const socket = response.webSocket;
  if (!socket) throw new Error("No WebSocket");
  socket.accept();
  sockets.push(socket);
  const asked = Object.assign([] as TerminalReadRequestMessage[], {
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
  });
  let attached = false;
  socket.addEventListener("message", (message) => {
    const frame = JSON.parse(message.data as string) as { type: string };
    if (frame.type === "interrupt.attached") attached = true;
    if (frame.type !== "terminal.read.request") return;
    const request = frame as TerminalReadRequestMessage;
    asked.push(request);
    const reply = answer(request);
    if (reply !== undefined) socket.send(JSON.stringify(reply));
  });
  socket.send(JSON.stringify({ type: "interrupt.attach", agent }));
  await waitFor(() => (attached ? true : undefined));
  return asked;
}

function screen(request: TerminalReadRequestMessage, lines = ["$ npm test", "2 passed"], cols = 80) {
  return { type: "terminal.text", agent: request.agent, id: request.id, cols, rows: lines.length, lines };
}

beforeEach(() => {
  github = new FakeGitHub();
  installGitHub(github);
});

afterEach(async () => {
  forgetTokens();
  for (const socket of sockets.splice(0)) socket.close();
  installGitHub(null);
  await reset();
});

describe("An Agent's summary", () => {
  it("holds its Tasks, latest Updates, files and the notes that matter for it, for anyone, Gone or not", async () => {
    const held = github.open({ title: "Fix the login redirect" }).number;
    const elsewhere = github.open({ title: "Unrelated" }).number;
    const alice = await register("alice", { nickname: "scout" });
    const carol = await register("carol");
    expect((await call(claimPath(held), "alice", alice, {})).status).toBe(200);
    for (let n = 1; n <= 7; n++) {
      expect(
        (await call("/api/updates", "alice", alice, { text: `Step ${n} done`, ...(n === 7 ? { task: held } : {}) }))
          .status,
      ).toBe(201);
    }
    const notes: [AgentId, Record<string, unknown>][] = [
      [alice, { text: "Redirect is built in auth/session.ts", tags: ["decision"], task: held }],
      [carol, { text: "Does the redirect keep the query string?", tags: ["question"], task: held }],
      [carol, { text: "Patching the router did not help", tags: ["dead-end"], task: held }],
      [carol, { text: "Carol's own fact about the login task", tags: ["fact"], task: held }],
      [carol, { text: "A question on another Task", tags: ["question"], task: elsewhere }],
    ];
    for (const [author, body] of notes) {
      expect((await call("/api/memory", author.split("/")[0] as string, author, body)).status).toBe(201);
    }
    const socket = await wrapper("alice", alice);
    socket.send({
      type: "hook",
      agent: alice,
      events: [
        {
          id: "00000000-0000-4000-8000-00000000d001",
          type: "file.edit",
          payload: { path: "auth/session.ts", additions: 1, deletions: 0 },
        },
      ],
    });
    await waitFor(async () => {
      const files = await (await call(`/api/agents/${encodeURIComponent(alice)}/touched-files`, "bob")).json();
      return (files as TouchedFilesResponse).files.length > 0 ? true : undefined;
    });

    const before = (await events()).length;
    // Another Person's Agent reads it with its own token.
    const read = await summary(alice, "carol", carol);
    expect(read.agent).toMatchObject({ id: alice, nickname: "scout" });
    expect(read.tasks.map((t) => t.number)).toEqual([held]);
    expect(read.updates.map((u) => u.text)).toEqual([
      "Step 7 done",
      "Step 6 done",
      "Step 5 done",
      "Step 4 done",
      "Step 3 done",
    ]);
    expect(read.updates[0]?.task).toBe(held);
    expect(read.files).toEqual(["auth/session.ts"]);
    // Its own notes, and the questions and dead ends on its Task by anyone, newest first.
    expect(read.notes.map((n) => n.text)).toEqual([
      "Patching the router did not help",
      "Does the redirect keep the query string?",
      "Redirect is built in auth/session.ts",
    ]);
    expect(read.successors).toEqual([]);
    // Reading records nothing.
    expect((await events()).length).toBe(before);

    expect((await call(`/api/agents/${encodeURIComponent(alice)}/end`, "alice", alice, {})).status).toBe(200);
    expect((await summary(alice)).agent.presence).toBe("gone");
    expect((await call(summaryPath("alice/claude/zzzz" as AgentId), "bob")).status).toBe(404);
  });
});

describe("A session that continues another", () => {
  it("records the hand-off once, about the Task its predecessor works on, and moves no Claim", async () => {
    const task = github.open({ title: "Billing" }).number;
    const before = await register("alice");
    expect((await call(claimPath(task), "alice", before, {})).status).toBe(200);

    sessions += 1;
    const id = sessionId(sessions);
    const first = await call("/api/agents", "bob", undefined, {
      cli: "claude-code",
      sessionId: id,
      resumed: false,
      cwd: "/r",
      continues: before,
    });
    expect(first.status).toBe(200);
    const after = (await first.json<AgentResponse>()).agent;
    expect(after.continues).toBe(before);

    const handoffs = (await events()).filter((e) => e.type === "agent.handoff");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ actor: { kind: "agent", agentId: after.id }, task, payload: { from: before } });
    expect((await summary(before)).successors).toEqual([after.id]);
    // The predecessor still holds its Task.
    expect((await summary(before)).tasks.map((t) => t.number)).toEqual([task]);

    // The same session registering again (a resume) keeps what it continues, and records nothing more.
    const other = await register("alice");
    const again = await call("/api/agents", "bob", undefined, {
      cli: "claude-code",
      sessionId: id,
      resumed: true,
      cwd: "/r",
      continues: other,
    });
    expect((await again.json<AgentResponse>()).agent.continues).toBe(before);
    expect((await events()).filter((e) => e.type === "agent.handoff")).toHaveLength(1);
  });

  it("refuses an Agent the Channel does not know, the session's own Agent, and one that is not an ID", async () => {
    const unknown = await registerAs("bob", { continues: "alice/claude/zzzz" });
    expect(unknown.status).toBe(404);
    expect((await unknown.json<ErrorResponse>()).reason).toMatch(/No Agent alice\/claude\/zzzz/);

    sessions += 1;
    const own = await call("/api/agents", "bob", undefined, {
      cli: "claude-code",
      sessionId: sessionId(sessions),
      resumed: false,
      cwd: "/r",
      continues: `bob/claude/${sessionId(sessions).slice(0, 4)}`,
    });
    expect(own.status).toBe(409);
    expect((await registerAs("bob", { continues: 7 })).status).toBe(400);
    expect((await events()).filter((e) => e.type === "agent.handoff")).toEqual([]);
  });
});

describe("Reading an Agent's terminal", () => {
  it("asks its wrapper for the screen, cleans it, and records who read it", async () => {
    const agent = await register("alice");
    const reader = await register("carol");
    await wrapper("alice", agent, (request) =>
      screen(request, ["$ npm test \u001b[32mok\u001b[0m", "token=sk-***", "x".repeat(120)], 80),
    );
    const response = await call(terminalReadPath(agent), "carol", reader);
    expect(response.status).toBe(200);
    expect(await response.json<TerminalReadResponse>()).toEqual({
      agent,
      cols: 80,
      rows: 3,
      // No escape sequence, and no row wider than the screen.
      lines: ["$ npm test ok", "token=sk-***", "x".repeat(80)],
    });
    const reads = (await events()).filter((e) => e.type === "terminal.read");
    expect(reads.map((e) => [e.actor, e.payload])).toEqual([
      [
        { kind: "agent", agentId: reader },
        { agent, rows: 3 },
      ],
    ]);
  });

  it("takes the screen only from the read Agent's own wrapper, and says why there is none", async () => {
    const agent = await register("alice");
    const other = await register("alice");
    const asked = await wrapper("alice", agent);
    const forger = await wrapper("alice", other);
    const read = call(terminalReadPath(agent), "bob");
    const request = await waitFor(() => asked[0]);
    forger.send(screen(request, ["Forged"]));
    // A second read of the same screen waits its turn.
    const second = await call(terminalReadPath(agent), "carol");
    expect(second.status).toBe(429);
    asked.send({ type: "terminal.text", agent, id: request.id, error: "The screen is not drawn yet." });
    const failed = await read;
    expect(failed.status).toBe(502);
    expect((await failed.json<ErrorResponse>()).reason).toMatch(/The screen is not drawn yet/);

    const bad = call(terminalReadPath(agent), "bob");
    const next = await waitFor(() => asked[1]);
    asked.send({ type: "terminal.text", agent, id: next.id, cols: 0, rows: 1, lines: ["x"] });
    expect((await bad).status).toBe(502);

    const offline = await register("dave");
    expect((await call(terminalReadPath(offline), "bob")).status).toBe(503);
    expect((await call(`/api/agents/${encodeURIComponent(offline)}/end`, "dave", offline, {})).status).toBe(200);
    expect((await call(terminalReadPath(offline), "bob")).status).toBe(409);
    expect((await call(terminalReadPath("dave/claude/zzzz" as AgentId), "bob")).status).toBe(404);
    expect((await events()).filter((e) => e.type === "terminal.read")).toEqual([]);
  });
});
