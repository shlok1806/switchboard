/**
 * Usage (ADR 0011): how much of its Claude account's limits an Agent's account has
 * used, as Claude Code's own `/usage` reports it, and how much the Agent's session
 * has used itself. The wrapper reads both and sends them with the Agent's heartbeat.
 */

/** One limit window `/usage` reports, such as the current session or week. */
export interface UsageLimit {
  /** Percent of the limit used, as `/usage` says it. */
  percent: number;
  /** When the window resets, when the wrapper could read it (ISO). */
  resetsAt?: string;
  /** The reset as `/usage` wrote it, such as "Oct 7 at 1:59am (America/Chicago)". */
  resets?: string;
}

/** A week limit for one model family, such as `Current week (Fable)`. */
export interface ModelLimit extends UsageLimit {
  /** The model as `/usage` names it, such as "Fable". */
  model: string;
}

/** What one `/usage` run said about the account's limits. Any line may be missing. */
export interface LimitsReading {
  /** When the wrapper read it (ISO). */
  readAt: string;
  session?: UsageLimit;
  /** The week across all models. */
  week?: UsageLimit;
  /** Every per-model week line, in the order `/usage` listed them. */
  models: ModelLimit[];
}

/**
 * What the Agent's own session has used, from its transcript: model requests,
 * tokens and an estimated cost at API prices. Subscriptions are not billed per
 * token, so the cost is only a way to compare Agents.
 */
export interface SessionUsage {
  requests: number;
  /** Input tokens not read from the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated, in US dollars. Absent when no model of the session has a known price. */
  costUsd?: number;
}

/**
 * What an Agent's wrapper last reported about usage. The account is the login the
 * CLI runs under, as `claude auth status` reports it: its full email address and
 * its plan (ADR 0011).
 */
export interface AgentUsage {
  email?: string;
  /** The plan or subscription type, such as "max". */
  plan?: string;
  limits?: LimitsReading;
  session?: SessionUsage;
  /** When the Channel last heard it (ISO), set by the Channel. */
  reportedAt: string;
}

/** What the wrapper sends: `AgentUsage` without the Channel's `reportedAt`. */
export type ReportedUsage = Omit<AgentUsage, "reportedAt">;

/** One point of an account's history, for its sparkline. */
export interface UsagePoint {
  at: string;
  session?: number;
  week?: number;
}

/**
 * One account the Channel has heard usage for (`GET /api/accounts`, the snapshot's
 * `accounts`, and `account` on the stream): its latest reading and its history.
 */
export interface AccountUsage {
  email: string;
  plan?: string;
  limits: LimitsReading;
  /** Oldest first, over the last `ACCOUNT_HISTORY_MS`. */
  history: UsagePoint[];
}

/** `GET /api/accounts` */
export interface AccountsResponse {
  accounts: AccountUsage[];
}

/** How long the Channel keeps an account's readings, for its history. */
export const ACCOUNT_HISTORY_MS = 24 * 60 * 60_000;

/** How long a Claude session window lasts: a session limit resets this long after it starts. */
export const SESSION_WINDOW_MS = 5 * 60 * 60_000;

/** A reading older than this is stale: the Dashboard dims it and says so. */
export const USAGE_STALE_MS = 15 * 60_000;

/** The wrapper reads usage at least this often while the session lives. */
export const USAGE_INTERVAL_MS = 5 * 60_000;

/** ...and never more often than this. */
export const USAGE_MIN_INTERVAL_MS = 60_000;

const MAX_EMAIL = 254;
const MAX_PLAN = 40;
const MAX_MODEL_NAME = 40;
const MAX_RESETS = 80;
const MAX_MODELS = 12;
const MAX_TOKENS = 1e13;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean === "" ? undefined : clean.slice(0, max);
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TOKENS
    ? Math.round(value)
    : undefined;
}

function limit(value: unknown): UsageLimit | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { percent, resetsAt, resets } = value as Record<string, unknown>;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 1000) return undefined;
  const at = isoTime(resetsAt);
  const said = text(resets, MAX_RESETS);
  return { percent, ...(at === undefined ? {} : { resetsAt: at }), ...(said === undefined ? {} : { resets: said }) };
}

function limits(value: unknown): LimitsReading | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const readAt = isoTime(raw.readAt);
  if (readAt === undefined) return undefined;
  const session = limit(raw.session);
  const week = limit(raw.week);
  const models: ModelLimit[] = [];
  for (const entry of Array.isArray(raw.models) ? raw.models.slice(0, MAX_MODELS) : []) {
    const model = text((entry as { model?: unknown } | null)?.model, MAX_MODEL_NAME);
    const window = limit(entry);
    if (model !== undefined && window !== undefined) models.push({ model, ...window });
  }
  return { readAt, ...(session === undefined ? {} : { session }), ...(week === undefined ? {} : { week }), models };
}

function session(value: unknown): SessionUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const requests = count(raw.requests);
  const inputTokens = count(raw.inputTokens);
  const outputTokens = count(raw.outputTokens);
  if (requests === undefined || inputTokens === undefined || outputTokens === undefined) return undefined;
  const cost = raw.costUsd;
  return {
    requests,
    inputTokens,
    outputTokens,
    cacheReadTokens: count(raw.cacheReadTokens) ?? 0,
    cacheWriteTokens: count(raw.cacheWriteTokens) ?? 0,
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost < 1e7 ? { costUsd: cost } : {}),
  };
}

/**
 * A usage report from a request, as the Channel keeps it: unknown fields dropped,
 * text cut to size, a part that does not parse left out. Undefined when nothing in
 * it is usable.
 */
export function cleanUsage(value: unknown): ReportedUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const email = text(raw.email, MAX_EMAIL);
  const plan = text(raw.plan, MAX_PLAN);
  const read = limits(raw.limits);
  const used = session(raw.session);
  const usage: ReportedUsage = {
    ...(email === undefined ? {} : { email }),
    ...(plan === undefined ? {} : { plan }),
    ...(read === undefined ? {} : { limits: read }),
    ...(used === undefined ? {} : { session: used }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}
