// `switchboard run claude [...args]`: runs Claude Code in a pty so the terminal
// stays fully interactive, and joins the session to the Channel as an Agent.
// Its hooks (the Hook Capture) report what the Agent does to the Channel.

import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "@lydell/node-pty";
import type { Agent } from "../../shared/src/index";
import { agentIdFor, DEFAULT_IDLE_AFTER_MS, HEARTBEAT_INTERVAL_MS } from "../../shared/src/index";
import { AgentLink, type AgentSession } from "./agent-link";
import { ChannelClient, ChannelError } from "./channel-client";
import { claudeConfigDir, planSession, projectDir, waitForPickedSession } from "./claude-session";
import { configDir, readConfig } from "./config";
import { HookCapture } from "./hooks/capture";
import { prepareSessionTools } from "./mcp-config";
import { IdleWatch } from "./presence";
import { ProxyCapture } from "./proxy/capture";
import { DEFAULT_PROXY_SETTING, originalBaseUrl, type ProxyFlags, takeProxyFlags } from "./proxy/options";
import { applySessionSettings } from "./session-settings";

/** How long the wrapper waits for the Channel to hear that the session ended. */
const END_TIMEOUT_MS = 3000;

function seconds(raw: string | undefined, fallbackMs: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0 ? value * 1000 : fallbackMs;
}

function dim(text: string): string {
  return process.stderr.isTTY ? `\x1b[2m${text}\x1b[0m` : text;
}

/** Takes the wrapper's own `--nickname` out of the arguments meant for the agent CLI. */
export function takeNickname(args: string[]): { nickname?: string; rest: string[] } {
  const rest: string[] = [];
  let nickname: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      rest.push(...args.slice(i));
      break;
    }
    if (arg === "--nickname") {
      nickname = args[i + 1];
      i++;
    } else if (arg.startsWith("--nickname=")) {
      nickname = arg.slice("--nickname=".length);
    } else {
      rest.push(arg);
    }
  }
  return nickname === undefined ? { rest } : { nickname, rest };
}

export async function runClaude(rawArgs: string[]): Promise<number> {
  const env = process.env;
  const config = await readConfig();
  if (!config) {
    console.error(
      "Not logged in. Run: switchboard login --url <channel url> --secret <join secret> --name <your name>",
    );
    return 2;
  }

  const logFile = join(configDir(), "wrapper.log");
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const log = (line: string) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
    } catch {
      // Logging must never break the session.
    }
  };

  const { nickname, rest: afterNickname } = takeNickname(rawArgs);
  let proxyFlags: ProxyFlags;
  try {
    proxyFlags = takeProxyFlags(afterNickname);
  } catch (error) {
    console.error(`switchboard: ${(error as Error).message}`);
    return 2;
  }
  const rest = proxyFlags.rest;
  const cwd = process.cwd();
  const claudeDir = claudeConfigDir(env);
  let plan: Awaited<ReturnType<typeof planSession>>;
  try {
    plan = await planSession(rest, { cwd, claudeConfigDir: claudeDir });
  } catch (error) {
    console.error(`switchboard: ${(error as Error).message}`);
    return 1;
  }

  const client = new ChannelClient(config);
  const heartbeatMs = seconds(env.SWITCHBOARD_HEARTBEAT_SECONDS, HEARTBEAT_INTERVAL_MS);
  const idleAfterMs = seconds(env.SWITCHBOARD_IDLE_AFTER_SECONDS, DEFAULT_IDLE_AFTER_MS);
  const session = (sessionId: string, resumed: boolean): AgentSession => ({
    cli: "claude-code",
    sessionId,
    resumed,
    cwd,
    ...(nickname === undefined ? {} : { nickname }),
    ...(proxyFlags.proxy === undefined || proxyFlags.proxy === "off" ? {} : { proxyMode: proxyFlags.proxy }),
    ...(proxyFlags.mask ? {} : { secretMasking: false }),
  });

  // The Channel stream stays open for the whole session. It carries the Hook
  // and Proxy Captures' Events and the Agent's Proxy mode changes; Interrupts
  // and the next-turn cache will read it too.
  let hooks: HookCapture | null = null;
  let proxy: ProxyCapture | null = null;
  const stream = client.follow(
    (message) => {
      if (message.type === "hook.ack" || message.type === "hook.refused") hooks?.reply(message);
      if (message.type === "proxy.ack" || message.type === "proxy.refused") proxy?.reply(message);
      if (message.type === "agent") proxy?.agentChanged(message.agent);
    },
    (connected) => {
      log(connected ? "stream connected" : "stream disconnected");
      if (connected) hooks?.connected();
      if (connected) proxy?.connected();
    },
  );

  // Hooks for this session only: a settings file of its own, passed with --settings.
  let args = plan.args;
  let hookDir: string | null = null;
  const stopHooks = async () => {
    stream.close();
    await hooks?.close();
    await proxy?.close();
    if (hookDir) await rm(hookDir, { recursive: true, force: true });
  };
  const childEnv: Record<string, string> = { ...(env as Record<string, string>) };
  if (plan.kind !== "none") {
    const setting = proxyFlags.proxy ?? DEFAULT_PROXY_SETTING;
    if (setting !== "off") {
      // The Proxy Capture: model traffic goes through a local proxy. If it cannot
      // start, Claude Code runs as it would without Switchboard.
      try {
        const upstream = await originalBaseUrl(env, claudeDir);
        proxy = await ProxyCapture.start({
          ...(upstream === undefined ? {} : { upstream }),
          mode: setting,
          mask: proxyFlags.mask,
          root: cwd,
          send: (frame) => stream.send(frame),
          log,
        });
        childEnv.ANTHROPIC_BASE_URL = proxy.url;
        log(`proxy on ${proxy.url} to ${upstream ?? "the Anthropic API"}`);
      } catch (error) {
        proxy = null;
        log(`proxy failed to start: ${(error as Error).message}`);
        console.error(
          dim(`switchboard: the Proxy Capture could not start (${(error as Error).message}). Running without it.`),
        );
      }
    }
  }
  if (plan.kind !== "none") {
    try {
      // Private to the Person: it holds the socket and the settings file.
      hookDir = await mkdtemp(join(tmpdir(), "switchboard-"));
      hooks = await HookCapture.start({ dir: hookDir, root: cwd, send: (frame) => stream.send(frame), log });
      // Claude Code settings can set ANTHROPIC_BASE_URL too, and they win over the
      // environment, so the session's own settings point it at the proxy as well.
      const proxySettings = proxy ? [{ env: { ANTHROPIC_BASE_URL: proxy.url } }] : [];
      args = await applySessionSettings(plan.args, hookDir, cwd, [hooks.settings(), ...proxySettings]);
    } catch (error) {
      console.error(`switchboard: could not install the session's hooks: ${(error as Error).message}`);
      await stopHooks();
      return 1;
    }
  }
  // Switchboard's MCP tools for this session only (the Tool Capture), passed with
  // --mcp-config. Claude Code settings cannot hold MCP servers, so they are not in --settings.
  const tools = plan.kind === "none" ? null : prepareSessionTools(env);
  process.once("exit", () => tools?.dispose());
  if (tools) args = tools.args(args);

  const onRegistered = (agent: Agent) => {
    hooks?.setAgent(agent.id);
    tools?.setAgent(agent.id);
    proxy?.setAgent(agent);
  };

  let link: AgentLink | null = null;
  if (plan.kind === "known") {
    link = new AgentLink(client, session(plan.sessionId, plan.resumed), heartbeatMs, log, onRegistered);
    const expected = agentIdFor(config.person, "claude-code", plan.sessionId);
    childEnv.SWITCHBOARD_AGENT_ID = expected;
    try {
      const agent = await link.register();
      console.error(dim(`switchboard: ${agent.id} is on the Channel at ${config.url}`));
    } catch (error) {
      if (error instanceof ChannelError && error.status !== 0) {
        console.error(`switchboard: the Channel refused ${expected}: ${error.message}`);
        await stopHooks();
        return 1;
      }
      console.error(dim(`switchboard: ${(error as Error).message}. Starting anyway; will keep trying.`));
    }
  }

  const bin = env.SWITCHBOARD_CLAUDE_BIN || "claude";
  const stdin = process.stdin;
  const stdout = process.stdout;
  const child = pty.spawn(bin, args, {
    name: env.TERM || "xterm-256color",
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    cwd,
    env: childEnv,
  });
  log(`started ${bin} ${args.join(" ")}`);

  const idle = new IdleWatch(idleAfterMs, (presence) => link?.report(presence));
  child.onData((data) => {
    stdout.write(data);
    idle.activity();
  });

  const onInput = (data: Buffer) => child.write(data.toString("utf8"));
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on("data", onInput);
  stdin.resume();
  const onResize = () => child.resize(stdout.columns || 80, stdout.rows || 24);
  stdout.on("resize", onResize);

  const picking = new AbortController();
  if (plan.kind === "picker") {
    const launchedAt = Date.now();
    void waitForPickedSession(projectDir(claudeDir, cwd), launchedAt, picking.signal).then((sessionId) => {
      if (!sessionId) return;
      link = new AgentLink(client, session(sessionId, true), heartbeatMs, log, onRegistered);
      link.report(idle.current);
      link.start();
    });
  }

  link?.start();
  idle.start();

  const forward = (signal: NodeJS.Signals) => () => {
    log(`got ${signal}`);
    child.kill(signal);
    setTimeout(() => process.exit(1), END_TIMEOUT_MS + 2000).unref();
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGHUP", forward("SIGHUP"));

  const exitCode = await new Promise<number>((resolve) => {
    child.onExit(({ exitCode, signal }) => resolve(signal ? 128 + signal : exitCode));
  });

  picking.abort();
  idle.stop();
  stdin.off("data", onInput);
  stdout.off("resize", onResize);
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
  // Send what the last hooks (turn end, SessionEnd) reported before the session ends.
  await Promise.all([hooks?.drain(END_TIMEOUT_MS), proxy?.drain(END_TIMEOUT_MS)]);
  await link?.end(END_TIMEOUT_MS);
  await stopHooks();
  tools?.dispose();
  log(`exited ${exitCode}`);
  return exitCode;
}
