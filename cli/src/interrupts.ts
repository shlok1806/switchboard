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
 * What the Person's keystrokes say about their input line. Only a guess: the
 * wrapper sees keys, not Claude Code's screen, so it errs towards "not empty".
 */
export class InputLine {
  private chars = 0;
  private pasting = false;
  /** Bytes of an escape sequence split across reads. */
  private partial = "";

  get empty(): boolean {
    return this.chars === 0 && !this.pasting;
  }

  /** The line was sent or cleared elsewhere (Claude Code reported a submitted prompt). */
  clear(): void {
    this.chars = 0;
  }

  /** Reads keystrokes the Person typed. Returns whether they included Enter or Escape. */
  keys(data: string): { enter: boolean; cancel: boolean } {
    const text = this.partial + data;
    this.partial = "";
    let enter = false;
    let cancel = false;
    let i = 0;
    while (i < text.length) {
      const ch = text[i] ?? "";
      if (ch === "\x1b") {
        const rest = text.slice(i);
        if (rest.length === 1) {
          // A lone Escape at the end of a read: a key press, most likely.
          cancel = true;
          i += 1;
          continue;
        }
        if (rest[1] !== "[" && rest[1] !== "O") {
          // Alt+key, or Escape followed by something else.
          cancel ||= rest[1] === "\x1b";
          i += 2;
          continue;
        }
        // After the Escape: "[" or "O", parameters, intermediates, and the final byte.
        const csi = /^[[O]([0-9;:?<>=]*)([ -/]*)([@-~])/.exec(rest.slice(1));
        if (!csi) {
          // Incomplete: wait for the rest.
          this.partial = rest;
          break;
        }
        this.sequence(csi[1] ?? "", csi[3] ?? "", (key) => {
          if (key === "enter") enter = true;
          if (key === "escape") cancel = true;
        });
        i += 1 + csi[0].length;
        continue;
      }
      if (this.pasting) {
        this.chars += 1;
      } else if (ch === "\r" || ch === "\n") {
        this.chars = 0;
        enter = true;
      } else if (ch === "\x03" || ch === "\x15") {
        // Ctrl+C and Ctrl+U clear Claude Code's input.
        this.chars = 0;
      } else if (ch === "\x7f" || ch === "\b") {
        this.chars = Math.max(0, this.chars - 1);
      } else if (ch >= " ") {
        this.chars += 1;
      }
      i += 1;
    }
    return { enter, cancel };
  }

  /** One escape sequence: paste markers, and keys sent as `CSI <code> ; <mods> u` (the kitty keyboard protocol). */
  private sequence(params: string, final: string, key: (key: "enter" | "escape") => void): void {
    if (final === "~" && params === "200") {
      this.pasting = true;
      return;
    }
    if (final === "~" && params === "201") {
      this.pasting = false;
      return;
    }
    if (final !== "u") return;
    const [code, mods] = params.split(";").map((p) => Number(p.split(":")[0]));
    const ctrl = mods !== undefined && ((mods - 1) & 4) !== 0;
    if (code === 13) {
      this.chars = 0;
      key("enter");
    } else if (code === 27) {
      key("escape");
    } else if (ctrl && (code === 99 || code === 117)) {
      this.chars = 0;
    } else if (code === 127 || code === 8) {
      this.chars = Math.max(0, this.chars - 1);
    } else if (code !== undefined && code >= 32 && !ctrl) {
      this.chars += 1;
    }
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
  private readonly line = new InputLine();
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
