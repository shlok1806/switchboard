// Idle wake, the wrapper's side (see shared/src/wakes.ts). When something held for the
// Agent's next turn deserves it and the Agent waits at its prompt, the wrapper types
// everything held as one prompt once its Person is quiet, which starts a turn.
//
// It tries when something may have made a Wake possible: something held for the next
// turn, a turn ending, the cap being lifted. A short settle first lets Events that
// arrive together go in one prompt. While the Agent works it waits for the turn to
// end; while its Person types or a dialog is open it tries again shortly.
//
// It counts its Wakes: at `cap` within `windowMs`, with no prompt or Directive from
// the Person between them, it stops waking the Agent and says so once. A prompt or
// Directive from the Person resets the count.

import { WAKE_CAP, WAKE_WINDOW_MS, wakeNotice } from "../../shared/src/index";
import type { NotTyped } from "./interrupts";
import type { WakeBatch } from "./next-turn";

/** How long a Wake waits after the first thing worth waking for, to take what arrives with it in the same prompt. */
export const WAKE_SETTLE_MS = 1000;
/** How soon a Wake tries again after its Person was typing or a dialog was open. */
const RETRY_MS = 500;

export type WakeOutcome = { typed: true } | { typed: false; reason: NotTyped | "busy" | "empty" };

export interface WakerOptions {
  /**
   * Types the prompt `produce` gives now, if the CLI waits at its prompt and nothing
   * stops typing; `produce` runs only then (InterruptTyper.wake).
   */
  type: (produce: () => string | null) => Promise<WakeOutcome>;
  /** Whether something held deserves a Wake. */
  pending: () => boolean;
  /** Takes everything held for the next turn, or null when nothing held deserves a Wake. */
  take: () => WakeBatch | null;
  /** The Agent was woken with `batch`. */
  woke: (batch: WakeBatch) => void;
  /** The wrapper stopped waking the Agent: it reached the cap. */
  capped: () => void;
  log: (line: string) => void;
  now?: () => number;
  cap?: number;
  windowMs?: number;
  settleMs?: number;
}

export class Waker {
  /** When each Wake since the Person's last prompt or Directive was typed. */
  private wakes: number[] = [];
  /** Whether the cap was reported since it was last reset. */
  private capReported = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private trying = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly cap: number;
  private readonly windowMs: number;
  private readonly settleMs: number;

  constructor(private readonly options: WakerOptions) {
    this.now = options.now ?? Date.now;
    this.cap = options.cap ?? WAKE_CAP;
    this.windowMs = options.windowMs ?? WAKE_WINDOW_MS;
    this.settleMs = options.settleMs ?? WAKE_SETTLE_MS;
  }

  /** Something changed that may make a Wake possible: something new held, or the Agent's turn ended. */
  poke(): void {
    if (this.stopped || this.timer !== undefined || this.trying || !this.options.pending()) return;
    this.schedule(this.settleMs);
  }

  /** The Person prompted the Agent or sent it a Directive: it may be woken again. */
  reset(why: string): void {
    if (this.wakes.length > 0 || this.capReported) this.options.log(`wakes counted afresh: ${why}`);
    this.wakes = [];
    this.capReported = false;
    this.poke();
  }

  /** The session ended. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.attempt();
    }, ms);
  }

  private atCap(): boolean {
    const since = this.now() - this.windowMs;
    this.wakes = this.wakes.filter((at) => at > since);
    return this.wakes.length >= this.cap;
  }

  private async attempt(): Promise<void> {
    if (this.stopped || !this.options.pending()) return;
    if (this.atCap()) {
      if (!this.capReported) {
        this.capReported = true;
        this.options.log(`not waking: ${this.wakes.length} Wakes in ${this.windowMs / 60_000} minutes`);
        this.options.capped();
      }
      return;
    }
    this.trying = true;
    let batch: WakeBatch | null = null;
    let outcome: WakeOutcome;
    try {
      outcome = await this.options.type(() => {
        batch = this.options.take();
        return batch === null ? null : wakeNotice(batch.text);
      });
    } finally {
      this.trying = false;
    }
    const taken = batch as WakeBatch | null;
    if (outcome.typed && taken !== null) {
      this.wakes.push(this.now());
      this.options.log(`woke the Agent: ${taken.deliveries.length} Queued, ${taken.directives.length} Directive(s)`);
      this.options.woke(taken);
      return;
    }
    // At work: its turn's end tries again. Its Person typing, or a dialog: try again shortly.
    if (!outcome.typed && (outcome.reason === "busy" || outcome.reason === "empty")) return;
    if (!this.stopped) this.schedule(RETRY_MS);
  }
}
