/**
 * The Agent part of the Channel API: how the laptop wrapper registers an Agent,
 * reports its Presence with heartbeats and ends its session. Terms follow CONTEXT.md.
 */
import type { Agent, AgentId, Cli, PersonName } from "./domain";

/** The short CLI name used in an Agent ID, such as `claude` in `shlok/claude/7f3a`. */
export const CLI_SHORT_NAMES: Record<Cli, string> = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
};

export const CLIS = Object.keys(CLI_SHORT_NAMES) as Cli[];

/** How many leading characters of the session ID go into the Agent ID. */
export const AGENT_ID_SESSION_CHARS = 4;

/**
 * A CLI session ID: letters, digits and "-", 4 to 128 characters.
 * Claude Code uses UUIDs.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{3,127}$/;

/** The longest Nickname the Channel accepts, in characters. */
export const MAX_NICKNAME_LENGTH = 40;

/** The Agent ID for a session: `<person>/<cli short name>/<first 4 of the session id>`. */
export function agentIdFor(person: PersonName, cli: Cli, sessionId: string): AgentId {
  return `${person}/${CLI_SHORT_NAMES[cli]}/${sessionId.slice(0, AGENT_ID_SESSION_CHARS).toLowerCase()}`;
}

/** The path of one Agent's resource. Agent IDs contain "/", so the ID is URL-encoded. */
export function agentPath(id: AgentId): string {
  return `/api/agents/${encodeURIComponent(id)}`;
}

/** Presence the wrapper can report. Only the Channel decides Gone. */
export type ReportedPresence = "live" | "idle";

/**
 * `POST /api/agents`: register an Agent for a session, or re-register it on resume.
 * The Channel derives the Agent ID from the authenticated Person, `cli` and `sessionId`,
 * so the same session always gets the same Agent ID. It answers 409 when a different
 * session of the same Person already holds that Agent ID.
 */
export interface RegisterAgentRequest {
  cli: Cli;
  sessionId: string;
  /** True when the session was resumed rather than started fresh. */
  resumed: boolean;
  /** Working directory of the session. */
  cwd: string;
  /** Sets the Nickname. Omit to keep the current one; null clears it. */
  nickname?: string | null;
}

/** `POST /api/agents` and `POST /api/agents/:id/heartbeat` answer with the Agent. */
export interface AgentResponse {
  ok: true;
  agent: Agent;
}

/**
 * `POST /api/agents/:id/heartbeat`: the Agent is still running. Sent about every
 * `HEARTBEAT_INTERVAL_MS` and whenever the reported Presence changes. A Gone Agent
 * that heartbeats again comes back. Answers 404 when the Channel does not know the
 * Agent, which tells the wrapper to register again.
 */
export interface HeartbeatRequest {
  presence: ReportedPresence;
}

/** `POST /api/agents/:id/end`: the session ended. The Agent goes Gone until it resumes. */
export type EndSessionRequest = Record<string, never>;

/** `GET /api/agents`: every Agent the Channel has seen, newest first. */
export interface AgentsResponse {
  agents: Agent[];
}

/** How often the wrapper heartbeats. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** The wrapper reports Idle after this long without any output from the agent CLI. */
export const DEFAULT_IDLE_AFTER_MS = 2 * 60_000;

/** An Agent goes Gone after this long without a heartbeat, unless the Worker sets PRESENCE_GONE_AFTER_SECONDS. */
export const DEFAULT_GONE_AFTER_SECONDS = 10 * 60;
