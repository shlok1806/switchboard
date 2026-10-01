/**
 * The Agent part of the Channel API: how the laptop wrapper registers an Agent,
 * reports its Presence with heartbeats and ends its session. Terms follow CONTEXT.md.
 */
import type { LostClaim } from "./claims";
import type { DirectiveDelivery } from "./directives";
import type { Agent, AgentId, Cli, PersonName, ProxyMode } from "./domain";
import type { Delivery } from "./relay";

/** The short CLI name used in an Agent ID, such as `claude` in `shlok/claude/7f3a`. */
export const CLI_SHORT_NAMES: Record<Cli, string> = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
};

export const CLIS = Object.keys(CLI_SHORT_NAMES) as Cli[];

/** How many characters of the session ID go into the Agent ID. */
export const AGENT_ID_SESSION_CHARS = 4;

/**
 * Which end of the session ID the Agent ID takes its characters from. Codex session
 * IDs are UUIDv7: their first characters are the clock, the same for every session
 * started within years, so a Codex Agent ID takes the last 4 (the random end).
 */
export const AGENT_ID_SESSION_END: Record<Cli, "start" | "end"> = {
  "claude-code": "start",
  codex: "end",
  gemini: "start",
};

/**
 * A CLI session ID: letters, digits and "-", 4 to 128 characters.
 * Claude Code and Gemini CLI use UUIDs; Codex uses UUIDv7 thread IDs.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{3,127}$/;

/** The longest Nickname the Channel accepts, in characters. */
export const MAX_NICKNAME_LENGTH = 40;

/**
 * The Agent ID for a session: `<person>/<cli short name>/<4 of the session id>`, the
 * first 4 characters, or the last 4 for Codex (see `AGENT_ID_SESSION_END`).
 */
export function agentIdFor(person: PersonName, cli: Cli, sessionId: string): AgentId {
  const short =
    AGENT_ID_SESSION_END[cli] === "end"
      ? sessionId.slice(-AGENT_ID_SESSION_CHARS)
      : sessionId.slice(0, AGENT_ID_SESSION_CHARS);
  return `${person}/${CLI_SHORT_NAMES[cli]}/${short.toLowerCase()}`;
}

/** The path of one Agent's resource. Agent IDs contain "/", so the ID is URL-encoded. */
export function agentPath(id: AgentId): string {
  return `/api/agents/${encodeURIComponent(id)}`;
}

/** Presence the wrapper can report. Only the Channel decides Gone. */
export type ReportedPresence = "live" | "idle";

/**
 * `POST /api/agents`: register an Agent for a session, or re-register it on resume.
 * It needs the Person's session, and answers with a new Agent token.
 * The Channel derives the Agent ID from the authenticated Person, `cli` and `sessionId`,
 * so the same session always gets the same Agent ID. It answers 409 when a different
 * session of the same Person already holds that Agent ID.
 */
export interface RegisterAgentRequest {
  cli: Cli;
  sessionId: string;
  /** True when the session was resumed rather than started fresh. */
  resumed: boolean;
  /** How the agent CLI started the session ("startup", "resume"), recorded on `session.start`. */
  source?: string;
  /**
   * True when the wrapper registers again within the same session, because the
   * Channel revoked its token (it went Gone) or forgot it. No new `session.start`
   * is recorded for a Channel that still knows the Agent: the session goes on.
   */
  rejoin?: boolean;
  /** Working directory of the session. */
  cwd: string;
  /** Sets the Nickname. Omit to keep the current one; null clears it. */
  nickname?: string | null;
  /** Sets the Proxy mode (the wrapper's `--proxy`). Omit to keep the current one; new Agents start in digest. */
  proxyMode?: ProxyMode;
  /** Whether the wrapper masks secrets in Proxy Events (`--no-mask` turns it off). Omitted means on. */
  secretMasking?: boolean;
  /**
   * Whether the wrapper can type Interrupts into this CLI's session. Omitted means
   * it cannot: the Relay then delivers the Agent's Interrupts as Queue, downgraded.
   */
  interrupts?: boolean;
}

/** `POST /api/agents` and `POST /api/agents/:id/heartbeat` answer with the Agent. */
export interface AgentResponse {
  ok: true;
  agent: Agent;
  /**
   * Claims this Agent lost to a Takeover that it has not been told about yet.
   * Present only when there are some; each is sent once.
   */
  lostClaims?: LostClaim[];
  /**
   * Queued Events for the Agent's next turn that its wrapper has not acknowledged
   * over the WebSocket. Present only when there are some; each is handed over once.
   */
  deliveries?: Delivery[];
  /**
   * Directives to this Agent that its wrapper has not acknowledged over the
   * WebSocket. Present only when there are some; each is handed over once.
   */
  directives?: DirectiveDelivery[];
  /**
   * `POST /api/agents` only: the new Agent token, bound to this one Agent (ADR 0007).
   * `switchboard run` trades its Person session for it here. The token posts the
   * Agent's Events, claims and releases for it and reads the Channel; it stops
   * working when the Agent goes Gone, and registering again issues a new one.
   */
  token?: string;
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
export interface EndSessionRequest {
  /** The agent CLI's own reason (its SessionEnd hook's), recorded on `session.end`. */
  detail?: string;
}

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
