// Usage (ADR 0011) as the Dashboard shows it: an Agent's account limits from Claude
// Code's `/usage`, their tone, how stale a reading is and when each window resets.

import type { AccountUsage, Agent, LimitsReading } from "@shared/index";
import { USAGE_STALE_MS } from "@shared/index";

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

/** The latest limits for an Agent's account: the account's own, or the Agent's when newer. */
export function limitsFor(agent: Agent, accounts: AccountUsage[]): LimitsReading | undefined {
  const theirs = agent.usage?.limits;
  const email = agent.usage?.email ?? agent.usage?.accountId;
  const account = email === undefined ? undefined : accounts.find((a) => a.email === email)?.limits;
  if (account === undefined) return theirs;
  if (theirs === undefined) return account;
  return theirs.readAt > account.readAt ? theirs : account;
}

/** "$1.24", or "<$0.01". */
export function dollars(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
