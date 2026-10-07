// Account usage (ADR 0011): every `/usage` reading an Agent's wrapper reports is kept
// by the account it was read for, for a day, so the Dashboard can show each
// account's latest limits and how its session percent moved. An Agent keeps its own
// latest report on its row (agents.ts); this is the account side.

import type { AccountUsage, LimitsReading, UsagePoint } from "../../shared/src/index";
import { ACCOUNT_HISTORY_MS } from "../../shared/src/index";

type ReadingRow = { email: string; read_at: number; plan: string | null; limits: string };

export const ACCOUNT_USAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS account_usage (
    email TEXT NOT NULL,
    read_at INTEGER NOT NULL,
    plan TEXT,
    limits TEXT NOT NULL,
    PRIMARY KEY (email, read_at)
  );
`;

export class AccountUsageStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly now: () => number = Date.now,
  ) {
    sql.exec(ACCOUNT_USAGE_SCHEMA);
  }

  /**
   * Keeps one reading of an account's limits. The same reading twice (two Agents on
   * one account report the same `/usage` run, or a heartbeat is retried) is kept
   * once. Answers the account as it is now, or null when the reading is too old to
   * keep.
   */
  record(email: string, plan: string | undefined, limits: LimitsReading): AccountUsage | null {
    const at = Date.parse(limits.readAt);
    const now = this.now();
    this.sql.exec("DELETE FROM account_usage WHERE read_at < ?", now - ACCOUNT_HISTORY_MS);
    if (at < now - ACCOUNT_HISTORY_MS) return null;
    this.sql.exec(
      "INSERT OR REPLACE INTO account_usage (email, read_at, plan, limits) VALUES (?, ?, ?, ?)",
      email,
      at,
      plan ?? null,
      JSON.stringify(limits),
    );
    return this.account(email);
  }

  /** Every account with a reading in the last `ACCOUNT_HISTORY_MS`, most recently read first. */
  list(): AccountUsage[] {
    const emails = this.sql
      .exec<{ email: string }>(
        "SELECT email FROM account_usage WHERE read_at >= ? GROUP BY email ORDER BY MAX(read_at) DESC",
        this.now() - ACCOUNT_HISTORY_MS,
      )
      .toArray();
    return emails.map(({ email }) => this.account(email)).filter((a): a is AccountUsage => a !== null);
  }

  private account(email: string): AccountUsage | null {
    const rows = this.sql
      .exec<ReadingRow>(
        "SELECT * FROM account_usage WHERE email = ? AND read_at >= ? ORDER BY read_at",
        email,
        this.now() - ACCOUNT_HISTORY_MS,
      )
      .toArray();
    const latest = rows.at(-1);
    if (latest === undefined) return null;
    const history = rows.map((row): UsagePoint => {
      const limits = JSON.parse(row.limits) as LimitsReading;
      return {
        at: limits.readAt,
        ...(limits.session === undefined ? {} : { session: limits.session.percent }),
        ...(limits.week === undefined ? {} : { week: limits.week.percent }),
      };
    });
    // The plan of the latest reading that named one.
    const plan = [...rows].reverse().find((row) => row.plan !== null)?.plan ?? undefined;
    return {
      email,
      ...(plan === undefined ? {} : { plan }),
      limits: JSON.parse(latest.limits) as LimitsReading,
      history,
    };
  }
}
