// `switchboard run <cli> [...args]`: runs an agent CLI (Claude Code, Codex or
// Gemini CLI) in a pty so the terminal stays fully interactive, and joins the
// session to the Channel as an Agent. Its hooks (the Hook Capture) report what the
// Agent does to the Channel. What differs from CLI to CLI is in its adapter
// (clis/): how the session ID is known, how hooks and MCP tools are installed for
// the session only, and whether Interrupts can be typed into it.

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
  STANDING_RULE,
} from "../../shared/src/index";
import { AgentLink, type AgentSession } from "./agent-link";
import { ChannelClient, ChannelError, targetOf } from "./channel-client";
import type { CliAdapter, ProxyRoute, SessionPlan } from "./clis/adapter";
import { configDir, readConfig } from "./config";
import { HookCapture } from "./hooks/capture";
import { DEFAULT_QUIET_MS, DEFAULT_WAIT_MS, InterruptTyper } from "./interrupts";
import { prepareSessionTools, type SessionTools } from "./mcp-config";
import { NextTurn, type NextTurnItems } from "./next-turn";
import { IdleWatch } from "./presence";
import { ProxyCapture } from "./proxy/capture";
import { DEFAULT_PROXY_SETTING, type ProxyFlags, takeProxyFlags } from "./proxy/options";

/** How long the wrapper waits for the Channel to hear that the session ended. */
const END_TIMEOUT_MS = 3000;
/** How long the wrapper waits for the first SessionStart hook before it says the hooks are not running. */
const HOOK_TRUST_WAIT_MS = 8000;

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

export async function runCli(adapter: CliAdapter, rawArgs: string[]): Promise<number> {
  const env = process.env;
  const config = await readConfig();
  if (!config) {
    console.error("Not logged in. Run: switchboard login --url <channel url>");
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
  // The Proxy Capture reads the model APIs of the CLIs whose adapters say so.
  const proxySetting = proxyFlags.proxy ?? (adapter.proxy ? DEFAULT_PROXY_SETTING : "off");
  if (!adapter.proxy && proxySetting !== "off") {
    console.error(`switchboard: the Proxy Capture does not support ${adapter.label} yet; use --proxy off.`);
    return 2;
  }
  const rest = proxyFlags.rest;
  const cwd = process.cwd();
  const ctx = { cwd, env };
  let plan: SessionPlan;
  try {
    plan = await adapter.plan(rest, ctx);
  } catch (error) {
    console.error(`switchboard: ${(error as Error).message}`);
    return 1;
  }

  // Registering trades the Person's session for the Agent's token; the client then
  // acts with the token, and the stream reconnects with it (ADR 0007).
  const client = new ChannelClient(targetOf(config));
  const heartbeatMs = seconds(env.SWITCHBOARD_HEARTBEAT_SECONDS, HEARTBEAT_INTERVAL_MS);
  const idleAfterMs = seconds(env.SWITCHBOARD_IDLE_AFTER_SECONDS, DEFAULT_IDLE_AFTER_MS);
  const session = (sessionId: string, resumed: boolean): AgentSession => ({
    cli: adapter.cli,
    sessionId,
    resumed,
    cwd,
    ...(nickname === undefined ? {} : { nickname }),
    ...(proxySetting === "off" ? {} : { proxyMode: proxySetting }),
    ...(proxyFlags.mask ? {} : { secretMasking: false }),
    // Whether the wrapper types Interrupts into this CLI's pty. When not, the
    // Relay delivers them as Queue, labelled downgraded.
    interrupts: adapter.interrupts,
  });

  // The Channel stream stays open for the whole session. It carries the Hook
  // and Proxy Captures' Events, the Agent's Proxy mode changes, and the Relay's
  // Deliveries, which it keeps the next-turn cache current with, and Interrupts,
  // which it types into the session.
  let hooks: HookCapture | null = null;
  let proxy: ProxyCapture | null = null;
  let proxyRoute: ProxyRoute | null = null;
  let tools: SessionTools | null = null;
  let agentId: AgentId | null = null;
  let child: pty.IPty | null = null;
  // Types Interrupts into the session, never over the Person's own typing.
  const typer = new InterruptTyper({
    write: (data) => child?.write(data),
    quietMs: seconds(env.SWITCHBOARD_INTERRUPT_QUIET_SECONDS, DEFAULT_QUIET_MS),
    waitMs: seconds(env.SWITCHBOARD_INTERRUPT_WAIT_SECONDS, DEFAULT_WAIT_MS),
    idleClears: adapter.idleClears,
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
  // False once a CLI whose hooks need the Person's trust is seen not to run them:
  // what the Agent must be told then goes to the read_channel tool instead of a hook.
  let hooksRunning = true;
  const heldForTools = () => {
    if (hooksRunning || tools === null) return;
    const text = nextTurn.take("UserPromptSubmit");
    if (text !== "") {
      tools.leaveForNextTurn(text);
      log("left next-turn notices for the read_channel tool: the CLI's hooks are not running");
    }
  };
  const addForNextTurn = (items: NextTurnItems) => {
    const kept = nextTurn.add(items);
    heldForTools();
    return kept;
  };
  const stream = client.follow(
    (message) => {
      if (message.type === "hook.ack" || message.type === "hook.refused") hooks?.reply(message);
      if (message.type === "proxy.ack" || message.type === "proxy.refused") proxy?.reply(message);
      if (message.type === "agent") proxy?.agentChanged(message.agent);
      if (message.type === "delivery" && message.agent === agentId) {
        const kept = addForNextTurn({ deliveries: message.deliveries });
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
        const kept = addForNextTurn({ directives: message.directives });
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

  let args = plan.args;
  let hookDir: string | null = null;
  const stopHooks = async () => {
    stream.close();
    await hooks?.close();
    await proxy?.close();
    if (hookDir) await rm(hookDir, { recursive: true, force: true });
  };
  const childEnv: Record<string, string> = { ...(env as Record<string, string>) };
  if (plan.kind !== "none" && proxySetting !== "off") {
    // The Proxy Capture: model traffic goes through a local proxy. If it cannot
    // start, the CLI runs as it would without Switchboard.
    try {
      const route = (await adapter.proxyRoute?.(ctx, plan.args)) ?? { unsupported: "no route for its model traffic" };
      if ("unsupported" in route) {
        log(`proxy not started: ${route.unsupported}`);
        console.error(
          dim(`switchboard: the Proxy Capture cannot read this session (${route.unsupported}). Running without it.`),
        );
      } else {
        proxy = await ProxyCapture.start({
          upstream: route.upstream,
          api: route.api,
          mode: proxySetting,
          mask: proxyFlags.mask,
          root: cwd,
          send: (frame) => stream.send(frame),
          log,
        });
        proxyRoute = route;
        log(`proxy on ${proxy.url} to ${route.upstream} (${route.api.name})`);
      }
    } catch (error) {
      proxy = null;
      log(`proxy failed to start: ${(error as Error).message}`);
      console.error(
        dim(`switchboard: the Proxy Capture could not start (${(error as Error).message}). Running without it.`),
      );
    }
  }

  // The session's Agent, registered once its session ID is known: before launch,
  // or from the first hook or the adapter's `discover` once the CLI has started.
  let link: AgentLink | null = null;
  let idle: IdleWatch | null = null;
  const onRegistered = (agent: Agent, token: string | undefined) => {
    agentId = agent.id;
    hooks?.setAgent(agent.id);
    if (token !== undefined) tools?.setAgent(agent.id, token);
    proxy?.setAgent(agent);
    attach();
  };
  const linkTo = (sessionId: string, resumed: boolean) => {
    if (link !== null) return;
    log(`session ${sessionId}`);
    link = new AgentLink(client, session(sessionId, resumed), heartbeatMs, log, onRegistered, addForNextTurn);
    link.report(idle?.current ?? "live");
    link.start();
  };

  let sawSessionStart = false;
  if (plan.kind !== "none") {
    try {
      // Private to the Person: it holds the socket and the session's config files.
      hookDir = await mkdtemp(join(tmpdir(), "switchboard-"));
      const discovering = plan.kind === "discover" && adapter.sessionFromHooks ? plan : null;
      hooks = await HookCapture.start({
        dir: hookDir,
        root: cwd,
        send: (frame) => stream.send(frame),
        log,
        context: (hook) => nextTurn.take(hook),
        onHook: (input) => {
          if (input.hook_event_name === "SessionStart") sawSessionStart = true;
          if (!hooksRunning) {
            hooksRunning = true;
            log("the CLI's hooks are running");
          }
          typer.hook(input);
        },
        ...(discovering === null ? {} : { onSessionId: (sessionId: string) => linkTo(sessionId, discovering.resumed) }),
        ...(adapter.translateHook ? { translate: adapter.translateHook } : {}),
        ...(adapter.hookAnswer ? { answer: adapter.hookAnswer } : {}),
      });
      // Switchboard's MCP tools for this session only (the Tool Capture).
      tools = prepareSessionTools(cwd, env);
      const installed = await adapter.install({
        ...ctx,
        args: plan.args,
        dir: hookDir,
        hooks,
        tools,
        ...(proxy && proxyRoute ? { proxyUrl: proxy.url, proxyRoute } : {}),
      });
      args = installed.args;
      Object.assign(childEnv, installed.env);
    } catch (error) {
      console.error(`switchboard: could not install the session's hooks: ${(error as Error).message}`);
      tools?.dispose();
      await stopHooks();
      return 1;
    }
  }
  const sessionTools = tools as SessionTools | null;
  process.once("exit", () => sessionTools?.dispose());

  if (plan.kind === "known") {
    link = new AgentLink(client, session(plan.sessionId, plan.resumed), heartbeatMs, log, onRegistered, addForNextTurn);
    const expected = agentIdFor(config.person, adapter.cli, plan.sessionId);
    childEnv.SWITCHBOARD_AGENT_ID = expected;
    try {
      const agent = await link.register();
      console.error(dim(`switchboard: ${agent.id} is on the Channel for ${config.repo} at ${config.url}`));
    } catch (error) {
      if (error instanceof ChannelError && error.status !== 0) {
        console.error(`switchboard: the Channel refused ${expected}: ${error.message}`);
        sessionTools?.dispose();
        await stopHooks();
        return 1;
      }
      console.error(dim(`switchboard: ${(error as Error).message}. Starting anyway; will keep trying.`));
    }
  }

  const bin = env[adapter.binEnv] || adapter.command;
  const stdin = process.stdin;
  const stdout = process.stdout;
  const cliPty = pty.spawn(bin, args, {
    name: env.TERM || "xterm-256color",
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    cwd,
    env: childEnv,
  });
  child = cliPty;
  log(`started ${bin} ${args.join(" ")}`);

  const watch = new IdleWatch(idleAfterMs, (presence) => link?.report(presence));
  idle = watch;
  cliPty.onData((data) => {
    stdout.write(data);
    watch.activity();
    typer.output(data);
  });

  const onInput = (data: Buffer) => {
    const text = data.toString("utf8");
    typer.personTyped(text);
    if (/[\r\n]/.test(text)) watchTrust();
  };
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on("data", onInput);
  stdin.resume();
  const onResize = () => cliPty.resize(stdout.columns || 80, stdout.rows || 24);
  stdout.on("resize", onResize);

  // Finds a `discover` session without hooks. Where hooks report the session (they
  // are exact), this only starts once they are seen not to run: a session file in
  // the same directory could be another session's.
  const discovering = new AbortController();
  const launchedAt = Date.now();
  const discover = () => {
    if (plan.kind !== "discover" || !adapter.discover || link !== null) return;
    const { resumed } = plan;
    void adapter.discover(ctx, launchedAt, discovering.signal, resumed).then((sessionId) => {
      if (sessionId) linkTo(sessionId, resumed);
    });
  };
  if (!adapter.sessionFromHooks) discover();

  // A CLI that runs session hooks only once the Person trusts them: say so when
  // none has arrived in time. Codex starts its session (and runs SessionStart) at
  // the first prompt, so the wait starts when the Person first presses Enter.
  // Until a hook arrives, next-turn notices go to the read_channel tool.
  let trustTimer: ReturnType<typeof setTimeout> | undefined;
  const hint = plan.kind === "none" ? undefined : adapter.untrustedHooksHint;
  const watchTrust = () => {
    if (hint === undefined || trustTimer !== undefined || sawSessionStart) return;
    trustTimer = setTimeout(
      () => {
        if (sawSessionStart) return;
        log("no SessionStart hook: the CLI's hooks are not trusted");
        stdout.write(`\r\n${dim(`switchboard: ${hint}`)}\r\n`);
        hooksRunning = false;
        sessionTools?.leaveForNextTurn(STANDING_RULE);
        heldForTools();
        discover();
      },
      seconds(env.SWITCHBOARD_HOOK_TRUST_SECONDS, HOOK_TRUST_WAIT_MS),
    );
  };

  link?.start();
  watch.start();

  const forward = (signal: NodeJS.Signals) => () => {
    log(`got ${signal}`);
    cliPty.kill(signal);
    setTimeout(() => process.exit(1), END_TIMEOUT_MS + 2000).unref();
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGHUP", forward("SIGHUP"));

  const exitCode = await new Promise<number>((resolve) => {
    cliPty.onExit(({ exitCode, signal }) => resolve(signal ? 128 + signal : exitCode));
  });

  clearTimeout(trustTimer);
  discovering.abort();
  watch.stop();
  stdin.off("data", onInput);
  stdout.off("resize", onResize);
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
  // Send what the last hooks (turn end, SessionEnd) reported before the session ends.
  await Promise.all([hooks?.drain(END_TIMEOUT_MS), proxy?.drain(END_TIMEOUT_MS)]);
  await (link as AgentLink | null)?.end(END_TIMEOUT_MS);
  await stopHooks();
  sessionTools?.dispose();
  log(`exited ${exitCode}`);
  return exitCode;
}
