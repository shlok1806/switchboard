// A Durable Object has exactly one alarm, but several parts of the Channel need to
// wake up on their own schedule: the Task reconcile (every few minutes) and the
// Presence check (when the quietest Agent would go Gone). Each keeps its own
// deadline here, and the one real alarm is always set to the earliest of them.

/** The parts of the Channel that wake up on a timer. */
export type AlarmJob = "tasks" | "presence";

type DeadlineRow = { job: string; at: number };

export class Alarms {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS alarm_deadlines (
        job TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      );
    `);
  }

  /** When `job` next wants to wake, or null when it has nothing scheduled. */
  deadline(job: AlarmJob): number | null {
    return (
      this.storage.sql.exec<DeadlineRow>("SELECT * FROM alarm_deadlines WHERE job = ?", job).toArray()[0]?.at ?? null
    );
  }

  /** Sets (or, with null, clears) when `job` next wakes, and re-arms the alarm. */
  async set(job: AlarmJob, at: number | null): Promise<void> {
    if (this.deadline(job) === at) return;
    if (at === null) this.storage.sql.exec("DELETE FROM alarm_deadlines WHERE job = ?", job);
    else this.storage.sql.exec("INSERT OR REPLACE INTO alarm_deadlines (job, at) VALUES (?, ?)", job, at);
    await this.arm();
  }

  /**
   * Called when the alarm fires: takes the jobs that are due now off the schedule
   * and returns them. The alarm is set for the earliest deadline, so if it fires
   * before any deadline (a test running it by hand, or clock skew), that earliest
   * job is the one it fired for. Each job sets its next deadline as it runs; call
   * `arm()` afterwards.
   */
  takeDue(now = Date.now()): Set<AlarmJob> {
    const rows = this.storage.sql.exec<DeadlineRow>("SELECT * FROM alarm_deadlines ORDER BY at").toArray();
    const due = rows.filter((row) => row.at <= now);
    const fired = due.length > 0 ? due : rows.slice(0, 1);
    for (const row of fired) this.storage.sql.exec("DELETE FROM alarm_deadlines WHERE job = ?", row.job);
    return new Set(fired.map((row) => row.job as AlarmJob));
  }

  /** Sets the Durable Object alarm to the earliest deadline, or clears it when there is none. */
  async arm(): Promise<void> {
    const next = this.storage.sql
      .exec<{ next: number | null }>("SELECT MIN(at) AS next FROM alarm_deadlines")
      .one().next;
    if (next === null) await this.storage.deleteAlarm();
    else if ((await this.storage.getAlarm()) !== next) await this.storage.setAlarm(next);
  }
}
