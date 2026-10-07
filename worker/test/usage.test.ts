// Usage (ADR 0011): the wrapper sends each Agent's `/usage` reading and session
// tokens with its heartbeat; the Channel keeps the Agent's latest report and each
// account's readings for a day, and serves both to the Dashboard. Driven through the
// public Channel API, against the real Worker and Channel Durable Object.

import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AccountsResponse,
  Agent,
  AgentId,
  AgentResponse,
  AgentsResponse,
  ReportedUsage,
  StreamMessage,
} from "../../shared/src/index";
import { agentPath } from "../../shared/src/index";
import { type As, bearer, forgetTokens, remember, streamQuery, url } from "./client";

function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(url(path), init));
}

async function post(as: As | string, path: string, body: unknown): Promise<Response> {
  return call(path, { method: "POST", headers: { Authorization: await bearer(as) }, body: JSON.stringify(body) });
}

async function register(person: string, sessionId: string, usage?: unknown): Promise<Agent> {
  const response = await post(person, "/api/agents", {
    cli: "claude-code",
    sessionId,
    resumed: false,
    cwd: "/repo",
    ...(usage === undefined ? {} : { usage }),
  });
  expect(response.status).toBe(200);
  return remember(await response.json<AgentResponse>()).agent;
}

async function heartbeat(agent: Agent, usage?: unknown): Promise<Agent> {
  const response = await post({ person: agent.person, agent: agent.id }, `${agentPath(agent.id)}/heartbeat`, {
    presence: "live",
    ...(usage === undefined ? {} : { usage }),
  });
  expect(response.status).toBe(200);
  return (await response.json<AgentResponse>()).agent;
}

async function accounts(as: As | string): Promise<AccountsResponse["accounts"]> {
  const response = await call("/api/accounts", { headers: { Authorization: await bearer(as) } });
  expect(response.status).toBe(200);
  return (await response.json<AccountsResponse>()).accounts;
}

async function agentNamed(as: string, id: AgentId): Promise<Agent | undefined> {
  const response = await call("/api/agents", { headers: { Authorization: await bearer(as) } });
  return (await response.json<AgentsResponse>()).agents.find((a) => a.id === id);
}

/** A `/usage` reading for an account, as the wrapper reports it. */
function reading(at: number, session: number, week = 44): ReportedUsage {
  return {
    email: "shlokthakkar1806@gmail.com",
    plan: "max",
    limits: {
      readAt: new Date(at).toISOString(),
      session: { percent: session, resetsAt: "2026-10-07T06:59:00.000Z", resets: "Oct 7 at 1:59am (America/Chicago)" },
      week: { percent: week, resetsAt: "2026-10-07T10:59:00.000Z" },
      models: [{ model: "Fable", percent: 32, resetsAt: "2026-10-07T10:59:00.000Z" }],
    },
    session: {
      requests: 12,
      inputTokens: 300,
      outputTokens: 4500,
      cacheReadTokens: 90000,
      cacheWriteTokens: 8000,
      costUsd: 0.42,
    },
  };
}

async function subscribe(person: string): Promise<{ received: StreamMessage[]; close: () => void }> {
  const response = await call(`/api/stream?${await streamQuery(person)}`, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new Error("No WebSocket in the upgrade response");
  socket.accept();
  const received: StreamMessage[] = [];
  socket.addEventListener("message", (m) => received.push(JSON.parse(m.data as string) as StreamMessage));
  return { received, close: () => socket.close() };
}

async function waitFor<T>(find: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  vi.useRealTimers();
  forgetTokens();
  await reset();
});

describe("Usage on the Channel (ADR 0011)", () => {
  it("keeps the latest reading on the Agent, serves it, and tells the stream", async () => {
    const watcher = await subscribe("ana");
    const agent = await register("shlok", "aaaa0000-0000-4000-8000-000000000001");
    const now = Date.now();
    const after = await heartbeat(agent, reading(now, 80));

    expect(after.usage).toMatchObject({
      email: "shlokthakkar1806@gmail.com",
      plan: "max",
      limits: { session: { percent: 80 } },
    });
    expect(after.usage?.session).toEqual(reading(now, 80).session);
    expect(Date.parse(after.usage?.reportedAt ?? "")).toBeGreaterThanOrEqual(now);
    expect((await agentNamed("ana", agent.id))?.usage?.limits?.models).toEqual([
      { model: "Fable", percent: 32, resetsAt: "2026-10-07T10:59:00.000Z" },
    ]);

    const streamed = await waitFor(() => watcher.received.find((m) => m.type === "account"));
    expect(streamed).toMatchObject({ type: "account", account: { email: "shlokthakkar1806@gmail.com", plan: "max" } });
    await waitFor(() =>
      watcher.received.find((m) => m.type === "agent" && m.agent.usage?.limits?.session?.percent === 80),
    );

    // A heartbeat without a reading, and a wrapper older than ADR 0011 registering again, keep it.
    await heartbeat(agent);
    await register("shlok", "aaaa0000-0000-4000-8000-000000000001");
    expect((await agentNamed("shlok", agent.id))?.usage?.limits?.session?.percent).toBe(80);
    watcher.close();
  });

  it("builds each account's history from every Agent on it, once per reading, over the last day", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-07T05:00:00Z"), toFake: ["Date"] });
    const one = await register("shlok", "bbbb0000-0000-4000-8000-000000000001");
    const two = await register("shlok", "b2bb0000-0000-4000-8000-000000000002");
    const first = Date.now();
    await heartbeat(one, reading(first, 70));
    // The second Agent on the account read the same `/usage` run: one point, not two.
    await heartbeat(two, reading(first, 70));
    vi.setSystemTime(first + 5 * 60_000);
    await heartbeat(two, reading(first + 5 * 60_000, 75, 45));

    const [account] = await accounts({ person: "shlok", agent: one.id });
    expect(account?.limits.session?.percent).toBe(75);
    expect(account?.history).toEqual([
      { at: new Date(first).toISOString(), session: 70, week: 44 },
      { at: new Date(first + 5 * 60_000).toISOString(), session: 75, week: 45 },
    ]);

    // A day later the old readings are gone, and a new one starts the history again.
    vi.setSystemTime(first + 25 * 60 * 60_000);
    expect(await accounts("shlok")).toEqual([]);
    // The Agent went Gone meanwhile, so its wrapper registers again, with the new reading.
    await register("shlok", "bbbb0000-0000-4000-8000-000000000001", reading(Date.now(), 5, 50));
    expect((await accounts("shlok")).map((a) => a.history.map((p) => p.session))).toEqual([[5]]);
  });

  it("keeps an Agent's account readings apart from another account's", async () => {
    const work = await register("shlok", "cccc0000-0000-4000-8000-000000000001");
    const home = await register("shlok", "c2cc0000-0000-4000-8000-000000000002");
    await heartbeat(work, { ...reading(Date.now(), 10), email: "shlokat2@illinois.edu", plan: "pro" });
    await heartbeat(home, reading(Date.now() + 1, 90));
    expect((await accounts("ana")).map((a) => [a.email, a.plan, a.limits.session?.percent])).toEqual([
      ["shlokthakkar1806@gmail.com", "max", 90],
      ["shlokat2@illinois.edu", "pro", 10],
    ]);
  });

  it("keeps the heartbeat when a reading does not parse, and keeps only the parts that do", async () => {
    const agent = await register("shlok", "dddd0000-0000-4000-8000-000000000001");
    expect((await heartbeat(agent, "80%")).usage).toBeUndefined();
    const partial = await heartbeat(agent, {
      email: "shlokthakkar1806@gmail.com",
      limits: { readAt: "not a time", session: { percent: 80 } },
      session: { requests: 3, inputTokens: 10, outputTokens: "lots" },
    });
    expect(partial.usage).toMatchObject({ email: "shlokthakkar1806@gmail.com" });
    expect(partial.usage?.limits).toBeUndefined();
    expect(partial.usage?.session).toBeUndefined();
    // Without a reading of its limits, the account has no history to show.
    expect(await accounts("shlok")).toEqual([]);
  });

  it("takes a reading sent with the registration", async () => {
    const agent = await register("shlok", "eeee0000-0000-4000-8000-000000000001", reading(Date.now(), 33));
    expect(agent.usage?.limits?.session?.percent).toBe(33);
    expect((await accounts("shlok"))[0]?.limits.session?.percent).toBe(33);
  });
});

describe("Context Reading on the Channel (ADR 0012)", () => {
  it("stores and broadcasts every context heartbeat while retaining it for older wrappers", async () => {
    const watcher = await subscribe("ana");
    const agent = await register("shlok", "ffff0000-0000-4000-8000-000000000001");
    const context = {
      readAt: new Date().toISOString(),
      tokens: 170000,
      window: 200000,
      autoCompactions: 2,
      task: "Fix redirect",
      brief: "Fix redirect\nFull brief",
      activity: "Tool: Read",
      cwd: "/repo",
      branch: "fix",
    };
    const response = await post({ person: agent.person, agent: agent.id }, `${agentPath(agent.id)}/heartbeat`, {
      presence: "idle",
      context,
    });
    expect(response.status).toBe(200);
    expect((await response.json<AgentResponse>()).agent.context).toEqual(context);
    await waitFor(() => watcher.received.find((m) => m.type === "agent" && m.agent.context?.tokens === 170000));
    expect((await agentNamed("ana", agent.id))?.context).toEqual(context);
    await heartbeat(agent);
    expect((await agentNamed("ana", agent.id))?.context).toEqual(context);
    const invalid = await post({ person: agent.person, agent: agent.id }, `${agentPath(agent.id)}/heartbeat`, {
      presence: "live",
      context: { readAt: "bad", tokens: -1 },
    });
    expect(invalid.status).toBe(200);
    expect((await invalid.json<AgentResponse>()).agent.context).toEqual(context);
    watcher.close();
  });
  it("serves Codex primary and weekly limits as a labelled account without inventing an email", async () => {
    const agent = await register("shlok", "fffe0000-0000-4000-8000-000000000001");
    const usage = {
      accountId: "Codex · shlok · work",
      plan: "plus",
      limits: {
        readAt: new Date().toISOString(),
        session: { percent: 25, resetsAt: "2026-10-08T00:00:00Z" },
        week: { percent: 51, resetsAt: "2026-10-10T00:00:00Z" },
        models: [],
      },
    };
    const after = await heartbeat(agent, usage);
    expect(after.usage?.email).toBeUndefined();
    expect(after.usage?.accountId).toBe(usage.accountId);
    const [account] = await accounts("ana");
    expect(account?.email).toBe(usage.accountId);
    expect(account?.limits.session?.percent).toBe(25);
    expect(account?.limits.week?.percent).toBe(51);
  });
});
