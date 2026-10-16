// The Agents this viewer picked last, newest first, so the palette can put them first. Kept per
// browser: it is a habit of this viewer, not Channel state.

import type { AgentId } from "@shared/index";

const KEY = "switchboard.recentAgents";
const KEEP = 8;

/** The Agents picked last, newest first. */
export function recentAgents(): AgentId[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is AgentId => typeof x === "string").slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

/** This Agent was just picked: it goes to the front. */
export function pickedAgent(id: AgentId) {
  const next = [id, ...recentAgents().filter((x) => x !== id)].slice(0, KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Blocked storage: the order is only lost on reload.
  }
}
