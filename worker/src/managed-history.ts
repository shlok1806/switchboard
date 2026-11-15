import type { ChannelEvent } from "../../shared/src/index";
import { MAX_EVENT_IDS, MAX_HISTORY_LIMIT } from "../../shared/src/index";
import { ManagedReadFailure } from "./managed-channel";
import { safeSharedEvent } from "./managed-projection";
import type { CandidateWindow } from "./managed-query";

/** Stored queries only. Merged/local queries remain closed in this subset. */
export type ManagedHistoryQuery =
  | { ids: string[]; after: 0; limit: number; wakes: false }
  | { ids?: undefined; after: number; limit: number; wakes: boolean };

export function managedHistoryQuery(params: URLSearchParams): ManagedHistoryQuery {
  // Do not silently turn a merged/scoped request into a different query.
  for (const key of params.keys())
    if (!["ids", "after", "limit", "type"].includes(key) || params.getAll(key).length !== 1)
      throw new ManagedReadFailure(404);
  const ids = params.get("ids");
  if (ids !== null) {
    if (["after", "limit", "type"].some((key) => params.has(key))) throw new ManagedReadFailure(404);
    const values = ids.split(",");
    if (!values.length || values.length > MAX_EVENT_IDS || values.some((id) => !id || id.length > 200))
      throw new ManagedReadFailure(404);
    return { ids: [...new Set(values)], after: 0, limit: values.length, wakes: false };
  }
  const integer = (key: string, fallback: number) => {
    const text = params.get(key);
    const value = text === null ? fallback : /^\d{1,16}$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value < 0) throw new ManagedReadFailure(404);
    return value;
  };
  const after = integer("after", 0);
  const limit = integer("limit", MAX_HISTORY_LIMIT);
  if (limit < 1 || limit > MAX_HISTORY_LIMIT || (params.has("type") && params.get("type") !== "wake"))
    throw new ManagedReadFailure(404);
  return { after, limit, wakes: params.get("type") === "wake" };
}

/** Project before pagination/cursors. No delivery/Directive reference IDs in Wakes. */
export function managedStoredEvent(event: ChannelEvent) {
  // Historical login-only Persons and system actors have no enrolled execution.
  if (event.actor.kind !== "agent") return null;
  if (event.type === "wake")
    return {
      id: event.id,
      seq: event.seq,
      at: event.at,
      actor: { kind: "agent" as const, agentId: event.actor.agentId },
      type: "wake" as const,
      payload: { verdicts: [], events: [], directives: [] },
    };
  return safeSharedEvent(event);
}

/** SQL source only; the executor authorizes constituents before invoking this. */
export function managedStoredWindow<T extends { id: string; seq: number }>(
  sql: SqlStorage,
  query: ManagedHistoryQuery,
  position: string | null,
  limit: number,
): CandidateWindow {
  const rows = query.ids
    ? query.ids
        .flatMap((id) => sql.exec<T>("SELECT * FROM events WHERE id = ?", id).toArray())
        .sort((a, b) => a.seq - b.seq)
    : sql
        .exec<T>(
          "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
          position === null ? query.after : Number(position),
          limit,
        )
        .toArray();
  return {
    rows: rows.map((row) => ({ key: row.id, value: row })),
    nextInternal: rows.length ? String(rows.at(-1)?.seq) : null,
    // Short windows are not exhaustion evidence; forward reads continue to empty.
    exhausted: !!query.ids || rows.length === 0,
  };
}
