// An Agent's live terminal (ADR 0021). The wrapper sends its screen, redacted, while
// someone watches. Input from a browser is signed by an attach key that the Agent's
// Person allowed on their own machine. The Channel carries both and decides neither:
// the owning wrapper checks every keystroke.

import type { AgentId } from "./domain";

/** The most often a wrapper sends its screen while watched. */
export const TERMINAL_FRAME_MS = 125;
/** The most text one input frame carries. */
export const TERMINAL_INPUT_MAX = 1024;
/** The most input frames one Person's socket may send a second. */
export const TERMINAL_INPUTS_PER_SECOND = 50;
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
  text: string;
  /** ECDSA P-256 with SHA-256 over {@link signedInput}, IEEE P1363 (r || s), base64. */
  sig: string;
  from?: string;
}

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
export function signedInput(repo: string, agent: string, nonce: string, seq: number, text: string): string {
  return `switchboard-terminal-input\n${repo}\n${agent}\n${nonce}\n${seq}\n${text}`;
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
