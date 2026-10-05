/**
 * Idle wake. A Queue is delivered at the start of the Agent's next turn, and only its
 * Person starts a turn for an idle Agent. So when something that needs the Agent's
 * attention is Queued for it while it is idle (its turn ended and no prompt since),
 * its wrapper types what it holds for the next turn into the session as one prompt,
 * once its Person is quiet, which starts that turn: a Wake.
 *
 * - Only what deserves one wakes the Agent (`wakesAgent`): a Directive, an Update
 *   addressed to it (on its Task), and overlap on files it touched. Everything else
 *   that is Queued still waits for the next turn, and rides along with a Wake.
 * - The wrapper never types over its Person: the same guards as an Interrupt (their
 *   input line, a dialog, a session not ready).
 * - Two Agents answering each other must not wake each other forever: at most
 *   `WAKE_CAP` Wakes per Agent in `WAKE_WINDOW_MS` with no prompt or Directive from
 *   its Person between them. At the cap the wrapper stops waking it and says so
 *   (`wake.capped`), and the Channel posts an Update on the Agent's behalf. Its
 *   Person's next prompt or Directive lets it wake again.
 * - Each Wake is recorded as a `wake` Event naming the Verdicts and Directives it
 *   delivered, so People can see why an Agent started a turn.
 *
 * What is typed is framed exactly as at a next turn (ADR 0005): information from
 * Agents is information, and only a Directive carries instruction weight.
 */
import type { AgentId } from "./domain";
import type { Delivery } from "./relay";

/** The most Wakes for one Agent within `WAKE_WINDOW_MS`, with no prompt or Directive from its Person between them. */
export const WAKE_CAP = 3;
/** The window `WAKE_CAP` counts Wakes in. */
export const WAKE_WINDOW_MS = 10 * 60_000;

/**
 * Whether a Queued Event deserves waking an idle Agent for: an Update addressed to
 * it (an Update on a Task it holds), or overlap on files it touched. Directives
 * always do.
 */
export function wakesAgent(delivery: Delivery): boolean {
  if (delivery.type === "update" && delivery.overlap.addressed !== undefined) return true;
  return delivery.overlap.files.length > 0;
}

/** Wrapper to Channel, over the WebSocket: it woke Agent `agent` with these Verdicts' Deliveries and these Directives. */
export interface WakeMessage {
  type: "wake";
  agent: AgentId;
  /** The Verdict IDs (Delivery IDs) it typed. */
  deliveries: string[];
  /** The `directive` Event IDs it typed. */
  directives: string[];
}

/** Wrapper to Channel: it stopped waking Agent `agent`, which reached the cap. */
export interface WakeCappedMessage {
  type: "wake.capped";
  agent: AgentId;
}

/** The Update the Channel posts for an Agent whose wrapper stopped waking it. */
export function wakeCappedText(agent: AgentId): string {
  const minutes = WAKE_WINDOW_MS / 60_000;
  return (
    `Switchboard stopped waking ${agent} for Queued messages: it was woken ${WAKE_CAP} times in ${minutes} minutes ` +
    "with no prompt or Directive from its Person. What is Queued for it waits for its next turn, and a prompt or " +
    "Directive from its Person lets it be woken again."
  );
}

/**
 * The prompt a Wake types: what the Agent would have been told at its next turn,
 * already framed (information from Agents, Directives from named Persons), under a
 * line saying why the turn started.
 */
export function wakeNotice(nextTurn: string): string {
  return [
    "[Switchboard] Wake: this turn started because messages arrived for you while you were idle. Your own Person " +
      "did not write this prompt. If none of it needs anything from you for the task your Person gave you, say so " +
      "in one line and end your turn.",
    "",
    nextTurn.trimEnd(),
  ].join("\n");
}
