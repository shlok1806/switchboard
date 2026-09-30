// `switchboard run claude [...args]`: runs Claude Code in a pty so the terminal
// stays fully interactive, and joins the session to the Channel as an Agent.
// Its hooks (the Hook Capture) report what the Agent does to the Channel.

import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "@lydell/node-pty";
import type {
  Agent,
  AgentId,
  DeliveryAck,
  DirectiveAck,
  DirectiveInterruptMessage,
  DirectiveTypedResult,
  InterruptAttach,
  InterruptMessage,
  InterruptResult,
} from "../../shared/src/index";
import {
  agentIdFor,
  DEFAULT_IDLE_AFTER_MS,
  directivesNotice,
  HEARTBEAT_INTERVAL_MS,
  interruptNotice,
} from "../../shared/src/index";
import { AgentLink, type AgentSession } from "./agent-link";
import { ChannelClient, ChannelError } from "./channel-client";
import { claudeConfigDir, planSession, projectDir, waitForPickedSession } from "./claude-session";
import { configDir, readConfig } from "./config";
import { HookCapture } from "./hooks/capture";
import { DEFAULT_QUIET_MS, DEFAULT_WAIT_MS, InterruptTyper } from "./interrupts";
import { prepareSessionTools } from "./mcp-config";
import { NextTurn } from "./next-turn";
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
    // The wrapper types Interrupts into Claude Code's pty.
    interrupts: true,
  });

  // The Channel stream stays open for the whole session. It carries the Hook
  // and Proxy Captures' Events, the Agent's Proxy mode changes, and the Relay's
  // Deliveries, which it keeps the next-turn cache current with, and Interrupts,
  // which it types into the session.
  let hooks: HookCapture | null = null;
  let proxy: ProxyCapture | null = null;
  let agentId: AgentId | null = null;
  let child: pty.IPty | null = null;
  // Types Interrupts into the session, never over the Person's own typing.
  const typer = new InterruptTyper({
    write: (data) => child?.write(data),
    quietMs: seconds(env.SWITCHBOARD_INTERRUPT_QUIET_SECONDS, DEFAULT_QUIET_MS),
    waitMs: seconds(env.SWITCHBOARD_INTERRUPT_WAIT_SECONDS, DEFAULT_WAIT_MS),
    log,
  });
  // Tells the Channel this socket is the Agent's wrapper, so its Interrupts and Directives come here.
  const attach = () => {
    if (agentId === null) return;
    const frame: InterruptAttach = { type: "interrupt.attach", agent: agentId };
    stream.send(JSON.stringify(frame));
  };
  const interrupted = async (message: InterruptMessage) => {
    log(`Interrupt ${message.delivery.id} from the Relay`);
    const outcome = await typer.type(interruptNotice(message.delivery));
    log(
      outcome.typed
        ? `typed Interrupt ${message.delivery.id}`
        : `Interrupt ${message.delivery.id} left for the Queue: ${outcome.reason}`,
    );
    const result: InterruptResult = {
      type: "interrupt.result",
      agent: message.agent,
      id: message.delivery.id,
      ...outcome,
    };
    stream.send(JSON.stringify(result));
  };
  // A Person's Directive, typed right away through the same guards as an Interrupt.
  // When it cannot be typed, the Channel holds it for the next turn instead.
  const directed = async (message: DirectiveInterruptMessage) => {
    const { directive } = message;
    log(`Directive ${directive.id} from ${directive.from}`);
    const outcome = await typer.type(directivesNotice([directive]));
    log(
      outcome.typed
        ? `typed Directive ${directive.id}`
        : `Directive ${directive.id} left for the next turn: ${outcome.reason}`,
    );
    const result: DirectiveTypedResult = {
      type: "directive.result",
      agent: message.agent,
      id: directive.id,
      ...outcome,
    };
    stream.send(JSON.stringify(result));
  };
  // What the Agent is told at its next turn: Claims it lost to a Takeover while it
  // was Gone, Queued Events, Directives, and the standing rule at SessionStart.
  const nextTurn = new NextTurn();
  const stream = client.follow(
    (message) => {
      if (message.type === "hook.ack" || message.type === "hook.refused") hooks?.reply(message);
      if (message.type === "proxy.ack" || message.type === "proxy.refused") proxy?.reply(message);
      if (message.type === "agent") proxy?.agentChanged(message.agent);
      if (message.type === "delivery" && message.agent === agentId) {
        const kept = nextTurn.add({ deliveries: message.deliveries });
        if (kept.length > 0) log(`queued for the next turn: ${kept.length} from the Relay`);
        // Held here now, so the Channel stops handing them over.
        const ack: DeliveryAck = {
          type: "delivery.ack",
          agent: message.agent,
          ids: message.deliveries.map((d) => d.id),
        };
        stream.send(JSON.stringify(ack));
      }
      if (message.type === "interrupt" && message.agent === agentId) void interrupted(message);
      if (message.type === "directives" && message.agent === agentId) {
        const kept = nextTurn.add({ directives: message.directives });
        if (kept.length > 0) log(`queued for the next turn: ${kept.length} Directive(s)`);
        const ack: DirectiveAck = {
          type: "directive.ack",
          agent: message.agent,
          ids: message.directives.map((d) => d.id),
        };
        stream.send(JSON.stringify(ack));
      }
      if (message.type === "directive.interrupt" && message.agent === agentId) void directed(message);
    },
    (connected) => {
      log(connected ? "stream connected" : "stream disconnected");
      if (connected) hooks?.connected();
      if (connected) proxy?.connected();
      if (connected) attach();
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
      hooks = await HookCapture.start({
        dir: hookDir,
        root: cwd,
        send: (frame) => stream.send(frame),
        log,
        context: (hook) => nextTurn.take(hook),
        onHook: (input) => typer.hook(input),
      });
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
  const tools = plan.kind === "none" ? null : prepareSessionTools(cwd, env);
  process.once("exit", () => tools?.dispose());
  if (tools) args = tools.args(args);

  const onRegistered = (agent: Agent) => {
    agentId = agent.id;
    hooks?.setAgent(agent.id);
    tools?.setAgent(agent.id);
    proxy?.setAgent(agent);
    attach();
  };

  let link: AgentLink | null = null;
  if (plan.kind === "known") {
    link = new AgentLink(client, session(plan.sessionId, plan.resumed), heartbeatMs, log, onRegistered, (items) =>
      nextTurn.add(items),
    );
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
  const claudePty = pty.spawn(bin, args, {
    name: env.TERM || "xterm-256color",
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    cwd,
    env: childEnv,
  });
  child = claudePty;
  log(`started ${bin} ${args.join(" ")}`);

  const idle = new IdleWatch(idleAfterMs, (presence) => link?.report(presence));
  claudePty.onData((data) => {
    stdout.write(data);
    idle.activity();
    typer.output(data);
  });

  const onInput = (data: Buffer) => typer.personTyped(data.toString("utf8"));
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on("data", onInput);
  stdin.resume();
  const onResize = () => claudePty.resize(stdout.columns || 80, stdout.rows || 24);
  stdout.on("resize", onResize);

  const picking = new AbortController();
  if (plan.kind === "picker") {
    const launchedAt = Date.now();
    void waitForPickedSession(projectDir(claudeDir, cwd), launchedAt, picking.signal).then((sessionId) => {
      if (!sessionId) return;
      link = new AgentLink(client, session(sessionId, true), heartbeatMs, log, onRegistered, (items) =>
        nextTurn.add(items),
      );
      link.report(idle.current);
      link.start();
    });
  }

  link?.start();
  idle.start();

  const forward = (signal: NodeJS.Signals) => () => {
    log(`got ${signal}`);
    claudePty.kill(signal);
    setTimeout(() => process.exit(1), END_TIMEOUT_MS + 2000).unref();
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGHUP", forward("SIGHUP"));

  const exitCode = await new Promise<number>((resolve) => {
    claudePty.onExit(({ exitCode, signal }) => resolve(signal ? 128 + signal : exitCode));
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
