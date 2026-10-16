// Interrupts, as rows instead of toasts (plan slice 9). When the Relay decides to type an
// Event into an Agent's running session, that Verdict is a row in Activity and a count on the
// Activity key until this viewer has seen it. What was seen is kept per browser: it is a
// reading position, not Channel state.

import type { Verdict } from "@shared/index";
import { useMemo, useSyncExternalStore } from "react";
import { useChannel } from "./store";

const KEY = "switchboard.activity.seen";

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

let seen = read();
const listeners = new Set<() => void>();

/** Everything up to `at` has been seen in Activity. */
export function markSeen(at: string) {
  if (at <= seen) return;
  seen = at;
  try {
    localStorage.setItem(KEY, at);
  } catch {
    // A private window keeps it for this page only.
  }
  for (const l of listeners) l();
}

function useSeen(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => seen,
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

/** How many Interrupts arrived since this viewer last read Activity. */
export function useUnseenInterrupts(): number {
  const all = useInterrupts();
  const at = useSeen();
  return all.filter((v) => v.at > at).length;
}
