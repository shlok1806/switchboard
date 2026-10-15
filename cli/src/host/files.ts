// A Host's files (ADR 0015), all under `<config>/host/`, next to the Person's login:
//
//   host.json       what `switchboard host install` was given: the name, the Channel,
//                   the folders Agents may run in and the loosest permission mode
//   agents.json     the Agents the Host runs, to resume them after a crash or a reboot
//                   (session ID, folder, Nickname, model and mode; never the brief)
//   host.pid        the running supervisor's process ID
//   host.log        the supervisor's own log, capped at 5 MB with one rotation
//   launchd.log     what launchd caught on the supervisor's stdout and stderr: only
//                   what it said before host.log opened, such as why it would not start
//   logs/<agent>.log  each Agent's raw terminal output, capped at 20 MB with one rotation

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, PermissionMode } from "../../../shared/src/index";
import { isPermissionMode } from "../../../shared/src/index";
import { configDir } from "../config";

export interface HostSettings {
  name: string;
  /** The Channel's repo, `owner/name`, that the Host attaches to. */
  repo: string;
  roots: string[];
  maxPermissionMode: PermissionMode;
}

/** One Agent the Host runs, as `agents.json` keeps it. */
export interface HostedAgent {
  agent: AgentId;
  sessionId: string;
  cwd: string;
  nickname?: string;
  model?: string;
  permissionMode: PermissionMode;
}

/** An Agent's log is cut over to `<agent>.log.1` past this size. */
export const AGENT_LOG_MAX_BYTES = 20 * 1024 * 1024;

export function hostDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "host");
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hostDir(env), "host.json");
}

export function pidPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hostDir(env), "host.pid");
}

export function hostLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hostDir(env), "host.log");
}

export function launchdLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hostDir(env), "launchd.log");
}

/** The supervisor's own log is cut over to `host.log.1` past this size. */
export const HOST_LOG_MAX_BYTES = 5 * 1024 * 1024;

export function agentsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hostDir(env), "agents.json");
}

/** Where Agent `agent`'s terminal output goes. Agent IDs contain "/", so they are joined with "-". */
export function agentLogPath(agent: AgentId, env: NodeJS.ProcessEnv = process.env): string {
  return join(hostDir(env), "logs", `${agent.replaceAll("/", "-")}.log`);
}

/** Writes `text` whole or not at all: to a temporary file, then renamed over `path`. */
function writePrivate(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readSettings(env: NodeJS.ProcessEnv = process.env): HostSettings | null {
  let parsed: Partial<HostSettings>;
  try {
    parsed = JSON.parse(readFileSync(settingsPath(env), "utf8")) as Partial<HostSettings>;
  } catch {
    return null;
  }
  const { name, repo, roots, maxPermissionMode } = parsed;
  if (typeof name !== "string" || typeof repo !== "string" || !Array.isArray(roots)) return null;
  return {
    name,
    repo,
    roots: roots.filter((r): r is string => typeof r === "string"),
    maxPermissionMode: isPermissionMode(maxPermissionMode) ? maxPermissionMode : "default",
  };
}

export function writeSettings(settings: HostSettings, env: NodeJS.ProcessEnv = process.env): void {
  writePrivate(settingsPath(env), `${JSON.stringify(settings, null, 2)}\n`);
}

/** One entry of `agents.json`, if it has every field with its type. */
function hostedAgent(value: unknown): HostedAgent | null {
  if (typeof value !== "object" || value === null) return null;
  const { agent, sessionId, cwd, nickname, model, permissionMode } = value as Record<string, unknown>;
  if (typeof agent !== "string" || agent.split("/").length !== 3) return null;
  if (typeof sessionId !== "string" || typeof cwd !== "string" || !isPermissionMode(permissionMode)) return null;
  if ((nickname !== undefined && typeof nickname !== "string") || (model !== undefined && typeof model !== "string")) {
    return null;
  }
  return {
    agent: agent as AgentId,
    sessionId,
    cwd,
    ...(nickname === undefined ? {} : { nickname }),
    ...(model === undefined ? {} : { model }),
    permissionMode,
  };
}

/**
 * The Agents the Host runs. No file means none. A file that cannot be read throws
 * rather than reading as none, so it is never overwritten with fewer Agents.
 */
export function readAgents(env: NodeJS.ProcessEnv = process.env): HostedAgent[] {
  let text: string;
  try {
    text = readFileSync(agentsPath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${agentsPath(env)} is not a list`);
  return parsed.map(hostedAgent).filter((a): a is HostedAgent => a !== null);
}

export function writeAgents(agents: readonly HostedAgent[], env: NodeJS.ProcessEnv = process.env): void {
  writePrivate(agentsPath(env), `${JSON.stringify(agents, null, 2)}\n`);
}

/** Appends to a log, cutting it over to `<path>.1` once it passes `max` bytes. */
export class CappedLog {
  private size: number;

  constructor(
    private readonly path: string,
    private readonly max = AGENT_LOG_MAX_BYTES,
  ) {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    try {
      this.size = statSync(path).size;
    } catch {
      this.size = 0;
    }
  }

  append(data: string): void {
    const bytes = Buffer.byteLength(data);
    try {
      if (this.size > 0 && this.size + bytes > this.max) {
        renameSync(this.path, `${this.path}.1`);
        this.size = 0;
      }
      appendFileSync(this.path, data, { mode: 0o600 });
      this.size += bytes;
    } catch {
      // A log must never stop an Agent.
    }
  }
}
