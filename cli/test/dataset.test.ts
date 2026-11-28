// The Dataset (ADR 0054): the collector copies the owner's own sessions, with their
// subagents and workflow runs, redacted, links them to their outcomes, and is safe to
// run again and again.

import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelEvent } from "../../shared/src/index";
import { DatasetTrigger, datasetStats } from "../src/dataset/command";
import type { GithubPr, LinkDeps } from "../src/dataset/outcomes";
import type { DatasetOutcome, DatasetSession, DatasetTurn } from "../src/dataset/schema";
import { syncDataset } from "../src/dataset/sync";

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";
const SESSION = "8304f443-0000-4000-8000-000000000001";
const RUN = "20261107-020458-930abba92641e91f";

// Secrets planted in the sessions; none may reach the Dataset.
const API_KEY = "sk-ant-api03-PLANTEDplantedPLANTED0123456789";
const ENV_VALUE = "hunter2-planted-db-password";
const BEARER = "planted.bearer.token-9f8e7d6c5b4a";

const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const at = (minute: number) => `2026-11-08T10:${String(minute).padStart(2, "0")}:00.000Z`;

let home: string;
let dataset: string;
let projects: string;

/** A Claude Code session of the owner's: prompts, tool calls with secrets, a PR, a Greenroom run, corrections. */
function mainSession(): string {
  const base = { sessionId: SESSION, cwd: "/work/app", gitBranch: "task/7-login", isSidechain: false };
  return [
    line({ type: "session-owner", accountUuid: OWNER, sessionId: SESSION }),
    line({ type: "ai-title", aiTitle: "Fix the login test", sessionId: SESSION }),
    line({
      ...base,
      type: "user",
      timestamp: at(0),
      origin: { kind: "human" },
      message: { role: "user", content: "Fix the login test" },
    }),
    line({
      ...base,
      type: "assistant",
      timestamp: at(1),
      message: {
        id: "msg_1",
        model: "claude-opus-5-5",
        content: [
          { type: "text", text: `I will call the API with ${API_KEY}.` },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat .env" } },
        ],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
      },
    }),
    line({
      ...base,
      type: "assistant",
      timestamp: at(1),
      message: {
        id: "msg_1",
        model: "claude-opus-5-5",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "Bash",
            input: { command: `curl -H "Authorization: Bearer ${BEARER}" https://api.example.com` },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
      },
    }),
    line({
      ...base,
      type: "user",
      timestamp: at(2),
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: `DB_PASSWORD=${ENV_VALUE}\nPORT=8080` },
          { type: "tool_result", tool_use_id: "t2", content: "ok" },
        ],
      },
    }),
    line({
      ...base,
      type: "assistant",
      timestamp: at(3),
      message: {
        id: "msg_2",
        model: "claude-opus-5-5",
        content: [
          { type: "tool_use", id: "t3", name: "Bash", input: { command: "git commit -m 'Fix the login test'" } },
          { type: "tool_use", id: "t4", name: "Bash", input: { command: "gh pr create --fill" } },
          { type: "tool_use", id: "t5", name: "mcp__greenroom__machine_create", input: {} },
          { type: "tool_use", id: "t6", name: "Edit", input: { file_path: "a.ts" } },
        ],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    }),
    line({
      ...base,
      type: "user",
      timestamp: at(4),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t3",
            content: "[task/7-login 1a2b3c4] Fix the login test\n 1 file changed",
          },
          { type: "tool_result", tool_use_id: "t4", content: "https://github.com/acme/app/pull/42" },
          { type: "tool_result", tool_use_id: "t5", content: `{"runId":"${RUN}","status":"booting"}` },
          {
            type: "tool_result",
            tool_use_id: "t6",
            content:
              "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).",
          },
        ],
      },
    }),
    line({
      ...base,
      type: "user",
      timestamp: at(5),
      origin: { kind: "human" },
      message: { role: "user", content: "no, keep the old test name and only fix the assertion" },
    }),
    line({
      type: "pr-link",
      sessionId: SESSION,
      prNumber: 42,
      prUrl: "https://github.com/acme/app/pull/42",
      prRepository: "acme/app",
      timestamp: at(6),
    }),
  ].join("");
}

/** A subagent's transcript, and a workflow run with its journal and an agent. */
async function writeChildren(dir: string): Promise<void> {
  const sub = join(dir, "subagents");
  await mkdir(join(sub, "workflows", "wf_1"), { recursive: true });
  const child = (text: string) =>
    line({
      type: "assistant",
      timestamp: at(7),
      isSidechain: true,
      message: { id: `m-${text}`, model: "claude-haiku-5-5", content: [{ type: "text", text }] },
    });
  await writeFile(join(sub, "agent-sub1.jsonl"), child("subagent findings"));
  await writeFile(
    join(sub, "agent-sub1.meta.json"),
    JSON.stringify({ agentType: "Explore", description: "Find the login test" }),
  );
  await writeFile(join(sub, "workflows", "wf_1", "agent-wfa1.jsonl"), child(`workflow agent saw ${API_KEY}`));
  await writeFile(
    join(sub, "workflows", "wf_1", "journal.jsonl"),
    line({ type: "launched" }) + line({ type: "result", agentId: "wfa1", result: "done" }),
  );
  await mkdir(join(dir, "workflows"), { recursive: true });
  await writeFile(
    join(dir, "workflows", "wf_1.json"),
    JSON.stringify({ runId: "wf_1", script: "export const meta = { name: 'login-sweep' }" }),
  );
}

function deps(overrides: Partial<LinkDeps> = {}): LinkDeps {
  return { greenroomRuns: join(home, ".greenroom", "runs"), repoOf: async () => "acme/app", ...overrides };
}

async function readAll(dir: string): Promise<string> {
  let text = "";
  for (const name of await readdir(dir, { recursive: true })) {
    const path = join(dir, String(name));
    if ((await stat(path)).isFile()) text += await readFile(path, "utf8");
  }
  return text;
}

const out = () => join(dataset, "sessions", "claude-code", SESSION);
const turnsOf = async () =>
  (await readFile(join(out(), "turns.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as DatasetTurn);
const json = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "sb-dataset-"));
  dataset = join(home, "dataset");
  projects = join(home, ".claude", "projects", "-work-app");
  await mkdir(projects, { recursive: true });
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: OWNER, emailAddress: "owner@example.com" } }),
  );
  await writeFile(join(projects, `${SESSION}.jsonl`), mainSession());
  await writeChildren(join(projects, SESSION));
  const run = join(home, ".greenroom", "runs", RUN);
  await mkdir(run, { recursive: true });
  await writeFile(
    join(run, "manifest.json"),
    JSON.stringify({
      runId: RUN,
      name: "Login check",
      verdict: { verdict: "pass" },
      finish: { outcome: "verified", summary: "It passed." },
    }),
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const sync = (extra: Partial<Parameters<typeof syncDataset>[0]> = {}) =>
  syncDataset({
    dir: dataset,
    env: { HOME: home },
    link: deps(),
    now: () => new Date("2026-11-09T00:00:00Z"),
    ...extra,
  });

describe("dataset sync", () => {
  it("copies the owner's session with its subagents and workflow run, every secret redacted", async () => {
    const report = await sync();
    expect(report).toMatchObject({ ran: true, written: 1, firstSync: true });

    const everything = await readAll(dataset);
    for (const secret of [API_KEY, ENV_VALUE, BEARER]) expect(everything).not.toContain(secret);

    const turns = await turnsOf();
    const text = JSON.stringify(turns);
    expect(text).toContain("sk-ant-****");
    expect(text).toContain("DB_PASSWORD=****");
    expect(text).toContain("Authorization: Bearer ****");
    expect(text).toContain("PORT=8080");
    expect(new Set(turns.map((t) => t.thread))).toEqual(
      new Set(["main", "subagent:sub1", "workflow:wf_1/wfa1", "workflow:wf_1"]),
    );

    const session = await json<DatasetSession>(join(out(), "session.json"));
    expect(session.account).toEqual({ id: OWNER, source: join(home, ".claude") });
    expect(session.title).toBe("Fix the login test");
    expect(session.threads.find((t) => t.id === "subagent:sub1")).toMatchObject({
      kind: "subagent",
      agentType: "Explore",
      turns: 1,
    });
    expect(session.workflows).toEqual([
      { runId: "wf_1", name: "login-sweep", agents: ["workflow:wf_1/wfa1"], journalEntries: 2 },
    ]);
    // One model message split over two entries counts its tokens once.
    expect(session.tokens).toEqual({ input: 13, output: 13, cacheCreation: 7, cacheRead: 100 });

    // The manifest counts by kind and never holds a value.
    const manifest = await json<{ kinds: Record<string, number>; total: number }>(join(dataset, "redactions.json"));
    expect(manifest.kinds).toMatchObject({
      "an Anthropic key": 2,
      "a secret assignment": 1,
      "an HTTP credential header": 1,
    });
    expect(manifest.total).toBe(4);
  });

  it("keeps the owner's corrections as they were said", async () => {
    await sync();
    const corrections = (await turnsOf()).filter((t) => t.correction);
    expect(corrections.map((t) => t.correction?.kind)).toEqual(["rejected-tool", "redirect"]);
    expect(corrections[1]?.parts).toEqual([
      { type: "text", text: "no, keep the old test name and only fix the assertion" },
    ]);
    // The first prompt of a session redirects nothing.
    expect((await turnsOf()).find((t) => t.kind === "prompt")?.correction).toBeUndefined();
  });

  it("links the repo, branch, commit, pull request and Greenroom verdict", async () => {
    await sync();
    const outcome = await json<DatasetOutcome>(join(out(), "outcome.json"));
    expect(outcome).toMatchObject({
      repo: "acme/app",
      branches: ["task/7-login"],
      commits: [{ sha: "1a2b3c4", branch: "task/7-login", message: "Fix the login test" }],
      prs: [{ repo: "acme/app", number: 42, via: ["tool-output", "cli"] }],
      greenroom: [{ runId: RUN, relation: "created", name: "Login check", verdict: "pass", outcome: "verified" }],
      corrections: 2,
    });
    expect(outcome.unlinked).toEqual([{ what: "pr acme/app#42", why: "linked offline" }]);
    expect(await readFile(join(dataset, "outcomes.jsonl"), "utf8")).toBe(`${JSON.stringify(outcome)}\n`);
  });

  it("asks GitHub whether a pull request merged and was reverted, and the Channel for the Agent's Task", async () => {
    await appendFile(
      join(projects, `${SESSION}.jsonl`),
      line({
        type: "assistant",
        timestamp: at(8),
        message: {
          id: "m9",
          content: [{ type: "tool_use", id: "t9", name: "mcp__switchboard__claim_task", input: { task: 7 } }],
        },
      }),
    );
    const prs: GithubPr[] = [
      {
        number: 42,
        title: "Fix the login test",
        state: "MERGED",
        url: "u42",
        mergedAt: "2026-11-08T12:00:00Z",
        closedAt: "2026-11-08T12:00:00Z",
        mergeCommit: { oid: "abc" },
      },
      {
        number: 43,
        title: 'Revert "Fix the login test"',
        state: "MERGED",
        url: "u43",
        mergedAt: "2026-11-08T13:00:00Z",
        closedAt: null,
        mergeCommit: null,
      },
    ];
    const agent = `owner/claude/${SESSION.slice(0, 4)}`;
    const event = (type: string, payload: unknown, seq: number) =>
      ({
        id: `e${seq}`,
        seq,
        at: at(seq),
        type,
        payload,
        task: 7,
        capture: "tool",
        actor: { kind: "agent", agentId: agent },
      }) as unknown as ChannelEvent;
    const asked: string[] = [];
    await sync({
      link: deps({
        pullRequests: async () => prs,
        person: "owner",
        agentEvents: async (repo, id) => {
          asked.push(`${repo} ${id}`);
          return [event("claim", {}, 1), event("step.complete", {}, 2), event("task.review", { pr: 42 }, 3)];
        },
      }),
    });
    const outcome = await json<DatasetOutcome>(join(out(), "outcome.json"));
    expect(asked).toEqual([`acme/app ${agent}`]);
    expect(outcome.prs).toEqual([
      expect.objectContaining({
        number: 42,
        state: "merged",
        mergeCommit: "abc",
        revertedBy: "acme/app#43",
        via: ["tool-output", "cli", "channel"],
      }),
    ]);
    expect(outcome.switchboard).toEqual({
      channel: "acme/app",
      agent,
      tasks: [{ task: 7, claimedAt: at(1), stepsCompleted: 1, pr: 42 }],
    });
    expect(outcome.unlinked).toEqual([]);
  });

  it("is idempotent, and copies a session again once it changes", async () => {
    await sync();
    const first = await readAll(join(dataset, "sessions"));
    expect(await sync()).toMatchObject({ written: 0, unchanged: 1 });
    expect(await readAll(join(dataset, "sessions"))).toBe(first);

    await appendFile(
      join(projects, `${SESSION}.jsonl`),
      line({
        type: "user",
        timestamp: at(9),
        origin: { kind: "human" },
        message: { role: "user", content: "thanks" },
        sessionId: SESSION,
      }),
    );
    expect(await sync()).toMatchObject({ written: 1 });
    expect((await turnsOf()).filter((t) => t.thread === "main").at(-1)?.parts).toEqual([
      { type: "text", text: "thanks" },
    ]);
  });

  it("resumes after a sync that stopped, and runs one at a time", async () => {
    await sync();
    const first = await readAll(join(dataset, "sessions"));
    // A sync that died before saving its state, and left its lock behind.
    await rm(join(dataset, "state.json"));
    await writeFile(join(dataset, "sync.lock"), "999999999");
    expect(await sync()).toMatchObject({ ran: true, written: 1 });
    expect(await readAll(join(dataset, "sessions"))).toBe(first);

    await writeFile(join(dataset, "sync.lock"), String(process.pid));
    expect(await sync()).toMatchObject({ ran: false, written: 0 });
  });

  it("keeps only the accounts sources.json lists", async () => {
    const other = "9f9f9f9f-0000-4000-8000-000000000002";
    await writeFile(
      join(projects, `${other}.jsonl`),
      line({ type: "session-owner", accountUuid: STRANGER }) +
        line({ type: "user", timestamp: at(1), message: { content: "a teammate's prompt" } }),
    );
    const report = await sync();
    expect(report.skipped).toEqual({ [STRANGER]: 1 });
    expect(await readAll(dataset)).not.toContain("a teammate's prompt");

    // The owner takes their own account off: its sessions leave the Dataset.
    const sources = await json<{ sources: { accounts: string[] }[] }>(join(dataset, "sources.json"));
    for (const source of sources.sources) source.accounts = [];
    await writeFile(join(dataset, "sources.json"), JSON.stringify({ ...sources, keepUnattributed: false }));
    expect(await sync()).toMatchObject({ removed: 1 });
    expect((await datasetStats(dataset)).sessions).toEqual({});
  });

  it("reads Codex rollouts, redacted, with their token totals", async () => {
    const codex = join(home, ".codex", "sessions", "2026", "11", "08");
    await mkdir(codex, { recursive: true });
    const id = "019ed23e-30fe-72a0-af30-1505b536b495";
    const entry = (type: string, payload: unknown) => line({ timestamp: at(1), type, payload });
    await writeFile(
      join(codex, `rollout-2026-11-08T10-00-00-${id}.jsonl`),
      entry("session_meta", { id, cwd: "/work/app", creator_account_id: "codex-acct" }) +
        entry("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }],
        }) +
        entry("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Deploy it" }],
        }) +
        entry("response_item", {
          type: "function_call",
          name: "exec",
          call_id: "c1",
          arguments: `{"cmd":"export OPENAI_API_KEY=${API_KEY}"}`,
        }) +
        entry("response_item", { type: "function_call_output", call_id: "c1", output: "done" }) +
        entry("event_msg", {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 8 } },
        }),
    );
    await sync();
    const base = join(dataset, "sessions", "codex", id);
    const session = await json<DatasetSession>(join(base, "session.json"));
    expect(session).toMatchObject({
      cli: "codex",
      account: { id: "codex-acct" },
      tokens: { input: 30, cacheRead: 20, output: 8, cacheCreation: 0 },
    });
    const turns = await readFile(join(base, "turns.jsonl"), "utf8");
    expect(turns).not.toContain(API_KEY);
    expect(
      turns
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as DatasetTurn).kind),
    ).toEqual(["context", "prompt", "message", "result"]);
  });
});

describe("dataset stats", () => {
  it("counts sessions, turns, tokens, outcomes and corrections", async () => {
    await sync();
    const stats = await datasetStats(dataset);
    expect(stats).toMatchObject({
      sessions: { "claude-code": 1 },
      threads: { subagents: 1, workflowAgents: 1, workflowRuns: 1 },
      prompts: 2,
      tokens: { input: 13, output: 13 },
      corrections: { "rejected-tool": 1, redirect: 1 },
      outcomes: {
        linked: 1,
        withRepo: 1,
        withCommits: 1,
        withPrs: 1,
        withGreenroomRun: 1,
        greenroomVerdicts: { pass: 1 },
      },
    });
  });
});

describe("the background sync a wrapper starts", () => {
  it("starts only once the owner set the Dataset up, and at most once per stretch of turns", async () => {
    const marker = join(home, "started");
    const entry = join(home, "fake-cli.mjs");
    await writeFile(
      entry,
      `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" ") + "\\n");`,
    );
    const env = { HOME: home, SWITCHBOARD_DATASET_DIR: dataset };
    const trigger = new DatasetTrigger(env, entry);
    expect(await trigger.kick("end")).toBe(false);

    await sync();
    expect(await trigger.kick("turn", 1_000_000)).toBe(true);
    expect(await trigger.kick("turn", 1_000_000 + 60_000)).toBe(false);
    expect(await trigger.kick("end", 1_000_000 + 60_000)).toBe(true);
    expect(await new DatasetTrigger({ ...env, SWITCHBOARD_DATASET: "off" }, entry).kick("end")).toBe(false);

    for (let i = 0; i < 50 && (await readFile(marker, "utf8").catch(() => "")).split("\n").length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await readFile(marker, "utf8")).toBe("dataset sync --quiet\ndataset sync --quiet\n");
  });
});
