// Hosts (ADR 0015): a Person's machine that starts and stops Agents for the Channel
// with no window. The Host registers itself, keeps a WebSocket open to the Channel
// while it runs (`/api/stream?host=<name>`), and starts `switchboard run <cli>` in a
// pty of its own when the Channel asks.
//
//   GET    /api/hosts               every Host, with whether it is Live
//   POST   /api/hosts               register (or update) one of the caller's Hosts
//   DELETE /api/hosts/:name         remove one of the caller's Hosts
//   POST   /api/agents/spawn        start an Agent on one of the caller's Hosts
//   POST   /api/agents/:id/stop     stop an Agent one of the caller's Hosts runs
//
// Every route takes a Person's session. An Agent token is refused until a Person
// grants an Agent that authority (the roles ADR that supersedes ADR 0005).

import type { Agent, AgentId, Cli, PersonName } from "./domain";

/** `<person>/<name>`, such as `shlok1806/studio`. */
export type HostId = `${string}/${string}`;

/** A Host's name: what `hostname -s` gives, lower-cased. */
export const HOST_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The Host ID of `person`'s Host `name`. */
export function hostIdFor(person: PersonName, name: string): HostId {
  return `${person}/${name}`;
}

/**
 * Claude Code's permission modes, strictest first. A Host starts Agents in at most the
 * mode it was installed with (`--max-permission-mode`), and refuses a looser one.
 */
export const PERMISSION_MODES = ["plan", "default", "acceptEdits", "auto", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The mode a Host allows when it was installed without `--max-permission-mode`, and a spawn's default. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode);
}

/** Whether `mode` is no looser than `max`. */
export function permissionModeWithin(mode: PermissionMode, max: PermissionMode): boolean {
  return PERMISSION_MODES.indexOf(mode) <= PERMISSION_MODES.indexOf(max);
}

/** How many Agents Hosts may run at once on one Channel, unless HOST_AGENTS_LIVE_CAP says otherwise. */
export const DEFAULT_HOST_AGENTS_LIVE_CAP = 20;

/** At most this many `--root` folders per Host. */
export const MAX_HOST_ROOTS = 20;
/** The longest folder path a Host or a spawn may name. */
export const MAX_PATH_LENGTH = 1024;
/** The longest brief, the session's first prompt: the same as a Directive. */
export const MAX_BRIEF_LENGTH = 4000;

export interface Host {
  id: HostId;
  person: PersonName;
  name: string;
  /** The folders Agents may start in, and under. Absolute paths. */
  roots: string[];
  /** The loosest permission mode the Host starts an Agent in. */
  maxPermissionMode: PermissionMode;
  /** Whether the Host's socket is attached now. Only a Live Host can start or stop Agents. */
  live: boolean;
  registeredAt: string;
  /** When its socket last attached. */
  lastSeenAt: string;
}

/** True when `cwd` is one of `roots` or inside one. Paths are absolute, with no `..` or `.` segments. */
export function underRoots(cwd: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const base = root.replace(/\/+$/, "");
    return cwd === base || cwd.startsWith(`${base}/`) || base === "";
  });
}

/** An absolute path with no `.` or `..` segments, or null when it is not one. */
export function cleanAbsolutePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH) return null;
  if (!value.startsWith("/") || value.includes("\0")) return null;
  const segments = value.split("/");
  if (segments.some((s) => s === "." || s === "..")) return null;
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

/** `POST /api/hosts`. */
export interface RegisterHostRequest {
  name: string;
  roots: string[];
  maxPermissionMode?: PermissionMode;
}

/** `POST /api/hosts` answers with the Host. */
export interface HostResponse {
  ok: true;
  host: Host;
}

/** `GET /api/hosts`. */
export interface HostsResponse {
  hosts: Host[];
  /** The Channel's cap on Agents Hosts run, and how many run or are starting now. */
  cap: number;
  running: number;
}

/** `POST /api/agents/spawn`. */
export interface SpawnAgentRequest {
  /** The Host's name, one of the caller's own. Omitted: their most recently seen Live Host. */
  host?: string;
  cli: Cli;
  /** Where the Agent runs: under one of the Host's roots. */
  cwd: string;
  nickname?: string;
  model?: string;
  /** The session's first prompt, as the requesting Person's words. */
  brief?: string;
  permissionMode?: PermissionMode;
}

/**
 * `POST /api/agents/spawn` answers 201 with the Agent once its wrapper registers, or
 * 202 without it when the Host has not answered yet: `spawn` is the `agent.spawn`
 * Event's ID, and `agent.spawned` or `agent.spawn.failed` names it later.
 */
export interface SpawnAgentResponse {
  ok: true;
  spawn: string;
  host: HostId;
  agent?: Agent;
}

/** `POST /api/agents/:id/stop`. */
export interface StopAgentResponse {
  ok: true;
  agent: AgentId;
  host: HostId;
}

/** The Channel asks a Host to start an Agent. `spawn` names the request. */
export interface HostSpawnMessage {
  type: "host.spawn";
  spawn: string;
  cli: Cli;
  cwd: string;
  nickname?: string;
  model?: string;
  brief?: string;
  permissionMode: PermissionMode;
  /** The Person who asked. */
  by: PersonName;
}

/** The Channel asks a Host to stop an Agent it runs. */
export interface HostStopMessage {
  type: "host.stop";
  agent: AgentId;
}

/**
 * A Host could not start what spawn `spawn` asked for. A spawn that worked needs no
 * answer: the new wrapper registers with `spawn` itself.
 */
export interface HostSpawnFailedFrame {
  type: "host.spawn.failed";
  spawn: string;
  reason: string;
}

/** The longest reason a Host gives for a failed spawn. */
export const MAX_SPAWN_FAILURE_LENGTH = 500;
