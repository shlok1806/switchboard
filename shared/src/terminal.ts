// An Agent's live terminal (ADR 0021). The wrapper sends its screen, redacted, while
// someone watches. Input from a browser is signed by an attach key that the Agent's
// Person allowed on their own machine. The Channel carries both and decides neither:
// the owning wrapper checks every keystroke.

import type { AgentId } from "./domain";
import { cleanTranscriptText, TRANSCRIPT_PAGE_BYTES } from "./transcript";

/** The most often a wrapper sends its screen while watched. */
export const TERMINAL_FRAME_MS = 125;
/** The most text one input frame carries. */
export const TERMINAL_INPUT_MAX = 1024;
/** The most input frames one Person's socket may send a second. */
export const TERMINAL_INPUTS_PER_SECOND = 50;
/** A typist holds the keyboard until this long without a keystroke from them. */
export const TERMINAL_HOLD_IDLE_MS = 60_000;
/** A key counts as attached while it typed this recently. */
export const TERMINAL_ATTACHED_MS = 120_000;

/** Wrapper to watchers, through the Channel: the whole screen, as redacted text. */
export interface TerminalScreenFrame {
  type: "terminal.screen";
  agent: AgentId;
  /** This run of the wrapper: input must be signed for it. */
  nonce: string;
  cols: number;
  rows: number;
  lines: string[];
  cursor: { x: number; y: number };
  /** Keys that typed recently: the label the owner gave each and its fingerprint's first group. */
  attached: { person: string; key: string }[];
  /**
   * A dialog may be open in the CLI: a permission prompt, a question or a plan to
   * approve, or the session has not started, so one may be open that no hook reported.
   */
  prompt: boolean;
  /** The CLI asked for bracketed paste: a paste goes in between ESC [200~ and ESC [201~. */
  paste: boolean;
  /**
   * Who holds the keyboard: a key's label and fingerprint, or the owner at the terminal
   * itself (`key` null); null when no one does.
   */
  holder: { person: string; key: string | null } | null;
}

/** A Person's socket to the Channel: start or stop watching Agent `agent`. */
export interface TerminalWatchFrame {
  type: "terminal.watch";
  agent: AgentId;
  on: boolean;
}

/** Channel to wrapper: how many sockets watch its Agent now, and whose. It sends frames only while some do. */
export interface TerminalWatchersMessage {
  type: "terminal.watchers";
  agent: AgentId;
  count: number;
  /** The Persons those sockets are signed in as, each once, sorted. */
  persons: string[];
}

/**
 * A Person's socket to the Channel, then to the wrapper: text to type into Agent
 * `agent`, signed by an attach key. `from` is added by the Channel, for the wrapper's
 * log only: the wrapper trusts the key, never `from`.
 */
export interface TerminalInputFrame {
  type: "terminal.input";
  agent: AgentId;
  /** The attach key's public key, SPKI, base64. */
  key: string;
  seq: number;
  /** Absent to type `text`; `take` or `release` the keyboard, with `text` empty. */
  op?: TerminalInputOp;
  text: string;
  /** ECDSA P-256 with SHA-256 over {@link signedInput}, IEEE P1363 (r || s), base64. */
  sig: string;
  from?: string;
}

export type TerminalInputOp = "take" | "release";

/** Wrapper to watchers: why a frame was not typed. */
export interface TerminalRefusedFrame {
  type: "terminal.refused";
  agent: AgentId;
  /** The key's fingerprint. */
  fingerprint: string;
  seq: number;
  reason: string;
}

/** Wrapper to Channel: a key typed into its Agent for the first time this run. Recorded as an Event. */
export interface TerminalAttachedFrame {
  type: "terminal.attached";
  agent: AgentId;
  person: string;
  key: string;
}

/**
 * The exact text an input frame's signature covers, one field per line. The Channel's
 * repo is in it, so a frame signed for an Agent in one Channel is no good in another.
 */
export function signedInput(
  repo: string,
  agent: string,
  nonce: string,
  seq: number,
  op: TerminalInputOp | undefined,
  text: string,
): string {
  return `switchboard-terminal-input\n${repo}\n${agent}\n${nonce}\n${seq}\n${op ?? "type"}\n${text}`;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** An attach key's fingerprint: SHA-256 of its SPKI, base32, five groups of four. */
export async function attachKeyFingerprint(spki: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", spki));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 20) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
    if (out.length === 20) break;
  }
  return out.match(/.{4}/g)?.join("-") ?? out;
}

/** A fingerprint as a Person may type it (any case, with or without dashes), or null when it is not one. */
export function normalizeFingerprint(raw: string): string | null {
  const plain = raw.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z2-7]{20}$/.test(plain)) return null;
  return plain.match(/.{4}/g)?.join("-") ?? null;
}

/**
 * `GET /api/agents/:id/terminal` (ADR 0024): Agent `agent`'s screen as its wrapper sends
 * watchers, plain text with every secret it recognises masked. Any Person or Agent on the
 * Channel may read it while the Agent runs; the Channel records a `terminal.read` Event.
 */
export interface TerminalReadResponse {
  agent: AgentId;
  cols: number;
  rows: number;
  /** The screen's rows, its bottom ones when it is cut: at most `TRANSCRIPT_PAGE_BYTES` in all. */
  lines: string[];
  /** Rows from the top of the screen left out to keep the read within its cap. */
  cut?: number;
}

/** The path that reads an Agent's screen. */
export function terminalReadPath(id: AgentId): string {
  return `/api/agents/${encodeURIComponent(id)}/terminal`;
}

/** Channel to wrapper: send Agent `agent`'s screen, answering with `id`. */
export interface TerminalReadRequestMessage {
  type: "terminal.read.request";
  agent: AgentId;
  id: string;
}

/** Wrapper to Channel: the screen asked for as `id`, or why there is none. */
export type TerminalTextFrame = {
  type: "terminal.text";
  agent: AgentId;
  id: string;
} & ({ cols: number; rows: number; lines: string[] } | { error: string });

/** The most rows and columns a screen read carries: anything past them is not a screen. */
export const TERMINAL_READ_MAX_ROWS = 300;
export const TERMINAL_READ_MAX_COLS = 1000;

/** A screen as it came off a wrapper's socket, cleaned, or null when it is not one. */
export function cleanTerminalText(raw: Record<string, unknown>): Omit<TerminalReadResponse, "agent"> | null {
  const { cols, rows, lines } = raw;
  const count = (value: unknown, max: number) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
  if (!count(cols, TERMINAL_READ_MAX_COLS) || !count(rows, TERMINAL_READ_MAX_ROWS) || !Array.isArray(lines)) {
    return null;
  }
  if (lines.length > TERMINAL_READ_MAX_ROWS || !lines.every((l) => typeof l === "string")) return null;
  const width = cols as number;
  // Text only: no escape sequence or control character, one row a line, cut to its width.
  const clean = (lines as string[]).map((l) => cleanTranscriptText(l).replace(/\n/g, " ").slice(0, width));
  // At most a transcript page in all, as ADR 0024 promises: the bottom rows, where the
  // latest output and the prompt are, and how many from the top were left out.
  const encoder = new TextEncoder();
  let bytes = 0;
  let first = clean.length;
  while (first > 0) {
    const cost = encoder.encode(clean[first - 1] ?? "").length + 1;
    if (bytes + cost > TRANSCRIPT_PAGE_BYTES) break;
    bytes += cost;
    first--;
  }
  return {
    cols: width,
    rows: rows as number,
    lines: clean.slice(first),
    ...(first > 0 ? { cut: first } : {}),
  };
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Bytes from base64, or null when it is not base64. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
