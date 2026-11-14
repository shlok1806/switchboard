/** Managed-only local records. Capacity exhaustion fails closed instead of dropping pending evidence. */
export const MANAGED_RECORD_CAP = 1024;
export const MANAGED_OUTCOME_TTL_MS = 24 * 60 * 60 * 1000;
export type ManagedOutcomeTable = "managed_outcome_outbox" | "managed_external_outcomes";

export function appendManagedOutcome(
  sql: SqlStorage,
  table: ManagedOutcomeTable,
  id: string,
  body: Record<string, unknown>,
  now = Date.now(),
): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
  // Old rows use their original timestamp; malformed timestamps expire immediately.
  sql.exec(`DELETE FROM ${table} WHERE COALESCE(json_extract(body, '$.at'), 0) <= ?`, now - MANAGED_OUTCOME_TTL_MS);
  const count = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
  const existing = sql.exec(`SELECT id FROM ${table} WHERE id=?`, id).toArray().length > 0;
  if (!existing && count >= MANAGED_RECORD_CAP) throw new Error("managed_outcome_capacity");
  sql.exec(`INSERT OR REPLACE INTO ${table} VALUES(?,?)`, id, JSON.stringify({ ...body, at: now }));
}
