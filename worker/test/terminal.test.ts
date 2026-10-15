// An Agent's live terminal through the Channel (ADR 0021), driven over the same sockets
// the Dashboard and the wrappers open. The Channel carries screens to watchers and input
// to the Agent's wrapper; what is checked is who it carries them from and to, since it
// must never let one socket speak for another Agent's terminal.

import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, AgentResponse, ChannelEvent, HistoryResponse } from "../../shared/src/index";
import { InputRate } from "../src/terminal";
import { bearer, forgetTokens, remember, streamQuery, url } from "./client";

type Frame = { type: string; agent?: string; [key: string]: unknown };

const open: Socket[] = [];
let sessions = 0;

/** One WebSocket to the Channel, keeping every frame it receives. */
class Socket {
  readonly frames: Frame[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (m) => {
      try {
        this.frames.push(JSON.parse(m.data as string) as Frame);
      } catch {
        // The keepalive answer.
      }
    });
  }

  /** A Person's Dashboard socket, or with `agent` that Agent's wrapper socket. */
  static async open(person: string, agent?: AgentId): Promise<Socket> {
    const query = await streamQuery(agent === undefined ? person : { person, agent });
    const response = await exports.default.fetch(
      new Request(url(`/api/stream?${query}`), { headers: { Upgrade: "websocket" } }),
    );
    const ws = response.webSocket;
    if (!ws) throw new Error("No WebSocket");
    ws.accept();
    const socket = new Socket(ws);
    open.push(socket);
    return socket;
  }

  send(frame: Frame): void {
    this.ws.send(JSON.stringify(frame));
  }

  of(type: string): Frame[] {
    return this.frames.filter((f) => f.type === type);
  }

  close(): void {
    this.ws.close();
  }
}

/** Registers an Agent of `person` and opens its wrapper's socket, attached for Interrupts. */
async function wrapper(person: string): Promise<{ id: AgentId; socket: Socket }> {
  sessions += 1;
  const response = await exports.default.fetch(
    new Request(url("/api/agents"), {
      method: "POST",
      headers: { Authorization: await bearer(person), "Content-Type": "application/json" },
      body: JSON.stringify({
        cli: "claude-code",
        sessionId: `${sessions.toString(16).padStart(4, "0")}eeee-0000-4000-8000-000000000000`,
        resumed: false,
        cwd: "/r",
        interrupts: true,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const id = remember(await response.json<AgentResponse>()).agent.id;
  const socket = await Socket.open(person, id);
  socket.send({ type: "interrupt.attach", agent: id });
  await waitFor(() => (socket.of("interrupt.attached").length > 0 ? true : undefined));
  return { id, socket };
}

async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The watcher counts a wrapper has been told, in order. */
const counts = (socket: Socket) => socket.of("terminal.watchers").map((f) => f.count);

/** Waits until the wrapper was last told `count`. */
const told = (socket: Socket, count: number) => waitFor(() => (counts(socket).at(-1) === count ? true : undefined));

const screen = (agent: AgentId, text: string): Frame => ({
  type: "terminal.screen",
  agent,
  nonce: "n0nce",
  cols: 20,
  rows: 2,
  lines: [text, ""],
  cursor: { x: 0, y: 1 },
  attached: [],
  prompt: false,
  paste: false,
  holder: { person: "alice", key: null },
});

async function events(): Promise<ChannelEvent[]> {
  const response = await exports.default.fetch(
    new Request(url("/api/events"), { headers: { Authorization: await bearer("dashboard") } }),
  );
  return (await response.json<HistoryResponse>()).events;
}

afterEach(async () => {
  for (const socket of open.splice(0)) socket.close();
  forgetTokens();
  await reset();
});

describe("Watching an Agent's terminal", () => {
  it("tells the wrapper how many sockets watch and whose, as they come, go and close", async () => {
    const { id, socket: agent } = await wrapper("alice");
    expect(counts(agent)).toEqual([0]);
    const bob = await Socket.open("bob");
    const carol = await Socket.open("carol");
    bob.send({ type: "terminal.watch", agent: id, on: true });
    await told(agent, 1);
    carol.send({ type: "terminal.watch", agent: id, on: true });
    // A second socket of bob's counts, and names him once.
    const bobAgain = await Socket.open("bob");
    bobAgain.send({ type: "terminal.watch", agent: id, on: true });
    await told(agent, 3);
    expect(agent.of("terminal.watchers").at(-1)?.persons).toEqual(["bob", "carol"]);
    bobAgain.close();
    await told(agent, 2);
    carol.send({ type: "terminal.watch", agent: id, on: false });
    await told(agent, 1);
    bob.close();
    await told(agent, 0);
  });

  it("tells a wrapper that attaches later that someone already watches", async () => {
    const { id, socket: first } = await wrapper("alice");
    const bob = await Socket.open("bob");
    bob.send({ type: "terminal.watch", agent: id, on: true });
    await told(first, 1);
    // The wrapper restarted: its new socket attaches for the same Agent.
    const again = await Socket.open("alice", id);
    again.send({ type: "interrupt.attach", agent: id });
    await waitFor(() => (again.of("terminal.watchers").length > 0 ? true : undefined));
    expect(counts(again)).toEqual([1]);
    expect(again.of("terminal.watchers")[0]?.persons).toEqual(["bob"]);
  });

  it("lets one socket watch at most 16 Agents at once", async () => {
    const first = await wrapper("alice");
    const agents = [first];
    for (let i = 1; i < 16; i++) agents.push(await wrapper("alice"));
    const last = await wrapper("alice");
    const bob = await Socket.open("bob");
    for (const { id, socket } of agents) {
      bob.send({ type: "terminal.watch", agent: id, on: true });
      await told(socket, 1);
    }
    bob.send({ type: "terminal.watch", agent: last.id, on: true });
    // Stopping one makes room: the 17th is counted only once the first is let go.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(counts(last.socket)).toEqual([0]);
    bob.send({ type: "terminal.watch", agent: first.id, on: false });
    await told(first.socket, 0);
    bob.send({ type: "terminal.watch", agent: last.id, on: true });
    await told(last.socket, 1);
  });

  it("carries the wrapper's screen to the sockets that watch it, and to no other", async () => {
    const { id, socket: agent } = await wrapper("alice");
    const bob = await Socket.open("bob");
    const carol = await Socket.open("carol");
    bob.send({ type: "terminal.watch", agent: id, on: true });
    await told(agent, 1);
    agent.send({ ...screen(id, "$ npm test"), extra: "dropped" });
    await waitFor(() => (bob.of("terminal.screen").length > 0 ? true : undefined));
    expect(bob.of("terminal.screen")).toEqual([screen(id, "$ npm test")]);
    // Carol's socket is open and receives Events, but not the screen she did not ask for.
    await waitFor(() => (carol.of("agent").length > 0 ? true : undefined));
    expect(carol.of("terminal.screen")).toEqual([]);
  });

  it("carries a screen only from the Agent's own wrapper", async () => {
    const { id, socket: agent } = await wrapper("alice");
    const { socket: other } = await wrapper("alice");
    const bob = await Socket.open("bob");
    bob.send({ type: "terminal.watch", agent: id, on: true });
    await told(agent, 1);
    other.send(screen(id, "forged by another Agent"));
    bob.send(screen(id, "forged by a Person"));
    const alice = await Socket.open("alice");
    alice.send(screen(id, "forged by the owner's Dashboard"));
    agent.send(screen(id, "the real one"));
    await waitFor(() => (bob.of("terminal.screen").length > 0 ? true : undefined));
    // Frames from one socket arrive in order; give the forgeries time to arrive too.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bob.of("terminal.screen").map((f) => (f.lines as string[])[0])).toEqual(["the real one"]);
  });

  it("drops a screen that is not well formed", async () => {
    const { id, socket: agent } = await wrapper("alice");
    const bob = await Socket.open("bob");
    bob.send({ type: "terminal.watch", agent: id, on: true });
    await told(agent, 1);
    agent.send({ ...screen(id, "x"), lines: ["a", "b", "too many rows"] });
    agent.send({ ...screen(id, "x"), cols: 0 });
    agent.send({ ...screen(id, "x"), prompt: "yes" });
    agent.send({ ...screen(id, "x"), paste: "yes" });
    agent.send({ ...screen(id, "x"), holder: { person: "bob", key: 7 } });
    agent.send({ ...screen(id, "x"), holder: "bob" });
    agent.send({ ...screen(id, "x"), attached: [{ person: 3, key: "ABCD" }] });
    agent.send(screen(id, "fine"));
    await waitFor(() => (bob.of("terminal.screen").length > 0 ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bob.of("terminal.screen").map((f) => (f.lines as string[])[0])).toEqual(["fine"]);
  });
});

describe("Typing into an Agent's terminal", () => {
  const input = (agent: AgentId, seq: number): Frame => ({
    type: "terminal.input",
    agent,
    key: "AAAA",
    seq,
    text: "y\r",
    sig: "BBBB",
  });

  it("carries a Person's input to the Agent's wrapper, naming the Person's socket it came from", async () => {
    const { id, socket: agent } = await wrapper("alice");
    const bob = await Socket.open("bob");
    bob.send({ ...input(id, 1), from: "alice" });
    await waitFor(() => (agent.of("terminal.input").length > 0 ? true : undefined));
    expect(agent.of("terminal.input")).toEqual([{ ...input(id, 1), from: "bob" }]);
  });

  it("carries a take or a release of the keyboard, without text, and nothing in between", async () => {
    const { id, socket: agent } = await wrapper("alice");
    const bob = await Socket.open("bob");
    bob.send({ ...input(id, 1), op: "take", text: "y" });
    bob.send({ ...input(id, 2), op: "grab", text: "" });
    bob.send({ ...input(id, 3), text: "" });
    bob.send({ ...input(id, 4), op: "take", text: "" });
    bob.send({ ...input(id, 5), op: "release", text: "" });
    await waitFor(() => (agent.of("terminal.input").length >= 2 ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(agent.of("terminal.input")).toEqual([
      { ...input(id, 4), op: "take", text: "", from: "bob" },
      { ...input(id, 5), op: "release", text: "", from: "bob" },
    ]);
  });

  it("carries input only from a Person's own socket, never a wrapper's", async () => {
    const { id, socket: agent } = await wrapper("alice");
    const { socket: other } = await wrapper("bob");
    other.send(input(id, 1));
    const bob = await Socket.open("bob");
    bob.send(input(id, 2));
    await waitFor(() => (agent.of("terminal.input").length > 0 ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(agent.of("terminal.input").map((f) => f.seq)).toEqual([2]);
  });

  it("tells the sender when the Agent's wrapper is not connected", async () => {
    const { id, socket: agent } = await wrapper("alice");
    agent.close();
    const bob = await Socket.open("bob");
    await new Promise((resolve) => setTimeout(resolve, 50));
    bob.send(input(id, 7));
    const [refused] = await waitFor(() =>
      bob.of("terminal.refused").length > 0 ? bob.of("terminal.refused") : undefined,
    );
    expect(refused).toEqual({
      type: "terminal.refused",
      agent: id,
      fingerprint: "",
      seq: 7,
      reason: "the Agent's wrapper is not connected",
    });
  });

  it("refuses frames past the limit a second, and tells the sender", async () => {
    const { id, socket: agent } = await wrapper("alice");
    const bob = await Socket.open("bob");
    for (let seq = 1; seq <= 200; seq++) bob.send(input(id, seq));
    await waitFor(() => (bob.of("terminal.refused").length > 0 ? true : undefined));
    await waitFor(() =>
      agent.of("terminal.input").length + bob.of("terminal.refused").length === 200 ? true : undefined,
    );
    // 200 frames sent at once span at most a few seconds, at 50 each.
    expect(agent.of("terminal.input").length).toBeLessThan(200);
    expect(bob.of("terminal.refused")[0]?.reason).toMatch(/too many keystrokes/);
  });

  it("allows a socket 50 frames in each second, counting again in the next", () => {
    const rate = new InputRate();
    const socket = {};
    const other = {};
    const taken = Array.from({ length: 60 }, () => rate.take(socket, 5_000));
    expect(taken.filter(Boolean)).toHaveLength(50);
    expect(taken.slice(0, 50).every(Boolean)).toBe(true);
    expect(rate.take(other, 5_999)).toBe(true);
    expect(rate.take(socket, 5_999)).toBe(false);
    expect(rate.take(socket, 6_000)).toBe(true);
  });
});

describe("Who is attached", () => {
  it("records the wrapper's terminal.attached as an Event of its Agent", async () => {
    const { id, socket: agent } = await wrapper("alice");
    agent.send({ type: "terminal.attached", agent: id, person: "bob", key: "K7QX" });
    const event = await waitFor(async () => (await events()).find((e) => e.type === "terminal.attached"));
    expect(event).toMatchObject({
      type: "terminal.attached",
      actor: { kind: "agent", agentId: id },
      payload: { agent: id, person: "bob", key: "K7QX" },
    });
  });

  it("records it only from the Agent's own wrapper", async () => {
    const { id, socket: agent } = await wrapper("alice");
    const { socket: other } = await wrapper("alice");
    other.send({ type: "terminal.attached", agent: id, person: "mallory", key: "AAAA" });
    const alice = await Socket.open("alice");
    alice.send({ type: "terminal.attached", agent: id, person: "mallory", key: "BBBB" });
    agent.send({ type: "terminal.attached", agent: id, person: "bob", key: "K7QX" });
    await waitFor(async () => ((await events()).some((e) => e.type === "terminal.attached") ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const attached = (await events()).filter((e) => e.type === "terminal.attached");
    expect(attached.map((e) => (e.payload as { person: string }).person)).toEqual(["bob"]);
  });
});
