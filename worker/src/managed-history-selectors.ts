import { MAX_HISTORY_PAGE } from "../../shared/src/index";
import { ManagedReadFailure } from "./managed-channel";
import type { QueryBinding } from "./managed-query";

export interface HistorySelection {
  source: "stored" | "merged" | "local";
  direction: "forward" | "backward";
  boundary: number;
  limit: number;
  agent?: string;
  task?: number;
  cursor?: string;
  identity: string;
}
const deny = (): never => {
  throw new ManagedReadFailure(404);
};
/** Separate from the shipped forward/ID/Wake parser; never changes those schemas. */
export function extendedHistory(params: URLSearchParams): HistorySelection | null {
  if (!["source", "tail", "before", "agent", "task", "cursor"].some((key) => params.has(key))) return null;
  for (const key of params.keys())
    if (
      !["source", "tail", "before", "after", "limit", "agent", "task", "cursor"].includes(key) ||
      params.getAll(key).length !== 1
    )
      deny();
  const number = (key: string, fallback: number) => {
    const value = params.get(key);
    const result = value === null ? fallback : /^\d{1,16}$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(result) || result < 0) deny();
    return result;
  };
  const source = params.get("source") ?? "merged";
  if (
    !["stored", "merged", "local"].includes(source) ||
    (params.has("tail") && params.has("limit")) ||
    (params.has("after") && (params.has("tail") || params.has("before")))
  )
    deny();
  const limit = number(params.has("tail") ? "tail" : "limit", MAX_HISTORY_PAGE);
  const task = params.has("task") ? number("task", 0) : undefined;
  const agent = params.get("agent") ?? undefined;
  if (
    limit < 1 ||
    limit > MAX_HISTORY_PAGE ||
    task === 0 ||
    (agent !== undefined && (!/^[^/]+\/[^/]+\/[^/]+$/.test(agent) || agent.length > 200))
  )
    deny();
  const direction = params.has("after") ? "forward" : "backward";
  const boundary = number(
    direction === "forward" ? "after" : "before",
    direction === "forward" ? 0 : Number.MAX_SAFE_INTEGER,
  );
  const identity = JSON.stringify([source, direction, boundary, limit, agent ?? null, task ?? null]);
  const cursor = params.get("cursor") ?? undefined;
  if (cursor !== undefined && (!cursor || cursor.length > 4096)) deny();
  return { source: source as HistorySelection["source"], direction, boundary, limit, agent, task, cursor, identity };
}

/** Memory-only encryption key; no query session, scanned position or authority is stored.
 * Hibernation intentionally invalidates old cursors; clients can restart the query.
 */
export class HistoryCursors {
  private readonly key: Promise<CryptoKey> = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]) as Promise<CryptoKey>;
  private readonly nonceKey = crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  private identity(binding: QueryBinding, selection: HistorySelection): string {
    return JSON.stringify([binding, selection.identity]);
  }
  async encode(binding: QueryBinding, selection: HistorySelection, boundary: number): Promise<string> {
    const data = new TextEncoder().encode(JSON.stringify([this.identity(binding, selection), boundary]));
    // A keyed deterministic nonce gives identical visible boundaries identical
    // cursors. Distinct plaintexts have pseudorandom 96-bit nonces.
    const iv = new Uint8Array(await crypto.subtle.sign("HMAC", await this.nonceKey, data)).slice(0, 12);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key, data));
    const bytes = new Uint8Array(iv.length + encrypted.length);
    bytes.set(iv);
    bytes.set(encrypted, iv.length);
    return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  }
  async decode(binding: QueryBinding, selection: HistorySelection): Promise<number> {
    if (!selection.cursor) return selection.boundary;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(selection.cursor)) return deny();
      const bytes = Uint8Array.from(atob(selection.cursor.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
        c.charCodeAt(0),
      );
      const canonical = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
      if (canonical !== selection.cursor) return deny();
      const data = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12) },
        await this.key,
        bytes.slice(12),
      );
      const [identity, boundary] = JSON.parse(new TextDecoder().decode(data));
      if (identity !== this.identity(binding, selection) || !Number.isSafeInteger(boundary) || boundary < 0)
        return deny();
      return boundary;
    } catch {
      return deny();
    }
  }
}
