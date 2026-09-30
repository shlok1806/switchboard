// A stand-in for Jev behind the Relay's interface: it answers with set
// probabilities, per Agent or by default, and records the state of every call, so
// the Relay's Verdict logic is tested deterministically.

import type { AgentId, RelayState, VerdictOption, VerdictProbabilities } from "../../shared/src/index";
import type { Jev, JevAnswer } from "../src/relay/jev";

export class FakeJev implements Jev {
  readonly model = "fake-jev";
  /** The state of every call, oldest first. */
  readonly calls: RelayState[] = [];
  /** Answers by receiving Agent; `answer` for the rest. */
  readonly byAgent = new Map<AgentId, VerdictProbabilities>();
  /** When set, every call fails with it: an Error to reject, "hang" to never answer. */
  failure: Error | "hang" | null = null;

  constructor(public answer: VerdictProbabilities = { drop: 1, queue: 0, interrupt: 0 }) {}

  async verdict(state: RelayState, signal: AbortSignal): Promise<JevAnswer> {
    this.calls.push(state);
    if (this.failure === "hang") {
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    }
    if (this.failure) throw this.failure;
    const probabilities = this.byAgent.get(state.agent.id) ?? this.answer;
    const choice = (Object.keys(probabilities) as VerdictOption[]).reduce((a, b) =>
      probabilities[b] > probabilities[a] ? b : a,
    );
    return { choice, confidence: probabilities[choice], probabilities };
  }
}
