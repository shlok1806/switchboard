// Claims (#9, ADR 0001), driven through the Channel API the way the wrapper's MCP
// tools and the Dashboard use it, with an in-memory GitHub behind the sync interface.

import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  AgentResponse,
  ChannelEvent,
  ClaimRefusal,
  HistoryResponse,
  PostUpdateResponse,
  Task,
  TaskActionResponse,
  TaskResponse,
  ToolCallResponse,
} from "../../shared/src/index";
import { CLAIMED_LABEL, claimPath, releasePath, stepPath } from "../../shared/src/index";
import { installGitHub } from "../src/github/index";
import { STATUS_MARKER } from "../src/status-comment";
import { type As, bearer, channelStub, forgetTokens, remember, url } from "./client";
import { FakeGitHub } from "./fake-github";

let github: FakeGitHub;

async function call(path: string, as: As, init: RequestInit = {}): Promise<Response> {
  const headers = { Authorization: await bearer(as), "Content-Type": "application/json" };
  return exports.default.fetch(new Request(url(path), { ...init, headers }));
}

function post(path: string, as: As, body: unknown = {}): Promise<Response> {
  return call(path, as, { method: "POST", body: JSON.stringify(body) });
}

let sessions = 0;

/** Registers an Agent for `person`, the way the wrapper does. */
async function agent(person: string): Promise<As & { agent: AgentId }> {
  sessions += 1;
  const sessionId = `${sessions.toString(16).padStart(4, "0")}aaaa-0000-4000-8000-000000000000`;
  const response = await post("/api/agents", { person }, { cli: "claude-code", sessionId, cwd: "/repo" });
  expect(response.status).toBe(200);
  return { person, agent: remember(await response.json<AgentResponse>()).agent.id };
}

async function task(number: number): Promise<Task> {
  const response = await call(`/api/tasks/${number}`, { person: "shlok" });
  expect(response.status).toBe(200);
  return (await response.json<TaskResponse>()).task;
}

async function events(): Promise<ChannelEvent[]> {
  return (await (await call("/api/events", { person: "shlok" })).json<HistoryResponse>()).events;
}

/** Claim Events after `seq` as [type, actor, capture, detail] for readable assertions. */
async function claimEvents(after = 0): Promise<[string, string, string | null, unknown][]> {
  const kinds = new Set(["claim", "claim.refused", "claim.release", "step.complete", "mirror.failed", "update"]);
  return (await events())
    .filter((e) => e.seq > after && kinds.has(e.type))
    .map((e) => {
      const actor = e.actor.kind === "agent" ? e.actor.agentId : e.actor.kind === "person" ? e.actor.person : "github";
      return [e.type, actor, e.capture, e.payload];
    });
}

async function lastSeq(): Promise<number> {
  return (await events()).at(-1)?.seq ?? 0;
}

beforeEach(() => {
  github = new FakeGitHub();
  installGitHub(github);
});

afterEach(async () => {
  installGitHub(null);
  forgetTokens();
  await reset();
});

describe("claiming", () => {
  it("lets exactly one of two concurrent Claims win, and the other names the holder", async () => {
    const number = github.open({ title: "Claims" }).number;
    const one = await agent("shlok");
    const two = await agent("sam");
    await task(number);

    const [a, b] = await Promise.all([post(claimPath(number), one), post(claimPath(number), two)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const [won, lost] = a.status === 200 ? [one, b] : [two, a];
    const refusal = await lost.json<ClaimRefusal>();
    expect(refusal.heldBy).toEqual({ kind: "agent", agentId: won.agent });
    expect(refusal.reason).toContain(won.agent);

    expect((await task(number)).claim?.holder).toEqual({ kind: "agent", agentId: won.agent });
    const claims = (await events()).filter((e) => e.type === "claim");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ actor: { kind: "agent", agentId: won.agent }, capture: "tool", task: number });
  });

  it("refuses a held Task with the holder's Agent ID or Person, and records the refusal", async () => {
    const number = github.open({ title: "Claims" }).number;
    const other = github.open({ title: "Dashboard" }).number;
    const shlok = await agent("shlok");
    const sam = await agent("sam");
    expect((await post(claimPath(number), shlok)).status).toBe(200);
    const since = await lastSeq();

    const refused = await post(claimPath(number), sam);
    expect(refused.status).toBe(409);
    expect(await refused.json<ClaimRefusal>()).toEqual({
      ok: false,
      reason: `Task #${number} is held by ${shlok.agent}.`,
      heldBy: { kind: "agent", agentId: shlok.agent },
    });
    expect(await claimEvents(since)).toEqual([
      ["claim.refused", sam.agent, "tool", { heldBy: { kind: "agent", agentId: shlok.agent } }],
    ]);

    // A Person holding it is named too.
    await post(claimPath(other), { person: "dev" });
    const byPerson = await (await post(claimPath(other), sam)).json<ClaimRefusal>();
    expect(byPerson.heldBy).toEqual({ kind: "person", person: "dev" });
    expect(byPerson.reason).toContain("dev");
  });

  it("changes nothing when the holder claims again", async () => {
    const number = github.open({ title: "Claims" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);
    const since = await lastSeq();
    const calls = github.calls.length;
    const again = await post(claimPath(number), shlok);
    expect(again.status).toBe(200);
    expect(await claimEvents(since)).toEqual([]);
    expect(github.calls.length).toBe(calls);
  });

  it("refuses a done Task, a blocked Task and an unknown one", async () => {
    const done = github.open({ title: "Old" }).number;
    const blocker = github.open({ title: "Skeleton" }).number;
    const blocked = github.open({ title: "Claims" }).number;
    github.addBlocker(blocked, blocker);
    await task(done);
    github.close(done);
    await runDurableObjectAlarm(channelStub());
    expect((await task(done)).status).toBe("done");
    const shlok = await agent("shlok");

    const onDone = await post(claimPath(done), shlok);
    expect(onDone.status).toBe(409);
    expect((await onDone.json<ClaimRefusal>()).reason).toBe(`Task #${done} is done.`);

    const onBlocked = await post(claimPath(blocked), shlok);
    expect(onBlocked.status).toBe(409);
    expect((await onBlocked.json<ClaimRefusal>()).reason).toBe(`Task #${blocked} is blocked by #${blocker}.`);

    expect((await post(claimPath(999), shlok)).status).toBe(404);
    expect(github.calls).toEqual([]);
  });
});

describe("who may claim", () => {
  it("lets a Person claim for themselves", async () => {
    const number = github.open({ title: "Claims" }).number;
    const response = await post(claimPath(number), { person: "shlok" });
    expect(response.status).toBe(200);
    const claimed = (await response.json<TaskActionResponse>()).task;
    expect(claimed).toMatchObject({ status: "claimed", claim: { holder: { kind: "person", person: "shlok" } } });
    expect(await claimEvents()).toEqual([["claim", "shlok", null, { holder: { kind: "person", person: "shlok" } }]]);
  });

  it("lets a Person claim for their own Agent, but not for another Person's", async () => {
    const number = github.open({ title: "Claims" }).number;
    const mine = await agent("shlok");
    const theirs = await agent("sam");

    const refused = await post(claimPath(number), { person: "shlok" }, { for: theirs.agent });
    expect(refused.status).toBe(403);
    expect((await refused.json<ClaimRefusal>()).reason).toContain(`belongs to sam`);
    expect((await task(number)).claim).toBeUndefined();

    const response = await post(claimPath(number), { person: "shlok" }, { for: mine.agent });
    expect(response.status).toBe(200);
    expect((await task(number)).claim?.holder).toEqual({ kind: "agent", agentId: mine.agent });
    // The Person did it, on the Dashboard or the API: no Tool Capture.
    expect(await claimEvents()).toEqual([["claim", "shlok", null, { holder: { kind: "agent", agentId: mine.agent } }]]);
  });

  it("lets an Agent claim only for itself, and only as its own Person", async () => {
    const number = github.open({ title: "Claims" }).number;
    const one = await agent("shlok");
    const two = await agent("shlok");

    const forOther = await post(claimPath(number), one, { for: two.agent });
    expect(forOther.status).toBe(403);

    // A token nobody issued is not anyone's.
    const forged = await exports.default.fetch(
      new Request(url(claimPath(number)), { method: "POST", headers: { Authorization: "Bearer sba_forged" } }),
    );
    expect(forged.status).toBe(401);
    expect((await task(number)).claim).toBeUndefined();
  });
});

describe("releasing", () => {
  it("frees the Task for someone else, and only the holder or its Person can do it", async () => {
    const number = github.open({ title: "Claims" }).number;
    const shlok = await agent("shlok");
    const sam = await agent("sam");
    await post(claimPath(number), shlok);

    const notHolder = await post(releasePath(number), sam);
    expect(notHolder.status).toBe(403);
    expect((await notHolder.json<ClaimRefusal>()).heldBy).toEqual({ kind: "agent", agentId: shlok.agent });

    const since = await lastSeq();
    const released = await post(releasePath(number), shlok);
    expect(released.status).toBe(200);
    expect((await released.json<TaskActionResponse>()).task).toMatchObject({ status: "open" });
    expect((await task(number)).claim).toBeUndefined();
    expect(await claimEvents(since)).toEqual([
      ["claim.release", shlok.agent, "tool", { holder: { kind: "agent", agentId: shlok.agent } }],
    ]);

    expect((await post(claimPath(number), sam)).status).toBe(200);
    // The holding Agent's Person may release for it.
    expect((await post(releasePath(number), { person: "sam" })).status).toBe(200);
    expect((await post(releasePath(number), { person: "sam" })).status).toBe(409);
  });
});

describe("Steps", () => {
  it("lets the holder complete a Step, recording it and ticking it on the Issue", async () => {
    const number = github.open({ title: "Claims", body: "## Build\n- [x] schema\n- [ ] claim\n- [ ] release" }).number;
    const shlok = await agent("shlok");
    const sam = await agent("sam");

    // Only the holder completes Steps.
    expect((await post(stepPath(number, 1), shlok)).status).toBe(409);
    await post(claimPath(number), shlok);
    expect((await post(stepPath(number, 1), sam)).status).toBe(403);

    const since = await lastSeq();
    const response = await post(stepPath(number, 1), shlok);
    expect(response.status).toBe(200);
    const after = (await response.json<TaskActionResponse>()).task;
    expect(after.stepsDone).toBe(2);
    expect(after.steps[1]).toEqual({ index: 1, text: "claim", done: true });
    expect(await claimEvents(since)).toEqual([["step.complete", shlok.agent, "tool", { step: 1, text: "claim" }]]);
    expect(github.issue(number).body).toBe("## Build\n- [x] schema\n- [x] claim\n- [ ] release");

    // Completing it again changes nothing; a Step that does not exist is refused.
    const calls = github.calls.length;
    expect((await post(stepPath(number, 1), shlok)).status).toBe(200);
    expect(github.calls.length).toBe(calls);
    expect((await post(stepPath(number, 7), shlok)).status).toBe(404);
  });
});

describe("mirroring Claims to GitHub", () => {
  it("assigns the holder's Person, labels status:claimed and posts one status comment, then undoes it on release", async () => {
    const number = github.open({ title: "Claims", labels: ["ready-for-agent"] }).number;
    const shlok = await agent("shlok");

    await post(claimPath(number), shlok);
    expect(github.calls).toEqual([
      ["addAssignees", number, ["shlok"]],
      ["addLabels", number, [CLAIMED_LABEL]],
      ["createComment", number, expect.stringContaining(`Held by Agent \`${shlok.agent}\` of \`shlok\``)],
    ]);
    expect(github.issue(number)).toMatchObject({ assignees: ["shlok"], labels: ["ready-for-agent", CLAIMED_LABEL] });
    expect((await task(number)).labels).toEqual(["ready-for-agent", CLAIMED_LABEL]);
    const [comment] = github.commentIds(number);

    github.calls.length = 0;
    await post(releasePath(number), shlok);
    expect(github.calls).toEqual([
      ["removeAssignees", number, ["shlok"]],
      ["removeLabel", number, CLAIMED_LABEL],
      ["updateComment", comment, expect.stringContaining("Not claimed.")],
    ]);
    expect(github.issue(number)).toMatchObject({ assignees: [], labels: ["ready-for-agent"] });
    expect((await task(number)).labels).toEqual(["ready-for-agent"]);
    // Still one comment, edited in place, with the history of both changes.
    expect(github.commentIds(number)).toEqual([comment]);
    const body = github.issue(number).comments[0] ?? "";
    expect(body.startsWith(STATUS_MARKER)).toBe(true);
    expect(body).toMatch(/History:\n- .*: Claimed by Agent `.*`\.\n- .*: Released by Agent `.*`\./);

    // A reconcile finds nothing it did not already know.
    const since = await lastSeq();
    await runDurableObjectAlarm(channelStub());
    expect((await events()).filter((e) => e.seq > since)).toEqual([]);
  });

  it("names a Person holder in the status comment", async () => {
    const number = github.open({ title: "Claims" }).number;
    await post(claimPath(number), { person: "dev" });
    expect(github.issue(number).comments).toEqual([expect.stringContaining("Held by Person `dev` since")]);
    expect(github.issue(number).assignees).toEqual(["dev"]);
  });

  it("keeps the Claim when GitHub fails, and records each failure as an Event", async () => {
    const number = github.open({ title: "Claims" }).number;
    const shlok = await agent("shlok");
    github.failing.add("addAssignees");
    github.failing.add("createComment");

    const response = await post(claimPath(number), shlok);
    expect(response.status).toBe(200);
    expect((await task(number)).claim?.holder).toEqual({ kind: "agent", agentId: shlok.agent });
    // The label still went on; the failing calls did not stop it.
    expect(github.calls).toEqual([["addLabels", number, [CLAIMED_LABEL]]]);
    const failures = (await claimEvents()).filter(([type]) => type === "mirror.failed");
    expect(failures).toEqual([
      ["mirror.failed", shlok.agent, null, { change: "claim", call: "assign", reason: expect.stringContaining("500") }],
      [
        "mirror.failed",
        shlok.agent,
        null,
        { change: "claim", call: "status comment", reason: expect.stringContaining("500") },
      ],
    ]);
  });

  it("keeps a completed Step when ticking it on GitHub fails", async () => {
    const number = github.open({ title: "Claims", body: "- [ ] one" }).number;
    const shlok = await agent("shlok");
    await post(claimPath(number), shlok);
    github.failing.add("setBody");
    expect((await post(stepPath(number, 0), shlok)).status).toBe(200);
    expect((await task(number)).stepsDone).toBe(1);
    expect((await claimEvents()).at(-1)).toEqual([
      "mirror.failed",
      shlok.agent,
      null,
      { change: "step.complete", call: "tick", reason: expect.stringContaining("500") },
    ]);
  });
});

describe("Updates and tool calls as an Agent", () => {
  it("records an Agent's Update and tool calls with the Tool Capture", async () => {
    const shlok = await agent("shlok");
    const update = await post("/api/updates", shlok, { text: "Starting on #9", task: 9 });
    expect(update.status).toBe(201);
    expect((await update.json<PostUpdateResponse>()).event).toMatchObject({
      type: "update",
      actor: { kind: "agent", agentId: shlok.agent },
      capture: "tool",
      task: 9,
      payload: { text: "Starting on #9" },
    });

    const toolCall = await post("/api/tool-calls", shlok, {
      tool: "post_update",
      arg: "Starting on #9",
      ok: true,
      durationMs: 12.4,
      task: 9,
    });
    expect(toolCall.status).toBe(201);
    expect((await toolCall.json<ToolCallResponse>()).event).toMatchObject({
      type: "tool.call",
      actor: { kind: "agent", agentId: shlok.agent },
      capture: "tool",
      task: 9,
      payload: { tool: "post_update", arg: "Starting on #9", ok: true, durationMs: 12 },
    });
  });

  it("refuses tool calls from a Person and an unknown tool", async () => {
    const shlok = await agent("shlok");
    const body = { tool: "claim_task", arg: "#1", ok: true, durationMs: 1 };
    expect((await post("/api/tool-calls", { person: "shlok" }, body)).status).toBe(400);
    expect((await post("/api/tool-calls", shlok, { ...body, tool: "rm_rf" })).status).toBe(400);
  });
});

describe("reading the Channel", () => {
  it("returns the latest Events with ?tail=, oldest first", async () => {
    for (const text of ["one", "two", "three"]) await post("/api/updates", { person: "shlok" }, { text });
    const response = await call("/api/events?tail=2", { person: "shlok" });
    const { events: latest, cursor } = await response.json<HistoryResponse>();
    expect(latest.map((e) => (e.type === "update" ? e.payload.text : e.type))).toEqual(["two", "three"]);
    expect(cursor).toBe(latest.at(-1)?.seq);
    expect((await call("/api/events?tail=0", { person: "shlok" })).status).toBe(400);
  });
});
