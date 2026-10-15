// Reading another session's transcript (ADR 0019), through the Channel API: the
// Channel asks the Agent's wrapper over its socket, passes the page on, keeps none of
// it, and records who read whose transcript.

import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  AgentResponse,
  ChannelEvent,
  ErrorResponse,
  HistoryResponse,
  TranscriptEntry,
  TranscriptRequestMessage,
  TranscriptResponse,
} from "../../shared/src/index";
import { transcriptPath } from "../../shared/src/index";
import { bearer, forgetTokens, remember, streamQuery, url } from "./client";

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

async function register(person: string): Promise<AgentId> {
  sessions += 1;
  const response = await call("/api/agents", person, undefined, {
    cli: "claude-code",
    sessionId: `${sessions.toString(16).padStart(4, "0")}ffff-0000-4000-8000-000000000000`,
    resumed: false,
    cwd: "/r",
  });
  expect(response.status).toBe(200);
  return (await response.json<AgentResponse>()).agent.id;
}

async function waitFor<T>(check: () => T | undefined, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Agent `agent`'s wrapper, attached to its socket: it answers each transcript request
 * with `answer(request)`, or never when that returns undefined.
 */
async function wrapper(
  person: string,
  agent: AgentId,
  answer: (request: TranscriptRequestMessage) => unknown,
): Promise<TranscriptRequestMessage[] & { send: (frame: unknown) => void }> {
  const query = await streamQuery({ person, agent });
  const response = await exports.default.fetch(
    new Request(url(`/api/stream?${query}`), { headers: { Upgrade: "websocket" } }),
  );
  const socket = response.webSocket;
  if (!socket) throw new Error("No WebSocket");
  socket.accept();
  sockets.push(socket);
  const asked = Object.assign([] as TranscriptRequestMessage[], {
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
  });
  let attached = false;
  socket.addEventListener("message", (message) => {
    const frame = JSON.parse(message.data as string) as { type: string };
    if (frame.type === "interrupt.attached") attached = true;
    if (frame.type !== "transcript.request") return;
    const request = frame as TranscriptRequestMessage;
    asked.push(request);
    const reply = answer(request);
    if (reply !== undefined) socket.send(JSON.stringify(reply));
  });
  socket.send(JSON.stringify({ type: "interrupt.attach", agent }));
  await waitFor(() => (attached ? true : undefined));
  return asked;
}

const ENTRIES: TranscriptEntry[] = [
  { n: 4, at: "2026-10-15T10:00:00.000Z", kind: "prompt", text: "Fix the flaky login test" },
  { n: 5, kind: "tool", text: "Bash: npm test" },
  { n: 6, kind: "result", text: "2 passed" },
];

function page(request: TranscriptRequestMessage, entries = ENTRIES, extra: Record<string, unknown> = {}) {
  return {
    type: "transcript.page",
    agent: request.agent,
    id: request.id,
    page: { from: request.from, entries, next: 7, redacted: 2, ...extra },
  };
}

async function reads(): Promise<ChannelEvent[]> {
  const history = await (await call("/api/events", "dashboard")).json<HistoryResponse>();
  return history.events.filter((e) => e.type === "transcript.read");
}

afterEach(async () => {
  forgetTokens();
  for (const socket of sockets.splice(0)) socket.close();
  await reset();
});

describe("Reading a transcript", () => {
  it("asks the Agent's wrapper for the page, and records who read it, for a Person or another Agent", async () => {
    const agent = await register("alice");
    const asked = await wrapper("alice", agent, (request) => page(request));

    const asPerson = await call(transcriptPath(agent, 4), "bob");
    expect(asPerson.status).toBe(200);
    expect(await asPerson.json<TranscriptResponse>()).toEqual({
      agent,
      from: 4,
      entries: ENTRIES,
      next: 7,
      redacted: 2,
    });
    expect(asked.map((r) => r.from)).toEqual([4]);

    // Another Person's Agent: any session on the Channel may read any session's.
    const reader = await register("carol");
    expect((await call(transcriptPath(agent), "carol", reader)).status).toBe(200);

    expect((await reads()).map((e) => [e.actor, e.payload])).toEqual([
      [
        { kind: "person", person: "bob" },
        { agent, from: 4, entries: 3 },
      ],
      [
        { kind: "agent", agentId: reader },
        { agent, from: 0, entries: 3 },
      ],
    ]);
  });

  it("passes on no control character, terminal escape or bidi control, and refuses a page that is not one", async () => {
    const agent = await register("alice");
    let entries: unknown[] = [
      { n: 0, kind: "result", text: "ok\u001b]52;c;cm0gLXJm\u0007 \u001b[31mred\u001b[0m\r\nnext‮line\u0000" },
    ];
    await wrapper("alice", agent, (request) => page(request, entries as TranscriptEntry[]));
    const clean = await (await call(transcriptPath(agent), "bob")).json<TranscriptResponse>();
    expect(clean.entries[0]?.text).toBe("ok]52;c;cm0gLXJm [31mred[0m\nnextline");

    for (const bad of [[{ n: -1, kind: "text", text: "x" }], [{ n: 0, kind: "secret", text: "x" }], [{ n: 0 }]]) {
      entries = bad;
      const refused = await call(transcriptPath(agent), "bob");
      expect(refused.status, JSON.stringify(bad)).toBe(502);
      expect((await refused.json<ErrorResponse>()).reason).toMatch(/could not read it/);
    }
    // Only the pages read are recorded.
    expect(await reads()).toHaveLength(1);
  });

  it("says why when the wrapper could not read it, and when it does not answer in time", async () => {
    const agent = await register("alice");
    let reply: (request: TranscriptRequestMessage) => unknown = (request) => ({
      type: "transcript.page",
      agent,
      id: request.id,
      error: "The session file is not there yet.",
    });
    await wrapper("alice", agent, (request) => reply(request));
    const failed = await call(transcriptPath(agent), "bob");
    expect(failed.status).toBe(502);
    expect((await failed.json<ErrorResponse>()).reason).toMatch(/The session file is not there yet/);

    reply = () => undefined;
    const silent = await call(transcriptPath(agent), "bob");
    expect(silent.status).toBe(504);
    expect((await silent.json<ErrorResponse>()).reason).toMatch(/did not send its transcript in time/);
    expect(await reads()).toEqual([]);
  });

  it("takes a page only from the read Agent's own wrapper, for the read it asked", async () => {
    const agent = await register("alice");
    const other = await register("alice");
    // The Agent's wrapper is silent. Another of alice's wrappers answers for it, even
    // with the request's own ID, and naming the read Agent: it is not that Agent's socket.
    const asked = await wrapper("alice", agent, () => undefined);
    const forger = await wrapper("alice", other, () => undefined);
    const read = call(transcriptPath(agent), "bob");
    const request = await waitFor(() => asked[0]);
    expect(forger).toHaveLength(0);
    forger.send(page(request, [{ n: 0, kind: "text", text: "Forged" }]));
    // An answer to an ID no read is waiting for is dropped as well.
    asked.send(page({ ...request, id: "made-up" }));
    const response = await read;
    expect(response.status).toBe(504);
  });

  it("refuses a Gone Agent, one whose wrapper is not attached, an unknown Agent and a bad entry", async () => {
    const gone = await register("alice");
    expect((await call(`/api/agents/${encodeURIComponent(gone)}/end`, "alice", gone, {})).status).toBe(200);
    const goneRead = await call(transcriptPath(gone), "bob");
    expect(goneRead.status).toBe(409);
    expect((await goneRead.json<ErrorResponse>()).reason).toMatch(/is Gone/);

    const offline = await register("alice");
    const offlineRead = await call(transcriptPath(offline), "bob");
    expect(offlineRead.status).toBe(503);
    expect((await offlineRead.json<ErrorResponse>()).reason).toMatch(/wrapper is not connected/);

    expect((await call(transcriptPath("alice/claude/zzzz" as AgentId), "bob")).status).toBe(404);
    expect((await call(`${transcriptPath(offline)}?from=-1`, "bob")).status).toBe(400);
    expect(await reads()).toEqual([]);
  });
});
