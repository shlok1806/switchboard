// The wrapper's Idle rule: an Agent is Live while its CLI has written to the
// terminal within the last `idleAfterMs`, and Idle once it has been quiet that long.
// Claude Code redraws while it thinks, streams or runs tools, and goes still when it
// is waiting at the prompt for its Person. Only the Channel decides Gone.

import type { ReportedPresence } from "../../shared/src/index";

export class IdleWatch {
  private lastActivity = Date.now();
  private presence: ReportedPresence = "live";
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly idleAfterMs: number,
    private readonly onChange: (presence: ReportedPresence) => void,
  ) {}

  get current(): ReportedPresence {
    return this.presence;
  }

  start(): void {
    this.timer = setInterval(() => this.check(), Math.max(100, Math.min(1000, this.idleAfterMs / 4)));
    this.timer.unref();
  }

  /** The CLI wrote output. */
  activity(): void {
    this.lastActivity = Date.now();
    this.set("live");
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private check(): void {
    if (Date.now() - this.lastActivity >= this.idleAfterMs) this.set("idle");
  }

  private set(presence: ReportedPresence): void {
    if (presence === this.presence) return;
    this.presence = presence;
    this.onChange(presence);
  }
}
