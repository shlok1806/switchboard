// Local Events and the history reads the Channel relays to the machines that keep
// them (ADR 0037). The per-call records of an Agent's work stay on the machine that
// made them, in its local store; the Channel asks that machine's wrapper or Host for
// them over its socket, and says which history is missing when it cannot be reached.

import type { AgentId, ChannelEvent, EventType, PersonName, TaskNumber } from "./domain";
import type { HostId } from "./hosts";

/** The Event types the Hook and Proxy Captures make per call, kept on the Agent's machine. */
export const LOCAL_EVENT_TYPES = [
  "tool.call",
  "command",
  "turn.end",
  "file.edit",
  "proxy.digest",
  "proxy.raw",
] as const satisfies readonly EventType[];

export type LocalEventType = (typeof LOCAL_EVENT_TYPES)[number];

/**
 * Whether `event` is a Local Event: one of `LOCAL_EVENT_TYPES` from the Hook or Proxy
 * Capture (a Tool Capture `tool.call` stays on the Channel), or the Relay's rule Drop
 * about one, which names it in `local`.
 */
export function isLocalEvent(event: Pick<ChannelEvent, "type" | "capture" | "payload">): boolean {
  if (event.type === "verdict") {
    const payload = event.payload as { source?: unknown; local?: unknown };
    return payload.source === "rule" && payload.local === true;
  }
  return (
    (LOCAL_EVENT_TYPES as readonly string[]).includes(event.type) &&
    (event.capture === "hook" || event.capture === "proxy")
  );
}

/** How long the Channel waits for a machine's history page. */
export const HISTORY_WAIT_MS = 3000;

/** The most Events one history page may hold. */
export const MAX_HISTORY_PAGE = 1000;

/** How long a machine keeps its Agents' Local Events. */
export const LOCAL_RETENTION_DAYS = 30;

/** The Channel to a wrapper or Host: a page of the Local Events it keeps. */
export interface HistoryRequestMessage {
  type: "history.request";
  id: string;
  /** Only this Agent's Events; a wrapper is only ever asked about its own. */
  agent?: AgentId;
  /** Only the Events on this Task. */
  task?: TaskNumber;
  /** Only Events with `seq` below this. */
  before: number;
  limit: number;
}

/** A wrapper or Host to the Channel: the page it was asked for, newest last, or why there is none. */
export type HistoryPageMessage =
  | { type: "history.page"; id: string; events: ChannelEvent[] }
  | { type: "history.page"; id: string; error: string };

/** History the Channel could not read: whose, and why. */
export interface HistoryGap {
  /** The Host that keeps it, when it has one. */
  host?: HostId;
  /** The Agents whose Local Events are missing; empty when the Host's whole store is. */
  agents: AgentId[];
  reason: string;
}

/** What a history read says while a machine is away. */
export function offlineReason(holder: string): string {
  return `offline: history unavailable until ${holder} is back`;
}

/** Merges pages of Events into one page of at most `limit`: each Event once, the newest kept, oldest first. */
export function mergePages(pages: readonly (readonly ChannelEvent[])[], limit: number): ChannelEvent[] {
  const byId = new Map<string, ChannelEvent>();
  for (const page of pages) for (const event of page) if (!byId.has(event.id)) byId.set(event.id, event);
  return [...byId.values()]
    .sort((a, b) => b.seq - a.seq)
    .slice(0, limit)
    .reverse();
}

/**
 * The Local Events of a history page a machine sent, or null when it is not one: each
 * must be a Local Event of an Agent of `person` (the Person whose wrapper or Host sent
 * it), inside what was asked. The Relay's rule Drops carry no Agent and are kept when
 * they are about an Event of the page.
 */
export function cleanHistoryPage(
  raw: unknown,
  person: PersonName,
  asked: Pick<HistoryRequestMessage, "agent" | "task" | "before" | "limit">,
): ChannelEvent[] | null {
  if (!Array.isArray(raw)) return null;
  const events: ChannelEvent[] = [];
  const ids = new Set<string>();
  for (const item of raw.slice(0, MAX_HISTORY_PAGE)) {
    if (typeof item !== "object" || item === null) return null;
    const event = item as ChannelEvent;
    if (typeof event.id !== "string" || typeof event.at !== "string" || typeof event.type !== "string") return null;
    if (typeof event.seq !== "number" || !Number.isSafeInteger(event.seq)) return null;
    if (typeof event.payload !== "object" || event.payload === null) return null;
    if (typeof event.actor !== "object" || event.actor === null) return null;
    if (!isLocalEvent(event) || event.seq >= asked.before) continue;
    if (asked.task !== undefined && event.task !== asked.task) continue;
    if (event.type === "verdict") {
      if (event.actor.kind !== "relay") continue;
    } else {
      if (event.actor.kind !== "agent" || !event.actor.agentId.startsWith(`${person}/`)) continue;
      if (asked.agent !== undefined && event.actor.agentId !== asked.agent) continue;
      ids.add(event.id);
    }
    events.push(event);
  }
  // A Verdict only about an Event of this page.
  const kept = events.filter((e) => e.type !== "verdict" || ids.has((e.payload as { event?: string }).event ?? ""));
  return mergePages([kept], asked.limit);
}
