// The librarian (ADR 0045), through the Channel API as its wrapper and its MCP call it:
// the Librarian Feed and Cursor, what its token may and may not do, its share of the
// Brief's daily writes, one librarian at a time, and how a Host is asked to start it.
// GitHub is the in-memory FakeGitHub, delivering its webhooks the way GitHub does.

import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  AgentResponse,
  ErrorResponse,
  LibrarianFeedResponse,
  Task,
  TaskActionResponse,
} from "../../shared/src/index";
import {
  branchPath,
  briefPagePath,
  claimPath,
  finishPath,
  LIBRARIAN_PATH,
  LIBRARIAN_SCAN,
  librarianWritesPerDay,
  rolePath,
  taskBranch,
} from "../../shared/src/index";
import type { Channel } from "../src/channel";
import type { ComparedFile } from "../src/github/index";
import { installGitHub, sign } from "../src/github/index";
import { type As, bearer, channelStub, forgetTokens, remember, url } from "./client";
import { FakeGitHub, type WebhookDelivery } from "./fake-github";
import { cleanUp, FakeHost } from "./hosts-harness";

const WEBHOOK_SECRET = "test-webhook-secret";
/** The tests' BRIEF_WRITES_PER_DAY (vitest.config.ts). */
const PER_DAY = 40;

let github: FakeGitHub;

async function call(path: string, as: As, init: RequestInit = {}): Promise<Response> {
  const headers = { Authorization: await bearer(as), "Content-Type": "application/json" };
  return exports.default.fetch(new Request(url(path), { ...init, headers }));
}

function post(path: string, as: As, body: unknown = {}): Promise<Response> {
  return call(path, as, { method: "POST", body: JSON.stringify(body) });
}

function put(path: string, as: As, body: unknown): Promise<Response> {
  return call(path, as, { method: "PUT", body: JSON.stringify(body) });
}

let sessions = 0;

/** Registers an Agent the way the wrapper does: the librarian's says so. */
async function register(person: string, librarian = false): Promise<Response> {
  sessions += 1;
  const sessionId = `${sessions.toString(16).padStart(4, "0")}dddd-0000-4000-8000-000000000000`;
  const response = await post(
    "/api/agents",
    { person },
    { cli: "claude-code", sessionId, cwd: "/repo", ...(librarian ? { librarian: true } : {}) },
  );
  if (response.ok) remember(await response.clone().json<AgentResponse>());
  return response;
}

async function agent(person: string, librarian = false): Promise<As & { agent: AgentId }> {
  const response = await register(person, librarian);
  expect(response.status, await response.clone().text()).toBe(200);
  return { person, agent: (await response.json<AgentResponse>()).agent.id };
}

async function feed(as: As): Promise<LibrarianFeedResponse> {
  const response = await call(LIBRARIAN_PATH, as);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<LibrarianFeedResponse>();
}

/** What the wrapper does once the librarian's turn ends: moves the cursor past what it was told. */
async function handled(librarian: As, answer: LibrarianFeedResponse): Promise<void> {
  const moved = await put(LIBRARIAN_PATH, librarian, {
    through: answer.through,
    quiet: answer.quiet.map((q) => q.task),
  });
  expect(moved.status, await moved.clone().text()).toBe(200);
}

async function delivered(delivery: WebhookDelivery): Promise<void> {
  const body = JSON.stringify(delivery.payload);
  const response = await exports.default.fetch(
    new Request(url("/api/github/webhook"), {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": delivery.event,
        "X-GitHub-Delivery": crypto.randomUUID(),
        "X-Hub-Signature-256": await sign(WEBHOOK_SECRET, body),
      },
    }),
  );
  expect(response.status, await response.clone().text()).toBe(204);
}

function added(path: string): ComparedFile {
  return { path, additions: 1, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+line" };
}

/** Opens an Issue on GitHub, delivered to the Channel as a new Task. */
async function opened(title: string): Promise<number> {
  const issue = github.open({ title });
  await delivered(issue);
  return issue.number;
}

/** Claims Task `number`, finishes it and merges its pull request with `files`. */
async function shipped(number: number, holder: As, files: ComparedFile[]): Promise<number> {
  expect((await post(claimPath(number), holder)).status).toBe(200);
  const title = github.issue(number)?.title ?? "";
  expect((await post(branchPath(number), holder, { branch: taskBranch(number, title) })).status).toBe(200);
  const pr = (await (await post(finishPath(number), holder)).json<TaskActionResponse>()).task.pr ?? 0;
  for (const delivery of github.merge(pr, files)) await delivered(delivery);
  return pr;
}

/** Makes Task `number`'s Claim six hours old, past QUIET_CLAIM_HOURS (4). */
async function claimedHoursAgo(number: number): Promise<void> {
  await runInDurableObject(channelStub(), (channel: Channel) => {
    const tasks = (channel as unknown as { tasks: { read(n: number): Task; write(t: Task): void } }).tasks;
    const task = tasks.read(number);
    const claimedAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    tasks.write({ ...task, claim: task.claim && { ...task.claim, claimedAt } });
  });
}

beforeEach(() => {
  github = new FakeGitHub();
  installGitHub(github);
});

afterEach(async () => {
  installGitHub(null);
  forgetTokens();
  await cleanUp();
});

describe("the Librarian Feed", () => {
  it("starts with no cursor and no Events, since a first pass reads where things stand, not the history", async () => {
    await opened("Fix the login redirect");
    const librarian = await agent("shlok1806", true);

    const first = await feed(librarian);
    expect(first.cursor).toBeNull();
    expect(first.changes).toEqual([]);
    expect(first.more).toBe(false);
    expect(first.brief).toMatchObject({ pages: 0, perDay: PER_DAY, librarianPerDay: librarianWritesPerDay(PER_DAY) });

    await handled(librarian, first);
    const next = await feed(librarian);
    expect(next.cursor).toBe(first.through);
    expect(next.changes).toEqual([]);
  });

  it("names what changes a page after the cursor, oldest first: merges with their ADRs, decisions, Tasks opened and closed, Stale Claims", async () => {
    const librarian = await agent("shlok1806", true);
    await handled(librarian, await feed(librarian));

    const builder = await agent("shlok1806");
    const login = await opened("Fix the login redirect");
    const pr = await shipped(login, builder, [
      added("worker/src/auth.ts"),
      added("docs/adr/0046-sessions-last-a-week.md"),
    ]);
    const noted = await post("/api/memory", builder, {
      text: "Sessions last a week; refresh tokens rotate.",
      tags: ["decision"],
      task: login,
    });
    expect(noted.status).toBe(201);
    // A fact is not a decision, and an Update changes no page on its own.
    expect((await post("/api/memory", builder, { text: "The CI runner has 4 cores.", tags: ["fact"] })).status).toBe(
      201,
    );
    expect((await post("/api/updates", builder, { text: "Working on it." })).status).toBe(201);
    const verifier = await opened("Verifier retries");
    const gone = await agent("maya");
    expect((await post(claimPath(verifier), gone)).status).toBe(200);
    expect((await post(`/api/agents/${encodeURIComponent(gone.agent)}/end`, gone)).status).toBe(200);

    const changes = (await feed(librarian)).changes.map(({ seq: _, at: __, ...change }) => change);
    expect(changes).toEqual([
      { kind: "task-opened", task: login, title: "Fix the login redirect" },
      {
        kind: "merge",
        pr,
        branch: taskBranch(login, "Fix the login redirect"),
        into: "main",
        files: 2,
        adrs: ["docs/adr/0046-sessions-last-a-week.md"],
      },
      { kind: "task-closed", task: login, pr },
      { kind: "decision", by: builder.agent, text: "Sessions last a week; refresh tokens rotate.", task: login },
      { kind: "task-opened", task: verifier, title: "Verifier retries" },
      { kind: "claim-stale", task: verifier, holder: gone.agent },
    ]);
  });

  it("leaves out what came before the cursor once it moves", async () => {
    const librarian = await agent("shlok1806", true);
    await handled(librarian, await feed(librarian));
    await opened("Fix the login redirect");
    const told = await feed(librarian);
    expect(told.changes.map((c) => c.kind)).toEqual(["task-opened"]);
    await handled(librarian, told);

    const pager = await opened("Wire the pager");
    const after = await feed(librarian);
    expect(after.cursor).toBe(told.through);
    expect(after.changes).toMatchObject([{ kind: "task-opened", task: pager }]);
  });

  it("says when a Claim goes quiet, and when it is no longer quiet once work resumes", async () => {
    const librarian = await agent("shlok1806", true);
    await handled(librarian, await feed(librarian));
    const holder = await agent("maya");
    const task = await opened("Verifier retries");
    expect((await post(claimPath(task), holder)).status).toBe(200);
    expect((await feed(librarian)).quietStarted).toEqual([]);

    await claimedHoursAgo(task);
    const quiet = await feed(librarian);
    expect(quiet.quiet).toMatchObject([{ task, title: "Verifier retries", holder: holder.agent }]);
    expect(quiet.quietStarted).toEqual([task]);
    await handled(librarian, quiet);
    // Told once: the next Feed no longer calls it new.
    expect((await feed(librarian)).quietStarted).toEqual([]);

    expect((await post("/api/updates", holder, { text: "Back on the retries.", task })).status).toBe(201);
    const resumed = await feed(librarian);
    expect(resumed.quiet).toEqual([]);
    expect(resumed.quietEnded).toEqual([task]);
  });

  it(`looks at no more than ${LIBRARIAN_SCAN} Events past the cursor, and says there are more`, async () => {
    const librarian = await agent("shlok1806", true);
    await handled(librarian, await feed(librarian));
    const first = await opened("The first Task");
    // A long stretch of Events that change no page, then one that does.
    await runInDurableObject(channelStub(), (channel: Channel) => {
      const append = (channel as unknown as { append(event: unknown): unknown }).append.bind(channel);
      for (let i = 0; i < LIBRARIAN_SCAN + 10; i++) {
        append({
          type: "update",
          actor: { kind: "person", person: "shlok1806" },
          capture: null,
          payload: { text: `${i}` },
        });
      }
    });
    const last = await opened("The last Task");

    const page = await feed(librarian);
    expect(page.more).toBe(true);
    expect(page.changes).toMatchObject([{ kind: "task-opened", task: first }]);
    // The wrapper reads on after each pass until there is no more, and misses nothing.
    let rest = page;
    const later = [];
    while (rest.more) {
      await handled(librarian, rest);
      rest = await feed(librarian);
      later.push(...rest.changes);
    }
    expect(later).toMatchObject([{ kind: "task-opened", task: last }]);
  });

  it("is moved only by the librarian's token", async () => {
    const plain = await agent("shlok1806");
    const librarian = await agent("shlok1806", true);
    const answer = await feed(plain);
    const body = { through: answer.through, quiet: [] };
    expect((await put(LIBRARIAN_PATH, plain, body)).status).toBe(403);
    expect((await put(LIBRARIAN_PATH, { person: "shlok1806" }, body)).status).toBe(403);
    expect((await put(LIBRARIAN_PATH, librarian, { through: answer.through + 1000, quiet: [] })).status).toBe(400);
    expect((await put(LIBRARIAN_PATH, librarian, body)).status).toBe(200);
  });
});

describe("the librarian's token", () => {
  it("writes Brief pages and reads the Channel, and is refused on everything else that writes", async () => {
    const task = await opened("Fix the login redirect");
    const librarian = await agent("shlok1806", true);
    const plain = await agent("shlok1806");

    expect((await put(briefPagePath("overview"), librarian, { text: "# The app\n\nLogin is in #1." })).status).toBe(
      201,
    );
    expect((await call("/api/events", librarian)).status).toBe(200);
    expect((await call("/api/tasks", librarian)).status).toBe(200);
    expect((await call("/api/memory", librarian)).status).toBe(200);

    const refused: [string, Response][] = [
      ["an Update", await post("/api/updates", librarian, { text: "I fixed it." })],
      ["a note", await post("/api/memory", librarian, { text: "A decision.", tags: ["decision"] })],
      ["a Claim", await post(claimPath(task), librarian)],
      ["a Directive", await post("/api/directives", librarian, { to: plain.agent, text: "Stop." })],
      ["a spawn", await post("/api/agents/spawn", librarian, { cli: "claude-code", cwd: "/work" })],
    ];
    for (const [what, response] of refused) {
      expect(response.status, what).toBe(403);
    }
    const claim = refused[2]?.[1] as Response;
    expect((await claim.json<ErrorResponse>()).reason).toContain("writes Brief pages and nothing else");
    // The same calls from a plain Agent go through.
    expect((await post("/api/updates", plain, { text: "On it." })).status).toBe(201);
    expect((await post(claimPath(task), plain)).status).toBe(200);
  });

  it("stays a librarian's when its session registers again without saying so", async () => {
    const librarian = await agent("shlok1806", true);
    sessions -= 1;
    const again = await register("shlok1806");
    expect(again.status).toBe(200);
    const agentAgain = (await again.json<AgentResponse>()).agent;
    expect(agentAgain).toMatchObject({ id: librarian.agent, librarian: true });
    expect((await post("/api/updates", librarian, { text: "Hello." })).status).toBe(403);
  });

  it(`stops the librarian's Brief writes at three quarters of the day's ${PER_DAY}, leaving the rest to other Agents`, async () => {
    const librarian = await agent("shlok1806", true);
    const plain = await agent("maya");
    const share = librarianWritesPerDay(PER_DAY);
    for (let i = 0; i < share; i++) {
      expect((await put(briefPagePath("overview"), librarian, { text: `Version ${i}.` })).status).toBe(201);
    }
    const refused = await put(briefPagePath("overview"), librarian, { text: "One more." });
    expect(refused.status).toBe(429);
    expect((await refused.json<ErrorResponse>()).reason).toContain("kept for the other Agents");
    expect((await put(briefPagePath("overview"), plain, { text: "From another Agent." })).status).toBe(201);
    expect((await feed(librarian)).brief).toMatchObject({ writesToday: share + 1, librarianToday: share });
  });
});

describe("one librarian", () => {
  it("is refused a second time while the first is not Gone, and may start again once it is", async () => {
    const first = await agent("shlok1806", true);
    const second = await register("maya", true);
    expect(second.status).toBe(409);
    expect((await second.json<ErrorResponse>()).reason).toContain(`${first.agent} is this Channel's librarian`);
    expect((await post(`/api/agents/${encodeURIComponent(first.agent)}/end`, first)).status).toBe(200);
    expect((await register("maya", true)).status).toBe(200);
  });

  it("is started on a Host in the dontAsk mode with no brief, for a Person and never by a lead", async () => {
    const host = await FakeHost.registered("shlok1806", "studio", ["/work"], "acceptEdits");
    await host.connect();
    const spawning = post(
      "/api/agents/spawn",
      { person: "shlok1806" },
      {
        cli: "claude-code",
        cwd: "/work/app",
        nickname: "librarian",
        librarian: true,
      },
    );
    const spawn = await host.nextSpawn();
    expect(spawn).toMatchObject({ librarian: true, permissionMode: "dontAsk", nickname: "librarian" });
    expect(spawn.brief).toBeUndefined();
    expect((await spawning).status).toBe(202);

    for (const body of [
      { permissionMode: "acceptEdits" },
      { brief: "Also fix the login bug." },
      { from: "shlok1806/claude-code/abcd" },
    ]) {
      const refused = await post(
        "/api/agents/spawn",
        { person: "shlok1806" },
        {
          cli: "claude-code",
          cwd: "/work/app",
          librarian: true,
          ...body,
        },
      );
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }

    const lead = await agent("shlok1806");
    expect((await put(rolePath(lead.agent), { person: "shlok1806" }, { role: "lead" })).status).toBe(200);
    const byLead = await post("/api/agents/spawn", lead, { cli: "claude-code", cwd: "/work/app", librarian: true });
    expect(byLead.status).toBe(403);
    expect((await byLead.json<ErrorResponse>()).reason).toContain("Only a Person starts the Channel's librarian");
  });
});
