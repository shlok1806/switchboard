// End to end: the built `switchboard` CLI, run in a real pty around a fake agent
// CLI standing in for `claude`, against the Channel Worker running locally in
// `wrangler dev`. Everything is observed the way a Person would: through the
// terminal, and through the Channel API the Dashboard reads.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as pty from "@lydell/node-pty";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Agent, AgentsResponse, ChannelEvent, HistoryResponse } from "../../shared/src/index";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "switchboard.js");
const FAKE_CLAUDE = join(here, "fixtures", "fake-claude.mjs");
const WORKER_DIR = join(here, "..", "..", "worker");
const SECRET = "e2e-join-secret";
const GONE_AFTER_SECONDS = 3;

let base = "";
let wrangler: ChildProcess | null = null;
let scratch = "";
let env: Record<string, string> = {};
let cwd = "";
const terminals: pty.IPty[] = [];

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

  constructor(args: string[]) {
    this.term = pty.spawn(process.execPath, [CLI, ...args], { cols: 100, rows: 30, cwd, env });
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

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "switchboard-e2e-"));
  cwd = await realpath(await mkdtemp(join(tmpdir(), "switchboard-repo-")));
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
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: WORKER_DIR,
      env: {
        ...process.env,
        JOIN_SECRET: SECRET,
        JEV_API_KEY: "unused",
        // No GitHub in this test: an empty token leaves Task sync off.
        GITHUB_TOKEN: "",
        GITHUB_WEBHOOK_SECRET: "unused",
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

    // The wrapper picked the session ID, and kept its own flag from the agent CLI.
    expect(args).toEqual(["--session-id", sessionId, "--model", "opus"]);
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

    expect((await agentEvents(firstId)).map((e) => [e.type, e.payload])).toEqual([
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
    expect(args).toEqual(["--resume", firstSession]);
    expect(sessionId).toBe(firstSession);
    await waitForPresence(firstId, "live");
    expect((await agents()).filter((a) => a.person === "e2e")).toHaveLength(1);
    // Resuming without --nickname keeps the Nickname.
    expect((await agents()).find((a) => a.id === firstId)?.nickname).toBe("scout");
    term.type("quit\r");
    expect(await term.exited).toBe(0);
    await waitForPresence(firstId, "gone");

    const starts = (await agentEvents(firstId)).filter((e) => e.type === "session.start");
    expect(starts.map((e) => e.payload)).toEqual([
      { cwd, resumed: false },
      { cwd, resumed: true },
    ]);
  });

  it("resumes the latest session in this directory with --continue", async () => {
    const term = new Terminal(["run", "claude", "--continue"]);
    const { args } = await term.started();
    expect(args).toEqual(["--resume", firstSession]);
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
