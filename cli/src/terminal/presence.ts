// Who is at an Agent's live terminal from the Dashboard (ADR 0021): the keys that typed
// lately and the Persons watching. The wrapper records an attach each time a key starts
// typing again after a quiet spell, and tells the owner in their own terminal when
// someone starts watching or typing.

import { TERMINAL_ATTACHED_MS } from "../../../shared/src/index";
import { BIDI_CONTROLS } from "./screen";

export interface Attached {
  fingerprint: string;
  person: string;
}

export class TerminalPresence {
  private readonly typing = new Map<string, { person: string; at: number }>();
  private watching = new Set<string>();
  /** Everyone who watched or typed during this run, for the summary when it ends. */
  private readonly watched = new Set<string>();
  private readonly typed = new Map<string, string>();

  constructor(
    /** The Person who runs this wrapper: their own watching is not news to them. */
    private readonly owner: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Key `fingerprint`, labelled `person`, typed. True when that is an attach: the key's
   * first keystroke this run, or its first after TERMINAL_ATTACHED_MS without one.
   */
  keyTyped(fingerprint: string, person: string): boolean {
    const now = this.now();
    const last = this.typing.get(fingerprint);
    this.typing.set(fingerprint, { person, at: now });
    this.typed.set(fingerprint, person);
    return last === undefined || now - last.at >= TERMINAL_ATTACHED_MS;
  }

  /** The keys that typed within TERMINAL_ATTACHED_MS, as the screen shows them. */
  attached(): { person: string; key: string }[] {
    const now = this.now();
    return [...this.typing]
      .filter(([, k]) => now - k.at < TERMINAL_ATTACHED_MS)
      .map(([fingerprint, k]) => ({ person: k.person, key: fingerprint.slice(0, 4) }));
  }

  /** The Channel's list of who watches now. Returns those who started watching, the owner aside. */
  watchers(persons: readonly string[]): string[] {
    const now = new Set(persons);
    const started = [...now].filter((p) => !this.watching.has(p) && p !== this.owner);
    for (const p of started) this.watched.add(p);
    this.watching = now;
    return started;
  }

  /** What happened at the terminal this run, for the owner once the CLI has exited; null when nothing did. */
  summary(): string | null {
    const typed = [...this.typed].map(([fingerprint, person]) => `${person} (key ${fingerprint.slice(0, 4)})`);
    const parts = [
      ...(this.watched.size > 0 ? [`watched from the Dashboard: ${[...this.watched].join(", ")}`] : []),
      ...(typed.length > 0 ? [`typed from the Dashboard: ${typed.join(", ")}`] : []),
    ];
    return parts.length > 0 ? `This run's terminal was ${parts.join("; ")}.` : null;
  }
}

/**
 * A terminal notification (OSC 9), which iTerm2, WezTerm, kitty and Ghostty show and
 * other terminals ignore. It moves no cursor and prints nothing on the screen, so it
 * never disturbs the CLI's own drawing, as a line written mid-run would.
 */
export function terminalNotification(text: string): string {
  // Only printable text: the notification ends at the first BEL or ESC.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  return `\x1b]9;${text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(BIDI_CONTROLS, " ")}\x07`;
}
