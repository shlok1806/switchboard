// `switchboard host run`: the Host's supervisor (ADR 0015). A plain Node process with
// no window: launchd starts it, or a test runs it directly. It keeps a WebSocket to
// the Channel open as its Person (`/api/stream?host=<name>`), and for each spawn the
// Channel sends it runs `switchboard run claude` in a pty of its own, in the folder
// asked for. Nothing is ever typed into anything the Person uses.
//
// - A spawn is checked here too: the folder must be under one of the Host's roots
//   and the mode no looser than its max, whatever the Channel says.
// - A spawn that works needs no answer: the wrapper registers with the spawn itself
//   once Claude Code's session has started (its SessionStart hook), and the Channel
//   says so with `host.spawned`. One that cannot start (a folder Claude Code has not
//   trusted, a wrapper that ends first) is answered with `host.spawn.failed`.
// - A wrapper that ends without being asked to (a crash) is resumed, at most
//   `MAX_RESUMES` times in `RESUME_WINDOW_MS`. A wrapper that ends with 0 was ended
//   by its session, not a crash. When the supervisor starts, it resumes every Agent
//   it was running.
// - A stop sends SIGTERM to the wrapper, which ends the session on the Channel, then
//   SIGKILL after `STOP_GRACE_MS`.
// - Who asks is checked here too (ADR 0028): every spawn, stop, pause and resume names
//   the requesting Person, and this machine's `--allow` list decides, never the Channel's copy.
// - A pause ends the wrapper like a stop, but keeps the Agent in `agents.json` marked
//   paused, and the Channel is told with `host.paused`. A paused Agent is never resumed
//   by the Host itself, not after a crash or a restart: only a `host.resume` brings it
//   back, with `--resume <session-id>`, once the local limits pass again.

import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import * as pty from "@lydell/node-pty";
import type { AgentId, HostSpawnedMessage } from "../../../shared/src/index";
import {
  agentIdFor,
  channelApiBase,
  directiveHeading,
  LIVE_PING,
  LIVE_PONG,
  MAX_SPAWN_FAILURE_LENGTH,
} from "../../../shared/src/index";
import { ChannelClient, targetOf } from "../channel-client";
import type { Config } from "../config";
import { cachedAttachList } from "../terminal/attach-keys";
import { checkAllowChange } from "./allow";
import { checkControl, checkFolderAndMode, checkSpawn, type LocalLimits, resolveRoots } from "./check";
import {
  agentLogPath,
  agentsPath,
  CappedLog,
  type HostedAgent,
  type HostSettings,
  readAgents,
  writeAgents,
  writeSettings,
} from "./files";

export const MAX_RESUMES = 3;
export const RESUME_WINDOW_MS = 10 * 60_000;
export const STOP_GRACE_MS = 10_000;
/** A spawn the wrapper has not answered by then (a resume: not registered) is ended, and failed. */
export const REGISTER_TIMEOUT_MS = 90_000;
/**
 * How long a resumed session is watched for the trust dialog. A spawn's is watched
 * until the Channel says the session started; after that the words could be the
 * Agent's own output.
 */
export const RESUME_TRUST_WATCH_MS = 30_000;

/** The pty each Agent runs in: wide, so its log reads well. */
const COLUMNS = 200;
const ROWS = 50;

/** What the wrapper prints once the Channel has registered its Agent. */
const REGISTERED = " is on the Channel for ";
/**
 * Claude Code's folder trust dialog, with spacing and escapes removed (2.1.300:
 * "Quick safety check: Is this a project you created or one you trust?").
 */
const TRUST_DIALOG = ["itrustthisfolder", "isthisaprojectyoucreatedoroneyoutrust"];
export const UNTRUSTED_REASON = "the folder is not trusted: run claude there once";

export interface SupervisorOptions {
  config: Config;
  settings: HostSettings;
  /** `<node> <cli>`: how to run `switchboard run claude`. */
  node: string;
  cli: string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

/** One running wrapper. */
interface Running {
  entry: HostedAgent;
  term: pty.IPty;
  /** Asked to stop or pause: its exit is not a crash. */
  stopping: boolean;
  /** Asked to pause (ADR 0028): its exit keeps the Agent, paused. */
  pausing: boolean;
  /** Asked to stop (rather than ended by itself, or by a pause). */
  stopRequested: boolean;
  /** Started by a resume of a paused Agent, for the Person `resumedBy`: if it never registers, the Agent stays paused. */
  resumedBy?: string;
  registered: boolean;
  /** The spawn it answers, until the Channel says the session started. */
  spawn?: string;
  /** Whether its output is still checked for Claude Code's folder trust dialog. */
  watchingTrust: boolean;
  /** The last of its output, for a failure's reason. */
  tail: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** Terminal escapes: OSC, CSI, charset and keypad sequences. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing escapes is the point.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;

/** Terminal output as text: escapes removed. */
export function plainText(data: string): string {
  return data.replace(ESCAPES, "");
}

/** Whether `screen` (plain text) shows Claude Code's folder trust dialog. */
export function showsTrustDialog(screen: string): boolean {
  const squeezed = screen.toLowerCase().replace(/[^a-z]/g, "");
  // Both of the dialog's lines, so a brief or a transcript quoting one is not taken for it.
  return TRUST_DIALOG.every((words) => squeezed.includes(words));
}

/** The session's first prompt: the brief, labelled as the requesting Person's words, or their lead's (ADR 0018). */
export function briefPrompt(by: string, host: string, brief: string, lead?: AgentId): string {
  return [
    `${directiveHeading(by, lead)}, ${lead === undefined ? "who" : "which"} started this Agent on ${host}:`,
    ...brief.split("\n").map((line) => `> ${line}`),
  ].join("\n");
}

/**
 * The arguments `switchboard run claude` gets for an Agent: a new session, or `--resume`.
 * `from` names the Agent a new session continues (ADR 0024); a resume has its brief already.
 */
export function wrapperArgs(entry: HostedAgent, resume: boolean, prompt?: string, from?: AgentId): string[] {
  return [
    "run",
    "claude",
    ...(entry.nickname === undefined ? [] : ["--nickname", entry.nickname]),
    ...(from === undefined || resume ? [] : ["--from", from]),
    ...(entry.model === undefined ? [] : ["--model", entry.model]),
    // Always given, so the Person's own default mode never applies to a Host's Agent.
    "--permission-mode",
    entry.permissionMode,
    ...(resume ? ["--resume", entry.sessionId] : ["--session-id", entry.sessionId]),
    ...(prompt === undefined ? [] : ["--", prompt]),
  ];
}

export class HostSupervisor {
  private readonly running = new Map<AgentId, Running>();
  /** Every Agent the Host runs or will resume: what `agents.json` holds, kept here and written whole. */
  private readonly known = new Map<AgentId, HostedAgent>();
  /** When each Agent was resumed after a crash, recent first. */
  private readonly resumes = new Map<AgentId, number[]>();
  private socket: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private pending: ReturnType<typeof setTimeout> | undefined;
  /** This machine's own limits, from `switchboard host install`: never the Channel's copy (ADR 0017). */
  private limits: LocalLimits;
  /** The settings as they are now: a signed change from the Dashboard rewrites the allow-list (ADR 0028). */
  private settings: HostSettings;
  private readonly attachList = cachedAttachList();
  private readonly allowSeqs = new Map<string, number>();
  private readonly hostId: string;

  constructor(private readonly options: SupervisorOptions) {
    // Compared after resolving links, so a root reached through a symlink still counts.
    this.limits = {
      roots: resolveRoots(options.settings.roots),
      maxPermissionMode: options.settings.maxPermissionMode,
      maxAgents: options.settings.maxAgents,
      owner: options.config.person,
      allow: options.settings.allow,
      allowChannel: options.settings.allowChannel,
    };
    this.hostId = `${options.config.person}/${options.settings.name}`;
    this.settings = options.settings;
  }

  /** Resumes the Agents it ran before, and attaches to the Channel. */
  start(): void {
    let saved: HostedAgent[] = [];
    try {
      saved = readAgents(this.options.env);
    } catch (error) {
      // Set aside, not overwritten: the Person can still see which Agents it held.
      const aside = `${agentsPath(this.options.env)}.unreadable-${Date.now()}`;
      this.options.log(`cannot read the Agents to resume (${(error as Error).message}); moved it to ${aside}`);
      try {
        renameSync(agentsPath(this.options.env), aside);
      } catch {
        // Gone already.
      }
    }
    for (const entry of saved) this.known.set(entry.agent, entry);
    for (const entry of saved) {
      // A Paused Agent stays paused through a restart: only a resume request brings it back.
      if (entry.paused) {
        this.options.log(`${entry.agent} is paused; leaving it`);
        continue;
      }
      this.options.log(`resuming ${entry.agent} in ${entry.cwd}`);
      this.launch(entry, { resume: true });
    }
    this.connect();
  }

  /** Detaches, and ends every wrapper. They are resumed when the supervisor starts again. */
  async shutdown(): Promise<void> {
    this.closed = true;
    clearTimeout(this.pending);
    this.socket?.close();
    const exits = [...this.running.values()].map(
      (r) =>
        new Promise<void>((resolve) => {
          r.stopping = true;
          r.term.onExit(() => resolve());
          this.signal(r, "SIGTERM");
          setTimeout(() => {
            this.signal(r, "SIGKILL");
            resolve();
          }, STOP_GRACE_MS).unref();
        }),
    );
    await Promise.all(exits);
  }

  /** The Agents running now. */
  agents(): HostedAgent[] {
    return [...this.running.values()].map((r) => r.entry);
  }

  /** The Agents paused here. */
  pausedAgents(): HostedAgent[] {
    return [...this.known.values()].filter((a) => a.paused);
  }

  private connect(): void {
    if (this.closed) return;
    this.pending = undefined;
    const { config, settings } = this.options;
    const query = new URLSearchParams({ token: config.session, host: settings.name });
    const base = `${config.url.replace(/\/+$/, "")}${channelApiBase(settings.repo)}`;
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/stream?${query}`);
    this.socket = ws;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    ws.addEventListener("open", () => {
      this.retry = 0;
      this.options.log(`attached to ${settings.repo} at ${config.url} as ${this.hostId}`);
      // A pause whose confirmation went out while detached: say so again (the Channel ignores repeats).
      for (const paused of this.pausedAgents()) this.send({ type: "host.paused", agent: paused.agent });
      keepalive = setInterval(() => ws.send(LIVE_PING), 30_000);
    });
    ws.addEventListener("message", (event) => {
      if (event.data === LIVE_PONG) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      // Valid JSON need not be an object: null, a number or a list is no frame.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      const frame = parsed as { type?: unknown } & Record<string, unknown>;
      const type = typeof frame.type === "string" ? frame.type.slice(0, 40) : "untyped";
      // Whatever a frame holds, it must never take the supervisor, and every Agent, down.
      try {
        if (frame.type === "host.spawn") this.spawn(frame);
        else if (frame.type === "host.spawned" && typeof frame.spawn === "string") {
          this.spawned(frame as unknown as HostSpawnedMessage);
        } else if (frame.type === "host.stop") this.control("stop", frame);
        else if (frame.type === "host.pause") this.control("pause", frame);
        else if (frame.type === "host.resume") this.control("resume", frame);
        else if (frame.type === "host.allow") void this.changeAllow(frame);
      } catch (error) {
        this.options.log(
          `could not handle a ${type} frame: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    });
    ws.addEventListener("close", (event) => {
      clearInterval(keepalive);
      if (this.closed || this.socket !== ws) return;
      this.retry += 1;
      const delay = Math.min(60_000, 1000 * 2 ** this.retry);
      this.options.log(`detached from the Channel (${event.code} ${event.reason}); trying again in ${delay / 1000} s`);
      this.pending = setTimeout(() => this.connect(), delay);
    });
    ws.addEventListener("error", () => {
      // "close" follows and reconnects.
    });
  }

  private send(frame: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private fail(spawn: string, reason: string): void {
    this.options.log(`spawn ${spawn} failed: ${reason}`);
    this.send({ type: "host.spawn.failed", spawn, reason: reason.slice(0, MAX_SPAWN_FAILURE_LENGTH) });
  }

  /** Tells the Channel that `action` for `agent`, asked by `by`, was refused or could not be done. */
  private refuse(action: "stop" | "pause" | "resume", agent: AgentId | null, by: string, reason: string): void {
    this.options.log(`${action} ${agent ?? "(no Agent)"} for ${by} refused: ${reason}`);
    if (agent === null) return;
    this.send({ type: "host.control.failed", action, agent, by, reason: reason.slice(0, MAX_SPAWN_FAILURE_LENGTH) });
  }

  /**
   * A signed allow-list change from the owner's Dashboard (ADR 0028): applied to this
   * machine's own file only for a key attach.json trusts for this Host's Person, then
   * republished to the Channel. Answered either way.
   */
  private async changeAllow(frame: Record<string, unknown>): Promise<void> {
    const id = typeof frame.id === "string" ? frame.id.slice(0, 100) : null;
    if (id === null) return;
    const answer = (ok: boolean, reason?: string) => {
      if (!ok) this.options.log(`allow-list change refused: ${reason}`);
      this.send({ type: "host.allow.result", id, ok, ...(reason === undefined ? {} : { reason }) });
    };
    try {
      const checked = await checkAllowChange(frame, {
        owner: this.options.config.person,
        host: this.settings.name,
        repo: this.settings.repo,
        list: await this.attachList(),
        now: Date.now(),
        seqs: this.allowSeqs,
      });
      if (!checked.ok) return answer(false, checked.reason);
      this.settings = { ...this.settings, allow: checked.allow, allowChannel: checked.allowChannel };
      writeSettings(this.settings, this.options.env);
      this.limits = { ...this.limits, allow: checked.allow, allowChannel: checked.allowChannel };
      this.options.log(
        `allow-list changed by key ${checked.fingerprint}: ${checked.allowChannel ? "the whole Channel" : checked.allow.join(", ") || "only the owner"}`,
      );
      // Tell the Channel what this machine now allows, from this machine's file.
      const { config } = this.options;
      await new ChannelClient(targetOf(config, this.settings.repo)).request("/api/hosts", {
        method: "POST",
        body: JSON.stringify({
          name: this.settings.name,
          roots: this.settings.roots,
          maxPermissionMode: this.settings.maxPermissionMode,
          allow: this.settings.allow,
          allowChannel: this.settings.allowChannel,
        }),
      });
      answer(true);
    } catch (error) {
      answer(false, `could not apply it: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  /** A stop, pause or resume from the Channel: checked against this Host's own allow-list first. */
  private control(action: "stop" | "pause" | "resume", frame: Record<string, unknown>): void {
    const checked = checkControl(frame, this.limits);
    if (!checked.ok) {
      this.refuse(action, checked.agent, checked.by, checked.reason);
      return;
    }
    const { agent, by } = checked;
    this.options.log(`${action} ${agent} asked by ${by}`);
    if (action === "stop") this.stop(agent, by);
    else if (action === "pause") this.pause(agent, by);
    else this.resume(agent, by);
  }

  /** Starts what spawn `frame` asks for, once this Host's own limits allow it, or answers why not. */
  private spawn(frame: Record<string, unknown>): void {
    const checked = checkSpawn(frame, this.limits);
    if (!checked.ok) {
      if (checked.spawn === null) this.options.log(`ignored a spawn request: ${checked.reason}`);
      else this.fail(checked.spawn, checked.reason);
      return;
    }
    const { request } = checked;
    // This machine's own cap, whatever the Channel's allows (ADR 0017).
    if (this.running.size >= this.limits.maxAgents) {
      const most = this.limits.maxAgents;
      this.fail(request.spawn, `this Host runs at most ${most} Agent${most === 1 ? "" : "s"} at once`);
      return;
    }
    const sessionId = randomUUID();
    const entry: HostedAgent = {
      agent: agentIdFor(this.options.config.person, request.cli, sessionId),
      sessionId,
      cwd: request.cwd,
      ...(request.nickname === undefined ? {} : { nickname: request.nickname }),
      ...(request.model === undefined ? {} : { model: request.model }),
      permissionMode: request.permissionMode,
    };
    this.options.log(`spawn ${request.spawn} from ${request.lead ?? request.by}: ${entry.agent} in ${entry.cwd}`);
    this.launch(entry, {
      resume: false,
      spawn: request.spawn,
      ...(request.from === undefined ? {} : { from: request.from }),
      ...(request.brief === undefined
        ? {}
        : { prompt: briefPrompt(request.by, this.hostId, request.brief, request.lead) }),
    });
  }

  /** The Channel has spawn `message.spawn`'s answer: the session started. */
  private spawned(message: HostSpawnedMessage): void {
    const running = [...this.running.values()].find((r) => r.spawn === message.spawn);
    if (running === undefined) return;
    running.spawn = undefined;
    running.watchingTrust = false;
    // The timer stays armed until the wrapper says it registered: the Channel's word alone does not end it.
    if (running.registered) clearTimeout(running.timer);
    this.options.log(`${running.entry.agent} started its session`);
  }

  /** Asks the wrapper of Agent `agent` to end its session, then kills it if it does not. A paused Agent has no process: it is forgotten. */
  private stop(agent: AgentId, by: string): void {
    const running = this.running.get(agent);
    if (running === undefined) {
      if (this.known.get(agent)?.paused) {
        this.options.log(`${agent} was paused; it is not kept any more`);
        this.forget(agent);
      } else {
        this.refuse("stop", agent, by, "this Host does not run it");
      }
      return;
    }
    running.stopRequested = true;
    this.end(running);
  }

  /** Ends a wrapper: SIGTERM, then SIGKILL if it does not go. */
  private end(running: Running): void {
    const { agent } = running.entry;
    running.stopping = true;
    this.signal(running, "SIGTERM");
    setTimeout(() => {
      if (this.running.get(agent) === running) this.signal(running, "SIGKILL");
    }, STOP_GRACE_MS).unref();
  }

  /** Ends Agent `agent`'s process and keeps its session: marked paused first, so no restart can resume it. */
  private pause(agent: AgentId, by: string): void {
    const running = this.running.get(agent);
    const known = this.known.get(agent);
    if (running === undefined) {
      if (known?.paused) this.send({ type: "host.paused", agent });
      else this.refuse("pause", agent, by, "this Host does not run it");
      return;
    }
    if (running.spawn !== undefined || !running.registered) {
      this.refuse("pause", agent, by, "it is still starting; pause it once it is on the Channel");
      return;
    }
    // Written before the process ends, so a Host that dies meanwhile does not bring it back.
    this.remember({ ...running.entry, paused: true });
    running.pausing = true;
    this.end(running);
  }

  /** Relaunches paused Agent `agent` from its saved session, once this Host's own limits allow it again. */
  private resume(agent: AgentId, by: string): void {
    const entry = this.known.get(agent);
    if (entry === undefined || !entry.paused) {
      this.refuse(
        "resume",
        agent,
        by,
        this.running.has(agent) ? "it is running already" : "this Host has not paused it",
      );
      return;
    }
    if (this.running.size >= this.limits.maxAgents) {
      const most = this.limits.maxAgents;
      this.refuse("resume", agent, by, `this Host runs at most ${most} Agent${most === 1 ? "" : "s"} at once`);
      return;
    }
    const allowed = checkFolderAndMode(entry.cwd, entry.permissionMode, this.limits);
    if (!allowed.ok) {
      this.refuse("resume", agent, by, allowed.reason);
      return;
    }
    const { paused: _, ...running } = entry;
    this.launch(running, { resume: true, resumedBy: by });
  }

  private signal(running: Running, signal: NodeJS.Signals): void {
    try {
      running.term.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private launch(
    entry: HostedAgent,
    how: { resume: boolean; spawn?: string; prompt?: string; from?: AgentId; resumedBy?: string },
  ): void {
    const { env, settings } = this.options;
    // A resume is checked again: the folder or the Host's own limits may have changed since.
    const allowed = checkFolderAndMode(entry.cwd, entry.permissionMode, this.limits);
    if (!allowed.ok) {
      this.options.log(`not starting ${entry.agent}: ${allowed.reason}`);
      this.forget(entry.agent);
      if (how.spawn !== undefined) this.fail(how.spawn, allowed.reason);
      return;
    }
    const log = new CappedLog(agentLogPath(entry.agent, env));
    log.append(`\n[host] ${new Date().toISOString()} ${how.resume ? "resuming" : "starting"} ${entry.agent}\n`);
    const term = pty.spawn(
      this.options.node,
      [this.options.cli, ...wrapperArgs(entry, how.resume, how.prompt, how.from)],
      {
        name: "xterm-256color",
        cols: COLUMNS,
        rows: ROWS,
        // The folder as just resolved and allowed, not as recorded: a link may have changed since.
        cwd: allowed.cwd,
        env: {
          ...(env as Record<string, string>),
          SWITCHBOARD_HOST: settings.name,
          ...(how.spawn === undefined ? {} : { SWITCHBOARD_SPAWN: how.spawn }),
        },
      },
    );
    const running: Running = {
      entry,
      term,
      stopping: false,
      pausing: false,
      stopRequested: false,
      ...(how.resumedBy === undefined ? {} : { resumedBy: how.resumedBy }),
      registered: false,
      ...(how.spawn === undefined ? {} : { spawn: how.spawn }),
      watchingTrust: true,
      tail: "",
    };
    this.running.set(entry.agent, running);
    this.remember(entry);
    running.timer = setTimeout(() => {
      if (running.spawn === undefined && running.registered) return;
      if (running.spawn !== undefined) {
        // The terminal's last line stays in the Host's log: on the Channel, everyone would see it.
        this.options.log(`${entry.agent} did not start: ${lastLine(running.tail)}`);
        this.fail(
          running.spawn,
          `its session did not start within ${REGISTER_TIMEOUT_MS / 1000} s; see the Host's log`,
        );
        running.spawn = undefined;
      }
      running.stopping = true;
      this.signal(running, "SIGTERM");
    }, REGISTER_TIMEOUT_MS);
    running.timer.unref();
    if (how.spawn === undefined) {
      setTimeout(() => {
        running.watchingTrust = false;
      }, RESUME_TRUST_WATCH_MS).unref();
    }

    term.onData((data) => {
      log.append(data);
      running.tail = (running.tail + plainText(data)).slice(-4000);
      if (!running.registered && running.tail.includes(REGISTERED)) {
        running.registered = true;
        this.options.log(`${entry.agent} is on the Channel`);
      }
      // The wrapper registers before Claude Code starts, so the dialog comes after it.
      if (running.watchingTrust && showsTrustDialog(running.tail)) {
        running.watchingTrust = false;
        // Never answered for the Person: the spawn fails and the folder stays untrusted.
        if (running.spawn !== undefined) this.fail(running.spawn, UNTRUSTED_REASON);
        else this.options.log(`${entry.agent}: ${UNTRUSTED_REASON}`);
        running.spawn = undefined;
        running.stopping = true;
        this.signal(running, "SIGTERM");
      }
    });
    term.onExit(({ exitCode, signal }) => {
      clearTimeout(running.timer);
      if (this.running.get(entry.agent) === running) this.running.delete(entry.agent);
      log.append(`\n[host] ${new Date().toISOString()} exited ${exitCode}${signal ? ` signal ${signal}` : ""}\n`);
      if (this.closed) return;
      if (running.pausing) {
        this.options.log(`${entry.agent} paused`);
        this.send({ type: "host.paused", agent: entry.agent });
        return;
      }
      if (running.resumedBy !== undefined && !running.registered && !running.stopRequested) {
        // A resume that never reached the Channel: keep it paused, and say why.
        const reason = `its session did not resume (exit ${exitCode}): ${lastLine(running.tail)}`;
        this.remember({ ...entry, paused: true });
        this.refuse("resume", entry.agent, running.resumedBy, reason);
        return;
      }
      const unanswered = running.spawn !== undefined;
      if (running.spawn !== undefined) {
        this.options.log(`${entry.agent} exited before its session started: ${lastLine(running.tail)}`);
        this.fail(running.spawn, `switchboard run exited (${exitCode}) before the session started; see the Host's log`);
      }
      // node-pty reports a kill -9 (say, the OOM killer) as exit code 0 with the signal.
      const clean = exitCode === 0 && !signal;
      if (unanswered || running.stopping || !running.registered || clean) {
        this.options.log(`${entry.agent} ended (${exitCode})`);
        this.forget(entry.agent);
        return;
      }
      this.crashed(entry, signal ? `signal ${signal}` : `${exitCode}`);
    });
  }

  /** A wrapper ended on its own: resumed, unless it already was too often lately. */
  private crashed(entry: HostedAgent, exitCode: string): void {
    const now = Date.now();
    const recent = (this.resumes.get(entry.agent) ?? []).filter((at) => now - at < RESUME_WINDOW_MS);
    if (recent.length >= MAX_RESUMES) {
      this.options.log(
        `${entry.agent} crashed (${exitCode}) after ${MAX_RESUMES} resumes in ${RESUME_WINDOW_MS / 60_000} minutes; giving up`,
      );
      this.resumes.delete(entry.agent);
      this.forget(entry.agent);
      return;
    }
    this.resumes.set(entry.agent, [now, ...recent]);
    this.options.log(`${entry.agent} crashed (${exitCode}); resuming it`);
    this.launch(entry, { resume: true });
  }

  private remember(entry: HostedAgent): void {
    this.known.set(entry.agent, entry);
    this.save();
  }

  private forget(agent: AgentId): void {
    this.known.delete(agent);
    this.save();
  }

  private save(): void {
    try {
      writeAgents([...this.known.values()], this.options.env);
    } catch (error) {
      this.options.log(`could not save the Agents to resume: ${(error as Error).message}`);
    }
  }
}

function lastLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1) ?? "no output"
  );
}
