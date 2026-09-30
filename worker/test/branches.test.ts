// Branch per Task (#10, ADR 0006), driven through the Channel API the way the
// wrapper's MCP tools use it, and through the GitHub webhook the way GitHub
// delivers pushes and merges, with an in-memory GitHub behind the sync interface.

import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  AgentResponse,
  ChannelEvent,
  ClaimRefusal,
  EventOf,
  HistoryResponse,
  Task,
  TaskActionResponse,
  TaskResponse,
} from "../../shared/src/index";
import {
  branchPath,
  CLAIMED_LABEL,
  claimPath,
  DIFF_LINES_PER_EVENT,
  DIFF_LINES_PER_FILE,
  finishPath,
  REVIEW_LABEL,
  releasePath,
  taskBranch,
} from "../../shared/src/index";
import type { ComparedFile } from "../src/github/index";
import { installGitHub, sign } from "../src/github/index";
import { type As, bearer, forgetTokens, remember, url } from "./client";
import { FakeGitHub, type WebhookDelivery } from "./fake-github";

const WEBHOOK_SECRET = "test-webhook-secret";

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
  const sessionId = `${sessions.toString(16).padStart(4, "0")}bbbb-0000-4000-8000-000000000000`;
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

async function eventsOf<K extends ChannelEvent["type"]>(type: K): Promise<EventOf<K>[]> {
  return (await events()).filter((e): e is EventOf<K> => e.type === type);
}

/** Delivers a webhook the way GitHub does: raw JSON body, HMAC signature, event and delivery headers. */
async function deliver(delivery: WebhookDelivery, options: { secret?: string; id?: string } = {}): Promise<Response> {
  const body = JSON.stringify(delivery.payload);
  return exports.default.fetch(
    new Request(url("/api/github/webhook"), {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": delivery.event,
        "X-GitHub-Delivery": options.id ?? crypto.randomUUID(),
        "X-Hub-Signature-256": await sign(options.secret ?? WEBHOOK_SECRET, body),
      },
    }),
  );
}

async function delivered(delivery: WebhookDelivery): Promise<void> {
  const response = await deliver(delivery);
  expect(response.status, await response.clone().text()).toBe(204);
}

/** A unified diff for one file: one hunk adding `lines` lines. */
function added(path: string, lines: number): ComparedFile {
  const body = Array.from({ length: lines }, (_, i) => `+line ${i + 1}`).join("\n");
  return { path, additions: lines, deletions: 0, patch: `@@ -0,0 +1,${lines} @@\n${body}` };
}

/** Claims `number` for an Agent and reports its branch, the way the wrapper's claim_task does. */
async function claimWithBranch(number: number, holder: As): Promise<string> {
  expect((await post(claimPath(number), holder)).status).toBe(200);
  const branch = taskBranch(number, (await task(number)).title);
  expect((await post(branchPath(number), holder, { branch })).status).toBe(200);
  return branch;
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

describe("the Task branch", () => {
  it("is named after the Issue number and title", () => {
    expect(taskBranch(10, "Branch per Task; pushes and merges as Events")).toBe(
      "task/10-branch-per-task-pushes-and-merges-as",
    );
    expect(taskBranch(7, "Hook Capture for Claude Code")).toBe("task/7-hook-capture-for-claude-code");
    expect(taskBranch(3, "  !!!  ")).toBe("task/3");
    expect(taskBranch(4, "Ünïcode Títle")).toBe("task/4-unicode-title");
  });

  it("is recorded on the Task when the holder's wrapper reports it, with an Event", async () => {
    const number = github.open({ title: "Branch per Task" }).number;
    const shlok = await agent("shlok");
    const branch = await claimWithBranch(number, shlok);

    const held = await task(number);
    expect(held.branch).toBe("task/1-branch-per-task");
    expect(held.branch).toBe(branch);
    // Reporting it again changes nothing and records nothing new.
    expect((await post(branchPath(number), shlok, { branch })).status).toBe(200);
    const recorded = await eventsOf("task.branch");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actor: { kind: "agent", agentId: shlok.agent },
      capture: "tool",
      task: number,
      payload: { branch },
    });
  });

  it("is refused from anyone but the holder, for another Task's name, or once a branch is set", async () => {
    const number = github.open({ title: "Branch per Task" }).number;
    const shlok = await agent("shlok");
    const sam = await agent("sam");
    const branch = await claimWithBranch(number, shlok);

    const bySam = await post(branchPath(number), sam, { branch });
    expect(bySam.status).toBe(403);
    expect((await bySam.json<ClaimRefusal>()).heldBy).toEqual({ kind: "agent", agentId: shlok.agent });

    expect((await post(branchPath(number), shlok, { branch: "task/99-other" })).status).toBe(400);
    expect((await post(branchPath(number), shlok, { branch: "feature/x" })).status).toBe(400);
    expect((await post(branchPath(number), shlok, { branch: `task/${number}-renamed` })).status).toBe(409);
    expect((await task(number)).branch).toBe(branch);
  });

  it("stays with the Task after a release, so the next holder picks up the same branch", async () => {
    const number = github.open({ title: "Branch per Task" }).number;
    const shlok = await agent("shlok");
    const sam = await agent("sam");
    const branch = await claimWithBranch(number, shlok);
    expect((await post(releasePath(number), shlok)).status).toBe(200);
    expect((await post(claimPath(number), sam)).status).toBe(200);
    expect((await task(number)).branch).toBe(branch);
  });
});

describe("finishing a Task", () => {
  it("opens a pull request that closes the Issue and names the Agent, and puts the Task in review", async () => {
    const number = github.open({ title: "Branch per Task" }).number;
    const shlok = await agent("shlok");
    const branch = await claimWithBranch(number, shlok);

    const response = await post(finishPath(number), shlok, { summary: "Adds finish_task." });
    expect(response.status).toBe(200);
    const finished = (await response.json<TaskActionResponse>()).task;
    expect(finished.status).toBe("review");
    expect(finished.claim?.holder).toEqual({ kind: "agent", agentId: shlok.agent });
    expect(finished.labels).toEqual([REVIEW_LABEL]);

    const pr = github.pullRequest(finished.pr ?? 0);
    expect(pr).toMatchObject({ title: "Branch per Task", head: branch, base: "main", state: "open" });
    expect(pr?.body.split("\n")).toEqual([
      `Closes #${number}`,
      "",
      `Opened via Switchboard by Agent \`${shlok.agent}\` of \`shlok\`.`,
      "",
      "Adds finish_task.",
    ]);
    expect(github.issue(number).labels).toEqual([REVIEW_LABEL]);
    expect(github.issue(number).labels).not.toContain(CLAIMED_LABEL);

    const review = await eventsOf("task.review");
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({
      actor: { kind: "agent", agentId: shlok.agent },
      capture: "tool",
      task: number,
      payload: { pr: finished.pr, url: `https://github.com/${github.repo}/pull/${finished.pr}`, branch },
    });

    // Finishing again returns the same pull request and opens no other.
    const again = await post(finishPath(number), shlok);
    expect((await again.json<TaskActionResponse>()).task.pr).toBe(finished.pr);
    expect(github.calls.filter((c) => c[0] === "createPullRequest")).toHaveLength(1);
  });

  it("is refused without a branch, from anyone but the holder, and when GitHub refuses the PR", async () => {
    const number = github.open({ title: "Branch per Task" }).number;
    const shlok = await agent("shlok");
    const sam = await agent("sam");
    expect((await post(claimPath(number), shlok)).status).toBe(200);

    const noBranch = await post(finishPath(number), shlok);
    expect(noBranch.status).toBe(409);
    expect((await noBranch.json<ClaimRefusal>()).reason).toContain("no branch");

    await post(branchPath(number), shlok, { branch: taskBranch(number, "Branch per Task") });
    expect((await post(finishPath(number), sam)).status).toBe(403);

    github.failing.add("createPullRequest");
    const refused = await post(finishPath(number), shlok);
    expect(refused.status).toBe(502);
    expect((await task(number)).status).toBe("claimed");
    expect(await eventsOf("task.review")).toEqual([]);
  });

  it("ends with the Task done when the pull request merges and GitHub closes the Issue", async () => {
    const number = github.open({ title: "Branch per Task" }).number;
    const shlok = await agent("shlok");
    const branch = await claimWithBranch(number, shlok);
    const pr = (await (await post(finishPath(number), shlok)).json<TaskActionResponse>()).task.pr ?? 0;

    const [merged, closed, ...rest] = github.merge(pr, [added("worker/src/branches.ts", 3)]);
    expect(rest).toEqual([]);
    await delivered(merged as WebhookDelivery);
    await delivered(closed as WebhookDelivery);

    const done = await task(number);
    expect(done.status).toBe("done");
    expect(done.pr).toBe(pr);
    const merges = await eventsOf("merge");
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ actor: { kind: "github" }, capture: null, task: number });
    expect(merges[0]?.payload).toMatchObject({ into: "main", pr, branch });
    expect(merges[0]?.payload.files).toEqual([
      {
        path: "worker/src/branches.ts",
        additions: 3,
        deletions: 0,
        hunks: [
          {
            header: "@@ -0,0 +1,3 @@",
            lines: [
              { type: "add", oldNo: null, newNo: 1, text: "line 1" },
              { type: "add", oldNo: null, newNo: 2, text: "line 2" },
              { type: "add", oldNo: null, newNo: 3, text: "line 3" },
            ],
          },
        ],
      },
    ]);
    expect((await eventsOf("task.done"))[0]).toMatchObject({ task: number, payload: { pr, closedOnGitHub: true } });
  });
});

describe("pushes and merges from the GitHub webhook", () => {
  it("records a push to a Task branch with its Task, commits, changed files and diff hunks", async () => {
    const number = github.open({ title: "Branch per Task" }).number;
    const shlok = await agent("shlok");
    const branch = await claimWithBranch(number, shlok);

    // The wrapper pushes the new branch at main: nothing changed, so no Event.
    await delivered(github.push(branch));
    expect(await eventsOf("push")).toEqual([]);

    const patch = ["@@ -10,3 +10,3 @@ export class Channel {", " keep", "-old();", "+renamed();", " keep"].join("\n");
    const pushed = github.push(branch, {
      commits: ["Add the Branches module\n\nLonger body.", "Wire it into the Channel"],
      files: [{ path: "worker/src/channel.ts", additions: 1, deletions: 1, patch }],
    });
    await delivered(pushed);

    const pushes = await eventsOf("push");
    expect(pushes).toHaveLength(1);
    const [push] = pushes;
    expect(push).toMatchObject({ actor: { kind: "github" }, capture: null, task: number });
    expect(push?.payload).toEqual({
      branch,
      commit: pushed.after,
      message: "Wire it into the Channel",
      commits: [
        { sha: expect.any(String), message: "Add the Branches module" },
        { sha: pushed.after, message: "Wire it into the Channel" },
      ],
      files: [
        {
          path: "worker/src/channel.ts",
          additions: 1,
          deletions: 1,
          hunks: [
            {
              header: "@@ -10,3 +10,3 @@ export class Channel {",
              lines: [
                { type: "ctx", oldNo: 10, newNo: 10, text: "keep" },
                { type: "del", oldNo: 11, newNo: null, text: "old();" },
                { type: "add", oldNo: null, newNo: 11, text: "renamed();" },
                { type: "ctx", oldNo: 12, newNo: 12, text: "keep" },
              ],
            },
          ],
        },
      ],
    });
  });

  it("caps hunks at about 100 lines per file and 400 per Event, marks what was cut and says how to get it", async () => {
    const files = [
      added("big.ts", 150),
      ...Array.from({ length: 4 }, (_, i) => added(`mid-${i}.ts`, 90)),
      added("last.ts", 5),
      { path: "logo.png", additions: 0, deletions: 0 },
      { path: "huge.json", additions: 5000, deletions: 0 },
    ];
    const pushed = github.push("task/3-caps", { commits: ["Lots of changes"], files });
    await delivered(pushed);

    const [push] = await eventsOf("push");
    const lines = (path: string) =>
      push?.payload.files.find((f) => f.path === path)?.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(push?.task).toBe(3);
    expect(lines("big.ts")).toBe(DIFF_LINES_PER_FILE);
    expect(lines("mid-0.ts")).toBe(90);
    expect(lines("mid-1.ts")).toBe(90);
    expect(lines("mid-2.ts")).toBe(90);
    // 100 + 90 + 90 + 90 = 370: 30 lines are left for the rest of the Event.
    expect(lines("mid-3.ts")).toBe(30);
    expect(lines("last.ts")).toBe(0);
    const total = push?.payload.files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
    expect(total).toBe(DIFF_LINES_PER_EVENT);
    expect(push?.payload.files.filter((f) => f.truncated).map((f) => f.path)).toEqual([
      "big.ts",
      "mid-3.ts",
      "last.ts",
      "huge.json",
    ]);
    // Every changed file is listed, even when none of its hunks fit.
    expect(push?.payload.files.map((f) => f.path)).toEqual(files.map((f) => f.path));
    expect(push?.payload.truncationNote).toContain("capped");
    expect(push?.payload.truncationNote).toContain(`git diff origin/main...${pushed.after.slice(0, 12)}`);
  });

  it("carries no truncation note when everything fits", async () => {
    await delivered(github.push("task/4-small", { commits: ["Small"], files: [added("a.ts", 10)] }));
    const [push] = await eventsOf("push");
    expect(push?.payload.truncationNote).toBeUndefined();
    expect(push?.payload.files[0]?.truncated).toBeUndefined();
  });

  it("links a Task branch pushed outside the wrapper to its claimed Task that has none (#45)", async () => {
    const number = github.open({ title: "Made by hand" }).number;
    const shlok = await agent("shlok");
    expect((await post(claimPath(number), shlok)).status).toBe(200);
    const branch = `task/${number}-by-hand`;

    // Even a branch pushed at main, with nothing changed yet, is the Task's branch.
    await delivered(github.push(branch));
    expect(await task(number)).toMatchObject({ status: "claimed", branch });
    const [linked] = await eventsOf("task.branch");
    expect(linked).toMatchObject({ actor: { kind: "github" }, capture: null, task: number, payload: { branch } });

    // A redelivery, or a second branch for the same Task, changes nothing.
    await delivered(github.push(branch, { commits: ["More"], files: [added("a.ts", 1)] }));
    await delivered(github.push(`task/${number}-another`, { commits: ["Other"], files: [added("b.ts", 1)] }));
    expect((await task(number)).branch).toBe(branch);
    expect(await eventsOf("task.branch")).toHaveLength(1);

    // With the branch on record, finish_task works as if the wrapper had set it up.
    expect((await post(finishPath(number), shlok)).status).toBe(200);
    expect(await task(number)).toMatchObject({ status: "review", branch });
  });

  it("links no branch to a Task nobody holds", async () => {
    const number = github.open({ title: "Unclaimed" }).number;
    await delivered(github.push(`task/${number}-early`, { commits: ["Early"], files: [added("a.ts", 1)] }));
    expect((await task(number)).branch).toBeUndefined();
    expect(await eventsOf("task.branch")).toEqual([]);
    expect(await eventsOf("push")).toHaveLength(1);
  });

  it("ignores pushes to other branches, deleted branches, other repos and unmerged or non-main pull requests", async () => {
    const number = github.open({ title: "Branch per Task" }).number;
    const shlok = await agent("shlok");
    const branch = await claimWithBranch(number, shlok);
    const before = (await events()).length;

    await delivered(github.push("main", { commits: ["Direct to main"], files: [added("a.ts", 1)] }));
    await delivered(github.push("feature/x", { commits: ["Feature"], files: [added("a.ts", 1)] }));
    await delivered(github.push("tasks/5-nope", { commits: ["Not a Task branch"], files: [added("a.ts", 1)] }));
    await delivered(github.push("task/5-elsewhere", { commits: ["Other repo"], repo: "someone/else" }));
    const tag = github.push(branch, { commits: ["Tagged"] });
    await delivered({ ...tag, payload: { ...tag.payload, ref: "refs/tags/v1" } });
    await delivered(github.deleteBranch(branch));

    const pr = (await (await post(finishPath(number), shlok)).json<TaskActionResponse>()).task.pr ?? 0;
    const afterFinish = (await events()).length;
    await delivered(github.closeUnmerged(pr));
    const [merged] = github.merge(pr);
    const intoRelease = merged as WebhookDelivery;
    const payload = intoRelease.payload as { pull_request: { base: Record<string, unknown> } };
    await delivered({
      event: "pull_request",
      payload: { ...payload, pull_request: { ...payload.pull_request, base: { ref: "release", sha: "f".repeat(40) } } },
    });

    // Only finishing recorded anything.
    expect((await events()).length).toBe(afterFinish);
    expect(afterFinish - before).toBe(1);
    expect(await eventsOf("push")).toEqual([]);
    expect(await eventsOf("merge")).toEqual([]);
  });

  it("records a merge into main from any branch, with no Task when it is not a Task branch", async () => {
    const number = github.open({ title: "Dashboard" }).number;
    const shlok = await agent("shlok");
    await claimWithBranch(number, shlok);
    github.push("task/dashboard-ui", { commits: ["UI"] });
    // A pull request opened by hand, from a branch that names no Task.
    const pr = await github.createPullRequest({ title: "UI", body: "", head: "task/dashboard-ui", base: "main" });
    const [merged] = github.merge(pr.number, [added("dashboard/src/App.tsx", 2)]);
    await delivered(merged as WebhookDelivery);

    const [merge] = await eventsOf("merge");
    expect(merge?.task).toBeUndefined();
    expect(merge?.payload).toMatchObject({ into: "main", pr: pr.number, branch: "task/dashboard-ui" });
    expect(merge?.payload.files.map((f) => f.path)).toEqual(["dashboard/src/App.tsx"]);
  });

  it("requires the webhook signature, and records a redelivered push once", async () => {
    const pushed = github.push("task/6-signed", { commits: ["Signed"], files: [added("a.ts", 1)] });

    const unsigned = await exports.default.fetch(
      new Request(url("/api/github/webhook"), {
        method: "POST",
        body: JSON.stringify(pushed.payload),
        headers: { "X-GitHub-Event": "push", "X-GitHub-Delivery": "d-1" },
      }),
    );
    expect(unsigned.status).toBe(401);
    expect((await deliver(pushed, { secret: "wrong-secret", id: "d-1" })).status).toBe(401);
    expect(await eventsOf("push")).toEqual([]);

    expect((await deliver(pushed, { id: "d-1" })).status).toBe(204);
    expect((await deliver(pushed, { id: "d-1" })).status).toBe(204);
    expect(await eventsOf("push")).toHaveLength(1);
  });

  it("answers 502 when GitHub cannot say what a push changed, so GitHub redelivers it later", async () => {
    const pushed = github.push("task/6-unknown", { commits: ["Mystery"] });
    const payload = { ...pushed.payload, after: "c".repeat(40) };
    const response = await deliver({ event: "push", payload });
    expect(response.status).toBe(502);
    expect(await eventsOf("push")).toEqual([]);
  });
});
