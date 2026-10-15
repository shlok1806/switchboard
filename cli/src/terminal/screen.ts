// An Agent's screen as watchers see it (ADR 0021): a headless terminal fed with the
// CLI's output, read back as plain text with every secret masked. Lines the terminal
// wrapped are joined before masking, so a secret split by a wrap is still found. No
// escape sequence ever leaves: a viewer's browser never interprets an Agent's output.

// @xterm/headless is CommonJS: Node's ESM loader finds no named exports in it.
import xterm from "@xterm/headless";
import { TERMINAL_FRAME_MS } from "../../../shared/src/index";
import { MASK, maskSecrets } from "../proxy/mask";

/** Header values masking by name misses: `Authorization: Bearer <token>` keeps its scheme, loses its token. */
const HEADER =
  /\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token)(\s*[:=]\s*)(?:(bearer|basic|token)\s+)?([^\s'"]+)/gi;
const COOKIE = /\b(cookie|set-cookie)(\s*:\s*)([^\r\n'"]+)/gi;

/** The bidi embeddings, overrides and isolates, and the marks: they reorder how text reads. */
export const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

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

/** `text` as a regular expression that matches it exactly. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Marks where a row's colours or style change: the same break a colour code is in raw output. */
const STYLE_BREAK = "\x1b[m";
// biome-ignore lint/suspicious/noControlCharactersInRegex: the style break is an escape sequence.
const STYLE_BREAKS = /\x1b\[m/g;
/** The style breaks that cannot start a key, as they do not follow a letter or digit. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the style break is an escape sequence.
const STYLE_BREAKS_INSIDE = /(?<![A-Za-z0-9])\x1b\[m/g;
/** A broken row's indent, style breaks among it included. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the style break is an escape sequence.
const LEADING_BLANKS = /^(?:[ \t]|\x1b\[m)*/;
/**
 * A mask, then a style or row break, then more of a token: the rest of a key that was
 * both glued to a word and split. It goes with the mask; the row breaks stay.
 */
const SPLIT_TAIL = new RegExp(`${literal(MASK)}(?:(?:${literal(STYLE_BREAK)}|\\n[ \\t]*)[A-Za-z0-9_-]+)+`, "g");

/**
 * The rows of one logical line, redacted twice, as a transcript is (ADR 0019).
 * - First with the rows on lines of their own and their style breaks in: a key that a
 *   colour change or a row start glues to the word before it (`OK` then a green
 *   `ghp_...`) starts there.
 * - Then with the rows joined and the style breaks out: a key that a colour change or a
 *   wrap split, whether the terminal wrapped it or the CLI broke the row itself, is whole.
 *   A row the CLI broke itself (`broken`) may be indented under the one before (Claude
 *   Code's tool output is), so it is joined without its indent. A row the terminal
 *   wrapped keeps its leading blanks: they are the text's own.
 * Each masked key stays on the row it starts on.
 */
function redactRows(rows: string[], broken: boolean[]): string[] {
  const first = redactLine(rows.join("\n")).replace(
    SPLIT_TAIL,
    (tail) => MASK + "\n".repeat(tail.split("\n").length - 1),
  );
  const kept = first.replace(STYLE_BREAKS, "").split("\n");
  // A mask that spans rows (a private key block) leaves fewer: the rows after it are blank.
  while (kept.length < rows.length) kept.push("");
  const indents = kept.map((row, i) => (broken[i] ? (/^[ \t]*/.exec(row)?.[0] ?? "") : ""));
  const bodies = kept.map((row, i) => row.slice(indents[i]?.length ?? 0));
  const joined = bodies.join("");
  // A key both glued to a word and split, with too little of it on its first row for the
  // first pass to know it: joined, it is whole, but stripped of its style breaks it is
  // glued again. So the style breaks after a letter or digit, where a key may start, stay
  // for one more pass before the rest go. A key a colour change split after a letter is
  // then masked only to that break, so the rest goes with its mask, as in the first pass.
  const glued = first
    .split("\n")
    .map((row, i) => (broken[i] ? row.replace(LEADING_BLANKS, "") : row))
    .join("")
    .replace(STYLE_BREAKS_INSIDE, "");
  const masked = redactLine(redactLine(glued).replace(SPLIT_TAIL, MASK).replace(STYLE_BREAKS, ""));
  if (masked === joined) return kept;
  // Where the second pass masked, map each row's start through it: the text before the
  // first change and after the last is the same, and a row that starts inside the
  // change starts after it.
  let same = 0;
  while (same < joined.length && same < masked.length && joined[same] === masked[same]) same++;
  let tail = 0;
  while (
    tail < joined.length - same &&
    tail < masked.length - same &&
    joined[joined.length - 1 - tail] === masked[masked.length - 1 - tail]
  )
    tail++;
  const at = (i: number) =>
    i <= same ? i : i >= joined.length - tail ? i - joined.length + masked.length : masked.length - tail;
  const out: string[] = [];
  let from = 0;
  bodies.forEach((body, i) => {
    out.push((indents[i] ?? "") + masked.slice(at(from), at(from + body.length)));
    from += body.length;
  });
  return out;
}

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/;
/** A line of base64 only, as a key's body is, after any indent or tool-output mark. */
const BASE64_LINE = /^[ \t]*(?:⎿[ \t]*)?([A-Za-z0-9+/]{16,}={0,2})$/;
/** How long a base64 line must be to count toward a block: a PEM line holds 64. */
const BASE64_LONG = 40;
/** How many long base64 lines make a block that is masked with no BEGIN line seen. */
const BASE64_BLOCK = 3;

/**
 * The rows, up to `end`, inside a private key printed over several lines: between its
 * BEGIN and END lines, or to the bottom while no END has come. Each row alone looks like
 * nothing to mask. Lines are read whole, over the rows the terminal wrapped them across
 * or the CLI broke them over (a row whose text reaches the last column goes on), and a
 * BEGIN or END line the CLI wrapped at a space is read over the two lines it took.
 * A key whose BEGIN line has gone past the scrollback is still found, as a block of
 * base64 lines with at least BASE64_BLOCK long ones, wherever it is.
 */
function privateKeyRows(buffer: { length: number; getLine(y: number): Line | undefined }, end: number): Set<number> {
  const lines: { from: number; to: number; text: string }[] = [];
  let y = 0;
  while (y < Math.min(end, buffer.length)) {
    let text = buffer.getLine(y)?.translateToString(true) ?? "";
    let full = markedRow(buffer.getLine(y)).full;
    let next = y + 1;
    while (next < buffer.length && (full || buffer.getLine(next)?.isWrapped)) {
      const line = buffer.getLine(next);
      // A row the CLI broke itself may be indented under the one before.
      const row = line?.translateToString(true) ?? "";
      text += line?.isWrapped ? row : row.replace(/^[ \t]+/, "");
      full = markedRow(line).full;
      next++;
    }
    lines.push({ from: y, to: next, text });
    y = next;
  }
  const rows = new Set<number>();
  const add = (line: { from: number; to: number }) => {
    for (let row = line.from; row < line.to; row++) rows.add(row);
  };
  // A BEGIN or END line the CLI wrapped at a space, over two lines.
  const marker = (pattern: RegExp, i: number) => {
    const line = lines[i]?.text ?? "";
    const next = lines[i + 1]?.text;
    if (next === undefined || pattern.test(line) || pattern.test(next)) return false;
    return pattern.test(`${line.trimEnd()} ${next.trim()}`);
  };
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as (typeof lines)[number];
    if (inside && PEM_END.test(line.text)) inside = false;
    else if (inside && marker(PEM_END, i)) {
      inside = false;
      i++;
    } else if (inside) add(line);
    else if (PEM_BEGIN.test(line.text) && !PEM_END.test(line.text)) inside = true;
    else if (marker(PEM_BEGIN, i)) {
      inside = true;
      i++;
    } else if (BASE64_LINE.test(line.text)) {
      // A block of base64 lines: a key's body whose BEGIN line is not in the buffer.
      let last = i;
      while (last + 1 < lines.length && BASE64_LINE.test(lines[last + 1]?.text ?? "")) last++;
      const block = lines.slice(i, last + 1);
      const long = block.filter((l) => (BASE64_LINE.exec(l.text)?.[1]?.length ?? 0) >= BASE64_LONG).length;
      if (long >= BASE64_BLOCK) for (const l of block) add(l);
      i = last;
    }
  }
  return rows;
}

type Line = NonNullable<ReturnType<InstanceType<typeof Terminal>["buffer"]["active"]["getLine"]>>;
type Cell = NonNullable<ReturnType<Line["getCell"]>>;

const style = (c: Cell) =>
  `${c.getFgColorMode()}:${c.getFgColor()}:${c.getBgColorMode()}:${c.getBgColor()}:${c.isBold()}${c.isItalic()}${c.isDim()}${c.isUnderline()}${c.isInverse()}`;

/**
 * A row's text with a style break before each cell whose style differs from the cell
 * before it, and whether its text reaches the last column. A row start needs no break:
 * rows are redacted first each on a line of its own.
 */
function markedRow(line: Line | undefined): { text: string; full: boolean } {
  if (!line) return { text: "", full: false };
  let text = "";
  let full = false;
  let last: string | undefined;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const s = style(cell);
    if (last !== undefined && s !== last) text += STYLE_BREAK;
    last = s;
    // Bidi controls go: in a viewer's browser they would reorder the text around them.
    const chars = (cell.getChars() || " ").replace(BIDI_CONTROLS, "");
    text += chars;
    // The last cell, or a wide character ending in it.
    if (x + cell.getWidth() >= line.length) full = chars.trim() !== "";
  }
  return { text, full };
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

  /**
   * The rows on screen, redacted. A row continues into the next when the terminal
   * wrapped it, or when its text reaches the last column: the agent CLI breaks a long
   * line itself (Ink does), and a key it broke must be masked whole.
   */
  snapshot(): ScreenSnapshot {
    const { rows } = this.term;
    const buffer = this.term.buffer.active;
    const top = buffer.viewportY;
    const full = (row: number) => markedRow(buffer.getLine(row)).full;
    const continues = (row: number) => buffer.getLine(row)?.isWrapped === true || full(row - 1);
    // Start at the first row of the logical line that holds the top row.
    let start = top;
    while (start > 0 && continues(start)) start--;
    const secret = privateKeyRows(buffer, top + rows);
    const lines: string[] = [];
    let row = start;
    while (row < top + rows) {
      const first = markedRow(buffer.getLine(row));
      const group = [first.text];
      const broken = [false];
      let joins = first.full;
      let next = row + 1;
      while (next < buffer.length && (joins || buffer.getLine(next)?.isWrapped)) {
        const marked = markedRow(buffer.getLine(next));
        group.push(marked.text);
        broken.push(buffer.getLine(next)?.isWrapped !== true);
        joins = marked.full;
        next++;
      }
      redactRows(group, broken).forEach((text, i) => {
        if (row + i >= top && row + i < top + rows) lines.push(secret.has(row + i) ? MASK : text.trimEnd());
      });
      row = next;
    }
    while (lines.length < rows) lines.push("");
    return { cols: this.term.cols, rows, lines, cursor: { x: buffer.cursorX, y: buffer.cursorY + buffer.baseY - top } };
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
