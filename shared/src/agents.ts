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

/** The longest Account Label the Channel accepts, in characters (ADR 0009). */
export const MAX_ACCOUNT_LABEL_LENGTH = 64;

/**
 * A Nickname as the Channel stores it: trimmed, inner whitespace collapsed, control
 * characters removed. Empty means none. Returns undefined when it is too long.
 */
export function cleanNickname(raw: string): string | null | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  const clean = raw.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (clean.length > MAX_NICKNAME_LENGTH) return undefined;
  return clean === "" ? null : clean;
}

/** An Account Label as the Channel stores it: like a Nickname, cut to `MAX_ACCOUNT_LABEL_LENGTH`. Empty means none. */
export function cleanAccountLabel(raw: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  const clean = raw.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean === "" ? null : clean.slice(0, MAX_ACCOUNT_LABEL_LENGTH);
}

/** Two Nicknames clash when they are the same without regard to case (ADR 0009). */
export function sameNickname(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The longest model ID and reasoning effort the Channel keeps (ADR 0010). */
export const MAX_MODEL_LENGTH = 100;
export const MAX_EFFORT_LENGTH = 20;

/** A model ID or effort as the Channel keeps it: one line, trimmed, cut to `max`. Empty means unknown. */
export function cleanModelField(raw: string, max: number): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean === "" ? null : clean.slice(0, max);
}

/** The path that reports an Agent's model (ADR 0010). */
export function modelPath(id: AgentId): string {
  return `${agentPath(id)}/model`;
}

const CLAUDE_FAMILIES: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };
const MODEL_WORDS: Record<string, string> = {
  pro: "Pro",
  flash: "Flash",
  lite: "Lite",
  codex: "Codex",
  mini: "Mini",
  nano: "Nano",
  max: "Max",
};

/**
 * A short readable name for a model ID (ADR 0010): `claude-opus-5-5` is "Opus 5.5",
 * `gpt-5-codex` "GPT-5 Codex", `gemini-3-pro-preview` "Gemini 3 Pro". An ID it does
 * not know comes back as it is.
 */
export function modelLabel(id: string): string {
  const model = id.trim();
  // claude-opus-5-5, claude-haiku-4-5-20251001, claude-sonnet-4-20250514, claude-opus-4-1[1m]
  const claude = /^(?:anthropic[./])?claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:-v\d+(?::\d+)?)?(\[1m\])?$/i.exec(
    model,
  );
  if (claude?.[1] && claude[2]) {
    const version = claude[3] === undefined ? claude[2] : `${claude[2]}.${claude[3]}`;
    return `${CLAUDE_FAMILIES[claude[1].toLowerCase()]} ${version}${claude[4] ? " (1M)" : ""}`;
  }
  // claude-3-5-sonnet-20241022
  const older = /^claude-(\d)-(?:(\d)-)?(opus|sonnet|haiku)(?:-\d{8})?$/i.exec(model);
  if (older?.[1] && older[3]) {
    return `${CLAUDE_FAMILIES[older[3].toLowerCase()]} ${older[2] === undefined ? older[1] : `${older[1]}.${older[2]}`}`;
  }
  // gpt-5, gpt-5-codex, gpt-5.1-codex-mini
  const gpt = /^gpt-(\d+(?:\.\d+)?)((?:-(?:codex|mini|nano|pro|max))*)$/i.exec(model);
  if (gpt?.[1] !== undefined) return [`GPT-${gpt[1]}`, ...words(gpt[2] ?? "")].join(" ");
  // gemini-3-pro-preview, gemini-2.5-flash-lite
  const gemini = /^(?:models\/)?gemini-(\d+(?:\.\d+)?)((?:-(?:pro|flash|lite))*)(?:-preview(?:-[\w-]+)?|-latest|-\d{3})?$/i.exec(model);
  if (gemini?.[1] !== undefined) return [`Gemini ${gemini[1]}`, ...words(gemini[2] ?? "")].join(" ");
  return model;
}

function words(suffix: string): string[] {
  return suffix
    .split("-")
    .filter((w) => w !== "")
    .map((w) => MODEL_WORDS[w.toLowerCase()] ?? w);
}

/**
 * `POST /api/agents/:id/model`: the Agent's wrapper reports the model its CLI runs on
 * (ADR 0010). The Agent's own token or its own Person. `via` says where the wrapper
 * read it: `proxy` (the model requests themselves) or `config` (`--model`, the CLI's
 * default). Answers with the Agent; a change is an `agent.model` Event.
 */
export interface SetModelRequest {
  model: string | null;
  effort?: string | null;
  via?: "proxy" | "config";
}

/** The path that renames one Agent (ADR 0009). */
export function nicknamePath(id: AgentId): string {
  return `${agentPath(id)}/nickname`;
}

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
  /**
   * Sets the Nickname. Omit to keep the current one; null clears it. A Nickname
   * another Agent holds is not set, and the answer says so in `nicknameRefused`
   * (ADR 0009); the Agent registers anyway.
   */
  nickname?: string | null;
  /** Sets the Account Label (ADR 0009). Omit to keep the current one; null clears it. */
  account?: string | null;
  /**
   * The model the wrapper knows the CLI runs on (ADR 0010), from `--model` or the
   * CLI's config, or the Proxy Capture's last report. Omit to keep the Channel's.
   */
  model?: string;
  /** Its reasoning effort, when known. Omitted with `model` keeps the Channel's. */
  effort?: string;
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
  /**
   * `POST /api/agents` only: why the Nickname asked for was not set, when it was
   * not (another Agent holds it). The Agent registered anyway (ADR 0009).
   */
  nicknameRefused?: string;
}

/**
 * `POST /api/agents/:id/nickname`: rename an Agent while it runs (ADR 0009). The
 * Agent's own token or any Person on the Channel may. Null or an empty name clears
 * it. Answers with the Agent, or 409 naming the Agent that holds the name.
 */
export interface RenameAgentRequest {
  nickname: string | null;
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
