/**
 * The Channel API contract: what a client (the Dashboard, the wrapper, hooks)
 * reads over HTTP and receives over the WebSocket. The Worker implements it.
 */
import type {
  Agent,
  AgentId,
  ChannelEvent,
  Holder,
  Person,
  ProxyMode,
  RelayConfig,
  Task,
  TaskNumber,
  Verdict,
} from "./domain";
import type { AccountUsage } from "./usage";

export interface ChannelInfo {
  id: string;
  /** `owner/name` of the GitHub repo this Channel mirrors. */
  repo: string;
  mainBranch: string;
}

/** `GET /api/snapshot`: everything the Dashboard needs to render, then follow the stream. */
export interface ChannelSnapshot {
  channel: ChannelInfo;
  persons: Person[];
  agents: Agent[];
  tasks: Task[];
  /** Oldest first. */
  events: ChannelEvent[];
  verdicts: Verdict[];
  relay: RelayConfig;
  /** Every account with usage readings (ADR 0011). Absent from a Channel older than it. */
  accounts?: AccountUsage[];
  /** The `seq` to resume the WebSocket from. */
  cursor: number;
}

/** Messages the Worker sends over the WebSocket (`/api/stream?after=<cursor>`). */
export type StreamMessage =
  | { type: "event"; event: ChannelEvent }
  | { type: "verdict"; verdict: Verdict }
  | { type: "agent"; agent: Agent }
  | { type: "task"; task: Task }
  | { type: "person"; person: Person }
  /** An account's usage changed (ADR 0011). */
  | { type: "account"; account: AccountUsage };

/** Actions a Person takes from the Dashboard. Each maps to one HTTP POST. */
export type PersonAction =
  /** `POST /api/updates` */
  | { type: "update"; text: string; task?: TaskNumber }
  /** `POST /api/directives` */
  | { type: "directive"; to: AgentId; text: string }
  /** `POST /api/tasks/:number/takeover`. Only valid on a Stale Claim (ADR 0002). */
  | { type: "takeover"; task: TaskNumber; to: Holder }
  /** `POST /api/agents/:id/proxy-mode`. Only the Agent's own Person may change it. */
  | { type: "proxy-mode"; agent: AgentId; mode: ProxyMode }
  /** `POST /api/agents/:id/nickname`. Any Person on the Channel may rename any Agent (ADR 0009); null clears it. */
  | { type: "rename"; agent: AgentId; nickname: string | null };

export type ActionResult = { ok: true } | { ok: false; reason: string };

/**
 * `POST /api/join`: join (or rejoin) the Channel as the signed-in Person (see auth.ts
 * for how a call is authenticated). A Person joins with their first call anyway.
 */
export interface JoinRequest {
  /** IANA time zone of the Person's laptop. Defaults to "UTC". */
  timeZone?: string;
}

export interface JoinResponse {
  ok: true;
  person: Person;
}

/** `GET /api/relay`: the Relay's settings, as the Dashboard shows them. Never a secret. */
export interface RelayResponse {
  relay: RelayConfig;
}

/**
 * `GET /api/events?after=<seq>&limit=<n>`: Events with `seq` above `after`, oldest first.
 * `GET /api/events?tail=<n>`: the latest `n` Events, oldest first.
 */
export interface HistoryResponse {
  events: ChannelEvent[];
  /** The `seq` of the last Event returned, or `after` when there are none. */
  cursor: number;
}

/** Largest `limit` a history read accepts, and the default. */
export const MAX_HISTORY_LIMIT = 1000;

/** The longest Update text the Channel accepts, in characters. */
export const MAX_UPDATE_LENGTH = 4000;

/** `POST /api/updates` answers with the recorded Update Event. */
export interface PostUpdateResponse {
  ok: true;
  event: ChannelEvent;
}

/** Every refused call answers with a 4xx status and this body. */
export type ErrorResponse = Extract<ActionResult, { ok: false }>;

/** Clients may send this text frame to keep the WebSocket open. The Worker answers `LIVE_PONG`. */
export const LIVE_PING = "ping";
export const LIVE_PONG = "pong";

/* ── Tasks (GitHub sync, ADR 0001) ────────────────────────── */

/** `GET /api/tasks`: every Task, lowest Issue number first. */
export interface TaskListResponse {
  tasks: Task[];
}

/** `GET /api/tasks/:number` */
export interface TaskResponse {
  task: Task;
}

/** `POST /api/tasks`: creates the GitHub Issue, then the Task. */
export interface CreateTaskRequest {
  title: string;
  description?: string;
  labels?: string[];
}

/** `POST /api/tasks` answers 201 with the new Task. */
export interface CreateTaskResponse {
  ok: true;
  task: Task;
}

/** GitHub's own limits on an Issue title and body, in characters. */
export const MAX_TASK_TITLE_LENGTH = 256;
export const MAX_TASK_DESCRIPTION_LENGTH = 65536;
