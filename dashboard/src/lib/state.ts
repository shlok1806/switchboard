// One state vocabulary (ADR 0023, design.md): every view reads an Agent's state from
// stateOf, so the Agents list, the canvas, the board and the top bar's counts agree.
import type { Agent, PersonName, Task } from "@shared/index";

/** An Agent's one state, in the order a Person reads them. */
export const AGENT_STATES = ["needs", "needs-other", "stale", "running", "idle", "gone"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Every state a glyph can show: an Agent's, plus a Task's review and done. */
export type GlyphState = AgentState | "review" | "review-other" | "done";

/**
 * What an Agent shows first: a prompt waiting on a Person (its own Person's, so "you" when
 * that is `me`), then a Stale Claim, then its Presence.
 */
export function stateOf(agent: Agent, claims: readonly Task[], me: PersonName): AgentState {
  if (agent.approval) return agent.person === me ? "needs" : "needs-other";
  if (agent.presence === "gone" && claims.some((t) => t.claim?.stale)) return "stale";
  if (agent.presence === "live") return "running";
  return agent.presence;
}

/** Whether a state calls for a Person: the only states drawn in the signal colour. */
export function needsPerson(state: GlyphState): boolean {
  return state === "needs" || state === "needs-other" || state === "stale" || state === "review" || state === "review-other";
}

/** The state's word. `person` names whose prompt waits, for "needs-other". */
export function stateWord(state: GlyphState, person?: PersonName): string {
  switch (state) {
    case "needs":
      return "Needs you";
    case "needs-other":
      return person ? `Needs ${person}` : "Needs its Person";
    case "stale":
      return "Stale";
    case "review":
    case "review-other":
      return "Review";
    case "running":
      return "Running";
    case "idle":
      return "Idle";
    case "gone":
      return "Gone";
    case "done":
      return "Done";
  }
}

/** Sorts Agents by state, in reading order. */
export function byState(a: AgentState, b: AgentState): number {
  return AGENT_STATES.indexOf(a) - AGENT_STATES.indexOf(b);
}

/** How many Agents are in each state. */
export function countStates(states: Iterable<AgentState>): Record<AgentState, number> {
  const n = Object.fromEntries(AGENT_STATES.map((s) => [s, 0])) as Record<AgentState, number>;
  for (const s of states) n[s]++;
  return n;
}
