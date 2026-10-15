// A paste from the Dashboard that never ends (ADR 0021). The Dashboard sends a long
// bracketed paste in frames of at most TERMINAL_INPUT_MAX characters, with the start
// marker in the first and the end marker in the last. If a frame after the first is
// refused, or the Channel drops it, the CLI stays in the paste and takes every key after
// it as pasted text. The wrapper sees what reached the CLI, so it ends the paste itself.

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
/** How long a paste may wait for its next frame: the Dashboard sends them back to back. */
export const PASTE_WAIT_MS = 2000;

export class PasteGuard {
  /** The key whose paste the CLI is in, or null. */
  private open: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** Writes the end marker to the CLI. */
    private readonly end: (text: string) => void,
    private readonly waitMs = PASTE_WAIT_MS,
  ) {}

  /** Key `fingerprint` is about to type `text`: another key's open paste ends first. */
  before(fingerprint: string): void {
    if (this.open !== null && this.open !== fingerprint) this.close();
  }

  /** Key `fingerprint`'s `text` reached the CLI. */
  typed(fingerprint: string, text: string): void {
    const start = text.lastIndexOf(PASTE_START);
    const end = text.lastIndexOf(PASTE_END);
    if (start > end) this.wait(fingerprint);
    else if (end >= 0) this.settle();
    else if (this.open === fingerprint) this.wait(fingerprint);
  }

  /**
   * A frame that may have continued the open paste did not reach the CLI: refused from
   * key `fingerprint`, or dropped in a flood (no key named).
   */
  lost(fingerprint?: string): void {
    if (this.open !== null && (fingerprint === undefined || fingerprint === this.open)) this.close();
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  private wait(fingerprint: string): void {
    this.open = fingerprint;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), this.waitMs);
    this.timer.unref?.();
  }

  private settle(): void {
    this.open = null;
    clearTimeout(this.timer);
  }

  private close(): void {
    this.settle();
    this.end(PASTE_END);
  }
}
