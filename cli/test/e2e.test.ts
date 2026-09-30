// End to end: the built `switchboard` CLI, run in a real pty around a fake agent
// CLI standing in for `claude`, against the Channel Worker running locally in
// `wrangler dev`. Everything is observed the way a Person would: through the
// terminal, and through the Channel API the Dashboard reads.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as pty from "@lydell/node-pty";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Agent,
  AgentId,
  AgentsResponse,
  ChannelEvent,
  HistoryResponse,
  TaskResponse,
  TouchedFilesResponse,
} from "../../shared/src/index";
import { agentPath, REVIEW_LABEL } from "../../shared/src/index";
import { GitHubApi } from "./fixtures/github-api";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "switchboard.js");
const FAKE_CLAUDE = join(here, "fixtures", "fake-claude.mjs");
const WORKER_DIR = join(here, "..", "..", "worker");
const SECRET = "e2e-join-secret";
const WEBHOOK_SECRET = "e2e-webhook-secret";
const GONE_AFTER_SECONDS = 3;

let base = "";
let wrangler: ChildProcess | null = null;
let scratch = "";
let env: Record<string, string> = {};
let cwd = "";
const terminals: pty.IPty[] = [];
const github = new GitHubApi("e2e/repo");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject()));
    });
  });
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined> | T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${last ? `: ${last}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${SECRET}`, "X-Switchboard-Person": "dashboard" },
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

async function agents(): Promise<Agent[]> {
  return (await api<AgentsResponse>("/api/agents")).agents;
}

async function agentEvents(id: string): Promise<ChannelEvent[]> {
  const { events } = await api<HistoryResponse>("/api/events");
  return events.filter((e) => e.actor.kind === "agent" && e.actor.agentId === id);
}

/** An Agent's Events from the wrapper and the Channel, leaving out the Hook Capture's. */
async function wrapperEvents(id: string): Promise<ChannelEvent[]> {
  return (await agentEvents(id)).filter((e) => e.capture !== "hook");
}

/** An Agent's Hook Capture Events. */
async function hookEvents(id: string): Promise<ChannelEvent[]> {
  return (await agentEvents(id)).filter((e) => e.capture === "hook");
}

function presenceOf(id: string): Promise<Agent["presence"] | undefined> {
  return agents().then((all) => all.find((a) => a.id === id)?.presence);
}

function waitForPresence(id: string, presence: Agent["presence"], ms?: number): Promise<true> {
  return waitFor(`${id} to be ${presence}`, async () => ((await presenceOf(id)) === presence ? true : undefined), ms);
}

/** A Person's terminal running `switchboard <args>` in a pty. */
class Terminal {
  output = "";
  readonly exited: Promise<number>;
  private readonly term: pty.IPty;

  constructor(args: string[], extraEnv: Record<string, string> = {}, dir = cwd) {
    this.term = pty.spawn(process.execPath, [CLI, ...args], {
      cols: 100,
      rows: 30,
      cwd: dir,
      env: { ...env, ...extraEnv },
    });
    terminals.push(this.term);
    this.term.onData((data) => {
      this.output += data;
    });
    this.exited = new Promise((resolve) => this.term.onExit(({ exitCode }) => resolve(exitCode)));
  }

  get pid(): number {
    return this.term.pid;
  }

  type(text: string): void {
    this.term.write(text);
  }

  waitForOutput(pattern: RegExp): Promise<RegExpMatchArray> {
    return waitFor(`terminal output ${pattern}`, () => this.output.match(pattern) ?? undefined).catch((error) => {
      throw new Error(`${error.message}. The terminal shows:\n${this.output}`);
    });
  }

  /** The fake agent CLI's report of what it was started with. */
  async started(): Promise<{ args: string[]; sessionId: string; agentEnv: string }> {
    const args = JSON.parse((await this.waitForOutput(/FAKE-CLAUDE args=(\[.*\])/))[1] ?? "[]") as string[];
    const sessionId = (await this.waitForOutput(/FAKE-CLAUDE session=([\w-]+)/))[1] ?? "";
    const agentEnv = (await this.waitForOutput(/FAKE-CLAUDE agent=(\S*)/))[1] ?? "";
    return { args, sessionId, agentEnv };
  }
}

/** Delivers GitHub's signed `issues` webhook for an Issue opened on the stand-in, so the Channel has its Task. */
async function openedOnGitHub(number: number): Promise<void> {
  const body = JSON.stringify({
    action: "opened",
    issue: { number },
    repository: { full_name: github.repo },
    sender: { login: "shlok1806" },
  });
  const response = await fetch(`${base}/api/github/webhook`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": randomUUID(),
      "X-Hub-Signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
    },
  });
  expect(response.status).toBe(204);
}

/**
 * Has the fake agent CLI call one of Switchboard's MCP tools, and returns the tool's
 * answer as the terminal shows it.
 */
async function callTool(term: Terminal, tool: string, input: unknown): Promise<string> {
  const seen = term.output.length;
  term.type(`call ${tool} ${JSON.stringify(input)}\r`);
  const done = new RegExp(`FAKE-CLAUDE done ${tool}`);
  await waitFor(`${tool} to answer`, () => (done.test(term.output.slice(seen)) ? true : undefined), 30_000);
  const output = term.output.slice(seen);
  // The tool's answer, up to the next line the fake prints (its PostToolUse hook, then "done").
  const answer = new RegExp(`FAKE-CLAUDE (${tool}(?: ERROR)?: [\\s\\S]*?)\\nFAKE-CLAUDE `).exec(output)?.[1];
  return (answer ?? output).replace(/\r/g, "").trim();
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "switchboard-e2e-"));
  cwd = await realpath(await mkdtemp(join(tmpdir(), "switchboard-repo-")));
  const githubUrl = await github.start(await freePort());
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  wrangler = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      join(scratch, "state"),
      "--var",
      `PRESENCE_GONE_AFTER_SECONDS:${GONE_AFTER_SECONDS}`,
      "--var",
      `GITHUB_REPO:${github.repo}`,
      "--var",
      `GITHUB_API_URL:${githubUrl}`,
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: WORKER_DIR,
      env: {
        ...process.env,
        JOIN_SECRET: SECRET,
        JEV_API_KEY: "unused",
        // Task sync talks to the local GitHub stand-in.
        GITHUB_TOKEN: "e2e-github-token",
        GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let wranglerLog = "";
  wrangler.stdout?.on("data", (d) => {
    wranglerLog += d;
  });
  wrangler.stderr?.on("data", (d) => {
    wranglerLog += d;
  });
  await waitFor(
    "wrangler dev",
    async () => ((await fetch(`${base}/api/agents`)).status === 401 ? true : undefined),
    60_000,
  ).catch((error) => {
    throw new Error(`${error.message}\n${wranglerLog}`);
  });

  env = {
    ...(process.env as Record<string, string>),
    SWITCHBOARD_CONFIG_DIR: join(scratch, "config"),
    SWITCHBOARD_CLAUDE_BIN: FAKE_CLAUDE,
    SWITCHBOARD_IDLE_AFTER_SECONDS: "1",
    SWITCHBOARD_HEARTBEAT_SECONDS: "0.5",
    CLAUDE_CONFIG_DIR: join(scratch, "claude"),
  };
}, 90_000);

afterAll(async () => {
  for (const term of terminals) {
    try {
      term.kill();
    } catch {
      // Already gone.
    }
  }
  wrangler?.kill();
  github.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("switchboard run claude", () => {
  it("logs in, saving the config outside the repo, readable only by the Person", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [CLI, "login", "--url", base, "--secret", SECRET, "--name", "E2E"],
      { env },
    );
    expect(stdout).toContain("as e2e");
    const mode = (await stat(join(scratch, "config", "config.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("refuses to log in with the wrong secret", async () => {
    const run = promisify(execFile)(
      process.execPath,
      [CLI, "login", "--url", base, "--secret", "wrong", "--name", "e2e"],
      { env: { ...env, SWITCHBOARD_CONFIG_DIR: join(scratch, "other") } },
    );
    await expect(run).rejects.toMatchObject({ stderr: expect.stringContaining("Wrong join secret") });
  });

  let firstId = "";
  let firstSession = "";

  it("registers the Agent, keeps the terminal interactive and tracks Presence", async () => {
    const term = new Terminal(["run", "claude", "--nickname", "scout", "--model", "opus"]);
    const { args, sessionId, agentEnv } = await term.started();
    firstSession = sessionId;
    firstId = `e2e/claude/${sessionId.slice(0, 4)}`;

    // The wrapper picked the session ID, added the session's own settings (its
    // hooks), and kept its own flag from the agent CLI.
    expect(args[0]).toBe("--settings");
    expect(args.slice(2)).toEqual(["--session-id", sessionId, "--model", "opus"]);
    expect(agentEnv).toBe(firstId);
    expect(term.output).toContain(`${firstId} is on the Channel`);

    const agent = await waitFor("the Agent", async () => (await agents()).find((a) => a.id === firstId));
    expect(agent).toMatchObject({ person: "e2e", cli: "claude-code", nickname: "scout" });

    // No output for a second: Idle. Output again: Live.
    await waitForPresence(firstId, "idle");
    term.type("work\r");
    await term.waitForOutput(/working on it/);
    await waitForPresence(firstId, "live");
    await waitForPresence(firstId, "idle");

    term.type("quit\r");
    expect(await term.exited).toBe(0);
    await waitForPresence(firstId, "gone");

    expect((await wrapperEvents(firstId)).map((e) => [e.type, e.payload])).toEqual([
      ["session.start", { cwd, resumed: false }],
      ["presence", { presence: "live" }],
      ["presence", { presence: "idle" }],
      ["presence", { presence: "live" }],
      ["presence", { presence: "idle" }],
      // Typing "quit" is output too (the echo and the goodbye).
      ["presence", { presence: "live" }],
      ["session.end", { reason: "exit" }],
      ["presence", { presence: "gone" }],
    ]);
  });

  it("keeps the Agent ID when the session resumes, and brings it back Live", async () => {
    const term = new Terminal(["run", "claude", "--resume", firstSession]);
    const { args, sessionId } = await term.started();
    expect(args.slice(2)).toEqual(["--resume", firstSession]);
    expect(sessionId).toBe(firstSession);
    await waitForPresence(firstId, "live");
    expect((await agents()).filter((a) => a.person === "e2e")).toHaveLength(1);
    // Resuming without --nickname keeps the Nickname.
    expect((await agents()).find((a) => a.id === firstId)?.nickname).toBe("scout");
    term.type("quit\r");
    expect(await term.exited).toBe(0);
    await waitForPresence(firstId, "gone");

    const starts = (await wrapperEvents(firstId)).filter((e) => e.type === "session.start");
    expect(starts.map((e) => e.payload)).toEqual([
      { cwd, resumed: false },
      { cwd, resumed: true },
    ]);
  });

  it("resumes the latest session in this directory with --continue", async () => {
    const term = new Terminal(["run", "claude", "--continue"]);
    const { args } = await term.started();
    expect(args.slice(2)).toEqual(["--resume", firstSession]);
    await waitForPresence(firstId, "live");
    term.type("quit\r");
    expect(await term.exited).toBe(0);
    await waitForPresence(firstId, "gone");
  });

  it("gives two sessions side by side two Agents, and marks a silent one Gone", async () => {
    const one = new Terminal(["run", "claude"]);
    const two = new Terminal(["run", "claude"]);
    const [a, b] = await Promise.all([one.started(), two.started()]);
    expect(a.sessionId).not.toBe(b.sessionId);
    await waitForPresence(a.agentEnv, "idle");
    await waitForPresence(b.agentEnv, "idle");

    // The first laptop vanishes without a word: the Channel's alarm marks it Gone.
    process.kill(one.pid, "SIGKILL");
    await waitForPresence(a.agentEnv, "gone", (GONE_AFTER_SECONDS + 10) * 1000);
    const gone = (await agentEvents(a.agentEnv)).at(-1);
    expect(gone).toMatchObject({ type: "presence", capture: null, payload: { presence: "gone" } });
    expect(await presenceOf(b.agentEnv)).toBe("idle");

    two.type("quit\r");
    expect(await two.exited).toBe(0);
    await waitForPresence(b.agentEnv, "gone");
  });
});

describe("the Hook Capture", () => {
  it("installs hooks for the wrapped session only, and sends each hook type to the Channel labelled Hook", async () => {
    const term = new Terminal(["run", "claude"]);
    const { args, agentEnv: id } = await term.started();
    const settingsPath = args[1] ?? "";

    // The hooks live in a settings file of the session's own, not in the Person's settings.
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "SessionEnd", "SessionStart", "Stop"]);
    await expect(stat(join(scratch, "claude", "settings.json"))).rejects.toThrow();

    await term.waitForOutput(/hook SessionStart exit=0/);
    term.type("turn\r");
    await term.waitForOutput(/FAKE-CLAUDE turn done/);
    term.type("quit\r");
    expect(await term.exited).toBe(0);

    // Hooks hand their input to the wrapper and return at once, printing nothing.
    const runs = [...term.output.matchAll(/FAKE-CLAUDE hook (\S+) exit=(\d+) ms=(\d+)( out=.*)?/g)];
    expect(runs.map((m) => m[1])).toEqual([
      "SessionStart",
      "PostToolUse:Bash",
      "PostToolUse:Bash",
      "PostToolUse:Write",
      "PostToolUse:Edit",
      "PostToolUse:MultiEdit",
      "PostToolUse:Read",
      "PostToolUse:mcp__switchboard__claim",
      "Stop",
      "SessionEnd",
    ]);
    for (const run of runs) {
      expect(run[2]).toBe("0");
      expect(Number(run[3])).toBeLessThan(1000);
      expect(run[4]).toBeUndefined();
    }

    // Every hook type reached the Channel, labelled with the Hook Capture, in order.
    const events = await waitFor("the SessionEnd hook on the Channel", async () => {
      const all = await hookEvents(id);
      return all.at(-1)?.type === "session.end" ? all : undefined;
    });
    for (const event of events) expect(event.capture).toBe("hook");
    const longCommand = `echo ${"a".repeat(2000)}`;
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ["session.start", { cwd, resumed: false, source: "startup" }],
      ["tool.call", { tool: "Bash", arg: "npm test", ok: true }],
      ["command", { command: "npm test" }],
      ["tool.call", { tool: "Bash", arg: `${longCommand.slice(0, 199)}…`, ok: true }],
      ["command", { command: `${longCommand.slice(0, 499)}…` }],
      ["tool.call", { tool: "Write", arg: "src/new.ts", ok: true }],
      ["file.edit", { path: "src/new.ts", additions: 2, deletions: 0 }],
      ["tool.call", { tool: "Edit", arg: "src/app.ts", ok: true }],
      ["file.edit", { path: "src/app.ts", additions: 2, deletions: 1 }],
      ["tool.call", { tool: "MultiEdit", arg: "src/app.ts", ok: true }],
      ["file.edit", { path: "src/app.ts", additions: 1, deletions: 1 }],
      ["tool.call", { tool: "Read", arg: "README.md", ok: true }],
      ["tool.call", { tool: "mcp__switchboard__claim", arg: "task=7 note=taking it", ok: true }],
      ["turn.end", { turn: 1 }],
      ["session.end", { reason: "exit", detail: "prompt_input_exit" }],
    ]);
    // File contents never leave the laptop.
    expect(JSON.stringify(events)).not.toContain("SECRET_CONTENT");

    // The hook Events reached the Channel before the wrapper ended the session.
    const all = await agentEvents(id);
    const ended = all.findIndex((e) => e.type === "session.end" && e.capture === null);
    expect(all.findIndex((e) => e.capture === "hook" && e.type === "session.end")).toBeLessThan(ended);

    // The Agent's touched files, from its file edits, most recently edited first.
    const touched = await api<TouchedFilesResponse>(`${agentPath(id as AgentId)}/touched-files`);
    expect(touched.files.map((f) => [f.path, f.edits])).toEqual([
      ["src/app.ts", 2],
      ["src/new.ts", 1],
    ]);

    // The session's settings and socket are cleaned up when it ends.
    await expect(stat(settingsPath)).rejects.toThrow();
  });
});

describe("Switchboard's tools (the Tool Capture)", () => {
  it("gives the session the MCP tools, and every call shows on the Channel and on GitHub", async () => {
    const claims = github.open("Claims via Switchboard tools", "## Build\n- [ ] claim\n- [ ] release");
    const held = github.open("Dashboard");
    // A Person already holds the second Task, from the Dashboard.
    const byPerson = await fetch(`${base}/api/tasks/${held}/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "X-Switchboard-Person": "dev" },
    });
    expect(byPerson.status).toBe(200);

    const term = new Terminal(["run", "claude"]);
    const { agentEnv: id } = await term.started();
    const mcpPath = (await term.waitForOutput(/FAKE-CLAUDE mcp=(\S+)/))[1] ?? "";
    // The tools are for this session only: a config of its own, nothing in the Person's settings.
    const mcp = JSON.parse(await readFile(mcpPath, "utf8")) as { mcpServers: Record<string, { args: string[] }> };
    expect(Object.keys(mcp.mcpServers)).toEqual(["switchboard"]);
    expect(mcp.mcpServers.switchboard?.args).toEqual([CLI, "mcp"]);
    await expect(stat(join(scratch, "claude", "settings.json"))).rejects.toThrow();
    await expect(stat(join(cwd, ".mcp.json"))).rejects.toThrow();

    const call = (tool: string, input: unknown) => callTool(term, tool, input);

    expect(await call("list_tasks", {})).toContain(`#${held} Dashboard [claimed] held by dev`);
    expect(term.output).toContain(
      'tools=["list_tasks","claim_task","release_task","complete_step","post_update","read_channel","finish_task"]',
    );
    expect(await call("claim_task", { task: held })).toBe(`claim_task ERROR: Task #${held} is held by dev.`);
    expect(await call("claim_task", { task: claims })).toContain(`claim_task: You hold Task #${claims} now`);
    expect(await call("complete_step", { task: claims, step: 0 })).toBe(
      `complete_step: Step 0 of #${claims} is done (1/2).`,
    );
    expect(await call("post_update", { text: "Claims work, on to release", task: claims })).toMatch(
      /^post_update: Posted Update/,
    );
    const read = await call("read_channel", { limit: 5 });
    expect(read).toContain(`${id} update #${claims} (tool): Claims work, on to release`);
    expect(await call("release_task", { task: claims })).toBe(`release_task: Released Task #${claims}.`);

    term.type("quit\r");
    expect(await term.exited).toBe(0);

    // Every call is an Event labelled with the Tool Capture, and so is what it did.
    const tool = (await agentEvents(id)).filter((e) => e.capture === "tool");
    expect(tool.map((e) => [e.type, e.task, e.type === "tool.call" ? [e.payload.tool, e.payload.ok] : null])).toEqual([
      ["tool.call", undefined, ["list_tasks", true]],
      ["claim.refused", held, null],
      ["tool.call", held, ["claim_task", false]],
      ["claim", claims, null],
      ["tool.call", claims, ["claim_task", true]],
      ["step.complete", claims, null],
      ["tool.call", claims, ["complete_step", true]],
      ["update", claims, null],
      ["tool.call", claims, ["post_update", true]],
      ["tool.call", undefined, ["read_channel", true]],
      ["claim.release", claims, null],
      ["tool.call", claims, ["release_task", true]],
    ]);

    // GitHub shows the Claim while it was held, then its release.
    const issue = github.issues.get(claims);
    expect(issue?.body).toBe("## Build\n- [x] claim\n- [ ] release");
    expect(issue?.assignees).toEqual([]);
    expect(issue?.labels).toEqual([]);
    expect(issue?.comments).toEqual([
      `Claimed by Agent \`${id}\` (Person e2e) via Switchboard.`,
      `Released by Agent \`${id}\` (Person e2e) via Switchboard.`,
    ]);
    const path = `/repos/${github.repo}/issues/${claims}`;
    expect(github.writes.filter((w) => w.includes(`${path}/`) || w.endsWith(path))).toEqual([
      `POST ${path}/assignees`,
      `POST ${path}/labels`,
      `POST ${path}/comments`,
      `PATCH ${path}`,
      `DELETE ${path}/assignees`,
      `DELETE ${path}/labels/status%3Aclaimed`,
      `POST ${path}/comments`,
    ]);
    expect(github.issues.get(held)?.assignees).toEqual([github.login]);

    // The session's MCP config is removed when it ends.
    await expect(stat(mcpPath)).rejects.toThrow();
  });
});

describe("the Proxy Capture", () => {
  const API_KEY = "sk-ant-api03-E2EkeyThatMustNeverLeave0123456789";
  const TURN = [
    {
      type: "message_start",
      message: {
        model: "claude-opus-5-5",
        usage: { input_tokens: 9, cache_read_input_tokens: 2048, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Tests pass. " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DB_PASSWORD=hunter2hunter2" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"command":"npm test"}' },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 31 } },
    { type: "message_stop" },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  const TURN_SHA = createHash("sha256").update(TURN).digest("hex");

  /** The model API the agent CLI would call without Switchboard. */
  const seenKeys: (string | undefined)[] = [];
  let upstream: Server | null = null;
  let upstreamUrl = "";

  beforeAll(async () => {
    upstream = createHttpServer((req, res) => {
      seenKeys.push(req.headers["x-api-key"] as string | undefined);
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(TURN);
      });
    });
    await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    upstream?.closeAllConnections();
    upstream?.close();
  });

  const proxyEvents = async (id: string) => (await agentEvents(id)).filter((e) => e.capture === "proxy");

  it("routes the model traffic through a local proxy unchanged, and each turn arrives as a Proxy Event", async () => {
    const term = new Terminal(["run", "claude"], { ANTHROPIC_BASE_URL: upstreamUrl, ANTHROPIC_API_KEY: API_KEY });
    const { agentEnv: id } = await term.started();
    await waitFor("the Agent", async () => (await agents()).find((a) => a.id === id));

    term.type("model run the tests\r");
    const first = await term.waitForOutput(/FAKE-CLAUDE model base=(\S+) status=(\d+) sha=(\w+)/);
    // The CLI talked to the local proxy, and got exactly what the API sent.
    expect(first[1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(first[1]).not.toBe(upstreamUrl);
    expect(first[2]).toBe("200");
    expect(first[3]).toBe(TURN_SHA);
    // The API got the CLI's own key.
    expect(seenKeys).toEqual([API_KEY]);

    const [digest] = await waitFor("a Proxy Digest", async () => {
      const events = await proxyEvents(id);
      return events.length > 0 ? events : undefined;
    });
    expect(digest).toMatchObject({
      type: "proxy.digest",
      capture: "proxy",
      actor: { kind: "agent", agentId: id },
      payload: {
        model: "claude-opus-5-5",
        inputTokens: 9,
        outputTokens: 31,
        cacheReadTokens: 2048,
        cacheCreationTokens: 0,
        reply: "Tests pass. DB_PASSWORD=****",
        toolCalls: [{ name: "Bash", arg: "npm test" }],
        maskedSecrets: 1,
      },
    });

    // The Person switches the Agent to raw mid-session; the next turn is a Raw Proxy Event.
    const switched = await fetch(`${base}${agentPath(id as AgentId)}/proxy-mode`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "X-Switchboard-Person": "e2e", "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "raw" }),
    });
    expect(switched.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const seen = term.output.length;
    term.type("model again\r");
    await waitFor("the second turn", () =>
      /FAKE-CLAUDE model .*sha=/.test(term.output.slice(seen)) ? true : undefined,
    );
    const raw = await waitFor("a Raw Proxy Event", async () =>
      (await proxyEvents(id)).find((e) => e.type === "proxy.raw"),
    );
    if (raw.type !== "proxy.raw") throw new Error("expected a Raw Proxy Event");
    expect(raw.payload.context).toContain('"content":"again"');
    expect(raw.payload.response).toContain("DB_PASSWORD=****");

    term.type("quit\r");
    expect(await term.exited).toBe(0);
    // Auth never left the laptop.
    expect(JSON.stringify(await agentEvents(id))).not.toContain("E2EkeyThatMustNeverLeave");
  });

  it("leaves the model traffic alone with --proxy off", async () => {
    const term = new Terminal(["run", "claude", "--proxy", "off"], {
      ANTHROPIC_BASE_URL: upstreamUrl,
      ANTHROPIC_API_KEY: API_KEY,
    });
    const { agentEnv: id } = await term.started();
    term.type("model hello\r");
    const answer = await term.waitForOutput(/FAKE-CLAUDE model base=(\S+) status=(\d+) sha=(\w+)/);
    expect(answer[1]).toBe(upstreamUrl);
    expect(answer[3]).toBe(TURN_SHA);
    term.type("quit\r");
    expect(await term.exited).toBe(0);
    expect(await proxyEvents(id)).toEqual([]);
  });
});

describe("a branch per Task (ADR 0006)", () => {
  // Git as a Person's laptop runs it, without their global config (hooks, signing).
  const gitEnv = {
    GIT_AUTHOR_NAME: "E2E",
    GIT_AUTHOR_EMAIL: "e2e@example.com",
    GIT_COMMITTER_NAME: "E2E",
    GIT_COMMITTER_EMAIL: "e2e@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  let origin = "";
  let repo = "";

  async function git(dir: string, ...args: string[]): Promise<string> {
    const { stdout } = await promisify(execFile)("git", args, { cwd: dir, env: { ...process.env, ...gitEnv } });
    return stdout.trim();
  }

  beforeAll(async () => {
    // A local bare repo stands in for origin, and the GitHub stand-in checks pull requests against it.
    origin = join(scratch, "origin.git");
    await git(scratch, "init", "--quiet", "--bare", "-b", "main", origin);
    const seed = join(scratch, "seed");
    await git(scratch, "clone", "--quiet", origin, seed);
    await writeFile(join(seed, "README.md"), "# e2e\n");
    await git(seed, "add", "README.md");
    await git(seed, "commit", "--quiet", "-m", "First commit");
    await git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    // The Person's clone, where they run the wrapper.
    await git(scratch, "clone", "--quiet", origin, join(scratch, "repo"));
    repo = await realpath(join(scratch, "repo"));
    github.origin = origin;
  });

  it("claiming creates the Task branch and its worktree; finishing pushes it and opens the PR", async () => {
    const number = github.open("Branch per Task", "- [ ] branch\n- [ ] finish");
    await openedOnGitHub(number);
    const term = new Terminal(["run", "claude"], gitEnv, repo);
    const { agentEnv: id } = await term.started();
    const branch = `task/${number}-branch-per-task`;
    const worktree = join(repo, ".switchboard", "worktrees", branch);

    // Claiming: the branch is created from origin's main, pushed, and checked out in its own worktree.
    const claimed = await callTool(term, "claim_task", { task: number });
    expect(claimed).toContain(`claim_task: You hold Task #${number} now: Branch per Task.`);
    expect(claimed).toContain(
      `Work in the worktree at ${worktree}, on branch ${branch} (new, from the latest origin main`,
    );
    const main = await git(origin, "rev-parse", "refs/heads/main");
    expect(await git(origin, "rev-parse", `refs/heads/${branch}`)).toBe(main);
    expect(await git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(main);
    expect(await git(worktree, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`origin/${branch}`);
    // The worktrees stay out of the Person's own checkout, without a commit to .gitignore.
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(await readFile(join(repo, ".git", "info", "exclude"), "utf8")).toContain("/.switchboard/");
    // The Channel records the Task's branch.
    const recorded = await api<TaskResponse>(`/api/tasks/${number}`);
    expect(recorded.task).toMatchObject({ status: "claimed", branch });

    // Claiming again picks the same worktree up.
    expect(await callTool(term, "claim_task", { task: number })).toContain(
      `Work in the worktree at ${worktree}, on branch ${branch} (picked up where it was`,
    );

    // The Agent works in the worktree. Uncommitted work is not finished work.
    await writeFile(join(worktree, "feature.ts"), "export const feature = true;\n");
    const dirty = await callTool(term, "finish_task", { task: number });
    expect(dirty).toContain("finish_task ERROR:");
    expect(dirty).toContain("1 uncommitted change");
    expect(github.pullRequests.size).toBe(0);

    await git(worktree, "add", "feature.ts");
    await git(worktree, "commit", "--quiet", "-m", "Add the feature");
    const head = await git(worktree, "rev-parse", "HEAD");
    const finished = await callTool(term, "finish_task", { task: number, summary: "Adds the feature." });

    // Finishing: the branch is pushed first, then the pull request is opened on GitHub.
    const [pr] = [...github.pullRequests.values()];
    expect(finished).toBe(
      `finish_task: Pushed ${branch} (${head.slice(0, 7)}) and opened pull request #${pr?.number}: ` +
        `https://github.com/${github.repo}/pull/${pr?.number}. It closes #${number} when it merges. ` +
        `Task #${number} is in review.`,
    );
    expect(await git(origin, "rev-parse", `refs/heads/${branch}`)).toBe(head);
    expect(pr).toMatchObject({ title: "Branch per Task", head: branch, base: "main", headSha: head });
    expect(pr?.body.split("\n")).toEqual([
      `Closes #${number}`,
      "",
      `Opened via Switchboard by Agent \`${id}\` (Person e2e).`,
      "",
      "Adds the feature.",
    ]);
    const inReview = await api<TaskResponse>(`/api/tasks/${number}`);
    expect(inReview.task).toMatchObject({ status: "review", branch, pr: pr?.number });
    expect(github.issues.get(number)?.labels).toEqual([REVIEW_LABEL]);

    term.type("quit\r");
    expect(await term.exited).toBe(0);

    // Every step is on the Channel, labelled with the Tool Capture.
    const tool = (await agentEvents(id)).filter((e) => e.capture === "tool");
    expect(tool.map((e) => [e.type, e.type === "tool.call" ? [e.payload.tool, e.payload.ok] : e.payload])).toEqual([
      ["claim", { holder: { kind: "agent", agentId: id } }],
      ["task.branch", { branch }],
      ["tool.call", ["claim_task", true]],
      ["tool.call", ["claim_task", true]],
      ["tool.call", ["finish_task", false]],
      ["task.review", { pr: pr?.number, url: `https://github.com/${github.repo}/pull/${pr?.number}`, branch }],
      ["tool.call", ["finish_task", true]],
    ]);
  });
});
