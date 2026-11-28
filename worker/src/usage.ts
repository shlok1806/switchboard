// Account usage (ADR 0011): every `/usage` reading an Agent's wrapper reports is kept
// by the account it was read for, for a day, so the Dashboard can show each
// account's latest limits and how its session percent moved. An Agent keeps its own
// latest report on its row (agents.ts); this is the account side.
//
// A reading that says what the account's latest one says is not kept again, whenever
// it was read: a wrapper may send the same reading with every heartbeat, two Agents on
// one account read the same limits, and an idle account's limits do not move. So the
// history holds each change, and the Agent's own report says when it last read them.
// Every query goes through the primary key (email, read_at) and reads a bounded number
// of rows: the table holds a day of readings per account.

import type { AccountUsage, LimitsReading, UsagePoint } from "../../shared/src/index";
import { ACCOUNT_HISTORY_MS, MAX_ACCOUNT_HISTORY, sameReading } from "../../shared/src/index";

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
   * Keeps one reading of an account's limits, unless the account's latest reading says
   * the same already. Answers the account as it is now, or null when nothing changed or
   * the reading is too old to keep.
   */
  record(email: string, plan: string | undefined, limits: LimitsReading): AccountUsage | null {
    const at = Date.parse(limits.readAt);
    const now = this.now();
    if (at < now - ACCOUNT_HISTORY_MS) return null;
    const latest = this.sql
      .exec<ReadingRow>("SELECT * FROM account_usage WHERE email = ? ORDER BY read_at DESC LIMIT 1", email)
      .toArray()[0];
    if (
      latest !== undefined &&
      (latest.read_at === at ||
        (at > latest.read_at &&
          latest.plan === (plan ?? null) &&
          sameReading(JSON.parse(latest.limits), limits, "readAt")))
    ) {
      return null;
    }
    // An older reading that arrives late still finds its place in the history.
    const kept = this.sql
      .exec(
        "INSERT OR IGNORE INTO account_usage (email, read_at, plan, limits) VALUES (?, ?, ?, ?) RETURNING read_at",
        email,
        at,
        plan ?? null,
        JSON.stringify(limits),
      )
      .toArray();
    if (kept.length === 0) return null;
    this.expire(email);
    return this.account(email);
  }

  /**
   * Every account with a reading in the last `ACCOUNT_HISTORY_MS`, most recently read
   * first. Steps from one account to the next through the key, a row each, and drops
   * the readings of an account that has none left in the day.
   */
  list(): AccountUsage[] {
    const accounts: AccountUsage[] = [];
    let email = "";
    for (;;) {
      const next = this.sql
        .exec<{ email: string }>("SELECT email FROM account_usage WHERE email > ? ORDER BY email LIMIT 1", email)
        .toArray()[0];
      if (next === undefined) break;
      email = next.email;
      const account = this.account(email);
      if (account === null) this.expire(email);
      else accounts.push(account);
    }
    return accounts.sort((a, b) => Date.parse(b.limits.readAt) - Date.parse(a.limits.readAt));
  }

  /** Drops `email`'s readings older than a day. */
  private expire(email: string): void {
    this.sql.exec("DELETE FROM account_usage WHERE email = ? AND read_at < ?", email, this.now() - ACCOUNT_HISTORY_MS);
  }

  /** The account with its latest `MAX_ACCOUNT_HISTORY` readings of the last day, or null when it has none. */
  private account(email: string): AccountUsage | null {
    const rows = this.sql
      .exec<ReadingRow>(
        "SELECT * FROM account_usage WHERE email = ? AND read_at >= ? ORDER BY read_at DESC LIMIT ?",
        email,
        this.now() - ACCOUNT_HISTORY_MS,
        MAX_ACCOUNT_HISTORY,
      )
      .toArray()
      .reverse();
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
    // The plan of the latest reading read that named one.
    const plan = [...rows].reverse().find((row) => row.plan !== null)?.plan ?? undefined;
    return {
      email,
      ...(plan === undefined ? {} : { plan }),
      limits: JSON.parse(latest.limits) as LimitsReading,
      history,
    };
  }
}
