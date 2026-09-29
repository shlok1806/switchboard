// Tasks from GitHub (#8, ADR 0001), driven through the Channel API the way real
// clients and GitHub do, with an in-memory GitHub behind the sync interface.

import { env, reset, runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChannelEvent,
  CreateTaskResponse,
  ErrorResponse,
  HistoryResponse,
  Task,
  TaskListResponse,
  TaskResponse,
} from "../../shared/src/index";
import { installGitHub, sign } from "../src/github/index";
import { FakeGitHub, type WebhookDelivery } from "./fake-github";

const BASE = "https://switchboard.test";
const WEBHOOK_SECRET = "test-webhook-secret";

let github: FakeGitHub;

function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

function as(person: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { Authorization: "Bearer test-join-secret", "X-Switchboard-Person": person, ...init.headers },
  };
}

async function tasks(): Promise<Task[]> {
  const response = await call("/api/tasks", as("shlok"));
  expect(response.status).toBe(200);
  return (await response.json<TaskListResponse>()).tasks;
}

async function task(number: number): Promise<Task> {
  const response = await call(`/api/tasks/${number}`, as("shlok"));
  expect(response.status).toBe(200);
  return (await response.json<TaskResponse>()).task;
}

async function events(): Promise<ChannelEvent[]> {
  const response = await call("/api/events", as("shlok"));
  return (await response.json<HistoryResponse>()).events;
}

/** The Task Events after `seq`, as [type, actor, task, via] for readable assertions. */
async function taskEvents(after = 0): Promise<[string, string, number | undefined, string | undefined][]> {
  return (await events())
    .filter((e) => e.seq > after && e.type.startsWith("task."))
    .map((e) => [
      e.type,
      e.actor.kind === "person" ? `person:${e.actor.person}` : e.actor.kind,
      e.task,
      "via" in e.payload ? e.payload.via : undefined,
    ]);
}

async function lastSeq(): Promise<number> {
  return (await events()).at(-1)?.seq ?? 0;
}

/** Delivers a webhook the way GitHub does: raw JSON body, HMAC signature, event header. */
async function deliver(delivery: WebhookDelivery, secret = WEBHOOK_SECRET): Promise<Response> {
  const body = JSON.stringify(delivery.payload);
  return call("/api/github/webhook", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": delivery.event,
      "X-GitHub-Delivery": crypto.randomUUID(),
      "X-Hub-Signature-256": await sign(secret, body),
    },
  });
}

async function delivered(delivery: WebhookDelivery): Promise<void> {
  expect((await deliver(delivery)).status).toBe(204);
}

/** Lets the reconcile alarm fire, as it does every few minutes in production. */
async function reconcile(): Promise<void> {
  const channel = env.CHANNEL.get(env.CHANNEL.idFromName("main"));
  expect(await runDurableObjectAlarm(channel)).toBe(true);
}

beforeEach(() => {
  github = new FakeGitHub();
  installGitHub(github);
});

afterEach(async () => {
  installGitHub(null);
  await reset();
});

describe("mirroring GitHub", () => {
  it("shows each open Issue as a Task, with Subtasks under their parent, Steps and blockers", async () => {
    const parent = github.open({
      title: "Tasks from GitHub",
      body: [
        "## Build",
        "- [x] sync module",
        "- [ ] webhook",
        "  * [X] nested step",
        "```md",
        "- [ ] inside a code fence, not a Step",
        "```",
      ].join("\n"),
      labels: ["ready-for-agent"],
    }).number;
    const openChild = github.open({ title: "Webhook" }).number;
    const doneChild = github.open({ title: "Reconcile" }).number;
    github.addSubIssue(parent, openChild);
    github.addSubIssue(parent, doneChild);
    github.close(doneChild);
    const blocker = github.open({ title: "Channel skeleton" }).number;
    const closedBlocker = github.open({ title: "Old blocker" }).number;
    github.close(closedBlocker);
    const blocked = github.open({ title: "Claims" }).number;
    github.addBlocker(blocked, blocker);
    github.addBlocker(blocked, closedBlocker);

    const all = await tasks();
    // Closed Issues the Channel never saw open are not Tasks.
    expect(all.map((t) => t.number)).toEqual([parent, openChild, blocker, blocked]);

    expect(await task(parent)).toMatchObject({
      title: "Tasks from GitHub",
      labels: ["ready-for-agent"],
      status: "open",
      url: `https://github.com/shlok1806/switchboard/issues/${parent}`,
      subtasks: [openChild, doneChild],
      subtasksDone: 1,
      steps: [
        { index: 0, text: "sync module", done: true },
        { index: 1, text: "webhook", done: false },
        { index: 2, text: "nested step", done: true },
      ],
      stepsDone: 2,
      blockedBy: [],
    });
    expect((await task(openChild)).parent).toBe(parent);
    // Only open blockers block.
    expect((await task(blocked)).blockedBy).toEqual([blocker]);
    expect(await taskEvents()).toEqual([
      ["task.create", "github", parent, "reconcile"],
      ["task.create", "github", openChild, "reconcile"],
      ["task.create", "github", blocker, "reconcile"],
      ["task.create", "github", blocked, "reconcile"],
    ]);
  });

  it("answers 404 for an unknown Task and refuses a wrong join secret", async () => {
    github.open({ title: "Only one" });
    const missing = await call("/api/tasks/99", as("shlok"));
    expect(missing.status).toBe(404);
    expect(await missing.json<ErrorResponse>()).toEqual({ ok: false, reason: "No Task #99." });

    const wrong = { headers: { Authorization: "Bearer nope", "X-Switchboard-Person": "mallory" } };
    expect((await call("/api/tasks", wrong)).status).toBe(401);
    expect((await call("/api/tasks/1", wrong)).status).toBe(401);
    expect((await call("/api/tasks", { ...wrong, method: "POST", body: '{"title":"x"}' })).status).toBe(401);
    expect(github.outbox).toHaveLength(1);
  });

  it.skipIf(env.GITHUB_TOKEN)("says so when GitHub sync is not configured", async () => {
    installGitHub(null);
    const response = await call("/api/tasks", as("shlok"));
    expect(response.status).toBe(503);
    expect((await response.json<ErrorResponse>()).reason).toMatch(/GITHUB_TOKEN/);
  });
});

describe("GitHub webhook", () => {
  it("updates a Task when its Issue is edited on GitHub", async () => {
    const number = github.open({ title: "Draft", body: "- [ ] one\n- [ ] two" }).number;
    await tasks();
    const since = await lastSeq();

    await delivered(github.edit(number, { title: "Final", body: "- [x] one\n- [ ] two", labels: ["bug"] }));

    expect(await task(number)).toMatchObject({
      title: "Final",
      labels: ["bug"],
      steps: [
        { index: 0, text: "one", done: true },
        { index: 1, text: "two", done: false },
      ],
      stepsDone: 1,
    });
    const change = (await events()).find((e) => e.seq > since && e.type === "task.change");
    expect(change).toMatchObject({
      actor: { kind: "github" },
      capture: null,
      task: number,
      payload: { fields: ["title", "description", "labels", "steps"], via: "webhook" },
    });
  });

  it("adds a Subtask under its parent and counts it done when it closes", async () => {
    const parent = github.open({ title: "Parent" }).number;
    const child = github.open({ title: "Child" }).number;
    await tasks();

    await delivered(github.addSubIssue(parent, child));
    expect(await task(parent)).toMatchObject({ subtasks: [child], subtasksDone: 0 });
    expect((await task(child)).parent).toBe(parent);

    await delivered(github.close(child, "sam-codes"));
    expect(await task(parent)).toMatchObject({ subtasks: [child], subtasksDone: 1 });
    expect((await task(child)).status).toBe("done");
  });

  it("shows a blocker added on GitHub, and drops it when the blocker closes", async () => {
    const blocker = github.open({ title: "Skeleton" }).number;
    const blocked = github.open({ title: "Tasks" }).number;
    await tasks();

    await delivered(github.addBlocker(blocked, blocker));
    expect((await task(blocked)).blockedBy).toEqual([blocker]);

    await delivered(github.close(blocker));
    expect((await task(blocked)).blockedBy).toEqual([]);
  });

  it("refuses a delivery with a bad signature, and changes nothing", async () => {
    const number = github.open({ title: "Before" }).number;
    await tasks();
    const since = await lastSeq();

    const forged = await deliver(github.edit(number, { title: "Forged" }), "not-the-secret");
    expect(forged.status).toBe(401);
    const unsigned = await call("/api/github/webhook", {
      method: "POST",
      body: "{}",
      headers: { "X-GitHub-Event": "issues" },
    });
    expect(unsigned.status).toBe(401);

    expect((await task(number)).title).toBe("Before");
    expect(await lastSeq()).toBe(since);
  });

  it("acknowledges events it does not use, and deliveries for other repos", async () => {
    await tasks();
    const since = await lastSeq();
    expect((await deliver({ event: "ping", payload: { zen: "Keep it simple." } })).status).toBe(204);
    const other = github.open({ title: "Elsewhere" });
    const foreign = { ...other, payload: { ...other.payload, repository: { full_name: "someone/else" } } };
    expect((await deliver(foreign)).status).toBe(204);
    expect(await lastSeq()).toBe(since);
  });

  it("removes the Task when its Issue is deleted", async () => {
    const number = github.open({ title: "Mistake" }).number;
    await tasks();
    await delivered(github.delete(number));
    expect((await call(`/api/tasks/${number}`, as("shlok"))).status).toBe(404);
    expect((await taskEvents()).at(-1)).toEqual(["task.remove", "github", number, "webhook"]);
  });
});

describe("reconcile", () => {
  it("repairs missed webhooks: edits, new Issues and closes", async () => {
    const edited = github.open({ title: "Old title" }).number;
    const closed = github.open({ title: "Will close" }).number;
    await tasks();
    const since = await lastSeq();

    // None of these deliveries reach the Channel.
    github.edit(edited, { title: "New title", body: "- [ ] a step" });
    const added = github.open({ title: "Opened while the webhook was down" }).number;
    github.close(closed, "Sam-Codes");
    expect((await task(edited)).title).toBe("Old title");

    await reconcile();

    expect(await task(edited)).toMatchObject({ title: "New title", stepsDone: 0, steps: [{ text: "a step" }] });
    expect((await task(added)).status).toBe("open");
    expect((await task(closed)).status).toBe("done");
    expect(await taskEvents(since)).toEqual([
      ["task.change", "github", edited, "reconcile"],
      ["task.create", "github", added, "reconcile"],
      ["task.done", "person:sam-codes", closed, undefined],
    ]);
  });

  it("records nothing when GitHub and the Channel already agree", async () => {
    github.open({ title: "Stable", body: "- [x] done" });
    await tasks();
    const since = await lastSeq();
    await reconcile();
    await reconcile();
    expect(await lastSeq()).toBe(since);
  });
});

describe("creating a Task", () => {
  it("creates the GitHub Issue, as an Event by the Person", async () => {
    await tasks();
    const since = await lastSeq();
    const response = await call(
      "/api/tasks",
      as("shlok", {
        method: "POST",
        body: JSON.stringify({ title: "  Presence  ", description: "- [ ] heartbeat\n- [ ] gone", labels: ["agent"] }),
      }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json<CreateTaskResponse>()).task;

    expect(github.issue(created.number)).toEqual({
      title: "Presence",
      body: "- [ ] heartbeat\n- [ ] gone",
      labels: ["agent"],
      state: "open",
      author: github.tokenLogin,
      assignees: [],
      comments: [],
    });
    expect(created).toMatchObject({ title: "Presence", status: "open", stepsDone: 0, labels: ["agent"] });
    expect(created.steps.map((s) => s.text)).toEqual(["heartbeat", "gone"]);
    expect(await task(created.number)).toEqual(created);

    const create = (await events()).find((e) => e.seq > since && e.type === "task.create");
    expect(create).toMatchObject({
      actor: { kind: "person", person: "shlok" },
      task: created.number,
      payload: { title: "Presence", via: "channel" },
    });

    // GitHub's own `issues.opened` delivery for it changes nothing.
    const seqAfterCreate = await lastSeq();
    const opened = github.outbox.at(-1);
    if (!opened) throw new Error("GitHub sent no delivery");
    await delivered(opened);
    expect(await lastSeq()).toBe(seqAfterCreate);
  });

  it("refuses a Task without a title, and does not touch GitHub", async () => {
    for (const body of [{}, { title: "   " }, { title: "x".repeat(257) }, { title: "ok", labels: "bug" }]) {
      const response = await call("/api/tasks", as("shlok", { method: "POST", body: JSON.stringify(body) }));
      expect(response.status).toBe(400);
    }
    expect(github.outbox).toEqual([]);
  });
});

describe("closing on GitHub", () => {
  it("marks the Task done as an Event by the Person who closed it, and reopens it", async () => {
    const number = github.open({ title: "Ship it" }).number;
    await tasks();
    const since = await lastSeq();

    await delivered(github.close(number, "Octo-Cat"));
    expect((await task(number)).status).toBe("done");
    const done = (await events()).find((e) => e.seq > since && e.type === "task.done");
    expect(done).toMatchObject({
      actor: { kind: "person", person: "octo-cat" },
      capture: null,
      task: number,
      payload: { closedOnGitHub: true },
    });
    // Closed Tasks stay on the list, done.
    expect((await tasks()).map((t) => [t.number, t.status])).toEqual([[number, "done"]]);

    await delivered(github.reopen(number));
    expect((await task(number)).status).toBe("open");
    expect((await taskEvents(since)).map(([type]) => type)).toEqual(["task.done", "task.reopen"]);
  });
});
