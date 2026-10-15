// An Agent's screen as watchers see it (ADR 0021): a headless terminal fed with the
// CLI's output, read back as plain text with every secret masked. Lines the terminal
// wrapped are joined before masking, so a secret split by a wrap is still found. No
// escape sequence ever leaves: a viewer's browser never interprets an Agent's output.

// @xterm/headless is CommonJS: Node's ESM loader finds no named exports in it.
import xterm from "@xterm/headless";
import { TERMINAL_FRAME_MS } from "../../../shared/src/index";
import { maskSecrets } from "../proxy/mask";

/** Header values masking by name misses: `Authorization: Bearer <token>` keeps its scheme, loses its token. */
const HEADER =
  /\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token)(\s*[:=]\s*)(?:(bearer|basic|token)\s+)?([^\s'"]+)/gi;
const COOKIE = /\b(cookie|set-cookie)(\s*:\s*)([^\r\n'"]+)/gi;

/** `text` with every secret the wrapper recognises masked. */
export function redactLine(text: string): string {
  const headers = text
    .replace(
      HEADER,
      (_m, name: string, sep: string, scheme: string | undefined) => `${name}${sep}${scheme ? `${scheme} ` : ""}****`,
    )
    .replace(COOKIE, (_m, name: string, sep: string) => `${name}${sep}****`);
  return maskSecrets(headers).text;
}

export interface ScreenSnapshot {
  cols: number;
  rows: number;
  lines: string[];
  cursor: { x: number; y: number };
}

const { Terminal } = xterm;

export class TerminalScreen {
  private readonly term: InstanceType<typeof Terminal>;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  }

  write(data: string, done?: () => void): void {
    this.term.write(data, done);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(Math.max(1, cols), Math.max(1, rows));
  }

  /** The rows on screen, redacted. */
  snapshot(): ScreenSnapshot {
    const { cols, rows } = this.term;
    const buffer = this.term.buffer.active;
    const top = buffer.viewportY;
    // Start at the first row of the logical line that holds the top row.
    let start = top;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
    const lines: string[] = [];
    let row = start;
    while (row < top + rows) {
      const segments: string[] = [buffer.getLine(row)?.translateToString(true) ?? ""];
      let next = row + 1;
      while (next < buffer.length && buffer.getLine(next)?.isWrapped) {
        segments.push(buffer.getLine(next)?.translateToString(true) ?? "");
        next++;
      }
      // Every segment but the last fills its row; trailing blanks only matter on the last.
      const whole = segments.map((s, i) => (i < segments.length - 1 ? s.padEnd(cols) : s)).join("");
      const masked = redactLine(whole);
      const parts = Array.from({ length: segments.length }, (_, i) =>
        i < segments.length - 1 ? masked.slice(i * cols, (i + 1) * cols) : masked.slice(i * cols),
      );
      parts.forEach((part, i) => {
        if (row + i >= top && row + i < top + rows) lines.push(part.trimEnd());
      });
      row = next;
    }
    while (lines.length < rows) lines.push("");
    return { cols, rows, lines, cursor: { x: buffer.cursorX, y: buffer.cursorY + buffer.baseY - top } };
  }

  dispose(): void {
    this.term.dispose();
  }
}

/**
 * Sends the screen while anyone watches: at once when a watcher comes, then at most
 * every {@link TERMINAL_FRAME_MS} while it changes. Nothing while no one watches.
 */
export class ScreenStream {
  private watchers = 0;
  private dirty = true;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly send: () => void,
    private readonly intervalMs = TERMINAL_FRAME_MS,
  ) {}

  /**
   * The Channel says how many watch each time one starts or stops. Each time, those
   * watching get the whole screen again: a socket that just started has none yet.
   */
  setWatchers(count: number): void {
    this.watchers = Math.max(0, count);
    if (this.watchers > 0) {
      this.send();
      this.dirty = false;
      if (this.timer === undefined) {
        this.timer = setInterval(() => this.tick(), this.intervalMs);
        this.timer.unref?.();
      }
    } else if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** The screen, or what is shown with it, changed. */
  changed(): void {
    this.dirty = true;
  }

  private tick(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.send();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
