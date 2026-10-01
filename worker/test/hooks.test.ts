// The Hook Capture on the Channel side, driven the way the laptop wrapper uses
// it: Hook Events sent over the Channel WebSocket, read back through the Channel
// API the Dashboard and the Relay use, against the real Worker and Durable Object.

import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  AgentResponse,
  AgentsResponse,
  ChannelEvent,
  ErrorResponse,
  HistoryResponse,
  HookCaptureMessage,
  HookCaptureReply,
  HookEvent,
  TouchedFilesResponse,
} from "../../shared/src/index";
import {
  agentPath,
  branchPath,
  claimPath,
  finishPath,
  MAX_HOOK_ARG_LENGTH,
  MAX_HOOK_COMMAND_LENGTH,
  releasePath,
  taskBranch,
} from "../../shared/src/index";
import { installGitHub } from "../src/github/index";
import { type As, bearer, forgetTokens, remember, streamQuery, url } from "./client";
import { FakeGitHub } from "./fake-github";

function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(url(path), init));
}

let nextId = 0;
/** A fresh Event ID, the way the wrapper picks one. */
function eventId(): string {
  nextId += 1;
  return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
}

function hook<K extends HookEvent["type"]>(type: K, payload: Extract<HookEvent, { type: K }>["payload"]): HookEvent {
  return { id: eventId(), type, payload } as HookEvent;
}

function edit(path: string, additions = 1, deletions = 0): HookEvent {
  return hook("file.edit", { path, additions, deletions });
}

/**
 * A laptop wrapper for one Person. Each of its Agents has its own WebSocket to the
 * Channel, opened with that Agent's token, as `switchboard run` does.
 */
class FakeWrapper {
  private readonly replies: HookCaptureReply[] = [];
  private readonly sockets = new Map<string, WebSocket>();
  private readonly mine = new Set<string>();

  constructor(readonly name: string) {}

  private async headers(): Promise<HeadersInit> {
    return { Authorization: await bearer(this.name) };
  }

  async register(sessionId: string): Promise<AgentId> {
    const response = await call("/api/agents", {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ cli: "claude-code", sessionId, resumed: false, cwd: "/repo" }),
    });
    expect(response.status).toBe(200);
    const { id } = remember(await response.json<AgentResponse>()).agent;
    this.mine.add(id);
    return id;
  }

  /** Opens the WebSocket of `agent` with its token, or, for an Agent it has no token for, the Person's. */
  private async connect(agent: string): Promise<WebSocket> {
    const known = this.sockets.get(agent);
    if (known) return known;
    // For an Agent that is not one of its own, the wrapper speaks as the Person, and is refused.
    const as: As = this.mine.has(agent) ? { person: this.name, agent: agent as AgentId } : { person: this.name };
    const response = await call(`/api/stream?${await streamQuery(as)}`, { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("No WebSocket in the upgrade response");
    socket.accept();
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(message.data as string) as { type: string };
      if (frame.type === "hook.ack" || frame.type === "hook.refused") this.replies.push(frame as HookCaptureReply);
    });
    this.sockets.set(agent, socket);
    return socket;
  }

  /** Sends one message over the WebSocket and waits for the Channel's reply to it. */
  async send(message: HookCaptureMessage | Record<string, unknown>): Promise<HookCaptureReply> {
    const socket = await this.connect(String(message.agent));
    const seen = this.replies.length;
    socket.send(JSON.stringify(message));
    const deadline = Date.now() + 2000;
    for (;;) {
      const reply = this.replies[seen];
      if (reply) return reply;
      if (Date.now() > deadline) throw new Error("No reply from the Channel");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  hooks(agent: AgentId, events: HookEvent[]): Promise<HookCaptureReply> {
    return this.send({ type: "hook", agent, events });
  }

  async touchedFiles(agent: AgentId): Promise<Response> {
    return call(`${agentPath(agent)}/touched-files`, { headers: await this.headers() });
  }

  async files(agent: AgentId): Promise<[string, number][]> {
    const response = await this.touchedFiles(agent);
    expect(response.status).toBe(200);
    const body = await response.json<TouchedFilesResponse>();
    expect(body.agent).toBe(agent);
    return body.files.map((f) => [f.path, f.edits]);
  }

  async hookEvents(): Promise<ChannelEvent[]> {
    const response = await call("/api/events", { headers: await this.headers() });
    return (await response.json<HistoryResponse>()).events.filter((e) => e.capture === "hook");
  }

  close(): void {
    for (const socket of this.sockets.values()) socket.close();
  }

  /** Drops every WebSocket, as a lost connection does; the next message reconnects. */
  reconnect(): void {
    this.close();
    this.sockets.clear();
  }
}

const wrappers: FakeWrapper[] = [];
function wrapper(name: string): FakeWrapper {
  const fake = new FakeWrapper(name);
  wrappers.push(fake);
  return fake;
}

afterEach(async () => {
  for (const w of wrappers.splice(0)) w.close();
  forgetTokens();
  await reset();
});

describe("recording Hook Events", () => {
  it("records every Hook Event type, labelled with the Hook Capture and naming its Agent", async () => {
    const shlok = wrapper("shlok");
    const agent = await shlok.register("7f3a0000-0000-4000-8000-000000000000");
    const events = [
      hook("session.start", { cwd: "/repo", resumed: false, source: "startup" }),
      hook("tool.call", { tool: "Bash", arg: "npm test", ok: true }),
      hook("command", { command: "npm test" }),
      hook("tool.call", { tool: "Edit", arg: "src/app.ts", ok: true }),
      edit("src/app.ts", 3, 1),
      hook("turn.end", { turn: 1 }),
      hook("session.end", { reason: "exit", detail: "prompt_input_exit" }),
    ];

    expect(await shlok.hooks(agent, events)).toEqual({ type: "hook.ack", recorded: events.map((e) => e.id) });

    const recorded = await shlok.hookEvents();
    expect(recorded.map((e) => [e.id, e.type, e.payload])).toEqual(events.map((e) => [e.id, e.type, e.payload]));
    for (const event of recorded) {
      expect(event).toMatchObject({ capture: "hook", actor: { kind: "agent", agentId: agent } });
    }
  });

  it("records a message sent again after a reconnect once, and counts its file edits once", async () => {
    const shlok = wrapper("shlok");
    const agent = await shlok.register("aaaa0000-0000-4000-8000-000000000000");
    const events = [edit("README.md"), hook("turn.end", { turn: 1 })];
    await shlok.hooks(agent, events);
    shlok.reconnect();

    const again = shlok;
    expect(await again.hooks(agent, events)).toEqual({ type: "hook.ack", recorded: events.map((e) => e.id) });
    expect(await again.hookEvents()).toHaveLength(2);
    expect(await again.files(agent)).toEqual([["README.md", 1]]);
  });

  it("cuts long text to size and never records tool output", async () => {
    const shlok = wrapper("shlok");
    const agent = await shlok.register("bbbb0000-0000-4000-8000-000000000000");
    const long = "x".repeat(5000);
    await shlok.hooks(agent, [
      { id: eventId(), type: "tool.call", payload: { tool: "Bash", arg: long, ok: true, output: long } },
      hook("command", { command: long, exitCode: 2 }),
    ]);
    const [tool, command] = await shlok.hookEvents();
    expect(tool?.payload).toEqual({ tool: "Bash", arg: `${"x".repeat(MAX_HOOK_ARG_LENGTH - 1)}…`, ok: true });
    expect(command?.payload).toEqual({ command: `${"x".repeat(MAX_HOOK_COMMAND_LENGTH - 1)}…`, exitCode: 2 });
  });

  it("counts Hook Events as a sign of life without changing Presence", async () => {
    const shlok = wrapper("shlok");
    const agent = await shlok.register("cccc0000-0000-4000-8000-000000000000");
    const before = await call("/api/agents", {
      headers: { Authorization: await bearer("shlok") },
    }).then((r) => r.json<AgentsResponse>());
    await new Promise((resolve) => setTimeout(resolve, 5));
    await shlok.hooks(agent, [hook("turn.end", { turn: 1 })]);
    const after = await call("/api/agents", {
      headers: { Authorization: await bearer("shlok") },
    }).then((r) => r.json<AgentsResponse>());
    expect(after.agents[0]?.presence).toBe("live");
    expect(Date.parse(after.agents[0]?.lastSeenAt ?? "")).toBeGreaterThan(
      Date.parse(before.agents[0]?.lastSeenAt ?? ""),
    );
  });

  it("refuses Events for another Person's Agent, for unknown Agents, and malformed ones", async () => {
    const shlok = wrapper("shlok");
    const sam = wrapper("sam");
    const agent = await shlok.register("dddd0000-0000-4000-8000-000000000000");
    const event = edit("secret.ts");

    const theirs = await sam.hooks(agent, [event]);
    expect(theirs).toMatchObject({ type: "hook.refused", ids: [event.id] });
    expect(theirs.type === "hook.refused" && theirs.reason).toContain(`Only Agent ${agent}'s own token`);

    expect(await shlok.hooks("shlok/claude/ffff", [event])).toMatchObject({ type: "hook.refused" });
    expect(await shlok.hooks(agent, [])).toMatchObject({ type: "hook.refused" });
    expect(await shlok.hooks(agent, [{ ...event, id: "not-a-uuid" }])).toMatchObject({ type: "hook.refused" });
    expect(
      await shlok.send({ type: "hook", agent, events: [{ id: eventId(), type: "claim", payload: {} }] }),
    ).toMatchObject({ type: "hook.refused" });
    expect(
      await shlok.send({ type: "hook", agent, events: [{ id: eventId(), type: "file.edit", payload: { path: "a" } }] }),
    ).toMatchObject({ type: "hook.refused" });

    expect(await shlok.hookEvents()).toEqual([]);
    expect(await shlok.files(agent)).toEqual([]);
  });
});

describe("an Agent's touched files", () => {
  it("lists each file the Agent edited once, most recently edited first, with its edit count", async () => {
    const shlok = wrapper("shlok");
    const agent = await shlok.register("eeee0000-0000-4000-8000-000000000000");
    expect(await shlok.files(agent)).toEqual([]);

    await shlok.hooks(agent, [edit("src/a.ts"), edit("src/b.ts")]);
    // Only file edits count: commands and other tool calls do not touch the list.
    await shlok.hooks(agent, [
      hook("command", { command: "rm src/c.ts" }),
      hook("tool.call", { tool: "Read", arg: "src/d.ts", ok: true }),
    ]);
    await shlok.hooks(agent, [edit("src/a.ts", 2, 2)]);

    expect(await shlok.files(agent)).toEqual([
      ["src/a.ts", 2],
      ["src/b.ts", 1],
    ]);
    const response = await shlok.touchedFiles(agent);
    const [a] = (await response.json<TouchedFilesResponse>()).files;
    expect(Date.parse(a?.lastEditedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(a?.firstEditedAt ?? ""));
  });

  it("keeps each Agent's list apart, and lets any Person read it", async () => {
    const shlok = wrapper("shlok");
    const sam = wrapper("sam");
    const mine = await shlok.register("1111aaaa-0000-4000-8000-000000000000");
    const other = await shlok.register("2222bbbb-0000-4000-8000-000000000000");
    const theirs = await sam.register("3333cccc-0000-4000-8000-000000000000");
    await shlok.hooks(mine, [edit("one.ts")]);
    await shlok.hooks(other, [edit("two.ts")]);
    await sam.hooks(theirs, [edit("three.ts")]);

    expect(await sam.files(mine)).toEqual([["one.ts", 1]]);
    expect(await sam.files(other)).toEqual([["two.ts", 1]]);
    expect(await shlok.files(theirs)).toEqual([["three.ts", 1]]);
  });

  it("answers 404 for an Agent the Channel does not know", async () => {
    const shlok = wrapper("shlok");
    const response = await shlok.touchedFiles("shlok/claude/0000");
    expect(response.status).toBe(404);
    expect((await response.json<ErrorResponse>()).reason).toContain("shlok/claude/0000");
  });
});

describe("the Task a Hook Event is about (#56)", () => {
  let github: FakeGitHub;
  beforeEach(() => {
    github = new FakeGitHub();
    installGitHub(github);
  });
  afterEach(() => installGitHub(null));

  /** A Task action as the Agent, the way its wrapper's tools call them. */
  async function act(path: string, agent: AgentId, body: unknown = {}): Promise<void> {
    const response = await call(path, {
      method: "POST",
      headers: { Authorization: await bearer({ person: "shlok", agent }), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  it("tags each Hook Event with the Task the Agent works on, following its Claims without a restart", async () => {
    github.open({ title: "Users page" });
    github.open({ title: "Settings page" });
    const shlok = wrapper("shlok");
    const agent = await shlok.register("5555eeee-0000-4000-8000-000000000000");
    const taskOf = async (event: HookEvent) => {
      await shlok.hooks(agent, [event]);
      return (await shlok.hookEvents()).find((e) => e.id === event.id)?.task ?? null;
    };

    // Holding no Task: none.
    expect(await taskOf(edit("README.md"))).toBeNull();
    // A Claim: its Task, on every kind of Hook Event.
    await act(claimPath(1), agent);
    expect(await taskOf(edit("src/users.ts"))).toBe(1);
    expect(await taskOf(hook("command", { command: "npm test" }))).toBe(1);
    expect(await taskOf(hook("turn.end", { turn: 1 }))).toBe(1);
    // A second Claim: the newest is the one it works on.
    await act(claimPath(2), agent);
    expect(await taskOf(edit("src/settings.ts"))).toBe(2);
    // Released: back to the one it still holds.
    await act(releasePath(2), agent);
    expect(await taskOf(edit("src/users.ts"))).toBe(1);
    // Finished: in review, the Claim stands until the PR merges, but the work is done.
    await act(branchPath(1), agent, { branch: taskBranch(1, "Users page") });
    await act(finishPath(1), agent);
    expect(await taskOf(edit("notes.md"))).toBeNull();
  });

  it("tags another Agent's Events with its own Task, not this one's", async () => {
    github.open({ title: "Users page" });
    const shlok = wrapper("shlok");
    const mine = await shlok.register("6666ffff-0000-4000-8000-000000000000");
    const other = await shlok.register("7777aaaa-0000-4000-8000-000000000000");
    await act(claimPath(1), mine);
    const event = edit("src/other.ts");
    await shlok.hooks(other, [event]);
    expect((await shlok.hookEvents()).find((e) => e.id === event.id)?.task).toBeUndefined();
  });
});
