// Agents and Presence, driven through the public Channel API the way the laptop
// wrapper and the Dashboard use it, against the real Worker and the real Channel
// Durable Object running in memory.

import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentId,
  AgentResponse,
  AgentsResponse,
  ChannelEvent,
  ErrorResponse,
  HistoryResponse,
  RegisterAgentRequest,
  ReportedPresence,
  StreamMessage,
  TaskListResponse,
} from "../../shared/src/index";
import { agentPath } from "../../shared/src/index";
import { installGitHub } from "../src/github/index";
import { FakeGitHub } from "./fake-github";

const SECRET = "test-join-secret";
const BASE = "https://switchboard.test";
const TEN_MINUTES = 10 * 60_000;

function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

/** Summarizes an Agent's Event as [type, Agent ID, detail] for readable assertions. */
function brief(event: ChannelEvent): [string, string | null, unknown] {
  const agent = event.actor.kind === "agent" ? event.actor.agentId : null;
  switch (event.type) {
    case "presence":
      return [event.type, agent, event.payload.presence];
    case "session.start":
      return [event.type, agent, event.payload.resumed ? "resumed" : "new"];
    case "session.end":
      return [event.type, agent, event.payload.reason];
    default:
      return [event.type, agent, null];
  }
}

/** A fake laptop wrapper (or Dashboard) acting for one Person. */
class FakePerson {
  readonly received: StreamMessage[] = [];
  private socket: WebSocket | null = null;

  constructor(readonly name: string) {}

  private post(path: string, body: unknown): Promise<Response> {
    return call(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "X-Switchboard-Person": this.name },
      body: JSON.stringify(body),
    });
  }

  register(sessionId: string, extra: Partial<RegisterAgentRequest> = {}): Promise<Response> {
    return this.post("/api/agents", { cli: "claude-code", sessionId, resumed: false, cwd: "/repo", ...extra });
  }

  async registered(sessionId: string, extra: Partial<RegisterAgentRequest> = {}): Promise<Agent> {
    const response = await this.register(sessionId, extra);
    expect(response.status).toBe(200);
    return (await response.json<AgentResponse>()).agent;
  }

  heartbeat(id: AgentId, presence: ReportedPresence): Promise<Response> {
    return this.post(`${agentPath(id)}/heartbeat`, { presence });
  }

  end(id: AgentId): Promise<Response> {
    return this.post(`${agentPath(id)}/end`, {});
  }

  async agents(): Promise<Agent[]> {
    const response = await call("/api/agents", {
      headers: { Authorization: `Bearer ${SECRET}`, "X-Switchboard-Person": this.name },
    });
    expect(response.status).toBe(200);
    return (await response.json<AgentsResponse>()).agents;
  }

  /** The Channel's Events that name an Agent, oldest first. */
  async agentEvents(): Promise<ChannelEvent[]> {
    const response = await call("/api/events", {
      headers: { Authorization: `Bearer ${SECRET}`, "X-Switchboard-Person": this.name },
    });
    return (await response.json<HistoryResponse>()).events.filter((e) => e.actor.kind === "agent");
  }

  async subscribe(): Promise<void> {
    const query = new URLSearchParams({ secret: SECRET, person: this.name });
    const response = await call(`/api/stream?${query}`, { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("No WebSocket in the upgrade response");
    socket.accept();
    socket.addEventListener("message", (message) => {
      this.received.push(JSON.parse(message.data as string) as StreamMessage);
    });
    this.socket = socket;
  }

  /** The latest Agent state the stream sent for `id`. */
  async waitForAgent(id: AgentId, presence: Agent["presence"]): Promise<Agent> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const last = this.received.flatMap((m) => (m.type === "agent" && m.agent.id === id ? [m.agent] : [])).at(-1);
      if (last?.presence === presence) return last;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id} to be ${presence}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  close(): void {
    this.socket?.close();
  }
}

const people: FakePerson[] = [];
function person(name: string): FakePerson {
  const fake = new FakePerson(name);
  people.push(fake);
  return fake;
}

/** Lets time pass for the Channel as well as the test: they share one isolate. */
function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

function channelStub() {
  return env.CHANNEL.get(env.CHANNEL.idFromName("main"));
}

afterEach(async () => {
  vi.useRealTimers();
  installGitHub(null);
  for (const p of people.splice(0)) p.close();
  await reset();
});

describe("registering an Agent", () => {
  it("names the Agent after its Person, CLI and session, and marks it Live", async () => {
    const shlok = person("shlok");
    const agent = await shlok.registered("7F3A9C2E-0000-4000-8000-000000000001", { nickname: "scout" });

    expect(agent).toMatchObject({
      id: "shlok/claude/7f3a",
      person: "shlok",
      cli: "claude-code",
      nickname: "scout",
      presence: "live",
    });
    expect(await shlok.agents()).toEqual([agent]);
    expect((await shlok.agentEvents()).map(brief)).toEqual([
      ["session.start", "shlok/claude/7f3a", "new"],
      ["presence", "shlok/claude/7f3a", "live"],
    ]);
    const [start] = await shlok.agentEvents();
    expect(start).toMatchObject({ capture: "hook", payload: { cwd: "/repo" } });
  });

  it("joins the Person to the Channel on first registration", async () => {
    const sam = person("sam");
    await sam.registered("abcd0000-0000-4000-8000-000000000000");
    const response = await call("/api/events", {
      headers: { Authorization: `Bearer ${SECRET}`, "X-Switchboard-Person": "sam" },
    });
    const events = (await response.json<HistoryResponse>()).events;
    expect(events[0]).toMatchObject({ type: "person.join", actor: { kind: "person", person: "sam" } });
  });

  it("gives two sessions running side by side two Agents", async () => {
    const shlok = person("shlok");
    const first = await shlok.registered("aaaa1111-0000-4000-8000-000000000000");
    const second = await shlok.registered("bbbb2222-0000-4000-8000-000000000000");
    expect([first.id, second.id]).toEqual(["shlok/claude/aaaa", "shlok/claude/bbbb"]);
    expect((await shlok.agents()).map((a) => [a.id, a.presence]).sort()).toEqual([
      ["shlok/claude/aaaa", "live"],
      ["shlok/claude/bbbb", "live"],
    ]);
  });

  it("refuses a second session whose Agent ID is taken, naming the ID", async () => {
    const shlok = person("shlok");
    await shlok.registered("cafe0000-0000-4000-8000-000000000001");
    const clash = await shlok.register("cafe0000-0000-4000-8000-000000000002");
    expect(clash.status).toBe(409);
    expect((await clash.json<ErrorResponse>()).reason).toContain("shlok/claude/cafe");
  });

  it("keeps Agents of different Persons apart even with the same session prefix", async () => {
    const a = await person("shlok").registered("1234aaaa-0000-4000-8000-000000000000");
    const b = await person("sam").registered("1234bbbb-0000-4000-8000-000000000000");
    expect([a.id, b.id]).toEqual(["shlok/claude/1234", "sam/claude/1234"]);
  });

  it("refuses malformed registrations and wrong secrets", async () => {
    const shlok = person("shlok");
    expect((await shlok.register("")).status).toBe(400);
    expect((await shlok.register("has spaces in it")).status).toBe(400);
    expect((await shlok.register("abcd-1234", { cli: "vim" as never })).status).toBe(400);
    expect((await shlok.register("abcd-1234", { nickname: "x".repeat(41) })).status).toBe(400);
    const wrong = await call("/api/agents", {
      method: "POST",
      headers: { Authorization: "Bearer nope", "X-Switchboard-Person": "shlok" },
      body: JSON.stringify({ cli: "claude-code", sessionId: "abcd-1234" }),
    });
    expect(wrong.status).toBe(401);
    expect(await shlok.agents()).toEqual([]);
  });
});

describe("resuming a session", () => {
  it("keeps the same Agent ID and brings the Agent back Live", async () => {
    const shlok = person("shlok");
    const session = "5e55e55e-0000-4000-8000-000000000000";
    const agent = await shlok.registered(session, { nickname: "scout" });
    expect((await shlok.end(agent.id)).status).toBe(200);

    const resumed = await shlok.registered(session, { resumed: true });
    expect(resumed).toMatchObject({ id: agent.id, presence: "live", nickname: "scout", startedAt: agent.startedAt });
    expect(await shlok.agents()).toHaveLength(1);
    expect((await shlok.agentEvents()).map(brief)).toEqual([
      ["session.start", agent.id, "new"],
      ["presence", agent.id, "live"],
      ["session.end", agent.id, "exit"],
      ["presence", agent.id, "gone"],
      ["session.start", agent.id, "resumed"],
      ["presence", agent.id, "live"],
    ]);
  });

  it("lets a resume change or clear the Nickname", async () => {
    const shlok = person("shlok");
    const session = "a1b2c3d4-0000-4000-8000-000000000000";
    await shlok.registered(session, { nickname: "scout" });
    expect((await shlok.registered(session, { resumed: true, nickname: "ranger" })).nickname).toBe("ranger");
    expect((await shlok.registered(session, { resumed: true, nickname: null })).nickname).toBeUndefined();
  });
});

describe("Presence", () => {
  it("follows the wrapper's heartbeats between Live and Idle, recording only changes", async () => {
    const shlok = person("shlok");
    const { id } = await shlok.registered("1d1e0000-0000-4000-8000-000000000000");

    for (const presence of ["live", "idle", "idle", "live"] as const) {
      const response = await shlok.heartbeat(id, presence);
      expect(response.status).toBe(200);
      expect((await response.json<AgentResponse>()).agent.presence).toBe(presence);
    }
    expect((await shlok.agentEvents()).map(brief)).toEqual([
      ["session.start", id, "new"],
      ["presence", id, "live"],
      ["presence", id, "idle"],
      ["presence", id, "live"],
    ]);
  });

  it("sends Presence changes live, and the roster to every new subscriber", async () => {
    const shlok = person("shlok");
    const { id } = await shlok.registered("50c1e700-0000-4000-8000-000000000000");
    const sam = person("sam");
    await sam.subscribe();
    await sam.waitForAgent(id, "live");

    await shlok.heartbeat(id, "idle");
    await sam.waitForAgent(id, "idle");
    await shlok.end(id);
    await sam.waitForAgent(id, "gone");
  });

  it("marks an Agent Gone when its session ends, once", async () => {
    const shlok = person("shlok");
    const { id } = await shlok.registered("e0d00000-0000-4000-8000-000000000000");
    expect((await shlok.end(id)).status).toBe(200);
    expect((await shlok.end(id)).status).toBe(200);
    expect((await shlok.agents())[0]?.presence).toBe("gone");
    expect((await shlok.agentEvents()).filter((e) => e.type === "presence").map(brief)).toEqual([
      ["presence", id, "live"],
      ["presence", id, "gone"],
    ]);
  });

  it("only lets an Agent's own Person heartbeat or end it", async () => {
    const { id } = await person("shlok").registered("0a0a0000-0000-4000-8000-000000000000");
    const sam = person("sam");
    const heartbeat = await sam.heartbeat(id, "idle");
    expect(heartbeat.status).toBe(403);
    expect((await heartbeat.json<ErrorResponse>()).reason).toBe(`Agent ${id} belongs to shlok.`);
    expect((await sam.end(id)).status).toBe(403);
    expect((await sam.agents())[0]?.presence).toBe("live");
  });

  it("answers 404 to a heartbeat for an Agent it does not know, so the wrapper registers again", async () => {
    const response = await person("shlok").heartbeat("shlok/claude/ffff", "live");
    expect(response.status).toBe(404);
    expect((await call("/api/agents/not-an-id/heartbeat", { method: "POST" })).status).toBe(404);
  });
});

describe("going Gone after silence", () => {
  it("marks a silent Agent Gone from the alarm, and keeps Agents that heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const shlok = person("shlok");
    const quiet = await shlok.registered("91e70000-0000-4000-8000-000000000000");
    const chatty = await shlok.registered("c4a70000-0000-4000-8000-000000000000");

    advance(TEN_MINUTES / 2);
    await shlok.heartbeat(chatty.id, "idle");
    // Nobody has been silent for ten minutes yet.
    advance(TEN_MINUTES / 2 - 1000);
    expect(await runDurableObjectAlarm(channelStub())).toBe(true);
    expect((await shlok.agents()).map((a) => [a.id, a.presence]).sort()).toEqual([
      [quiet.id, "live"],
      [chatty.id, "idle"],
    ]);

    advance(2000);
    expect(await runDurableObjectAlarm(channelStub())).toBe(true);
    expect((await shlok.agents()).map((a) => [a.id, a.presence]).sort()).toEqual([
      [quiet.id, "gone"],
      [chatty.id, "idle"],
    ]);
    const gone = (await shlok.agentEvents()).at(-1);
    expect(gone).toMatchObject({ type: "presence", capture: null, payload: { presence: "gone" } });
    expect(gone?.actor).toEqual({ kind: "agent", agentId: quiet.id });

    // The chatty Agent goes silent too; the alarm set itself for it.
    advance(TEN_MINUTES);
    expect(await runDurableObjectAlarm(channelStub())).toBe(true);
    expect((await shlok.agents()).every((a) => a.presence === "gone")).toBe(true);
    // With everyone Gone there is nothing left to watch.
    expect(await runDurableObjectAlarm(channelStub())).toBe(false);
  });

  it("brings a Gone Agent back when it heartbeats again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const shlok = person("shlok");
    const { id } = await shlok.registered("b0b00000-0000-4000-8000-000000000000");
    advance(TEN_MINUTES + 1000);
    await runDurableObjectAlarm(channelStub());
    expect((await shlok.agents())[0]?.presence).toBe("gone");

    const response = await shlok.heartbeat(id, "live");
    expect((await response.json<AgentResponse>()).agent.presence).toBe("live");
    expect((await shlok.agentEvents()).map(brief).slice(-2)).toEqual([
      ["presence", id, "gone"],
      ["presence", id, "live"],
    ]);
  });
});

describe("sharing the Channel's one alarm with the Task reconcile", () => {
  it("runs the Presence check and the reconcile from the same alarm, each on its own schedule", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const github = new FakeGitHub();
    installGitHub(github);
    const shlok = person("shlok");
    const headers = { Authorization: `Bearer ${SECRET}`, "X-Switchboard-Person": "shlok" };
    const titles = async () =>
      (await (await call("/api/tasks", { headers })).json<TaskListResponse>()).tasks.map((t) => t.title);
    const presence = async (id: AgentId) => (await shlok.agents()).find((a) => a.id === id)?.presence;

    // Reading Tasks schedules the reconcile (every 5 minutes); the Agent schedules its silence check.
    expect(await titles()).toEqual([]);
    const { id } = await shlok.registered("a1a70000-0000-4000-8000-000000000000");
    github.open({ title: "Opened while no webhook arrived" });

    // Five minutes on: the reconcile is due, the Agent is not silent yet.
    advance(5 * 60_000 + 1000);
    expect(await runDurableObjectAlarm(channelStub())).toBe(true);
    expect(await titles()).toEqual(["Opened while no webhook arrived"]);
    expect(await presence(id)).toBe("live");

    // Ten minutes after its last heartbeat the Agent is Gone, and the reconcile still runs on its own schedule.
    github.open({ title: "Another one" });
    advance(5 * 60_000);
    expect(await runDurableObjectAlarm(channelStub())).toBe(true);
    expect(await presence(id)).toBe("gone");
    expect(await titles()).toEqual(["Opened while no webhook arrived", "Another one"]);
  });
});
