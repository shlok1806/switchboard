// Who holds an Agent's keyboard (ADR 0022): the owner at the terminal itself, one
// attach key from the Dashboard, or no one. One typist at a time, so two people never
// mix their keystrokes into one prompt. The wrapper keeps the hold; the Channel only
// carries the requests.

import { TERMINAL_HOLD_IDLE_MS } from "../../../shared/src/index";

/** Ctrl+]: at the terminal, takes the keyboard back from a Dashboard holder. */
export const TAKE_BACK = "\x1d";

/**
 * The terminal's replies to queries the CLI made, as the Interrupt typer reads them
 * (interrupts.ts): control strings (OSC, DCS, APC, PM, SOS), device attributes and
 * modes (`CSI ? ...`, `CSI > ...`, `CSI ... $ y`), size, status and cursor reports
 * (`CSI ... t`, `n`, `R`), and focus (`CSI I`, `CSI O`). A reply split across two
 * reads is not seen whole and is held back with the keys around it.
 */
const REPLIES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: replies are escape sequences.
  /\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\)|\x1b\[(?:[?>][0-9;:?<>=]*[ -/]*[@-~]|[0-9;:]*\$y|[0-9;:]*[tnR]|[IO])/g;

/**
 * Who holds the keyboard. A key's `person` is its label on the owner's machine; `watcher`
 * is who the Channel says sent its take, in the names the Channel's watcher list uses.
 * The wrapper never lets `watcher` grant anything: it only ends a hold, or refuses one.
 */
export type Holder = { kind: "local" } | { kind: "key"; fingerprint: string; person: string; watcher: string };

export interface KeyboardOptions {
  /** The holder changed: to show at the terminal and on the screen. */
  onChange: (holder: Holder | null, was: Holder | null) => void;
  idleMs?: number;
}

export class TerminalKeyboard {
  private holder: Holder | null = null;
  /** Who watches the terminal now, as the Channel last said. */
  private watchers: readonly string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleMs: number;

  constructor(private readonly options: KeyboardOptions) {
    this.idleMs = options.idleMs ?? TERMINAL_HOLD_IDLE_MS;
  }

  /** Who holds the keyboard now. */
  get held(): Holder | null {
    return this.holder;
  }

  /**
   * What came in at the terminal itself. Returns what goes on to the CLI: all of it while
   * no Dashboard key holds the keyboard; while one does, only the terminal's replies to
   * the CLI's queries, which are not typing. Ctrl+] then takes the keyboard back and is
   * kept from the CLI. Replies alone (a focus report as the window changes) never take
   * the keyboard.
   */
  local(data: string): { pass: string; heldBack: boolean } {
    const keys = data.replace(REPLIES, "");
    if (this.holder?.kind === "key") {
      if (keys.includes(TAKE_BACK)) this.hold({ kind: "local" });
      return { pass: data.match(REPLIES)?.join("") ?? "", heldBack: keys !== "" && this.holder.kind === "key" };
    }
    if (keys !== "") this.hold({ kind: "local" });
    return { pass: data, heldBack: false };
  }

  /**
   * Key `fingerprint`, labelled `person`, asks for the keyboard, sent by `watcher` as the
   * Channel says. Null when it holds it now, else why not. Only someone watching the
   * terminal may hold it: the hold ends when they stop.
   */
  take(fingerprint: string, person: string, watcher: string | undefined): string | null {
    if (watcher === undefined || !this.watchers.includes(watcher)) return `${person} is not watching this terminal`;
    const refusal = this.busy(fingerprint);
    if (refusal !== null) return refusal;
    this.hold({ kind: "key", fingerprint, person, watcher });
    return null;
  }

  /** Whether key `fingerprint` holds the keyboard now. */
  holds(fingerprint: string): boolean {
    return this.holder?.kind === "key" && this.holder.fingerprint === fingerprint;
  }

  /** Key `fingerprint` typed. Null when it holds the keyboard (and keeps it), else why not. */
  typed(fingerprint: string): string | null {
    if (this.holder?.kind === "key" && this.holds(fingerprint)) {
      this.hold(this.holder);
      return null;
    }
    return this.busy(fingerprint) ?? "take the keyboard first";
  }

  /** Key `fingerprint` lets go of the keyboard, if it holds it. */
  release(fingerprint: string): void {
    if (this.holds(fingerprint)) this.free();
  }

  /** Who watches now, as the Channel names them: a Dashboard holder who stopped watching has gone. */
  watching(persons: readonly string[]): void {
    this.watchers = persons;
    if (this.holder?.kind === "key" && !persons.includes(this.holder.watcher)) this.free();
  }

  /** The wrapper lost the Channel: no Dashboard key can type or release now. */
  disconnected(): void {
    if (this.holder?.kind === "key") this.free();
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  /** Why key `fingerprint` cannot take the keyboard now, or null when it can. */
  private busy(fingerprint: string): string | null {
    const h = this.holder;
    if (h === null || (h.kind === "key" && h.fingerprint === fingerprint)) return null;
    return h.kind === "local"
      ? "the owner is typing at the terminal, and holds the keyboard"
      : `${h.person} holds the keyboard`;
  }

  private hold(holder: Holder): void {
    const was = this.holder;
    this.holder = holder;
    // Each keystroke starts the idle wait again.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.free(), this.idleMs);
    this.timer.unref?.();
    if (!same(was, holder)) this.options.onChange(holder, was);
  }

  private free(): void {
    const was = this.holder;
    clearTimeout(this.timer);
    this.holder = null;
    if (was !== null) this.options.onChange(null, was);
  }
}

function same(a: Holder | null, b: Holder | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "local" || b.kind === "local") return a.kind === b.kind;
  return a.fingerprint === b.fingerprint;
}

/** The holder as a screen frame names it: the owner at the terminal has no key. */
export function holderOf(holder: Holder | null, owner: string): { person: string; key: string | null } | null {
  if (holder === null) return null;
  return holder.kind === "local" ? { person: owner, key: null } : { person: holder.person, key: holder.fingerprint };
}
