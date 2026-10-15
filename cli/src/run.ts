// `switchboard run <cli> [...args]`: runs an agent CLI (Claude Code, Codex or
// Gemini CLI) in a pty so the terminal stays fully interactive, and joins the
// session to the Channel as an Agent. Its hooks (the Hook Capture) report what the
// Agent does to the Channel. What differs from CLI to CLI is in its adapter
// (clis/): how the session ID is known, how hooks and MCP tools are installed for
// the session only, and whether Interrupts can be typed into it.

import { randomBytes } from "node:crypto";
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
  MemoryResponse,
  SetApprovalRequest,
  SetModelRequest,
  TerminalAttachedFrame,
  TerminalInputFrame,
  TerminalRefusedFrame,
  TerminalScreenFrame,
  TranscriptPageFrame,
  TranscriptRequestMessage,
  TranscriptResponse,
  WakeCappedMessage,
  WakeMessage,
} from "../../shared/src/index";
import {
  agentIdFor,
  approvalPath,
  channelKey,
  DEFAULT_IDLE_AFTER_MS,
  denyReason,
  directivesNotice,
  HEARTBEAT_INTERVAL_MS,
  interruptNotice,
  modelPath,
  STANDING_RULE,
  TERMINAL_HOLD_IDLE_MS,
} from "../../shared/src/index";
import { accountLabel } from "./account-label";
import { AgentLink, type AgentSession } from "./agent-link";
import { ApprovalReporter, DenyGate } from "./approvals";
import { type ChannelChoice, ChannelChoiceError, chooseChannel, describeChoice } from "./channel-choice";
import { ChannelClient, ChannelError, targetOf } from "./channel-client";
import { claudeConfigDir, projectDir, withSessionId } from "./claude-session";
import type { CliAdapter, ProxyRoute, SessionPlan } from "./clis/adapter";
import { configDir, readConfig } from "./config";
import { HookCapture } from "./hooks/capture";
import { DEFAULT_QUIET_MS, DEFAULT_WAIT_MS, InterruptTyper } from "./interrupts";
import { prepareSessionTools, type SessionTools } from "./mcp-config";
import { MemoryInbox, MemoryNudges } from "./memory";
import { configuredModel, ModelWatch } from "./model-watch";
import { NextTurn, type NextTurnItems } from "./next-turn";
import { IdleWatch } from "./presence";
import { ProxyCapture } from "./proxy/capture";
import { DEFAULT_PROXY_SETTING, type ProxyFlags, takeProxyFlags } from "./proxy/options";
import { SessionContextReader } from "./session-context";
import { channelCheckout, GitError } from "./task-worktree";
import { cachedAttachList } from "./terminal/attach-keys";
import { AttachGate } from "./terminal/gate";
import { holderOf, TerminalKeyboard } from "./terminal/keyboard";
import { PasteGuard } from "./terminal/paste";
import { TerminalPresence, terminalNotification } from "./terminal/presence";
import { ScreenStream, TerminalScreen } from "./terminal/screen";
import { TranscriptReader } from "./transcript";
import { readAccount } from "./usage/limits";
import { UsageSchedule } from "./usage/schedule";
import { SessionTally } from "./usage/session";
import { UsageWatch } from "./usage/watch";
import { Waker } from "./wake";

/** How long the wrapper waits for the Channel to hear that the session ended. */
const END_TIMEOUT_MS = 3000;
/** How long a session that ends waits for a usage reading in progress. */
const USAGE_END_WAIT_MS = 10_000;
/** The environment variable that turns usage readings off (ADR 0011): `off`. */
const USAGE_ENV = "SWITCHBOARD_USAGE";
/** How long the wrapper waits for the first SessionStart hook before it says the hooks are not running. */
const HOOK_TRUST_WAIT_MS = 8000;

function seconds(raw: string | undefined, fallbackMs: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0 ? value * 1000 : fallbackMs;
}

function dim(text: string): string {
  return process.stderr.isTTY ? `\x1b[2m${text}\x1b[0m` : text;
}

/** Takes one of the wrapper's own `--<name> <value>` options out of the arguments meant for the agent CLI. */
function takeOption(args: string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      rest.push(...args.slice(i));
      break;
    }
    if (arg === `--${name}`) {
      value = args[i + 1];
      i++;
    } else if (arg.startsWith(`--${name}=`)) {
      value = arg.slice(name.length + 3);
    } else {
      rest.push(arg);
    }
  }
  return value === undefined ? { rest } : { value, rest };
}

/** Takes the wrapper's own `--nickname` out of the arguments meant for the agent CLI. */
export function takeNickname(args: string[]): { nickname?: string; rest: string[] } {
  const { value, rest } = takeOption(args, "nickname");
  return value === undefined ? { rest } : { nickname: value, rest };
}

/** Takes the wrapper's own `--account-label` (ADR 0009) out of the agent CLI's arguments. */
export function takeAccountLabel(args: string[]): { accountLabel?: string; rest: string[] } {
  const { value, rest } = takeOption(args, "account-label");
  return value === undefined ? { rest } : { accountLabel: value, rest };
}

/** Takes the wrapper's own `--repo`, which names the Channel (ADR 0008), out of the agent CLI's arguments. */
export function takeRepo(args: string[]): { repo?: string; rest: string[] } {
  const { value, rest } = takeOption(args, "repo");
  return value === undefined ? { rest } : { repo: value, rest };
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
  const { accountLabel: accountFlag, rest: afterAccount } = takeAccountLabel(afterNickname);
  const { repo: repoFlag, rest: afterRepo } = takeRepo(afterAccount);
  let proxyFlags: ProxyFlags;
  try {
    proxyFlags = takeProxyFlags(afterRepo);
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
  // One login serves every Channel on the Worker (ADR 0008): this session's is chosen
  // here, once, and every part of the session is told the same repo.
  let choice: ChannelChoice;
  try {
    choice = await chooseChannel(config, { ...(repoFlag === undefined ? {} : { flag: repoFlag }), env, cwd });
  } catch (error) {
    if (!(error instanceof ChannelChoiceError)) throw error;
    console.error(`switchboard: ${error.message}`);
    return 2;
  }
  const { repo } = choice;
  log(`using ${describeChoice(choice)} at ${config.url}`);
  if (choice.reason !== "default" || choice.note !== undefined) {
    console.error(dim(`switchboard: using ${describeChoice(choice)}`));
  }

  // An Agent's Tasks are branches pushed through origin, so a session starts only in
  // a clone of the Channel's repo. A command that starts no session runs anywhere.
  if (plan.kind !== "none") {
    try {
      await channelCheckout(cwd, repo);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      console.error(`switchboard: ${error.message}`);
      return 1;
    }
  }

  // Registering trades the Person's session for the Agent's token; the client then
  // acts with the token, and the stream reconnects with it (ADR 0007).
  const client = new ChannelClient(targetOf(config, repo));
  // The Channel checks the Person's Membership itself. A refusal is said in its own
  // words, since signing in again would not change it; when the Channel cannot be
  // reached the session starts anyway and keeps trying.
  try {
    if (plan.kind !== "none") await client.join();
  } catch (error) {
    if (!(error instanceof ChannelError)) throw error;
    if (error.status !== 0) {
      log(`the Channel for ${repo} refused ${config.person}: ${error.message}`);
      console.error(`switchboard: the Channel for ${repo} at ${config.url} refused ${config.person}: ${error.message}`);
      if (error.status === 401) console.error("switchboard: run `switchboard login` to sign in again.");
      return 1;
    }
    log(`could not reach the Channel for ${repo}: ${error.message}`);
  }
  // Which login of the CLI this Agent runs under, shown beside it on the Channel (ADR 0009).
  const account = await accountLabel(adapter.cli, accountFlag, env);
  // The model until the Proxy Capture sees the CLI ask for one (ADR 0010).
  const configured = await configuredModel(adapter.cli, rest, env, cwd);
  const heartbeatMs = seconds(env.SWITCHBOARD_HEARTBEAT_SECONDS, HEARTBEAT_INTERVAL_MS);
  const idleAfterMs = seconds(env.SWITCHBOARD_IDLE_AFTER_SECONDS, DEFAULT_IDLE_AFTER_MS);
  const session = (sessionId: string, resumed: boolean): AgentSession => ({
    cli: adapter.cli,
    sessionId,
    resumed,
    cwd,
    source: resumed ? "resume" : "startup",
    ...(nickname === undefined ? {} : { nickname }),
    account,
    ...configured,
    ...(proxySetting === "off" ? {} : { proxyMode: proxySetting }),
    ...(proxyFlags.mask ? {} : { secretMasking: false }),
    // Whether the wrapper types Interrupts into this CLI's pty. When not, the
    // Relay delivers them as Queue, labelled downgraded.
    interrupts: adapter.interrupts,
    // A Host started this wrapper (ADR 0015): the Agent runs on it, and answers its spawn.
    ...(env.SWITCHBOARD_HOST ? { host: env.SWITCHBOARD_HOST } : {}),
    ...(env.SWITCHBOARD_HOST && env.SWITCHBOARD_SPAWN ? { spawn: env.SWITCHBOARD_SPAWN } : {}),
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
  // The Person pressed Enter, here or from the Dashboard.
  let entered = () => {};
  const typer = new InterruptTyper({
    write: (data) => child?.write(data),
    quietMs: seconds(env.SWITCHBOARD_INTERRUPT_QUIET_SECONDS, DEFAULT_QUIET_MS),
    waitMs: seconds(env.SWITCHBOARD_INTERRUPT_WAIT_SECONDS, DEFAULT_WAIT_MS),
    idleClears: adapter.idleClears,
    log,
    onPersonPrompt: () => waker?.reset("the Person sent a prompt"),
    // Set below to the hook trust watch, once the CLI runs.
    onEnter: () => entered(),
    onApproval: (request) => {
      screenStream.changed();
      approvals.changed(request);
      if (request === null) denyGate?.release();
    },
  });
  // Holds the prompt's hook, so the Agent's own Person can deny it from the Channel (ADR 0014).
  // A held hook that ends before a deny reaches it leaves the prompt to the terminal.
  const denyGate = adapter.remoteDeny ? new DenyGate((id) => approvals.lapsed(id)) : null;
  // Shows the permission prompt the CLI waits on to the Channel (ADR 0013).
  const approvals = new ApprovalReporter({
    deniable: denyGate !== null,
    send: async (approval) => {
      if (agentId === null) return false;
      try {
        const body: SetApprovalRequest = { approval };
        await client.request(approvalPath(agentId), { method: "POST", body: JSON.stringify(body) });
        return true;
      } catch (error) {
        log(`could not report the pending approval: ${(error as Error).message}`);
        return false;
      }
    },
    log,
  });
  // Tells the Channel this socket is the Agent's wrapper, so its Interrupts and Directives come here.
  const attach = () => {
    if (agentId === null) return;
    const frame: InterruptAttach = { type: "interrupt.attach", agent: agentId };
    stream.send(JSON.stringify(frame));
  };
  // The live terminal (ADR 0021): the screen goes to watchers, redacted, while anyone watches;
  // input comes back signed by a key this machine's Person allowed, and only then is typed.
  const nonce = randomBytes(16).toString("base64url");
  let screen: TerminalScreen | null = null;
  const presence = new TerminalPresence(config.person);
  // Tells the owner in their own terminal, without drawing over the CLI.
  const notify = (text: string) => {
    log(text);
    if (process.stdout.isTTY) process.stdout.write(terminalNotification(`switchboard: ${text}`));
  };
  const sendScreen = () => {
    if (agentId === null || screen === null) return;
    const shot = screen.snapshot();
    const frame: TerminalScreenFrame = {
      type: "terminal.screen",
      agent: agentId,
      nonce,
      ...shot,
      attached: presence.attached(),
      prompt: typer.dialogOpen !== null,
      paste: typer.pasteMode,
      holder: holderOf(keyboard.held, config.person),
    };
    stream.send(JSON.stringify(frame));
  };
  const screenStream = new ScreenStream(sendScreen);
  // A paste a lost frame left open is ended here, or every key after it is pasted text.
  const paste = new PasteGuard((end) => typer.personTyped(end));
  // One typist at a time holds the keyboard: the Person here, or one Dashboard key.
  const keyboard = new TerminalKeyboard({
    idleMs: seconds(env.SWITCHBOARD_TERMINAL_HOLD_SECONDS, TERMINAL_HOLD_IDLE_MS),
    onChange: (holder, was) => {
      screenStream.changed();
      // A key that lost the keyboard mid-paste leaves it to whoever types next: end it first.
      if (was?.kind === "key") paste.lost(was.fingerprint);
      if (holder?.kind === "key")
        notify(
          `${holder.person} holds the keyboard from the Dashboard (key ${holder.fingerprint}): your keys are held back until they let go. Ctrl+] takes it back.`,
        );
      else if (was?.kind === "key")
        notify(holder === null ? `${was.person} let go of the keyboard` : "you hold the keyboard again");
    },
  });
  const gate = new AttachGate({
    owner: config.person,
    // As the Dashboard names it, from its address: the default repo in config.json may not be lowercase.
    repo: channelKey(repo) ?? repo,
    agent: () => agentId,
    nonce,
    list: cachedAttachList(env),
    dialog: () => typer.dialogOpen,
  });
  let floodLoggedAt = 0;
  const typedFromChannel = async (frame: TerminalInputFrame) => {
    const result = await gate.check(frame);
    if (agentId === null) return;
    if (!result.ok) paste.lost(result.limited ? undefined : result.fingerprint);
    if (!result.ok && result.limited) {
      // A flood: said once a second, and not answered frame by frame.
      if (Date.now() - floodLoggedAt >= 1000) {
        floodLoggedAt = Date.now();
        log(`dropping terminal input from the Channel: ${result.reason}`);
      }
      return;
    }
    const refuse = (fingerprint: string, reason: string) => {
      log(
        `refused terminal input from ${fingerprint || "a bad key"} (Channel says ${frame.from ?? "nobody"}): ${reason}`,
      );
      const refused: TerminalRefusedFrame = {
        type: "terminal.refused",
        agent: agentId as AgentId,
        fingerprint,
        seq: typeof frame.seq === "number" ? frame.seq : -1,
        reason,
      };
      stream.send(JSON.stringify(refused));
    };
    if (!result.ok) {
      refuse(result.fingerprint, result.reason);
      return;
    }
    if (result.op === "release") {
      keyboard.release(result.fingerprint);
      return;
    }
    const busy =
      result.op === "take"
        ? keyboard.take(result.fingerprint, result.person, frame.from)
        : keyboard.typed(result.fingerprint);
    if (busy !== null) {
      paste.lost(result.fingerprint);
      refuse(result.fingerprint, busy);
      return;
    }
    // A take is not typing: the hold's change is shown already.
    if (result.op === "take") return;
    // Typed as the Person's own keys are: Interrupts wait for it, and Enter is the Person's prompt.
    // Held back behind an Interrupt, they go only if this key still holds the keyboard then.
    const { fingerprint } = result;
    paste.before(fingerprint);
    typer.personTyped(result.text, () => keyboard.holds(fingerprint));
    paste.typed(fingerprint, result.text);
    const attaching = presence.keyTyped(result.fingerprint, result.person);
    screenStream.changed();
    if (attaching) {
      notify(`${result.person} is typing into this terminal from the Dashboard (key ${result.fingerprint})`);
      const attachedFrame: TerminalAttachedFrame = {
        type: "terminal.attached",
        agent: agentId,
        person: result.person,
        key: result.fingerprint.slice(0, 4),
      };
      stream.send(JSON.stringify(attachedFrame));
    }
  };
  // Another session on the Channel reads this one's transcript (ADR 0019): read from the
  // session file, condensed and always redacted here, before it leaves the machine.
  const transcripts = new TranscriptReader(adapter.cli);
  const transcribed = async (message: TranscriptRequestMessage) => {
    const reply = (answer: { page: Omit<TranscriptResponse, "agent"> } | { error: string }) => {
      const frame: TranscriptPageFrame = { type: "transcript.page", agent: message.agent, id: message.id, ...answer };
      stream.send(JSON.stringify(frame));
    };
    try {
      const path = await contextReader?.file();
      if (path === undefined) {
        reply({ error: "The session has not written its transcript yet." });
        return;
      }
      const page = await transcripts.page(path, message.from);
      log(`sent transcript entries ${message.from}+${page.entries.length}, ${page.redacted} redacted`);
      reply({ page });
    } catch (error) {
      log(`could not read the transcript: ${(error as Error).message}`);
      reply({ error: "The session's transcript could not be read." });
    }
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
    log(`Directive ${directive.id} from ${directive.lead ?? directive.from}`);
    // Only its Person's word lets the Agent be woken again, never a lead's (ADR 0018).
    if (directive.lead === undefined) waker?.reset(`Directive from ${directive.from}`);
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
  // Notes other Agents wrote to the Channel's shared memory, for the next turn's digest (ADR 0019).
  const memory = new MemoryInbox({
    dir: join(configDir(), "memory"),
    read: (path) => client.request<MemoryResponse>(path),
    log,
  });
  // What the Agent is told at its next turn: Claims it lost to a Takeover while it
  // was Gone, Queued Events, Directives, notes, and the standing rule at SessionStart.
  const nextTurn = new NextTurn(memory);
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
  // Wakes the Agent while it is idle for what deserves it, instead of waiting for its next turn.
  const waker = adapter.wakes
    ? new Waker({
        type: (produce) => typer.wake(produce),
        pending: () => hooksRunning && nextTurn.wakeWorthy,
        take: () => nextTurn.takeForWake(),
        woke: (batch) => {
          if (agentId === null) return;
          const frame: WakeMessage = {
            type: "wake",
            agent: agentId,
            deliveries: batch.deliveries,
            directives: batch.directives,
          };
          if (!stream.send(JSON.stringify(frame))) log("the Channel did not hear of the Wake: not connected");
        },
        capped: () => {
          if (agentId === null) return;
          const frame: WakeCappedMessage = { type: "wake.capped", agent: agentId };
          if (!stream.send(JSON.stringify(frame))) log("the Channel did not hear the Wakes stopped: not connected");
        },
        log,
      })
    : null;
  const addForNextTurn = (items: NextTurnItems) => {
    const kept = nextTurn.add(items);
    // A Person's Directive is their word: the Agent may be woken again. A lead's is not (ADR 0018).
    if ((items.directives ?? []).some((d) => d.lead === undefined && kept.includes(d.id))) {
      waker?.reset("a Directive from its Person");
    }
    heldForTools();
    waker?.poke();
    return kept;
  };
  const stream = client.follow(
    (message) => {
      if (message.type === "hook.ack" || message.type === "hook.refused") hooks?.reply(message);
      if (message.type === "event") memory.event(message.event);
      if (message.type === "proxy.ack" || message.type === "proxy.refused") proxy?.reply(message);
      if (message.type === "agent") {
        proxy?.agentChanged(message.agent);
        link?.agentChanged(message.agent);
        if (message.agent.id === agentId) models.known(message.agent.model, message.agent.effort);
      }
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
      if (message.type === "interrupt.attached" && message.agent === agentId) {
        log(`attached: ${agentId}'s Interrupts and Directives come to this wrapper`);
      }
      if (message.type === "interrupt" && message.agent === agentId) void interrupted(message);
      if (message.type === "terminal.watchers" && message.agent === agentId) {
        screenStream.setWatchers(message.count);
        // An older Channel sends only the count.
        for (const person of presence.watchers(Array.isArray(message.persons) ? message.persons : []))
          notify(`${person} is watching this terminal from the Dashboard`);
        // A Dashboard holder who stopped watching closed the page or lost their connection.
        if (Array.isArray(message.persons)) keyboard.watching(message.persons);
      }
      if (message.type === "terminal.input" && message.agent === agentId) void typedFromChannel(message);
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
      if (message.type === "transcript.request" && message.agent === agentId) void transcribed(message);
      if (message.type === "approval.deny" && message.agent === agentId) {
        const { person } = message;
        const denied = denyGate?.deny(message.id, denyReason(person, message.message)) ?? Promise.resolve(false);
        void denied.then((printed) => {
          // The dialog is answered only once Claude Code has the deny: until then typing still waits.
          if (printed) {
            log(`permission prompt denied from the Channel by ${person}`);
            typer.permissionAnswered();
          } else {
            log(`a deny from ${person} did not reach the permission prompt: it closed, or its hook ended`);
          }
        });
      }
    },
    (connected) => {
      log(connected ? "stream connected" : "stream disconnected");
      if (connected) hooks?.connected();
      if (connected) proxy?.connected();
      if (connected) attach();
      else keyboard.disconnected();
    },
  );

  // The model each turn asks for, reported to the Channel once it holds (ADR 0010).
  // Before the Agent is registered there is no one to report for: the next turn tries again.
  const models = new ModelWatch(async ({ model, effort }) => {
    if (agentId === null) return false;
    try {
      const body: SetModelRequest = { model, effort, via: "proxy" };
      await client.request(modelPath(agentId), { method: "POST", body: JSON.stringify(body) });
      log(`model ${model}${effort === null ? "" : ` (${effort})`}`);
      return true;
    } catch (error) {
      log(`could not report the model: ${(error as Error).message}`);
      return false;
    }
  });

  let args = plan.args;
  let hookDir: string | null = null;
  const stopHooks = async () => {
    models.close();
    approvals.close();
    // A held hook keeps its connection open: let it go, or the socket never closes.
    denyGate?.release();
    stream.close();
    await hooks?.close();
    await proxy?.close();
    if (hookDir) await rm(hookDir, { recursive: true, force: true });
  };
  const childEnv: Record<string, string> = { ...(env as Record<string, string>) };
  // What the Host told this wrapper is about this session only, not one an Agent starts.
  delete childEnv.SWITCHBOARD_HOST;
  delete childEnv.SWITCHBOARD_SPAWN;
  for (const name of adapter.parentEnv ?? []) delete childEnv[name];
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
          onModel: (seen) => models.seen(seen),
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

  // Usage (ADR 0011): the account's limits from Claude Code's own /usage, and the
  // session's tokens from its transcript, read at the start, after every turn and
  // every few minutes, and sent with the heartbeat. Claude Code only.
  const bin = env[adapter.binEnv] || adapter.command;
  let usage: { schedule: UsageSchedule; tally: SessionTally } | null = null;
  const watchUsage = (sessionId: string) => {
    if (usage !== null || adapter.cli !== "claude-code" || env[USAGE_ENV] === "off") return;
    const tally = new SessionTally(join(projectDir(claudeConfigDir(env), cwd), `${sessionId}.jsonl`));
    const watch = new UsageWatch(
      () => readAccount(bin, env, cwd),
      tally,
      (reading) => {
        const { session: limit } = reading.limits ?? {};
        log(`usage: ${reading.email ?? "unknown account"}${limit ? `, session ${limit.percent}%` : ""}`);
        link?.reportUsage(reading);
      },
      log,
    );
    usage = { schedule: new UsageSchedule(() => watch.read(), { log }), tally };
    usage.schedule.start();
  };

  // The session's Agent, registered once its session ID is known: before launch,
  // or from the first hook or the adapter's `discover` once the CLI has started.
  let link: AgentLink | null = null;
  let idle: IdleWatch | null = null;
  let contextReader: SessionContextReader | null = null;
  // One reading at a time: the reader follows the session file from where it left off.
  let contextReading: Promise<unknown> = Promise.resolve();
  const readContext = (reader: SessionContextReader) => {
    const reading = contextReading.catch(() => undefined).then(() => reader.read());
    contextReading = reading;
    return reading;
  };
  const watchContext = (sessionId: string) => {
    contextReader = new SessionContextReader(
      adapter.cli,
      sessionId,
      cwd,
      env,
      `Codex · ${config.person} · ${account ?? sessionId.slice(-8)}`,
    );
    const reader = contextReader;
    if (link) link.readContext = () => readContext(reader);
  };
  // Asks the model for memory notes when a turn changed files, and before compaction (ADR 0019).
  const nudges =
    adapter.cli === "claude-code"
      ? new MemoryNudges({
          context: async () => (contextReader === null ? undefined : (await readContext(contextReader)).context),
          env,
          log,
        })
      : null;
  const onRegistered = (agent: Agent, token: string | undefined) => {
    agentId = agent.id;
    hooks?.setAgent(agent.id);
    if (token !== undefined) tools?.setAgent(agent.id, token);
    proxy?.setAgent(agent);
    models.known(agent.model, agent.effort);
    void models.flush();
    approvals.registered();
    attach();
    void memory.registered(agent.id);
  };
  const linkTo = (sessionId: string, resumed: boolean) => {
    if (link !== null) return;
    log(`session ${sessionId}`);
    link = new AgentLink(client, session(sessionId, resumed), heartbeatMs, log, onRegistered, addForNextTurn);
    link.report(idle?.current ?? "live");
    link.start();
    watchContext(sessionId);
    watchUsage(sessionId);
  };

  let sawSessionStart = false;
  let endDetail: string | undefined;
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
        ...(nudges === null
          ? {}
          : { decide: (input) => nudges.decide(input), onEvents: (events) => nudges.events(events) }),
        onHook: (input) => {
          nudges?.hook(input);
          if (input.hook_event_name === "SessionStart") {
            sawSessionStart = true;
            link?.sessionStarted();
          }
          // The CLI's own reason the session ended, for the session's one `session.end` (#54).
          if (input.hook_event_name === "SessionEnd") {
            endDetail = (typeof input.reason === "string" ? input.reason : "other").slice(0, 40);
          }
          if (!hooksRunning) {
            hooksRunning = true;
            log("the CLI's hooks are running");
          }
          typer.hook(input);
          // The hook knows where the session's transcript is.
          if (typeof input.transcript_path === "string" && input.transcript_path !== "") {
            usage?.tally.follow(input.transcript_path);
            contextReader?.follow(input.transcript_path);
          }
          if (input.hook_event_name === "Stop") usage?.schedule.turnEnded();
          // A turn ended: what arrived meanwhile may wake the Agent now.
          waker?.poke();
        },
        ...(discovering === null ? {} : { onSessionId: (sessionId: string) => linkTo(sessionId, discovering.resumed) }),
        ...(adapter.translateHook ? { translate: adapter.translateHook } : {}),
        ...(adapter.hookAnswer ? { answer: adapter.hookAnswer } : {}),
        ...(denyGate === null
          ? {}
          : {
              hold: (input, hook) => {
                const open = approvals.open;
                if (input.hook_event_name !== "PermissionRequest" || open === null) return false;
                denyGate.hold(open.id, hook);
                return true;
              },
            }),
      });
      // Switchboard's MCP tools for this session only (the Tool Capture).
      tools = prepareSessionTools(cwd, repo, env);
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
    const known = new AgentLink(
      client,
      session(plan.sessionId, plan.resumed),
      heartbeatMs,
      log,
      onRegistered,
      addForNextTurn,
    );
    link = known;
    try {
      // A session ID we picked may give an Agent ID another session has: then we pick another.
      const agent = plan.picked ? await known.registerPicked() : await known.register();
      console.error(dim(`switchboard: ${agent.id} is on the Channel for ${repo} at ${config.url}`));
      if (agent.nicknameRefused !== undefined) console.error(`switchboard: ${agent.nicknameRefused}`);
    } catch (error) {
      if (error instanceof ChannelError && error.status !== 0) {
        const refused = agentIdFor(config.person, adapter.cli, known.sessionId);
        console.error(`switchboard: the Channel refused ${refused}: ${error.message}`);
        sessionTools?.dispose();
        await stopHooks();
        return 1;
      }
      console.error(dim(`switchboard: ${(error as Error).message}. Starting anyway; will keep trying.`));
    }
    const { sessionId } = known;
    if (sessionId !== plan.sessionId) args = withSessionId(args, plan.sessionId, sessionId);
    childEnv.SWITCHBOARD_AGENT_ID = agentIdFor(config.person, adapter.cli, sessionId);
    watchContext(sessionId);
    watchUsage(sessionId);
  }

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
  screen = new TerminalScreen(stdout.columns || 80, stdout.rows || 24);
  log(`started ${bin} ${args.join(" ")}`);

  const watch = new IdleWatch(idleAfterMs, (presence) => link?.report(presence));
  idle = watch;
  cliPty.onData((data) => {
    stdout.write(data);
    screen?.write(data, () => screenStream.changed());
    watch.activity();
    typer.output(data);
  });

  let remindedAt = 0;
  const onInput = (data: Buffer) => {
    const { pass, heldBack } = keyboard.local(data.toString("utf8"));
    if (pass !== "") typer.personTyped(pass);
    const holder = keyboard.held;
    if (heldBack && holder?.kind === "key" && Date.now() - remindedAt >= 5000) {
      remindedAt = Date.now();
      notify(`${holder.person} holds the keyboard from the Dashboard: Ctrl+] takes it back`);
    }
  };
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on("data", onInput);
  stdin.resume();
  const onResize = () => {
    cliPty.resize(stdout.columns || 80, stdout.rows || 24);
    screen?.resize(stdout.columns || 80, stdout.rows || 24);
    screenStream.changed();
  };
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

  // A CLI that runs session hooks only once the Person trusts them: notice when
  // none has arrived in time. Codex starts its session (and runs SessionStart) at
  // the first prompt, so the wait starts when the Person first presses Enter.
  // Until a hook arrives, next-turn notices go to the read_channel tool. The Person
  // is told how to trust them once the CLI exits: written while it runs, the hint
  // would paint over the CLI's screen (its approval dialog, its own /hooks review).
  let trustTimer: ReturnType<typeof setTimeout> | undefined;
  const hint = plan.kind === "none" ? undefined : adapter.untrustedHooksHint;
  const watchTrust = () => {
    if (hint === undefined || trustTimer !== undefined || sawSessionStart) return;
    trustTimer = setTimeout(
      () => {
        if (sawSessionStart) return;
        log("no SessionStart hook: the CLI's hooks are not trusted");
        hooksRunning = false;
        sessionTools?.leaveForNextTurn(STANDING_RULE);
        heldForTools();
        discover();
      },
      seconds(env.SWITCHBOARD_HOOK_TRUST_SECONDS, HOOK_TRUST_WAIT_MS),
    );
  };
  entered = watchTrust;

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
  screenStream.stop();
  keyboard.dispose();
  paste.dispose();
  screen?.dispose();
  waker?.stop();
  discovering.abort();
  watch.stop();
  stdin.off("data", onInput);
  stdout.off("resize", onResize);
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
  // The terminal is the wrapper's again: the hooks never ran, so say how to trust them.
  if (hint !== undefined && !hooksRunning) stdout.write(`${dim(`switchboard: ${hint}`)}\n`);
  const visitors = presence.summary();
  if (visitors !== null) stdout.write(`${dim(`switchboard: ${visitors}`)}\n`);
  // Send what the last hooks (turn end, SessionEnd) reported before the session ends.
  await Promise.all([hooks?.drain(END_TIMEOUT_MS), proxy?.drain(END_TIMEOUT_MS)]);
  // Then the last usage reading, once the last turn end has been seen.
  await (usage as { schedule: UsageSchedule } | null)?.schedule.finish(USAGE_END_WAIT_MS);
  await (link as AgentLink | null)?.end(END_TIMEOUT_MS, endDetail);
  await stopHooks();
  sessionTools?.dispose();
  log(`exited ${exitCode}`);
  return exitCode;
}
