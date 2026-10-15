// Building the scoped history's indexes within a daily write budget: building one
// writes a row per Event it covers, and a Durable Object's written rows are capped
// per day, so a Channel with a long history must not build them all at once.

import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { buildHistoryIndexes, createEventsTable, HISTORY_INDEXES, utcDay } from "../src/channel";
import { channelStub } from "./client";

afterEach(() => reset());

/** 300 Events by Agents, 50 of them on a Task, and 5 Wakes, with no history index built yet. */
function seed(sql: SqlStorage): void {
  for (const index of HISTORY_INDEXES) sql.exec(`DROP INDEX IF EXISTS ${index.name}`);
  sql.exec("DELETE FROM index_builds");
  for (let i = 0; i < 300; i++) {
    sql.exec(
      `INSERT INTO events (id, at, type, actor, capture, task, turn, payload, actor_kind, actor_id)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, '{}', 'agent', 'shlok/claude/7f3a')`,
      `e${i}`,
      new Date().toISOString(),
      i < 5 ? "wake" : "tool.call",
      JSON.stringify({ kind: "agent", agentId: "shlok/claude/7f3a" }),
      i % 6 === 0 ? 7 : null,
    );
  }
}

it("builds what fits today's budget, one index past it on a day that spent nothing, and the rest on later days", async () => {
  await runInDurableObject(channelStub(), (_channel, state) => {
    const sql = state.storage.sql;
    seed(sql);
    const built = () =>
      sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (" +
            HISTORY_INDEXES.map((i) => `'${i.name}'`).join(", ") +
            ")",
        )
        .toArray()
        .map((r) => r.name)
        .sort();

    // events_by_agent covers 300 rows, more than the day allows. Nothing is spent yet,
    // so it is built anyway, and the rest waits.
    expect([...buildHistoryIndexes(sql, "2026-10-15", 200, 1000).built]).toEqual(["events_by_agent"]);
    // Later the same day: nothing more is built, and the Events are not counted again.
    expect([...buildHistoryIndexes(sql, "2026-10-15", 200, 1000).built]).toEqual(["events_by_agent"]);
    // The next day the rest fits.
    expect(buildHistoryIndexes(sql, "2026-10-16", 200, 1000).built.size).toBe(HISTORY_INDEXES.length);
    expect(built()).toEqual(HISTORY_INDEXES.map((i) => i.name).sort());
    // What SQLite says each build wrote: a row per Event it covers, and its schema row.
    expect(sql.exec("SELECT day, rows FROM index_builds ORDER BY day").toArray()).toEqual([
      { day: "2026-10-15", rows: 300 + 1 },
      { day: "2026-10-16", rows: 55 + 4 },
    ]);
  });
});

it("never builds an index past the ceiling, and keeps saying so without counting again", async () => {
  await runInDurableObject(channelStub(), (_channel, state) => {
    const sql = state.storage.sql;
    seed(sql);
    const first = buildHistoryIndexes(sql, "2026-10-15", 200, 100);
    expect([...first.tooLarge]).toEqual(["events_by_agent"]);
    expect(first.built.has("events_by_task")).toBe(true);
    const again = buildHistoryIndexes(sql, "2026-10-16", 200, 100);
    expect([...again.tooLarge]).toEqual(["events_by_agent"]);
    expect([...buildHistoryIndexes(sql, "2026-10-16", 200, 100).tooLarge]).toEqual(["events_by_agent"]);
  });
});

it("charges the actor columns' one-time backfill to the same day's budget", async () => {
  await runInDurableObject(channelStub(), (_channel, state) => {
    const sql = state.storage.sql;
    sql.exec("DROP TABLE events");
    sql.exec("DROP TABLE IF EXISTS index_builds");
    sql.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL,
      type TEXT NOT NULL, actor TEXT NOT NULL, capture TEXT, task INTEGER, turn TEXT, payload TEXT NOT NULL)`);
    for (let i = 0; i < 40; i++) {
      sql.exec(
        "INSERT INTO events (id, at, type, actor, payload) VALUES (?, ?, 'tool.call', ?, '{}')",
        `e${i}`,
        new Date().toISOString(),
        JSON.stringify({ kind: "person", person: "shlok" }),
      );
    }
    createEventsTable(sql);
    expect(sql.exec("SELECT rows FROM index_builds WHERE day = ?", utcDay()).one().rows).toBeGreaterThanOrEqual(40);
    expect(sql.exec("SELECT count(*) AS n FROM events WHERE actor_id = 'shlok'").one().n).toBe(40);
  });
});
