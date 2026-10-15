// Building the scoped history's indexes within a daily write budget: building one
// writes a row per Event it covers, and a Durable Object's written rows are capped
// per day, so a Channel with a long history must not build them all at once.

import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { buildHistoryIndexes, HISTORY_INDEXES } from "../src/channel";
import { channelStub } from "./client";

afterEach(() => reset());

it("builds what fits today's budget, and the rest on later days", async () => {
  await runInDurableObject(channelStub(), (_channel, state) => {
    const sql = state.storage.sql;
    for (const index of HISTORY_INDEXES) sql.exec(`DROP INDEX IF EXISTS ${index.name}`);
    sql.exec("DROP TABLE IF EXISTS index_builds");
    // 300 Events by Agents, 50 of them on a Task, and 5 Wakes.
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

    // events_by_agent covers 300 rows, more than the day allows: everything smaller is built.
    expect([...buildHistoryIndexes(sql, "2026-10-15", 200)].sort()).toEqual([
      "events_by_task",
      "events_directives_to",
      "events_renames_of",
      "events_wakes",
    ]);
    expect(built()).not.toContain("events_by_agent");
    // The same day, nothing is left of its budget for it.
    expect(buildHistoryIndexes(sql, "2026-10-15", 350).has("events_by_agent")).toBe(false);
    // The next day it fits.
    expect(buildHistoryIndexes(sql, "2026-10-16", 350).has("events_by_agent")).toBe(true);
    expect(built()).toEqual(HISTORY_INDEXES.map((i) => i.name).sort());
    expect(sql.exec("SELECT day, rows FROM index_builds ORDER BY day").toArray()).toEqual([
      { day: "2026-10-15", rows: 55 },
      { day: "2026-10-16", rows: 300 },
    ]);
  });
});
