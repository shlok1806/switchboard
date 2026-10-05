// One login, every Channel (ADR 0008): which Channel a command uses, that the
// session saved by `switchboard login` only ever goes to the Worker that issued it,
// and that the session's MCP server is told the Channel the wrapper chose.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelChoiceError, chooseChannel } from "../src/channel-choice";
import { type Config, readConfig, writeConfig } from "../src/config";
import { LoginError, login } from "../src/login";
import { prepareSessionTools, writeClaudeMcpConfig } from "../src/mcp-config";

interface Seen {
  route: string;
  /** Everything of the request a credential could ride in: its URL, headers and body. */
  everything: string;
}

/**
 * A stand-in for a Switchboard Worker: it lists `repos` as its Channels, signs
 * anyone in as `person` with the session `issues`, and lets a session join the
 * Channels in `repos` unless `refuses` says otherwise.
 */
class FakeWorker {
  readonly seen: Seen[] = [];
  refuses: { status: number; reason: string } | null = null;
  url = "";
  private server: Server | null = null;

  constructor(
    readonly repos: string[],
    readonly issues: string,
    readonly person = "ada",
  ) {}

  routes(): string[] {
    return this.seen.map((request) => request.route);
  }

  async start(): Promise<string> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const route = `${request.method} ${request.url}`;
        const body = Buffer.concat(chunks).toString("utf8");
        this.seen.push({ route, everything: `${route}\n${JSON.stringify(request.headers)}\n${body}` });
        const [status, answer] = this.answer(route, request.headers.authorization);
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(answer));
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return this.url;
  }

  stop(): void {
    this.server?.close();
    this.server?.closeAllConnections();
  }

  private answer(route: string, authorization: string | undefined): [number, unknown] {
    if (route === "GET /auth/config") return [200, { configured: true, repos: this.repos, devSignIn: false }];
    if (route === "POST /auth/device/code") {
      return [
        200,
        { deviceCode: "device", userCode: "CODE-1", verificationUri: "https://gh/device", interval: 1, expiresIn: 60 },
      ];
    }
    if (route === "POST /auth/device/token") return [200, { ok: true, session: this.issues, person: this.person }];
    const join = /^POST \/r\/(.+)\/api\/join$/.exec(route);
    if (join) {
      if (authorization !== `Bearer ${this.issues}`) {
        return [401, { ok: false, reason: "Your session expired or is not valid. Sign in again." }];
      }
      if (this.refuses) return [this.refuses.status, { ok: false, reason: this.refuses.reason }];
      return [200, { ok: true, person: { name: this.person, timeZone: "UTC", joinedAt: "2026-01-01T00:00:00Z" } }];
    }
    return [404, { ok: false, reason: "Not found." }];
  }
}

let scratch = "";
let worker: FakeWorker;
let env: NodeJS.ProcessEnv;

/** A directory that is a git checkout whose `origin` remote is `remote`. */
async function checkoutOf(remote: string): Promise<string> {
  const dir = await mkdtemp(join(scratch, "checkout-"));
  const git = (args: string[]) => promisify(execFile)("git", args, { cwd: dir });
  await git(["init", "--quiet"]);
  await git(["remote", "add", "origin", remote]);
  return dir;
}

/** The Person's saved login on `worker`, with `ada/home` as their default Channel. */
function saved(): Config {
  return { url: worker.url, repo: "ada/home", session: worker.issues, person: "ada" };
}

const quiet = { say: () => {}, sleep: async () => {} };

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "switchboard-choice-"));
  worker = new FakeWorker(["ada/home", "ada/engine", "ada/site"], "session-of-worker-a");
  await worker.start();
  env = { SWITCHBOARD_CONFIG_DIR: join(scratch, "config") };
});

afterEach(async () => {
  worker.stop();
  await rm(scratch, { recursive: true, force: true });
});

describe("the Channel a command uses", () => {
  it("is the repo of the directory's origin remote when the Worker has a Channel for it", async () => {
    const cwd = await checkoutOf("git@github.com:Ada/Engine.git");
    expect(await chooseChannel(saved(), { cwd, env })).toEqual({ repo: "ada/engine", reason: "origin" });
  });

  it("puts $SWITCHBOARD_REPO before the directory's repo, and --repo before both", async () => {
    const cwd = await checkoutOf("https://github.com/ada/engine");
    const withEnv = { ...env, SWITCHBOARD_REPO: "ada/site" };
    expect(await chooseChannel(saved(), { cwd, env: withEnv })).toEqual({ repo: "ada/site", reason: "env" });
    expect(await chooseChannel(saved(), { cwd, env: withEnv, flag: "Ada/Home" })).toEqual({
      repo: "ada/home",
      reason: "flag",
    });
  });

  it("falls back to the default Channel, saying why, when the Worker has no Channel for the directory's repo", async () => {
    const cwd = await checkoutOf("https://github.com/ada/unlisted.git");
    const choice = await chooseChannel(saved(), { cwd, env });
    expect(choice).toMatchObject({ repo: "ada/home", reason: "default" });
    expect(choice.note).toContain("no Channel for ada/unlisted");
  });

  it("uses the directory's repo on a Worker that allows a Channel for any repo", async () => {
    const open = new FakeWorker([], "session-of-open-worker");
    await open.start();
    try {
      const cwd = await checkoutOf("https://github.com/ada/anything.git");
      const config = { ...saved(), url: open.url, session: open.issues };
      expect(await chooseChannel(config, { cwd, env })).toEqual({ repo: "ada/anything", reason: "origin" });
    } finally {
      open.stop();
    }
  });

  it("uses the default Channel outside a GitHub checkout", async () => {
    const elsewhere = await checkoutOf("https://gitlab.com/ada/engine.git");
    expect(await chooseChannel(saved(), { cwd: elsewhere, env })).toEqual({ repo: "ada/home", reason: "default" });
    expect(await chooseChannel(saved(), { cwd: scratch, env })).toEqual({ repo: "ada/home", reason: "default" });
  });

  it("uses the directory's repo, saying it is unconfirmed, when the Worker cannot be asked", async () => {
    const cwd = await checkoutOf("https://github.com/ada/engine.git");
    const config = saved();
    worker.stop();
    const choice = await chooseChannel(config, { cwd, env });
    expect(choice).toMatchObject({ repo: "ada/engine", reason: "origin" });
    expect(choice.note).toContain("could not ask");
  });

  it("refuses a --repo or $SWITCHBOARD_REPO that is not owner/name, so neither can name another host", async () => {
    for (const bad of ["https://evil.example/ada/home", "../../auth", "ada", "ada/home/extra"]) {
      await expect(chooseChannel(saved(), { cwd: scratch, env, flag: bad })).rejects.toBeInstanceOf(ChannelChoiceError);
      await expect(
        chooseChannel(saved(), { cwd: scratch, env: { ...env, SWITCHBOARD_REPO: bad } }),
      ).rejects.toBeInstanceOf(ChannelChoiceError);
    }
  });
});

describe("one login", () => {
  it("serves another repo's Channel from a config file saved before Channels were chosen per directory", async () => {
    // Exactly what `switchboard login` wrote before ADR 0008.
    await mkdir(join(scratch, "config"), { recursive: true });
    await writeFile(
      join(scratch, "config", "config.json"),
      `${JSON.stringify({ url: worker.url, repo: "ada/home", session: worker.issues, person: "ada" }, null, 2)}\n`,
    );
    const config = await readConfig(env);
    expect(config).toEqual(saved());
    const cwd = await checkoutOf("https://github.com/ada/engine.git");
    expect((await chooseChannel(config as Config, { cwd, env })).repo).toBe("ada/engine");
  });

  it("changes the default Channel without signing in again, keeping the session and the file private", async () => {
    await writeConfig(saved(), env);
    const said: string[] = [];
    const result = await login({ ...quiet, url: `${worker.url}/ada/engine`, env, say: (line) => said.push(line) });

    expect(result.reused).toBe(true);
    expect(worker.routes()).toEqual(["POST /r/ada/engine/api/join"]);
    expect(said).toEqual([]);
    expect(await readConfig(env)).toEqual({ ...saved(), repo: "ada/engine" });
    expect((await stat(join(scratch, "config", "config.json"))).mode & 0o777).toBe(0o600);
  });

  it("uses the saved Worker when no --url is given", async () => {
    await writeConfig(saved(), env);
    await login({ ...quiet, repo: "ada/site", env });
    expect(await readConfig(env)).toEqual({ ...saved(), repo: "ada/site" });
  });

  it("says the Channel's refusal in its own words, and neither signs in again nor changes the config", async () => {
    await writeConfig(saved(), env);
    worker.refuses = {
      status: 403,
      reason: "ada does not have write access to ada/engine, so cannot join its Channel.",
    };
    const attempt = login({ ...quiet, url: `${worker.url}/ada/engine`, env });
    await expect(attempt).rejects.toBeInstanceOf(LoginError);
    await expect(attempt).rejects.toThrow("ada does not have write access to ada/engine");
    expect(worker.routes()).toEqual(["POST /r/ada/engine/api/join"]);
    expect(await readConfig(env)).toEqual(saved());
  });

  it("signs in again when the Worker no longer accepts the saved session, or with force", async () => {
    await writeConfig({ ...saved(), session: "expired-session" }, env);
    const result = await login({ ...quiet, url: `${worker.url}/ada/engine`, env });
    expect(result.reused).toBe(false);
    expect(worker.routes()).toContain("POST /auth/device/token");
    expect(await readConfig(env)).toEqual({ ...saved(), repo: "ada/engine" });

    worker.seen.length = 0;
    expect((await login({ ...quiet, url: `${worker.url}/ada/site`, env, force: true })).reused).toBe(false);
    expect(worker.routes()).toContain("POST /auth/device/code");
  });

  it("never sends a session to a Worker other than the one that issued it", async () => {
    const other = new FakeWorker(["ada/engine"], "session-of-worker-b");
    await other.start();
    try {
      await writeConfig(saved(), env);
      // Logging in to another Worker signs in there; the saved session stays home.
      const result = await login({ ...quiet, url: `${other.url}/ada/engine`, env });
      expect(result.reused).toBe(false);
      expect(await readConfig(env)).toEqual({
        url: other.url,
        repo: "ada/engine",
        session: other.issues,
        person: "ada",
      });

      // Choosing a Channel asks the Worker which repos it has, without any credential.
      const cwd = await checkoutOf("https://github.com/ada/site.git");
      await chooseChannel(saved(), { cwd, env });

      expect(other.seen.length).toBeGreaterThan(0);
      for (const request of other.seen) expect(request.everything).not.toContain(worker.issues);
      for (const request of worker.seen) expect(request.everything).not.toContain(other.issues);
      const asked = worker.seen.filter((request) => request.route === "GET /auth/config");
      expect(asked).toHaveLength(1);
      expect(asked[0]?.everything).not.toContain(worker.issues);
    } finally {
      other.stop();
    }
  });
});

describe("the session's MCP server", () => {
  it("is told the Channel the wrapper chose, and uses it whatever directory it runs in", async () => {
    const started = await checkoutOf("https://github.com/ada/engine.git");
    const { repo } = await chooseChannel(saved(), { cwd: started, env });
    const tools = prepareSessionTools(started, repo, env);
    try {
      // What Claude Code is given to start the server with.
      const written = JSON.parse(await readFile(writeClaudeMcpConfig(tools), "utf8")) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      const serverEnv = written.mcpServers[tools.server.name]?.env ?? {};
      // The server resolves its Channel from that environment, even from a checkout of another repo.
      const moved = await checkoutOf("https://github.com/ada/site.git");
      expect(await chooseChannel(saved(), { cwd: moved, env: serverEnv })).toEqual({
        repo: "ada/engine",
        reason: "env",
      });
      // No credential rides along: the server acts with the Agent token only.
      expect(JSON.stringify(written)).not.toContain(worker.issues);
    } finally {
      tools.dispose();
    }
  });
});
