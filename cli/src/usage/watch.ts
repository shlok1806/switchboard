// Puts one usage report together for a Claude Code session (ADR 0011): the account
// the session runs under and its limits (limits.ts), and what the session itself
// used (session.ts). A part that cannot be read this time keeps what was read
// before, so a `/usage` that fails once shows the last reading, aging, rather than
// none.

import type { ReportedUsage } from "../../../shared/src/index";
import type { AccountReading } from "./limits";
import type { SessionTally } from "./session";

export class UsageWatch {
  private last: AccountReading = {};

  constructor(
    private readonly readAccount: () => Promise<AccountReading>,
    private readonly tally: SessionTally,
    private readonly report: (usage: ReportedUsage) => void,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Reads everything once and reports it. Never throws. */
  async read(): Promise<void> {
    const [account, session] = await Promise.allSettled([this.readAccount(), this.tally.read()]);
    if (account.status === "fulfilled") {
      const now = account.value;
      if (now.limits === undefined && this.last.limits !== undefined)
        this.log("usage: /usage named no limits; keeping the last reading");
      this.last = {
        ...this.last,
        ...now,
        // A reading of another account must not keep this one's limits.
        ...(now.email !== undefined && now.email !== this.last.email && now.limits === undefined
          ? { limits: undefined }
          : {}),
      };
    } else {
      this.log(`usage: could not read the account: ${(account.reason as Error).message}`);
    }
    const { email, plan, limits } = this.last;
    const usage: ReportedUsage = {
      ...(email === undefined ? {} : { email }),
      ...(plan === undefined ? {} : { plan }),
      ...(limits === undefined ? {} : { limits }),
      ...(session.status === "fulfilled" ? { session: session.value } : {}),
    };
    if (Object.keys(usage).length === 0) return;
    this.report(usage);
  }
}
