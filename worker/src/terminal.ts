// What the Channel checks on an Agent's live terminal (ADR 0021) before carrying a frame.
// None of it decides who may type: the owning wrapper verifies every input frame's
// signature against its own allow list. These checks keep malformed or oversized frames
// off the Channel, and keep one Person's socket from flooding a wrapper.

import {
  type AgentId,
  TERMINAL_INPUT_MAX,
  TERMINAL_INPUTS_PER_SECOND,
  type TerminalAttachedFrame,
  type TerminalInputFrame,
  type TerminalRefusedFrame,
  type TerminalScreenFrame,
} from "../../shared/src/index";

/** The most Agents one Person's socket watches at once. */
export const MAX_WATCHED = 16;
/** Base64 of a P-256 SPKI is 124 characters; a P1363 signature is 88. */
const MAX_KEY = 256;
const MAX_SIG = 256;
const MAX_NONCE = 64;
const MAX_COLS = 1000;
const MAX_ROWS = 500;
const MAX_LINE = 4 * MAX_COLS;
const MAX_ATTACHED = 32;
const MAX_LABEL = 100;
const MAX_REASON = 300;

/** What a Person's socket carries: the Agents it watches. Kept on the socket, so it survives hibernation. */
export interface WatchAttachment {
  watch: AgentId[];
}

const str = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const int = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/** A Person's `terminal.input`, as the Channel forwards it, with `from` set to the sending Person; or null. */
export function parseInput(body: Record<string, unknown>, from: string): TerminalInputFrame | null {
  const { agent, key, seq, text, sig } = body;
  if (!str(agent, MAX_LABEL) || agent === "") return null;
  if (!str(key, MAX_KEY) || key === "" || !str(sig, MAX_SIG) || sig === "") return null;
  if (!int(seq, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!str(text, TERMINAL_INPUT_MAX) || text === "") return null;
  return { type: "terminal.input", agent: agent as AgentId, key, seq, text, sig, from };
}

/** A wrapper's `terminal.screen` for `agent`, rebuilt from its known fields; or null. */
export function parseScreen(body: Record<string, unknown>, agent: AgentId): TerminalScreenFrame | null {
  const { nonce, cols, rows, lines, cursor, attached, prompt } = body;
  if (!str(nonce, MAX_NONCE) || !int(cols, 1, MAX_COLS) || !int(rows, 1, MAX_ROWS)) return null;
  if (!Array.isArray(lines) || lines.length > rows || !lines.every((l) => str(l, MAX_LINE))) return null;
  const c = cursor as { x?: unknown; y?: unknown } | null;
  if (typeof c !== "object" || c === null || !int(c.x, 0, MAX_COLS) || !int(c.y, -MAX_ROWS, MAX_ROWS)) return null;
  if (!Array.isArray(attached) || attached.length > MAX_ATTACHED) return null;
  const who: TerminalScreenFrame["attached"] = [];
  for (const a of attached as { person?: unknown; key?: unknown }[]) {
    if (typeof a !== "object" || a === null || !str(a.person, MAX_LABEL) || !str(a.key, MAX_LABEL)) return null;
    who.push({ person: a.person, key: a.key });
  }
  if (typeof prompt !== "boolean") return null;
  return {
    type: "terminal.screen",
    agent,
    nonce,
    cols,
    rows,
    lines: lines as string[],
    cursor: { x: c.x, y: c.y },
    attached: who,
    prompt,
  };
}

/** A wrapper's `terminal.refused` for `agent`; or null. */
export function parseRefused(body: Record<string, unknown>, agent: AgentId): TerminalRefusedFrame | null {
  const { fingerprint, seq, reason } = body;
  if (!str(fingerprint, MAX_LABEL) || !int(seq, 0, Number.MAX_SAFE_INTEGER) || !str(reason, MAX_REASON)) return null;
  return { type: "terminal.refused", agent, fingerprint, seq, reason };
}

/** A wrapper's `terminal.attached` for `agent`; or null. */
export function parseAttached(body: Record<string, unknown>, agent: AgentId): TerminalAttachedFrame | null {
  const { person, key } = body;
  if (!str(person, MAX_LABEL) || person === "" || !str(key, MAX_LABEL) || key === "") return null;
  return { type: "terminal.attached", agent, person, key };
}

/**
 * Counts each socket's input frames per second. Kept in memory: a Durable Object that
 * receives frames is awake, and a socket that hibernated sent nothing to count.
 */
export class InputRate {
  private readonly seen = new WeakMap<object, { second: number; count: number }>();

  constructor(private readonly perSecond = TERMINAL_INPUTS_PER_SECOND) {}

  /** True when `socket` may send one more frame now. */
  take(socket: object, now = Date.now()): boolean {
    const second = Math.floor(now / 1000);
    const entry = this.seen.get(socket);
    if (entry === undefined || entry.second !== second) {
      this.seen.set(socket, { second, count: 1 });
      return true;
    }
    if (entry.count >= this.perSecond) return false;
    entry.count++;
    return true;
  }
}
