// Usage (ADR 0011) as the Dashboard shows it: one card per account, with its limits
// from Claude Code's `/usage`, the Agents running on it now and what each used.

import type { AccountUsage, Agent, LimitsReading, SessionUsage, UsagePoint } from "@shared/index";
import { SESSION_WINDOW_MS, USAGE_STALE_MS } from "@shared/index";

/** A meter's colour: green under 70%, amber from 70% to 90%, red over 90%. */
export type MeterTone = "green" | "amber" | "red";

export function meterTone(percent: number): MeterTone {
  if (percent > 90) return "red";
  if (percent >= 70) return "amber";
  return "green";
}

/** Whether a reading is old enough to dim: more than 15 minutes. */
export function isStale(readAt: string, now: number): boolean {
  return now - Date.parse(readAt) > USAGE_STALE_MS;
}

/** "42 min", "3 h 20 min", "1 d 16 h". */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/** A clock time such as "1:59am", in the viewer's time zone. */
function clockOf(at: Date, timeZone?: string): string {
  return at
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone })
    .replace(":00", "")
    .replace(/\s?(AM|PM)$/, (_, m: string) => m.toLowerCase());
}

/**
 * When a window resets, with a countdown: "resets 1:59am, in 42 min", or with the
 * day when it is not today ("resets Thu 4:59pm, in 1 d 16 h"). Without a time it
 * could read, what `/usage` wrote.
 */
export function resetText(limit: { resetsAt?: string; resets?: string }, now: number, timeZone?: string): string | null {
  if (limit.resetsAt === undefined) return limit.resets === undefined ? null : `resets ${limit.resets}`;
  const at = new Date(limit.resetsAt);
  const left = at.getTime() - now;
  if (left <= 0) return `reset ${duration(-left)} ago`;
  const day = (d: Date) => d.toLocaleDateString("en-US", { timeZone });
  const sameDay = day(at) === day(new Date(now));
  const weekday = sameDay ? "" : `${at.toLocaleDateString("en-US", { weekday: "short", timeZone })} `;
  return `resets ${weekday}${clockOf(at, timeZone)}, in ${duration(left)}`;
}

/** One Agent running on an account, and its share of what the account's Agents used. */
export interface AccountAgent {
  agent: Agent;
  session?: SessionUsage;
  /** 0 to 1, by estimated cost when every Agent has one, else by tokens. */
  share: number;
}

/** One account card: the account, its latest limits and the Agents on it now. */
export interface AccountCard {
  email: string;
  plan?: string;
  limits?: LimitsReading;
  history: UsagePoint[];
  agents: AccountAgent[];
  /** What the Agents on it used, added up. */
  total: SessionUsage;
}

function tokensOf(s: SessionUsage): number {
  return s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens;
}

function add(a: SessionUsage, b: SessionUsage): SessionUsage {
  const cost = a.costUsd === undefined && b.costUsd === undefined ? undefined : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

const NONE: SessionUsage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * One card per account the Channel knows: every account with `/usage` readings, and
 * every account an Agent reported without them (an API key has no limits). An
 * Agent counts as running on it while it is not Gone. Most recently read first.
 */
export function accountCards(accounts: AccountUsage[], agents: Agent[]): AccountCard[] {
  const cards = new Map<string, AccountCard>();
  for (const a of accounts) {
    cards.set(a.email, { email: a.email, plan: a.plan, limits: a.limits, history: a.history, agents: [], total: NONE });
  }
  for (const agent of agents) {
    const email = agent.usage?.email ?? agent.usage?.accountId;
    if (email === undefined) continue;
    let card = cards.get(email);
    if (card === undefined) {
      card = { email, plan: agent.usage?.plan, limits: agent.usage?.limits, history: [], agents: [], total: NONE };
      cards.set(email, card);
    }
    // A newer reading from an Agent than the account's own (the stream is behind).
    const theirs = agent.usage?.limits;
    if (theirs !== undefined && (card.limits === undefined || theirs.readAt > card.limits.readAt)) card.limits = theirs;
    card.plan ??= agent.usage?.plan;
    if (agent.presence === "gone") continue;
    card.agents.push({ agent, session: agent.usage?.session, share: 0 });
  }
  for (const card of cards.values()) {
    card.agents.sort((x, y) => x.agent.startedAt.localeCompare(y.agent.startedAt));
    card.total = card.agents.reduce((sum, a) => (a.session ? add(sum, a.session) : sum), NONE);
    const byCost = card.agents.every((a) => a.session?.costUsd !== undefined);
    const weight = (s?: SessionUsage) => (s === undefined ? 0 : byCost ? (s.costUsd ?? 0) : tokensOf(s));
    const all = card.agents.reduce((sum, a) => sum + weight(a.session), 0);
    for (const a of card.agents) a.share = all === 0 ? 0 : weight(a.session) / all;
  }
  const readAt = (c: AccountCard) => c.limits?.readAt ?? "";
  return [...cards.values()].sort((x, y) => readAt(y).localeCompare(readAt(x)) || x.email.localeCompare(y.email));
}

/** The latest limits for an Agent's account: the account's own, or the Agent's when newer. */
export function limitsFor(agent: Agent, accounts: AccountUsage[]): LimitsReading | undefined {
  const theirs = agent.usage?.limits;
  const email = agent.usage?.email ?? agent.usage?.accountId;
  const account = email === undefined ? undefined : accounts.find((a) => a.email === email)?.limits;
  if (account === undefined) return theirs;
  if (theirs === undefined) return account;
  return theirs.readAt > account.readAt ? theirs : account;
}

/**
 * The session percent over the current session window (the 5 hours before it
 * resets), or the last 5 hours when the reset is unknown, oldest first.
 */
export function sessionHistory(card: Pick<AccountCard, "history" | "limits">, now: number): { at: number; percent: number }[] {
  const resets = card.limits?.session?.resetsAt;
  const from = resets === undefined ? now - SESSION_WINDOW_MS : Date.parse(resets) - SESSION_WINDOW_MS;
  return card.history
    .filter((p): p is UsagePoint & { session: number } => p.session !== undefined && Date.parse(p.at) >= from)
    .map((p) => ({ at: Date.parse(p.at), percent: p.session }));
}

/** "$1.24", or "<$0.01". */
export function dollars(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
