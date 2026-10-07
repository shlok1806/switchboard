// When the wrapper reads usage (ADR 0011): once when the session starts, after
// every turn the wrapper sees end, and every `intervalMs` while the session lives,
// but never more often than every `minIntervalMs`. A turn end that comes too soon
// is read once the floor allows, and a burst of them reads once. Reads never run
// side by side, and a read that fails only waits for the next one.

import { USAGE_INTERVAL_MS, USAGE_MIN_INTERVAL_MS } from "../../../shared/src/index";

export interface UsageScheduleOptions {
  intervalMs?: number;
  minIntervalMs?: number;
  log?: (line: string) => void;
}

export class UsageSchedule {
  private readonly intervalMs: number;
  private readonly minIntervalMs: number;
  private readonly log: (line: string) => void;
  /** When the last read started, or null before the first. */
  private lastStart: number | null = null;
  private running = false;
  private wanted = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Promise<void> | null = null;

  constructor(
    private readonly read: () => Promise<void>,
    options: UsageScheduleOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? USAGE_INTERVAL_MS;
    this.minIntervalMs = options.minIntervalMs ?? USAGE_MIN_INTERVAL_MS;
    this.log = options.log ?? (() => {});
  }

  /** The session started: read now, then keep the cadence. */
  start(): void {
    this.soon();
  }

  /** A turn ended: read as soon as the floor allows. */
  turnEnded(): void {
    this.soon();
  }

  /**
   * The session is ending: waits at most `timeoutMs` for a read in progress, then
   * reads once more when none has run yet or a turn ended since the last one, so
   * even a short session reports what its last turn used. The floor does not
   * hold this last read back.
   */
  async finish(timeoutMs: number): Promise<void> {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.stopped = true;
    const last = (async () => {
      if (this.current !== null) await this.current;
      if (this.lastStart === null || this.wanted) await this.run(true);
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([last, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private soon(): void {
    if (this.stopped) return;
    this.wanted = true;
    if (this.running) return;
    const due = this.lastStart === null ? 0 : this.lastStart + this.minIntervalMs - Date.now();
    this.at(Math.max(0, due));
  }

  private at(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delayMs);
    this.timer.unref?.();
  }

  private async run(last = false): Promise<void> {
    if ((this.stopped && !last) || this.running) return;
    this.running = true;
    this.wanted = false;
    this.lastStart = Date.now();
    this.current = this.read().catch((error: unknown) => {
      this.log(`could not read usage: ${(error as Error).message}`);
    });
    await this.current;
    this.current = null;
    this.running = false;
    if (this.stopped) return;
    // A turn that ended meanwhile reads once the floor allows; otherwise the cadence goes on.
    const next = this.wanted ? this.minIntervalMs : this.intervalMs;
    this.at(Math.max(0, this.lastStart + next - Date.now()));
  }
}
