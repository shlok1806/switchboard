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
 * Claude Code clears its input on a second Escape within this long of the first
 * (its double-press window).
 */
export const DOUBLE_ESCAPE_MS = 800;

/** One key the Person pressed, as far as the input line goes. */
type Key =
  | { kind: "text"; text: string }
  | { kind: "enter" | "escape" | "backspace" | "delete-word" | "clear" | "other" };

/**
 * `text` without its last word, the way Ctrl+W and Alt+Backspace delete one: spaces
 * before the cursor, then a run of word characters or a run of punctuation. Where
 * Claude Code's keys could delete more (Ctrl+W takes `src/app.ts` whole), this
 * takes the least, so the line is never thought empty while it is not.
 */
function withoutLastWord(text: string): string {
  const trimmed = text.replace(/\s+$/u, "");
  const word = /(?:[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]+)$/u.exec(trimmed);
  return word ? trimmed.slice(0, word.index) : trimmed;
}

/**
 * What the Person's keystrokes say about their input line. Only a guess: the
 * wrapper sees keys, not Claude Code's screen, so it errs towards "not empty".
 * Like Backspace, the word keys assume the cursor is at the end of the line.
 */
export class InputLine {
  private text = "";
  private pasting = false;
  /** When the last key was an Escape, the time it was pressed. */
  private escapeAt: number | null = null;
  /** Bytes of an escape sequence split across reads. */
  private partial = "";

  constructor(private readonly now: () => number = Date.now) {}

  get empty(): boolean {
    return this.text === "" && !this.pasting;
  }

  /** The line was sent or cleared elsewhere (Claude Code reported a submitted prompt). */
  clear(): void {
    this.text = "";
  }

  /** Reads keystrokes the Person typed. Returns whether they included Enter or Escape. */
  keys(data: string): { enter: boolean; cancel: boolean } {
    let enter = false;
    let cancel = false;
    for (const key of this.read(data)) {
      // A paste marker or a key release: no key press.
      if (key === null) continue;
      if (key.kind === "enter") enter = true;
      if (key.kind === "escape") cancel = true;
      this.press(key);
    }
    return { enter, cancel };
  }

  /** What one key does to the line. */
  private press(key: Key): void {
    const escapeAt = this.escapeAt;
    this.escapeAt = null;
    switch (key.kind) {
      case "text":
        this.text += key.text;
        return;
      case "enter":
      case "clear":
        this.text = "";
        return;
      case "escape": {
        const now = this.now();
        if (escapeAt !== null && now - escapeAt <= DOUBLE_ESCAPE_MS) {
          // A double Escape clears the line. A third starts over.
          this.text = "";
        } else {
          this.escapeAt = now;
        }
        return;
      }
      case "backspace":
        this.text = [...this.text].slice(0, -1).join("");
        return;
      case "delete-word":
        this.text = withoutLastWord(this.text);
        return;
      case "other":
        return;
    }
  }

  /** The keys in `data`, keeping an escape sequence split across reads for the next one. */
  private *read(data: string): Generator<Key | null> {
    const text = this.partial + data;
    this.partial = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i] ?? "";
      if (ch === "\x1b") {
        const rest = text.slice(i);
        if (rest.length === 1 || rest[1] === "\x1b") {
          // A lone Escape at the end of a read, or one followed by another: a key press, most likely.
          yield { kind: "escape" };
          i += 1;
          continue;
        }
        if (rest[1] !== "[" && rest[1] !== "O") {
          // Alt+Backspace, or another Alt+key.
          yield { kind: rest[1] === "\x7f" ? "delete-word" : "other" };
          i += 2;
          continue;
        }
        // After the Escape: "[" or "O", parameters, intermediates, and the final byte.
        const csi = /^[[O]([0-9;:?<>=]*)([ -/]*)([@-~])/.exec(rest.slice(1));
        if (!csi) {
          // Incomplete: wait for the rest.
          this.partial = rest;
          return;
        }
        yield this.sequence(csi[1] ?? "", csi[3] ?? "");
        i += 1 + csi[0].length;
        continue;
      }
      i += 1;
      if (this.pasting) yield { kind: "text", text: ch };
      else if (ch === "\r" || ch === "\n") yield { kind: "enter" };
      // Ctrl+C and Ctrl+U clear Claude Code's input; Ctrl+W deletes a word.
      else if (ch === "\x03" || ch === "\x15") yield { kind: "clear" };
      else if (ch === "\x17") yield { kind: "delete-word" };
      else if (ch === "\x7f" || ch === "\b") yield { kind: "backspace" };
      else if (ch >= " ") yield { kind: "text", text: ch };
      else yield { kind: "other" };
    }
  }

  /**
   * One escape sequence: paste markers, and keys sent as
   * `CSI <code>[:<alternates>] ; <mods>[:<event>] u` (the kitty keyboard protocol).
   * A key release is no key press, so it yields nothing.
   */
  private sequence(params: string, final: string): Key | null {
    if (final === "~" && params === "200") {
      this.pasting = true;
      return null;
    }
    if (final === "~" && params === "201") {
      this.pasting = false;
      return null;
    }
    if (final !== "u") return { kind: "other" };
    const [codeField = "", modsField = ""] = params.split(";");
    const [mods, event] = modsField.split(":");
    if (event === "3") return null;
    const code = Number(codeField.split(":")[0]);
    const flags = Math.max(0, Number(mods || "1") - 1);
    const ctrl = (flags & 4) !== 0;
    const alt = (flags & 2) !== 0;
    // Super, hyper and meta are the bits above.
    const command = ctrl || alt || flags >= 8;
    if (code === 13) return { kind: "enter" };
    if (code === 27) return { kind: "escape" };
    if (ctrl && (code === 99 || code === 117)) return { kind: "clear" };
    if ((ctrl && code === 119) || (alt && code === 127)) return { kind: "delete-word" };
    if (code === 127 || code === 8) return { kind: "backspace" };
    // Codes in Unicode's private use area are keys with no text: arrows, F-keys, modifiers.
    const printable = code >= 32 && !(code >= 0xe000 && code <= 0xf8ff);
    if (printable && !command) return { kind: "text", text: String.fromCodePoint(code) };
    return { kind: "other" };
  }
}

export interface InterruptTyperOptions {
  /** Writes into the agent CLI's pty. */
  write: (data: string) => void;
  quietMs?: number;
  waitMs?: number;
  log: (line: string) => void;
  now?: () => number;
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
    this.line = new InputLine(this.now);
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

  /** A hook the agent CLI ran: when the session is ready, and when a dialog opens or closes. */
  hook(input: ClaudeHookInput): void {
    switch (input.hook_event_name) {
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
