// Interrupts on the wrapper side. The Relay pushes an Interrupt over the WebSocket
// and the wrapper types it into Claude Code's pty as a prompt, the way a Person
// typing mid-turn does: Claude Code takes typed input while it works and reads it
// at its next step. Nothing is stopped.
//
// It is typed as one bracketed paste followed by Enter, so a multi-line message is
// one prompt, not one prompt per line. Claude Code turns bracketed paste on when
// its prompt is up.
//
// The wrapper never types over its Person. It waits while:
//
// - the Person typed in the last `quietMs`, or their input line is not empty as far
//   as the keystrokes show (typed characters not yet sent with Enter or cleared);
// - a dialog is open (a permission prompt, a question, a plan to approve), which
//   typing would answer;
// - the session is not ready (no SessionStart yet, or bracketed paste is off).
//
// If that lasts longer than `waitMs` it gives up and tells the Channel why, and the
// Relay delivers the Interrupt as a Queue at the next turn. While it types, the
// Person's own keystrokes are held back and sent right after, never interleaved.

import type { ClaudeHookInput } from "./hooks/summarize";

/** Why the wrapper did not type an Interrupt. */
export type NotTyped = "person-typing" | "dialog-open" | "session-not-ready";

/** The hooks the wrapper watches to know when a dialog is open. */
export const DIALOG_HOOKS = ["PermissionRequest", "PreToolUse"] as const;
/** The tools whose PreToolUse means a dialog opens: they ask the Person something. */
export const DIALOG_TOOLS = ["AskUserQuestion", "ExitPlanMode"] as const;
/** SessionStart sources that leave the CLI at its prompt. Not "compact", which can come mid-turn. */
const IDLE_SOURCES = new Set(["startup", "resume", "clear"]);

/** The Person must have been this quiet before an Interrupt is typed, unless configured otherwise. */
export const DEFAULT_QUIET_MS = 2000;
/** How long an Interrupt waits for its moment before it becomes a Queue. Below the Channel's own wait. */
export const DEFAULT_WAIT_MS = 10_000;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** Between the end of the paste and Enter, so Claude Code has taken the paste in. */
const SUBMIT_DELAY_MS = 150;
/** After Enter, before the Person's held-back keystrokes go through. */
const SETTLE_MS = 100;
const POLL_MS = 100;

/**
 * Text safe to type inside a bracketed paste: no escape sequences or other control
 * characters, which could end the paste early or act as keys. Newlines become
 * carriage returns, as a terminal pastes them.
 */
export function pasteText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
      .replace(/\n/g, "\r")
  );
}

/**
 * At its idle prompt, Claude Code clears its input on a second Escape within 800 ms
 * of the first (its double-press window). The wrapper reads the keys at other
 * moments than Claude Code does, so it only counts a second Escape well inside that.
 */
export const DOUBLE_ESCAPE_MS = 600;
/**
 * Two Escapes this close may be a double press to Claude Code or Codex, so on an
 * empty line they may open its picker of earlier prompts. Well past their windows.
 */
const PICKER_ESCAPE_MS = 1500;

/** What one key does to the input line, as far as the wrapper can tell. */
type Key =
  | { kind: "text"; text: string }
  /** Enter: submits, unless something else takes it (a line ending in `\`, a suggestion). */
  | { kind: "enter" }
  /** Shift/Alt+Enter, Ctrl+J: a line break in the prompt. */
  | { kind: "newline" }
  | { kind: "escape" }
  /** Ctrl+C: clears the line at the idle prompt; cancels the turn while one runs. */
  | { kind: "interrupt" }
  | { kind: "backspace" }
  | { kind: "delete-word" }
  /** Ctrl+U: deletes back to the start of the line the cursor is on. */
  | { kind: "delete-to-line-start" }
  /** Moves the cursor: deletes are no longer at the end of the line. */
  | { kind: "move" }
  /** Puts text on the line the wrapper cannot see: a yank, recalled history, anything unknown. */
  | { kind: "unknown" }
  /** Changes nothing the wrapper needs to know: focus reports, modifier keys, forward deletes. */
  | { kind: "none" };

const TEXT_KEYS = new Map<string, Key>([
  ["\r", { kind: "enter" }],
  ["\n", { kind: "newline" }],
  ["\x03", { kind: "interrupt" }],
  ["\x15", { kind: "delete-to-line-start" }],
  ["\x17", { kind: "delete-word" }],
  ["\x7f", { kind: "backspace" }],
  ["\b", { kind: "backspace" }],
  // Ctrl+A, B, E, F: start and end of line, back and forward a character.
  ["\x01", { kind: "move" }],
  ["\x02", { kind: "move" }],
  ["\x05", { kind: "move" }],
  ["\x06", { kind: "move" }],
  // Ctrl+P and Ctrl+N: history, like Up and Down.
  ["\x10", { kind: "unknown" }],
  ["\x0e", { kind: "unknown" }],
  // Ctrl+Y: yanks back what a delete took.
  ["\x19", { kind: "unknown" }],
  // Ctrl+D and Ctrl+K delete forward, which never empties a line the wrapper thinks has text.
  ["\x04", { kind: "none" }],
  ["\x0b", { kind: "none" }],
]);

/** Alt+key, sent as Escape and the key. */
const ALT_KEYS = new Map<string, Key>([
  ["\x7f", { kind: "delete-word" }],
  ["\b", { kind: "delete-word" }],
  ["\r", { kind: "newline" }],
  ["b", { kind: "move" }],
  ["f", { kind: "move" }],
  ["y", { kind: "unknown" }],
  ["d", { kind: "none" }],
]);

/** Kitty keyboard protocol modifier bits, after subtracting 1 from the field. */
const SHIFT = 1;
const ALT = 2;
const CTRL = 4;
/** Super, hyper and meta. Caps Lock (64) and Num Lock (128) do not make text a command. */
const COMMAND = 8 | 16 | 32;

/** Kitty key codes for keys that only modify others, or lock: Caps, Scroll and Num Lock, Shift, Ctrl... */
function modifierKey(code: number): boolean {
  return (code >= 57358 && code <= 57360) || (code >= 57441 && code <= 57452);
}

/**
 * `text` without its last word, the way Ctrl+W and Alt+Backspace delete one at the
 * end of the line: spaces, then a run of word characters or a run of punctuation.
 * Where Claude Code's keys could delete more (Ctrl+W takes `src/app.ts` whole), this
 * takes the least, and it never crosses a line break.
 */
function withoutLastWord(text: string): string {
  if (text.endsWith("\n")) return text.slice(0, -1);
  const trimmed = text.replace(/[^\S\n]+$/u, "");
  if (trimmed.endsWith("\n")) return trimmed;
  const word = /(?:[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]+)$/u.exec(trimmed);
  return word ? trimmed.slice(0, word.index) : trimmed;
}

/** Whether Claude Code may be showing suggestions, where Escape and Enter act on them. */
function suggesting(text: string, moved: boolean): boolean {
  if (text.startsWith("/")) return true;
  // An @ mention at the cursor; with the cursor somewhere unknown, any @ mention.
  return moved ? /(^|\s)@/.test(text) : /(^|\s)@\S*$/.test(text);
}

/**
 * What the Person's keystrokes say about their input line. Only a guess: the
 * wrapper sees keys, not Claude Code's screen. It may wrongly think the line has
 * text, which only delays an Interrupt, but never wrongly thinks it is empty,
 * which would type the Interrupt onto the Person's prompt and submit both. So it
 * treats a key as clearing only when Claude Code certainly clears on it.
 */
export class InputLine {
  /** The text the wrapper knows is on the line. */
  private text = "";
  /** The cursor may not be at the end of the line, so deletes are no longer followed. */
  private moved = false;
  /** The line may hold text the wrapper cannot see. Only a submitted or cleared prompt resets it. */
  private unknown = false;
  private pasting = false;
  /** Claude Code is at its prompt with no turn running, where Escape and Ctrl+C clear the line. */
  private idle = false;
  /** When the last key was an Escape, the time it was pressed. */
  private escapeAt: number | null = null;
  /** Bytes of an escape sequence, or of a paste end, split across reads. */
  private partial = "";

  private readonly now: () => number;
  /** The prompt clears on double Escape and Ctrl+C at its idle prompt, as Claude Code's does. */
  private readonly idleClears: boolean;

  constructor({ now = Date.now, idleClears = false }: { now?: () => number; idleClears?: boolean } = {}) {
    this.now = now;
    this.idleClears = idleClears;
  }

  get empty(): boolean {
    return this.text === "" && !this.unknown && !this.pasting;
  }

  /** The line was sent elsewhere (Claude Code reported a submitted prompt). */
  clear(): void {
    this.reset();
  }

  /** Whether Claude Code is at its prompt, from its hooks: a turn ended, or one started. */
  setIdle(idle: boolean): void {
    this.idle = idle;
  }

  /** Reads keystrokes the Person typed. Returns whether they included Enter or Escape. */
  keys(data: string): { enter: boolean; cancel: boolean } {
    let enter = false;
    let cancel = false;
    for (const key of this.read(data)) {
      if (key.kind === "enter") enter = true;
      if (key.kind === "escape") cancel = true;
      this.press(key);
    }
    return { enter, cancel };
  }

  private reset(): void {
    this.text = "";
    this.moved = false;
    this.unknown = false;
  }

  /** What one key does to the line. */
  private press(key: Key): void {
    const escapeAt = this.escapeAt;
    this.escapeAt = null;
    switch (key.kind) {
      case "text":
        this.text += key.text;
        return;
      case "newline":
        this.text += "\n";
        return;
      case "enter": {
        // `\` then Enter starts a new line; Enter on a suggestion takes the suggestion.
        const backslash = this.moved ? this.text.includes("\\") : this.text.endsWith("\\");
        if (this.unknown || backslash || suggesting(this.text, this.moved)) {
          if (!this.moved && backslash) this.text = `${this.text.slice(0, -1)}\n`;
          return;
        }
        this.reset();
        // A submitted prompt starts a turn.
        this.idle = false;
        return;
      }
      case "escape": {
        const now = this.now();
        const gap = escapeAt === null ? Number.POSITIVE_INFINITY : now - escapeAt;
        if (gap >= PICKER_ESCAPE_MS) {
          this.escapeAt = now;
          return;
        }
        // On an empty line a double Escape opens Claude Code's rewind picker (Codex's
        // "edit previous message"), where Enter puts an earlier prompt back on the line.
        if (this.text === "") {
          this.unknown = true;
          return;
        }
        if (gap >= DOUBLE_ESCAPE_MS) {
          this.escapeAt = now;
          return;
        }
        // While a turn runs, Escape cancels it; with suggestions up, it closes them.
        if (this.idleClears && this.idle && !this.unknown && !suggesting(this.text, this.moved)) this.reset();
        return;
      }
      case "interrupt":
        if (this.idleClears && this.idle) this.reset();
        return;
      case "backspace":
        if (!this.moved) this.text = [...this.text].slice(0, -1).join("");
        return;
      case "delete-word":
        if (!this.moved) this.text = withoutLastWord(this.text);
        return;
      case "delete-to-line-start":
        if (!this.moved) this.text = this.text.slice(0, this.text.lastIndexOf("\n") + 1);
        return;
      case "move":
        this.moved = true;
        return;
      case "unknown":
        this.unknown = true;
        return;
      case "none":
        return;
    }
  }

  /** The keys in `data`, keeping a sequence split across reads for the next one. */
  private *read(data: string): Generator<Key> {
    const text = this.partial + data;
    this.partial = "";
    let i = 0;
    while (i < text.length) {
      if (this.pasting) {
        // Inside a paste everything is text, up to the paste-end marker.
        const end = text.indexOf(PASTE_END, i);
        if (end === -1) {
          const tail = splitPrefix(text.slice(i), PASTE_END);
          if (text.length - tail > i) yield { kind: "text", text: text.slice(i, text.length - tail) };
          this.partial = text.slice(text.length - tail);
          return;
        }
        if (end > i) yield { kind: "text", text: text.slice(i, end) };
        this.pasting = false;
        i = end + PASTE_END.length;
        continue;
      }
      const ch = text[i] ?? "";
      if (ch !== "\x1b") {
        i += 1;
        yield TEXT_KEYS.get(ch) ?? (ch >= " " ? { kind: "text", text: ch } : { kind: "unknown" });
        continue;
      }
      const rest = text.slice(i);
      if (rest.length === 1 || rest[1] === "\x1b") {
        // A lone Escape at the end of a read, or one followed by another: a key press, most likely.
        yield { kind: "escape" };
        i += 1;
        continue;
      }
      if (rest[1] !== "[" && rest[1] !== "O") {
        yield ALT_KEYS.get(rest[1] ?? "") ?? { kind: "unknown" };
        i += 2;
        continue;
      }
      // After the Escape: "[" or "O", parameters, intermediates, and the final byte.
      const csi = /^([[O])([0-9;:?<>=]*)([ -/]*)([@-~])/.exec(rest.slice(1));
      if (!csi) {
        // Incomplete: wait for the rest.
        this.partial = rest;
        return;
      }
      i += 1 + csi[0].length;
      if (csi[1] === "[" && csi[2] === "200" && csi[4] === "~") {
        this.pasting = true;
        continue;
      }
      const key = this.sequence(csi[1] ?? "", csi[2] ?? "", csi[4] ?? "");
      if (key !== null) yield key;
    }
  }

  /**
   * One escape sequence: cursor and history keys, and keys sent as
   * `CSI <code>[:<alternates>] ; <mods>[:<event>] u` (the kitty keyboard protocol).
   * A key release is no key press, so it gives null.
   */
  private sequence(intro: string, params: string, final: string): Key | null {
    // Up and Down recall history (or move between the lines of a long prompt).
    if (final === "A" || final === "B") return { kind: "unknown" };
    // Left, Right, End and Home.
    if (final === "C" || final === "D" || final === "F" || final === "H") return { kind: "move" };
    // Focus reports.
    if (intro === "[" && params === "" && (final === "I" || final === "O")) return { kind: "none" };
    if (final === "~") {
      const code = params.split(";")[0];
      if (code === "1" || code === "4" || code === "7" || code === "8") return { kind: "move" };
      // Delete, and the end of a paste that never started.
      if (code === "3" || code === "201") return { kind: "none" };
      return { kind: "unknown" };
    }
    if (final !== "u") return { kind: "unknown" };
    const [codeField = "", modsField = ""] = params.split(";");
    const [mods, event] = modsField.split(":");
    if (event === "3") return null;
    const code = Number(codeField.split(":")[0]);
    const flags = Math.max(0, Number(mods || "1") - 1);
    const ctrl = (flags & CTRL) !== 0;
    const alt = (flags & ALT) !== 0;
    const command = (flags & COMMAND) !== 0;
    if (modifierKey(code)) return { kind: "none" };
    if (code === 13) {
      if (ctrl || command) return { kind: "unknown" };
      return (flags & (SHIFT | ALT)) !== 0 ? { kind: "newline" } : { kind: "enter" };
    }
    if (code === 27) return ctrl || alt || command ? { kind: "unknown" } : { kind: "escape" };
    if (code === 127 || code === 8) return alt ? { kind: "delete-word" } : { kind: "backspace" };
    if (ctrl && !alt && !command) {
      const legacy = TEXT_KEYS.get(String.fromCharCode(code & 0x1f));
      return code >= 97 && code <= 122 && legacy !== undefined ? legacy : { kind: "unknown" };
    }
    if (alt && !ctrl && !command) return ALT_KEYS.get(String.fromCodePoint(code)) ?? { kind: "unknown" };
    // Codes in Unicode's private use area are keys with no text: arrows, F-keys, the keypad.
    const printable = code >= 32 && !(code >= 0xe000 && code <= 0xf8ff);
    if (printable && !ctrl && !alt && !command) return { kind: "text", text: String.fromCodePoint(code) };
    return { kind: "unknown" };
  }
}

/** How many characters at the end of `text` could start `marker`. */
function splitPrefix(text: string, marker: string): number {
  for (let n = Math.min(text.length, marker.length - 1); n > 0; n--) {
    if (marker.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

export interface InterruptTyperOptions {
  /** Writes into the agent CLI's pty. */
  write: (data: string) => void;
  quietMs?: number;
  waitMs?: number;
  log: (line: string) => void;
  now?: () => number;
  /**
   * Whether the CLI's prompt clears on double Escape and Ctrl+C at its idle prompt,
   * as Claude Code's does. Off, the wrapper never reads those keys as clearing.
   */
  idleClears?: boolean;
}

export class InterruptTyper {
  private readonly line: InputLine;
  private lastKey = 0;
  private started = false;
  private pasteMode = false;
  private dialog: string | null = null;
  /** The Person's keystrokes held back while an Interrupt is typed; null when none is. */
  private held: string[] | null = null;
  /** Interrupts are typed one at a time. */
  private turn: Promise<unknown> = Promise.resolve();
  private readonly quietMs: number;
  private readonly waitMs: number;
  private readonly now: () => number;

  constructor(private readonly options: InterruptTyperOptions) {
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.now = options.now ?? Date.now;
    this.line = new InputLine({ now: this.now, idleClears: options.idleClears ?? false });
  }

  /** The Person typed `data`: passes it to the agent CLI, or holds it while an Interrupt is being typed. */
  personTyped(data: string): void {
    this.lastKey = this.now();
    const { enter, cancel } = this.line.keys(data);
    // Enter or Escape answers or cancels an open dialog.
    if (enter || cancel) this.dialog = null;
    if (this.held) this.held.push(data);
    else this.options.write(data);
  }

  /** The agent CLI wrote `data` to the terminal: watch whether bracketed paste is on. */
  output(data: string): void {
    const on = data.lastIndexOf("\x1b[?2004h");
    const off = data.lastIndexOf("\x1b[?2004l");
    if (on > off) this.pasteMode = true;
    else if (off > on) this.pasteMode = false;
  }

  /**
   * A hook the agent CLI ran: when the session is ready, when a dialog opens or
   * closes, and whether a turn is running (the input line reads some keys differently then).
   */
  hook(input: ClaudeHookInput): void {
    const event = input.hook_event_name;
    // At its prompt only after a turn ended, or a session started afresh. Any other
    // hook may come from a turn: one the Person started, one the CLI started by itself
    // (a background task finishing), or one that compacted its context mid-turn.
    const idle = event === "Stop" || (event === "SessionStart" && IDLE_SOURCES.has(input.source ?? ""));
    if (event !== "SessionEnd") this.line.setIdle(idle);
    switch (event) {
      case "SessionStart":
        this.started = true;
        this.dialog = null;
        return;
      case "PermissionRequest":
        this.dialog = `permission for ${input.tool_name ?? "a tool"}`;
        return;
      case "PreToolUse":
        if ((DIALOG_TOOLS as readonly (string | undefined)[]).includes(input.tool_name)) {
          this.dialog = input.tool_name ?? "a question";
        }
        return;
      case "UserPromptSubmit":
        this.line.clear();
        this.dialog = null;
        return;
      case "PostToolUse":
      case "Stop":
        this.dialog = null;
        return;
      default:
        return;
    }
  }

  /** Types `text` into the session as a prompt when the moment is right; says why not otherwise. */
  type(text: string): Promise<{ typed: true } | { typed: false; reason: NotTyped }> {
    const next = this.turn.then(() => this.typeNow(text));
    this.turn = next.catch(() => {});
    return next;
  }

  /** What stops an Interrupt being typed right now, or null when nothing does. */
  private blocked(): NotTyped | null {
    if (!this.started || !this.pasteMode) return "session-not-ready";
    if (this.dialog !== null) return "dialog-open";
    if (!this.line.empty || this.now() - this.lastKey < this.quietMs) return "person-typing";
    return null;
  }

  private async typeNow(text: string): Promise<{ typed: true } | { typed: false; reason: NotTyped }> {
    const deadline = this.now() + this.waitMs;
    let reason = this.blocked();
    while (reason !== null) {
      if (this.now() >= deadline) {
        this.options.log(`Interrupt not typed: ${reason}${reason === "dialog-open" ? ` (${this.dialog})` : ""}`);
        return { typed: false, reason };
      }
      await sleep(POLL_MS);
      reason = this.blocked();
    }
    this.held = [];
    // The typed prompt starts a turn, if none is running.
    this.line.setIdle(false);
    try {
      this.options.write(`${PASTE_START}${pasteText(text)}${PASTE_END}`);
      await sleep(SUBMIT_DELAY_MS);
      this.options.write("\r");
      await sleep(SETTLE_MS);
    } finally {
      const held = this.held;
      this.held = null;
      for (const data of held) this.options.write(data);
    }
    return { typed: true };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
