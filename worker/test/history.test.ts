// History reads the Channel relays to the machines that keep Local Events (ADR 0037):
// an Agent's wrapper while it runs, its Host after, and a clear answer when neither
// can be reached.

import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  AgentSummary,
  ChannelEvent,
  HistoryRequestMessage,
  HistoryResponse,
} from "../../shared/src/index";
import { summaryPath } from "../../shared/src/index";
import { streamQuery, url } from "./client";
import { call, cleanUp, closeAfterTest, FakeHost, post, wrapperRegisters } from "./hosts-harness";

afterEach(cleanUp);

let made = 0;

/** A Local Event of Agent `agent`, as the Channel recorded it and its machine kept it. */
function local(agent: AgentId, seq: number, payload: { tool: string; arg: string }): ChannelEvent {
  made += 1;
  return {
    id: `local-${made}`,
    seq,
    at: new Date(Date.UTC(2026, 10, 6, 0, 0, seq % 60)).toISOString(),
    type: "tool.call",
    actor: { kind: "agent", agentId: agent },
    capture: "hook",
    payload: { ...payload, ok: true },
  };
}

/** Answers every `history.request` on `socket` from `store`, as a wrapper or Host does. */
function answerFrom(socket: WebSocket, store: () => ChannelEvent[], asked: HistoryRequestMessage[] = []): void {
  socket.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data)) as { type: string };
    if (frame.type !== "history.request") return;
    const request = frame as HistoryRequestMessage;
    asked.push(request);
    const events = store()
      .filter((e) => request.agent === undefined || (e.actor.kind === "agent" && e.actor.agentId === request.agent))
      .filter((e) => e.seq < request.before)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, request.limit)
      .reverse();
    socket.send(JSON.stringify({ type: "history.page", id: request.id, events }));
  });
}

/** Agent `agent`'s wrapper socket, attached and keeping its Local Events. */
async function wrapperSocket(person: string, agent: AgentId): Promise<WebSocket> {
  const response = await exports.default.fetch(
    new Request(url(`/api/stream?${await streamQuery({ person, agent })}`), { headers: { Upgrade: "websocket" } }),
  );
  const socket = response.webSocket;
  if (!socket) throw new Error(`No WebSocket: ${response.status}`);
  socket.accept();
  closeAfterTest(socket);
  const attached = new Promise<void>((resolve) =>
    socket.addEventListener("message", (message) => {
      if (String(message.data).includes('"interrupt.attached"')) resolve();
    }),
  );
  socket.send(JSON.stringify({ type: "interrupt.attach", agent, history: true }));
  await attached;
  return socket;
}

/** A Host that keeps its Agents' Local Events and answers from `store`. */
async function historyHost(person: string, name: string, store: () => ChannelEvent[]): Promise<FakeHost> {
  const host = await FakeHost.registered(person, name);
  const query = await streamQuery(person, { host: name, history: "1" });
  const response = await exports.default.fetch(
    new Request(url(`/api/stream?${query}`), { headers: { Upgrade: "websocket" } }),
  );
  const socket = response.webSocket;
  if (!socket) throw new Error(`No WebSocket: ${response.status}`);
  socket.accept();
  closeAfterTest(socket);
  answerFrom(socket, store);
  return host;
}

/** What `switchboard run` registers in a terminal, naming its machine's Host. */
async function terminalAgent(person: string, historyHost?: string): Promise<AgentId> {
  made += 1;
  const response = await post("/api/agents", person, {
    cli: "claude-code",
    sessionId: `${made.toString(16).padStart(4, "0")}aaaa-0000-4000-8000-000000000000`,
    resumed: false,
    cwd: "/work/app",
    ...(historyHost === undefined ? {} : { historyHost }),
  });
  expect(response.status).toBe(200);
  return (await response.json<{ agent: { id: AgentId } }>()).agent.id;
}

async function history(query: string): Promise<HistoryResponse> {
  const response = await call(`/api/events?${query}`, "dashboard");
  expect(response.status).toBe(200);
  return response.json<HistoryResponse>();
}

describe("an Agent's history", () => {
  it("merges what the Channel stores with what its wrapper keeps, newest first, cut to the page", async () => {
    const agent = await terminalAgent("shlok");
    const update = await post("/api/updates", "shlok", { text: "Starting on the parser" }, agent);
    expect(update.status).toBe(201);
    const stored = (await update.json<{ event: ChannelEvent }>()).event;
    const kept = [
      local(agent, stored.seq - 1, { tool: "Read", arg: "src/parser.ts" }),
      local(agent, stored.seq + 10, { tool: "Edit", arg: "src/parser.ts" }),
      local(agent, stored.seq + 20, { tool: "Bash", arg: "npm test" }),
    ];
    answerFrom(await wrapperSocket("shlok", agent), () => kept);

    const page = await history(`tail=3&agent=${encodeURIComponent(agent)}`);
    expect(page.events.map((e) => e.id)).toEqual([stored.id, kept[1]?.id, kept[2]?.id]);
    expect(page.unavailable).toBeUndefined();
    // Older pages go on from the oldest one shown.
    const older = await history(`tail=3&agent=${encodeURIComponent(agent)}&before=${stored.seq}`);
    expect(older.events.map((e) => e.id)).toContain(kept[0]?.id);
  });

  it("is answered by the machine's Host once its wrapper is gone", async () => {
    const store: ChannelEvent[] = [];
    await historyHost("shlok", "studio", () => store);
    const agent = await terminalAgent("shlok", "studio");
    store.push(local(agent, 5, { tool: "Bash", arg: "npm run build" }));

    const page = await history(`tail=50&agent=${encodeURIComponent(agent)}`);
    expect(page.events.map((e) => e.payload)).toContainEqual({ tool: "Bash", arg: "npm run build", ok: true });
  });

  it("says which machine is away instead of failing, while its Host is offline", async () => {
    const host = await FakeHost.registered("shlok", "laptop");
    const { agent } = await wrapperRegisters("shlok", host.name);
    expect(agent.historyHost).toBe("shlok/laptop");

    const page = await history(`tail=50&agent=${encodeURIComponent(agent.id)}`);
    expect(page.unavailable).toEqual([
      {
        host: "shlok/laptop",
        agents: [agent.id],
        reason: "offline: history unavailable until shlok/laptop is back",
      },
    ]);
  });

  it("keeps only its own Person's Agents' Local Events from what a machine answers", async () => {
    const agent = await terminalAgent("shlok");
    const other = await terminalAgent("maya");
    const forged = local(other, 7, { tool: "Bash", arg: "rm -rf /" });
    const update: ChannelEvent = {
      ...local(agent, 8, { tool: "x", arg: "y" }),
      type: "update",
      capture: "tool",
      payload: { text: "Never asked for" },
    } as ChannelEvent;
    const mine = local(agent, 9, { tool: "Read", arg: "README.md" });
    const socket = await wrapperSocket("shlok", agent);
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data)) as HistoryRequestMessage;
      if (frame.type !== "history.request") return;
      socket.send(JSON.stringify({ type: "history.page", id: frame.id, events: [forged, update, mine] }));
    });

    // The whole feed: the wrapper is asked about its own Agent and may answer only for it.
    const page = await history("tail=50");
    const ids = page.events.map((e) => e.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(forged.id);
    expect(ids).not.toContain(update.id);
  });
});

describe("the Channel's feed", () => {
  it("asks every attached Host and the wrappers it does not cover, and names the Hosts that are away", async () => {
    const studio: ChannelEvent[] = [];
    await historyHost("shlok", "studio", () => studio);
    await FakeHost.registered("shlok", "laptop");
    const onStudio = await terminalAgent("shlok", "studio");
    const inTerminal = await terminalAgent("shlok");
    studio.push(local(onStudio, 3, { tool: "Read", arg: "a.ts" }));
    const asked: HistoryRequestMessage[] = [];
    const wrapped = [local(inTerminal, 4, { tool: "Read", arg: "b.ts" })];
    answerFrom(await wrapperSocket("shlok", inTerminal), () => wrapped, asked);
    // A wrapper on the studio, whose Host keeps the same store, is not asked again.
    const studioWrapper: HistoryRequestMessage[] = [];
    answerFrom(await wrapperSocket("shlok", onStudio), () => studio, studioWrapper);

    const page = await history("tail=100");
    const ids = page.events.map((e) => e.id);
    expect(ids).toContain(studio[0]?.id);
    expect(ids).toContain(wrapped[0]?.id);
    expect(asked.map((a) => a.agent)).toEqual([inTerminal]);
    expect(studioWrapper).toEqual([]);
    expect(page.unavailable).toEqual([
      { host: "shlok/laptop", agents: [], reason: "offline: history unavailable until shlok/laptop is back" },
    ]);
  });
});

describe("an Agent Summary", () => {
  it("tells what the Agent did last, from its machine, and says so when the machine is away", async () => {
    const store: ChannelEvent[] = [];
    await historyHost("shlok", "studio", () => store);
    const agent = await terminalAgent("shlok", "studio");
    store.push(local(agent, 1, { tool: "Read", arg: "src/a.ts" }), {
      ...local(agent, 2, { tool: "", arg: "" }),
      type: "file.edit",
      payload: { path: "src/a.ts", additions: 2, deletions: 1 },
    });
    const summary = await (await call(summaryPath(agent), "dashboard")).json<AgentSummary>();
    expect(summary.activity?.map((a) => a.text)).toEqual(["edited src/a.ts (+2 -1)", "Read src/a.ts"]);
    expect(summary.files).toEqual(["src/a.ts"]);

    const away = await terminalAgent("shlok");
    const unread = await (await call(summaryPath(away), "dashboard")).json<AgentSummary>();
    expect(unread.activity).toBeUndefined();
    expect(unread.historyUnavailable).toBe(`offline: history unavailable until ${away} is back`);
  });
});
