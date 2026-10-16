// This browser's attach key (ADR 0021): an ECDSA P-256 key pair made here, whose private
// half cannot be exported and stays in IndexedDB. The Agent's owner allows its
// fingerprint on their own machine; from then on the wrapper takes keystrokes signed by it.

import { attachKeyFingerprint, signedAllowChange, signedInput, type TerminalInputOp, toBase64 } from "@shared/index";

export interface AttachKey {
  /** The public key, SPKI, base64: sent with every input frame. */
  spki: string;
  fingerprint: string;
  sign(
    repo: string,
    agent: string,
    nonce: string,
    seq: number,
    op: TerminalInputOp | undefined,
    text: string,
  ): Promise<string>;
  /** Signs a change to who may use a Host (ADR 0028), for the Host to check against its attach.json. */
  signAllow(repo: string, host: string, at: number, seq: number, allow: readonly string[], allowChannel: boolean): Promise<string>;
}

const DB = "switchboard";
const STORE = "attach-key";
const ID = "default";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function database(): Promise<IDBDatabase> {
  const open = indexedDB.open(DB, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  return request(open);
}

let loading: Promise<AttachKey> | null = null;

/** This browser's attach key, made the first time it is asked for. */
export function attachKey(): Promise<AttachKey> {
  loading ??= load().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

async function load(): Promise<AttachKey> {
  const db = await database();
  let pair = await request(db.transaction(STORE).objectStore(STORE).get(ID) as IDBRequest<CryptoKeyPair | undefined>);
  if (pair === undefined) {
    // Not extractable: the private key can sign here and cannot be read out, by this page or anyone.
    pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(pair, ID));
  }
  db.close();
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const privateKey = pair.privateKey;
  return {
    spki: toBase64(spki),
    fingerprint: await attachKeyFingerprint(spki),
    async sign(repo, agent, nonce, seq, op, text) {
      const message = new TextEncoder().encode(signedInput(repo, agent, nonce, seq, op, text));
      // WebCrypto's ECDSA signature is already r || s, as the wrapper verifies it.
      return toBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, message)));
    },
    async signAllow(repo, host, at, seq, allow, allowChannel) {
      const message = new TextEncoder().encode(signedAllowChange(repo, host, at, seq, allow, allowChannel));
      return toBase64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, message)));
    },
  };
}

let lastSeq = 0;

/**
 * The next sequence number for an input frame. It follows the clock, in microseconds,
 * so a reloaded page or a second tab with the same key keeps counting up and the
 * wrapper does not take its frames for replays.
 */
export function nextSeq(now = Date.now()): number {
  lastSeq = Math.max(lastSeq + 1, now * 1000);
  return lastSeq;
}

const ARROWS: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Delete: "\x1b[3~",
};

/** What a terminal receives for a key press, or null when the key types nothing there. */
export function keyInput(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | null {
  if (e.metaKey) return null; // The browser's own shortcuts: copy, paste, reload.
  if (e.ctrlKey && !e.altKey && e.key.length === 1) {
    const code = e.key.toUpperCase().charCodeAt(0);
    // Ctrl+A to Ctrl+Z, and Ctrl+[ \ ] ^ _ : the control codes 1 to 31.
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
    return null;
  }
  if (e.key === "Enter") return "\r";
  if (e.key === "Backspace") return "\x7f";
  if (e.key === "Tab") return e.shiftKey ? "\x1b[Z" : "\t";
  if (e.key === "Escape") return "\x1b";
  if (e.key in ARROWS) return ARROWS[e.key] ?? null;
  if (e.key.length === 1) return e.altKey ? `\x1b${e.key}` : e.key;
  return null;
}

/**
 * What a terminal receives for pasted `text`. Line breaks become Enter. When the CLI asked
 * for bracketed paste, the text goes in between the start and end markers, so a
 * multi-line paste is one prompt; its own ESC bytes are shown as \u241b, as xterm.js
 * does, so the text cannot end the paste early and run the rest as keystrokes.
 */
export function pasteInput(text: string, bracketed: boolean): string {
  const lines = text.replace(/\r?\n/g, "\r");
  return bracketed ? `\x1b[200~${lines.replaceAll("\x1b", "\u241b")}\x1b[201~` : lines;
}
