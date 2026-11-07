// How the CLI's connections to a Channel behave when the Channel stops answering
// (ADR 0052). A wedged `wrangler dev` once held every local port of a Mac: its
// clients kept trying at a fixed rate, and closed sockets nobody answered, which
// stayed open. So: every socket has a deadline to open and to close, after which it
// is destroyed; every retry waits longer, with jitter; and a machine out of ports or
// file descriptors is named as such, and waited out, instead of added to.

/** The errno codes that mean this machine, not the Channel, is out of something. */
const EXHAUSTED = new Set(["EADDRNOTAVAIL", "EMFILE", "ENFILE", "ENOBUFS"]);

/** What a Person reads when the machine has run out of local ports or file descriptors. */
export function exhaustionMessage(code: string): string {
  return code === "EADDRNOTAVAIL"
    ? "this machine has run out of local ports (EADDRNOTAVAIL); something is holding thousands of connections. " +
        "`lsof -nP -iTCP -sTCP:ESTABLISHED | awk '{print $1, $2}' | sort | uniq -c | sort -rn | head` names it"
    : `this machine has run out of file descriptors (${code}); something is holding thousands of them. ` +
        "`lsof -n | awk '{print $1, $2}' | sort | uniq -c | sort -rn | head` names it";
}

/**
 * The errno code when `error`, or any error in its `cause` chain (fetch wraps the
 * socket's), says this machine is out of local ports or file descriptors; else null.
 */
export function exhaustedCode(error: unknown): string | null {
  for (let at: unknown = error, depth = 0; at !== null && typeof at === "object" && depth < 5; depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && EXHAUSTED.has(code)) return code;
    const text = (at as { message?: unknown }).message;
    if (typeof text === "string") {
      for (const name of EXHAUSTED) if (text.includes(name)) return name;
    }
    at = (at as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Exponential backoff with jitter: the n-th wait in a row is a random time between
 * half and all of `baseMs * 2^n`, capped at `maxMs`. Jitter keeps every wrapper on a
 * machine from retrying in step.
 */
export class Backoff {
  private failures = 0;

  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
    private readonly random: () => number = Math.random,
  ) {}

  /** Failures in a row so far. */
  get count(): number {
    return this.failures;
  }

  /** One more failure: how long to wait before the next try. */
  next(): number {
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** this.failures);
    this.failures += 1;
    return Math.round(ceiling * (0.5 + this.random() / 2));
  }

  /** The longest wait, for a failure that should not be retried soon. */
  longest(): number {
    this.failures += 1;
    return Math.round(this.maxMs * (0.5 + this.random() / 2));
  }

  reset(): void {
    this.failures = 0;
  }
}
