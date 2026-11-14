/** Persisted managed-only token buckets. Caller wraps admission and append in transactionSync. */
export interface UpdateBucket {
  tokens: number;
  at: number;
}
export function refillBucket(
  bucket: UpdateBucket | undefined,
  now: number,
  burst: number,
  perMinute: number,
): UpdateBucket {
  if (!Number.isFinite(now)) return { tokens: 0, at: now };
  if (!bucket) return { tokens: burst, at: now };
  // A backwards clock cannot mint tokens.
  if (!Number.isFinite(bucket.at) || !Number.isFinite(bucket.tokens) || now < bucket.at)
    return { tokens: 0, at: bucket.at };
  return { tokens: Math.min(burst, Math.max(0, bucket.tokens) + ((now - bucket.at) * perMinute) / 60_000), at: now };
}
export class ManagedUpdateBudgets {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS managed_update_buckets (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
  }
  /** Returns retry seconds, or zero after debiting BOTH buckets. No partial debit on denial. */
  consume(executionId: string | undefined, now = Date.now()): number {
    const specs = [
      { id: "channel", burst: 50, rate: 300 },
      ...(executionId ? [{ id: `execution:${executionId}`, burst: 10, rate: 30 }] : []),
    ];
    const buckets = specs.map((spec) => {
      const row = this.sql
        .exec<{ body: string }>("SELECT body FROM managed_update_buckets WHERE id=?", spec.id)
        .toArray()[0];
      return {
        spec,
        bucket: refillBucket(row ? (JSON.parse(row.body) as UpdateBucket) : undefined, now, spec.burst, spec.rate),
      };
    });
    const retry = Math.max(
      0,
      ...buckets.map(({ spec, bucket }) =>
        bucket.tokens >= 1
          ? 0
          : Math.max(1, Math.ceil((Math.max(0, bucket.at - now) + ((1 - bucket.tokens) * 60_000) / spec.rate) / 1000)),
      ),
    );
    if (retry) return retry;
    for (const { spec, bucket } of buckets)
      this.sql.exec(
        "INSERT OR REPLACE INTO managed_update_buckets VALUES(?,?)",
        spec.id,
        JSON.stringify({ tokens: bucket.tokens - 1, at: bucket.at }),
      );
    return 0;
  }
}
