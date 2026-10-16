// Interrupts, as rows instead of toasts (plan slice 9). When the Relay decides to type an
// Event into an Agent's running session, that Verdict is a row in Activity and a count on the
// Activity key until this viewer has seen its row. What was seen is kept per browser and per
// Channel: it is a reading position, not Channel state. Only a row Activity actually showed
// counts as seen, so a filter or an unloaded page never clears an Interrupt nobody read.

import type { Verdict } from "@shared/index";
import { useMemo, useSyncExternalStore } from "react";
import { useChannel } from "./store";

// Seen keys kept per Channel; older ones fall off.
const KEEP = 500;

type Seen = { since: string; keys: string[] };

/** The key of one Interrupt: the Event it typed in and the Agent it was typed into. */
export const interruptKey = (v: Verdict) => `${v.event}:${v.agent}`;

const storageKey = (channel: string) => `switchboard.activity.seen:${channel}`;
const cache = new Map<string, Seen>();
const listeners = new Set<() => void>();
// Before the snapshot names the Channel nothing counts and nothing is stored.
const NONE: Seen = { since: "\uffff", keys: [] };

function load(channel: string): Seen {
  if (!channel) return NONE;
  const hit = cache.get(channel);
  if (hit) return hit;
  let seen: Seen | undefined;
  try {
    const raw = localStorage.getItem(storageKey(channel));
    if (raw) seen = JSON.parse(raw) as Seen;
  } catch {
    // Unreadable or blocked storage: start fresh.
  }
  // A first visit counts only Interrupts from now on, not the Channel's whole history.
  if (!seen || typeof seen.since !== "string" || !Array.isArray(seen.keys)) {
    seen = { since: new Date().toISOString(), keys: [] };
    save(channel, seen);
  }
  cache.set(channel, seen);
  return seen;
}

function save(channel: string, seen: Seen) {
  try {
    localStorage.setItem(storageKey(channel), JSON.stringify(seen));
  } catch {
    // A private window keeps it for this page only.
  }
}

/** These Interrupts' rows were shown in Activity. */
export function markSeen(channel: string, keys: string[]) {
  if (!channel) return;
  const seen = load(channel);
  const add = keys.filter((k) => !seen.keys.includes(k));
  if (add.length === 0) return;
  const next = { since: seen.since, keys: [...seen.keys, ...add].slice(-KEEP) };
  cache.set(channel, next);
  save(channel, next);
  for (const l of listeners) l();
}

function useSeen(channel: string): Seen {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => load(channel),
  );
}

/** An Interrupt, or one that was meant to be and reached the Agent as a Queue instead. */
export const isInterrupt = (v: Verdict) => v.option === "interrupt" || v.downgraded !== undefined;

/** The Channel's Interrupts, oldest first. */
export function useInterrupts(): Verdict[] {
  const { verdictsByEvent } = useChannel();
  return useMemo(() => {
    const out: Verdict[] = [];
    for (const vs of verdictsByEvent.values()) for (const v of vs) if (isInterrupt(v)) out.push(v);
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }, [verdictsByEvent]);
}

/** How many Interrupts arrived that this viewer has not seen as a row in Activity. */
export function useUnseenInterrupts(): number {
  const all = useInterrupts();
  const { snapshot } = useChannel();
  const seen = useSeen(snapshot?.channel.repo ?? "");
  return all.filter((v) => v.at > seen.since && !seen.keys.includes(interruptKey(v))).length;
}
