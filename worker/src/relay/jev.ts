// Jev, TypeSafe's decision model, behind an interface (ADR 0003). The Relay asks
// it one choice question per Event and Agent: drop, queue or interrupt. The first
// implementation calls TypeSafe's API directly with the JEV_API_KEY Worker secret.
// Tests install a fake that answers with set probabilities.

import type { RelayState, VerdictOption, VerdictProbabilities } from "../../../shared/src/index";

/** Jev's answer to the verdict question. */
export interface JevAnswer {
  choice: VerdictOption;
  confidence: number;
  probabilities: VerdictProbabilities;
}

export interface Jev {
  /** The model name, as the Dashboard shows it. */
  readonly model: string;
  /** Asks the verdict question about `state`. Rejects on errors and timeouts. */
  verdict(state: RelayState, signal: AbortSignal): Promise<JevAnswer>;
}

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/** The one choice question, worded as in the first Jev test (issue #3 defers narrower ones). */
export const VERDICT_QUESTION = {
  type: "choice",
  instructions:
    "Should `agent` be told about `event`? `overlap` was computed in code: files both touch, symbols the " +
    "event's diff removed or renamed that the agent uses, and whether the event is addressed to the agent. " +
    "Drop if it is irrelevant to the agent's task and files. Queue if it is relevant but can wait until the " +
    "agent's next turn. Interrupt only if the agent will likely produce conflicting or broken work if it keeps " +
    "going without knowing.",
  criteria: {
    drop: "Irrelevant to this agent",
    queue: "Relevant, can wait for the agent's next turn",
    interrupt: "Must know right now to avoid conflicting or broken work",
  },
} as const;

const OPTIONS: readonly VerdictOption[] = ["drop", "queue", "interrupt"];

function probability(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** Reads Jev's response body, or throws when it is not a verdict answer. */
export function readJevAnswer(body: unknown): JevAnswer {
  const answer = (body as { answers?: { verdict?: Record<string, unknown> } } | null)?.answers?.verdict;
  if (answer === undefined || answer === null) throw new Error("Jev's answer has no verdict.");
  const raw = (answer.probabilities ?? {}) as Record<string, unknown>;
  const probabilities = {} as VerdictProbabilities;
  for (const option of OPTIONS) {
    const p = probability(raw[option]);
    if (p === null) throw new Error(`Jev's answer has no probability for "${option}".`);
    probabilities[option] = p;
  }
  const choice = OPTIONS.includes(answer.choice as VerdictOption)
    ? (answer.choice as VerdictOption)
    : OPTIONS.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
  const confidence = probability(answer.confidence) ?? probabilities[choice];
  return { choice, confidence, probabilities };
}

/** TypeSafe's API, called with the Worker secret. */
export class HttpJev implements Jev {
  readonly model = JEV_MODEL;

  constructor(
    private readonly key: string,
    private readonly url = JEV_URL,
  ) {}

  async verdict(state: RelayState, signal: AbortSignal): Promise<JevAnswer> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, state, questions: { verdict: VERDICT_QUESTION } }),
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`Jev answered ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return readJevAnswer(await response.json());
  }
}

let installed: Jev | null = null;

/**
 * Replaces the Jev every Channel uses, for tests. The Workers test runner runs the
 * Channel Durable Object in the test's own isolate, so this reaches it.
 */
export function installJev(jev: Jev | null): void {
  installed = jev;
}

declare global {
  interface Env {
    /** Where Jev lives. Unset in production (TypeSafe's API); the CLI end-to-end test points it at a stand-in. */
    JEV_API_URL?: string;
  }
}

/** The Jev the Relay asks, or null when JEV_API_KEY is not set. */
export function jevFor(env: Pick<Env, "JEV_API_KEY" | "JEV_API_URL">): Jev | null {
  if (installed !== null) return installed;
  return env.JEV_API_KEY ? new HttpJev(env.JEV_API_KEY, env.JEV_API_URL || undefined) : null;
}
