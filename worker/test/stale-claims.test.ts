// Stale Claims and Takeover (#11, ADR 0002), driven through the Channel API the way
// the wrapper, its MCP tools and the Dashboard use it, with an in-memory GitHub.

import { env, reset, runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentId,
  AgentResponse,
  ChannelEvent,
  ClaimRefusal,
  HistoryResponse,
  Holder,
  Task,
  TaskActionResponse,
  TaskResponse,
} from "../../shared/src/index";
import { AGENT_HEADER, agentPath, CLAIMED_LABEL, claimPath, stepPath, takeoverPath } from "../../shared/src/index";
import { installGitHub, sign } from "../src/github/index";
import { FakeGitHub, type WebhookDelivery } from "./fake-github";

const BASE = "https://switchboard.test";
const TEN_MINUTES = 10 * 60_000;

let github: FakeGitHub;

type As = { person: string; agent?: AgentId };
type AgentAs = As & { agent: AgentId; sessionId: string };

function call(path: string, as: As, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: "Bearer test-join-secret",
    "X-Switchboard-Person": as.person,
    "Content-Type": "application/json",
  };
  if (as.agent !== undefined) headers[AGENT_HEADER] = as.agent;
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

function post(path: string, as: As, body: unknown = {}): Promise<Response> {
  return call(path, as, { method: "POST", body: JSON.stringify(body) });
}

let sessions = 0;

/** Registers an Agent for `person`, the way the wrapper does. */
async function agent(person: string): Promise<AgentAs> {
  sessions += 1;
  const sessionId = `${sessions.toString(16).padStart(4, "0")}bbbb-0000-4000-8000-000000000000`;
  const response = await post("/api/agents", { person }, { cli: "claude-code", sessionId, cwd: "/repo" });
  expect(response.status).toBe(200);
  return { person, agent: (await response.json<AgentResponse>()).agent.id, sessionId };
}

/** The wrapper registering the same session again, as `switchboard run claude --resume` does. */
async function resume(a: AgentAs): Promise<AgentResponse> {
  const response = await post(
    "/api/agents",
    { person: a.person },
    { cli: "claude-code", sessionId: a.sessionId, resumed: true, cwd: "/repo" },
  );
  expect(response.status).toBe(200);
  return response.json<AgentResponse>();
}

/** The session ends: the Agent is Gone. */
async function end(a: AgentAs): Promise<void> {
  expect((await post(`${agentPath(a.agent)}/end`, { person: a.person })).status).toBe(200);
}

async function task(number: number): Promise<Task> {
  const response = await call(`/api/tasks/${number}`, { person: "shlok" });
  expect(response.status).toBe(200);
  return (await response.json<TaskResponse>()).task;
}

async function events(): Promise<ChannelEvent[]> {
  return (await (await call("/api/events", { person: "shlok" })).json<HistoryResponse>()).events;
}

async function lastSeq(): Promise<number> {
  return (await events()).at(-1)?.seq ?? 0;
}

const KINDS = new Set([
  "claim",
  "claim.stale",
  "claim.recovered",
  "claim.blocked",
  "claim.unblocked",
  "takeover",
  "mirror.failed",
]);

/** Claim Events after `seq` as [type, actor, payload]. */
async function claimEvents(after = 0): Promise<[string, string, unknown][]> {
  return (await events())
    .filter((e) => e.seq > after && KINDS.has(e.type))
    .map((e) => {
      const actor = e.actor.kind === "agent" ? e.actor.agentId : e.actor.kind === "person" ? e.actor.person : "github";
      return [e.type, actor, e.payload];
    });
}

const byAgent = (id: AgentId): Holder => ({ kind: "agent", agentId: id });
const byPerson = (person: string): Holder => ({ kind: "person", person });

function takeover(number: number, as: As, to: Holder): Promise<Response> {
  return post(takeoverPath(number), as, { to });
}

function channelStub() {
  return env.CHANNEL.get(env.CHANNEL.idFromName("main"));
}

async function deliver(delivery: WebhookDelivery): Promise<void> {
  const body = JSON.stringify(delivery.payload);
  const response = await exports.default.fetch(
    new Request(`${BASE}/api/github/webhook`, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": delivery.event,
        "X-Hub-Signature-256": await sign("test-webhook-secret", body),
      },
    }),
  );
  expect(response.status).toBe(204);
}

beforeEach(() => {
  github = new FakeGitHub();
  installGitHub(github);
});

afterEach(async () => {
  vi.useRealTimers();
  installGitHub(null);
  await reset();
});

describe("a Claim held by a Gone Agent", () => {
  it("is marked Stale, as an Event, when its session ends", async () => {
    const number = github.open({ title: "Claims" }).number;
    const other = github.open({ title: "Held by a Person" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);
    await post(claimPath(other), { person: "shlok" });
    const since = await lastSeq();

    await end(shlok);
    expect((await task(number)).claim).toMatchObject({ holder: byAgent(shlok.agent), stale: true });
    // A Person's own Claim never goes Stale.
    expect((await task(other)).claim?.stale).toBe(false);
    const stale = (await events()).filter((e) => e.seq > since && e.type === "claim.stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      actor: { kind: "agent", agentId: shlok.agent },
      capture: null,
      task: number,
      payload: { holder: byAgent(shlok.agent) },
    });
  });

  it("is marked Stale when the Agent goes silent, and stays held indefinitely without a Takeover", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const number = github.open({ title: "Claims" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);

    vi.setSystemTime(Date.now() + TEN_MINUTES + 1000);
    expect(await runDurableObjectAlarm(channelStub())).toBe(true);
    expect((await task(number)).claim).toMatchObject({ holder: byAgent(shlok.agent), stale: true });

    // Weeks go by, the reconcile keeps running: the Claim never expires on its own.
    for (let week = 0; week < 4; week++) {
      vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000);
      await runDurableObjectAlarm(channelStub());
    }
    expect((await task(number)).claim).toMatchObject({ holder: byAgent(shlok.agent), stale: true });
    expect((await task(number)).status).toBe("claimed");
    expect((await claimEvents()).map(([type]) => type)).toEqual(["claim", "claim.stale"]);

    // Another Agent still cannot claim it, and the refusal says a Person can take it over.
    const sam = await agent("sam");
    const refused = await post(claimPath(number), sam);
    expect(refused.status).toBe(409);
    expect(await refused.json<ClaimRefusal>()).toMatchObject({
      heldBy: byAgent(shlok.agent),
      reason: `Task #${number} is held by ${shlok.agent}. Its Claim is Stale: only a Person can take it over.`,
    });
  });

  it("stops being Stale, as an Event, when the Agent comes back before any Takeover", async () => {
    const number = github.open({ title: "Claims" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);
    await end(shlok);
    const since = await lastSeq();

    const back = await resume(shlok);
    expect(back.lostClaims).toBeUndefined();
    expect((await task(number)).claim).toMatchObject({ holder: byAgent(shlok.agent), stale: false });
    expect(await claimEvents(since)).toEqual([["claim.recovered", shlok.agent, { holder: byAgent(shlok.agent) }]]);

    // A heartbeat bringing it back from silence does the same.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + TEN_MINUTES + 1000);
    await runDurableObjectAlarm(channelStub());
    expect((await task(number)).claim?.stale).toBe(true);
    expect((await post(`${agentPath(shlok.agent)}/heartbeat`, shlok, { presence: "idle" })).status).toBe(200);
    expect((await task(number)).claim?.stale).toBe(false);
    expect((await claimEvents(since)).map(([type]) => type)).toEqual([
      "claim.recovered",
      "claim.stale",
      "claim.recovered",
    ]);
  });
});

describe("Takeover", () => {
  it("moves a Stale Claim to the Person, with a hand-off Event, and mirrors it to GitHub", async () => {
    const number = github.open({ title: "Claims", body: "- [ ] schema\n- [ ] claim\n- [ ] release" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);
    await post(stepPath(number, 0), shlok);
    await post(stepPath(number, 1), shlok);
    await post("/api/updates", shlok, {
      text: "Claim works; release next, uncommitted in src/claims.ts",
      task: number,
    });
    await post("/api/updates", shlok, { text: "Lunch", task: 99 });
    await end(shlok);
    const since = await lastSeq();
    github.calls.length = 0;

    const response = await takeover(number, { person: "dev" }, byPerson("dev"));
    expect(response.status).toBe(200);
    const after = (await response.json<TaskActionResponse>()).task;
    expect(after).toMatchObject({ status: "claimed", claim: { holder: byPerson("dev"), stale: false } });
    expect(after.claim?.claimedAt).toBeDefined();

    expect(await claimEvents(since)).toEqual([
      [
        "takeover",
        "dev",
        {
          from: byAgent(shlok.agent),
          to: byPerson("dev"),
          stepsCompleted: ["schema", "claim"],
          lastUpdate: "Claim works; release next, uncommitted in src/claims.ts",
        },
      ],
    ]);
    const handOff = (await events()).find((e) => e.type === "takeover");
    expect(handOff).toMatchObject({ capture: null, task: number });

    expect(github.calls).toEqual([
      ["addAssignees", number, [github.tokenLogin]],
      ["addLabels", number, [CLAIMED_LABEL]],
      [
        "addComment",
        number,
        [
          "Taken over by Person `dev` for Person `dev` via Switchboard.",
          "",
          `Previous holder: Agent \`${shlok.agent}\` (Person shlok), Gone.`,
          "Steps completed:\n- [x] schema\n- [x] claim",
          "Last Update:\n> Claim works; release next, uncommitted in src/claims.ts",
        ].join("\n"),
      ],
    ]);
    expect(github.issue(number).assignees).toEqual([github.tokenLogin]);

    // The new holder carries on: the old Steps stay done, and it can finish the rest.
    expect((await post(stepPath(number, 2), { person: "dev" })).status).toBe(200);
  });

  it("moves a Stale Claim to one of the Person's own Agents, but not to someone else's or a Gone one", async () => {
    const number = github.open({ title: "Claims" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);
    await end(shlok);
    const mine = await agent("dev");
    const idle = await agent("dev");
    await end(idle);
    const theirs = await agent("sam");

    const toOthers = await takeover(number, { person: "dev" }, byAgent(theirs.agent));
    expect(toOthers.status).toBe(403);
    expect((await toOthers.json<ClaimRefusal>()).reason).toContain("belongs to sam");
    expect((await takeover(number, { person: "dev" }, byPerson("sam"))).status).toBe(403);
    const toGone = await takeover(number, { person: "dev" }, byAgent(idle.agent));
    expect(toGone.status).toBe(409);
    expect((await toGone.json<ClaimRefusal>()).reason).toContain("is Gone");
    expect((await takeover(number, { person: "dev" }, byAgent("dev/claude/zzzz"))).status).toBe(404);
    expect((await task(number)).claim?.holder).toEqual(byAgent(shlok.agent));

    const response = await takeover(number, { person: "dev" }, byAgent(mine.agent));
    expect(response.status).toBe(200);
    expect((await task(number)).claim).toMatchObject({ holder: byAgent(mine.agent), stale: false });
    const [event] = (await claimEvents()).filter(([type]) => type === "takeover");
    expect(event).toEqual([
      "takeover",
      "dev",
      { from: byAgent(shlok.agent), to: byAgent(mine.agent), stepsCompleted: [] },
    ]);
    expect(github.issue(number).comments.at(-1)).toContain(
      `Taken over by Person \`dev\` for Agent \`${mine.agent}\` (Person dev) via Switchboard.`,
    );
    // The new holder is an ordinary holder: if it goes Gone, its Claim is Stale in turn.
    await end(mine);
    expect((await task(number)).claim).toMatchObject({ holder: byAgent(mine.agent), stale: true });
  });

  it("refuses an Agent, even one acting for a Person who could take it over", async () => {
    const number = github.open({ title: "Claims" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);
    await end(shlok);
    const sam = await agent("sam");
    const since = await lastSeq();

    for (const to of [byAgent(sam.agent), byPerson("sam")]) {
      const refused = await takeover(number, sam, to);
      expect(refused.status).toBe(403);
      expect((await refused.json<ClaimRefusal>()).reason).toBe(
        "Only a Person can take over a Claim. An Agent never can.",
      );
    }
    expect((await task(number)).claim).toMatchObject({ holder: byAgent(shlok.agent), stale: true });
    expect(await claimEvents(since)).toEqual([]);
  });

  it("refuses a Claim that is not Stale, a Task nobody holds, and a done Task", async () => {
    const live = github.open({ title: "Live holder" }).number;
    const free = github.open({ title: "Free" }).number;
    const person = github.open({ title: "A Person holds it" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(live), shlok);
    await post(claimPath(person), { person: "shlok" });
    const since = await lastSeq();
    github.calls.length = 0;

    const notStale = await takeover(live, { person: "dev" }, byPerson("dev"));
    expect(notStale.status).toBe(409);
    expect(await notStale.json<ClaimRefusal>()).toEqual({
      ok: false,
      reason: `Task #${live} is held by ${shlok.agent}, which is not Gone. Only a Stale Claim can be taken over.`,
      heldBy: byAgent(shlok.agent),
    });
    // Its own Person cannot take it over either while the Agent is Live.
    expect((await takeover(live, { person: "shlok" }, byPerson("shlok"))).status).toBe(409);
    // A Person's Claim is never Stale.
    expect((await takeover(person, { person: "dev" }, byPerson("dev"))).status).toBe(409);

    const unclaimed = await takeover(free, { person: "dev" }, byPerson("dev"));
    expect(unclaimed.status).toBe(409);
    expect((await unclaimed.json<ClaimRefusal>()).reason).toBe(`Task #${free} is not claimed. Claim it instead.`);
    expect((await takeover(999, { person: "dev" }, byPerson("dev"))).status).toBe(404);
    expect((await post(takeoverPath(live), { person: "dev" }, { to: "dev" })).status).toBe(400);

    expect((await task(live)).claim?.holder).toEqual(byAgent(shlok.agent));
    expect(await claimEvents(since)).toEqual([]);
    expect(github.calls).toEqual([]);
  });

  it("keeps the Takeover when GitHub fails, and records the failure", async () => {
    const number = github.open({ title: "Claims" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);
    await end(shlok);
    github.failing.add("addComment");

    expect((await takeover(number, { person: "dev" }, byPerson("dev"))).status).toBe(200);
    expect((await task(number)).claim?.holder).toEqual(byPerson("dev"));
    expect((await claimEvents()).at(-1)).toEqual([
      "mirror.failed",
      "dev",
      { change: "takeover", call: "comment", reason: expect.stringContaining("500") },
    ]);
  });
});

describe("the Agent that lost its Claim", () => {
  it("is told when it resumes, once, and no longer holds the Task", async () => {
    const number = github.open({ title: "Claims", body: "- [ ] one" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);
    await end(shlok);
    await takeover(number, { person: "dev" }, byPerson("dev"));
    const handOff = (await events()).find((e) => e.type === "takeover");

    const back = await resume(shlok);
    expect(back.lostClaims).toEqual([
      { task: number, title: "Claims", by: "dev", to: byPerson("dev"), at: handOff?.at, event: handOff?.id },
    ]);
    // Told once: the next registration or heartbeat does not repeat it.
    expect((await resume(shlok)).lostClaims).toBeUndefined();
    const beat = await post(`${agentPath(shlok.agent)}/heartbeat`, shlok, { presence: "live" });
    expect((await beat.json<AgentResponse>()).lostClaims).toBeUndefined();

    // Its tools answer with the new holder, and nothing turns the Claim Stale again.
    const step = await post(stepPath(number, 0), shlok);
    expect(step.status).toBe(403);
    expect((await step.json<ClaimRefusal>()).heldBy).toEqual(byPerson("dev"));
    expect((await task(number)).claim).toMatchObject({ holder: byPerson("dev"), stale: false });
    expect((await claimEvents()).map(([type]) => type)).toEqual(["claim", "claim.stale", "takeover"]);
  });

  it("is told on the heartbeat that brings it back from silence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const number = github.open({ title: "Claims" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);
    vi.setSystemTime(Date.now() + TEN_MINUTES + 1000);
    await runDurableObjectAlarm(channelStub());
    await takeover(number, { person: "shlok" }, byPerson("shlok"));

    const beat = await post(`${agentPath(shlok.agent)}/heartbeat`, shlok, { presence: "live" });
    expect((await beat.json<AgentResponse>()).lostClaims).toMatchObject([
      { task: number, by: "shlok", to: byPerson("shlok") },
    ]);
  });
});

describe("a Task blocked after it was claimed", () => {
  it("keeps its Claim, flagged with the blockers as an Event and on the Task, until they close", async () => {
    const number = github.open({ title: "Claims" }).number;
    const blocker = github.open({ title: "Schema" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);
    const since = await lastSeq();

    await deliver(github.addBlocker(number, blocker));
    const blocked = await task(number);
    expect(blocked).toMatchObject({
      status: "claimed",
      blockedBy: [blocker],
      claim: { holder: byAgent(shlok.agent), blockedBy: [blocker] },
    });
    expect(await claimEvents(since)).toEqual([
      ["claim.blocked", "github", { holder: byAgent(shlok.agent), blockedBy: [blocker] }],
    ]);
    // Nothing was released, on the Channel or on GitHub.
    expect(github.issue(number).assignees).toEqual([github.tokenLogin]);

    // A reconcile finds nothing new to flag.
    const quiet = await lastSeq();
    await runDurableObjectAlarm(channelStub());
    expect(await claimEvents(quiet)).toEqual([]);

    // The blocker closes: the flag goes away.
    await deliver(github.close(blocker));
    const unblocked = await task(number);
    expect(unblocked.blockedBy).toEqual([]);
    expect(unblocked.claim).toMatchObject({ holder: byAgent(shlok.agent) });
    expect(unblocked.claim?.blockedBy).toBeUndefined();
    expect((await claimEvents(since)).at(-1)).toEqual(["claim.unblocked", "github", { holder: byAgent(shlok.agent) }]);
  });

  it("keeps the blocked flag through a Takeover", async () => {
    const number = github.open({ title: "Claims" }).number;
    const blocker = github.open({ title: "Schema" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);
    await deliver(github.addBlocker(number, blocker));
    await end(shlok);
    await takeover(number, { person: "dev" }, byPerson("dev"));
    expect((await task(number)).claim).toMatchObject({ holder: byPerson("dev"), blockedBy: [blocker] });
  });
});
