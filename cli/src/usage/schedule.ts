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
   * The session is ending: waits at most `timeoutMs` for a read in progress, or
   * reads once now when none has started yet, so even a short session reports.
   */
  async finish(timeoutMs: number): Promise<void> {
    clearTimeout(this.timer);
    if (!this.stopped && this.lastStart === null) void this.run();
    this.stopped = true;
    const current = this.current;
    if (current === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([current, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
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

  private async run(): Promise<void> {
    if (this.stopped || this.running) return;
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
