// Usage (ADR 0011): what Claude Code's own `/usage` and `claude auth status` say,
// read from real captured outputs; when the wrapper reads them; and what a
// session's transcript says it used.

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportedUsage } from "../../shared/src/index";
import { parseAuthStatus, parseReset, parseUsage } from "../src/usage/limits";
import { UsageSchedule } from "../src/usage/schedule";
import { SessionTally } from "../src/usage/session";
import { UsageWatch } from "../src/usage/watch";

const fixture = (name: string) => readFile(join(__dirname, "fixtures", "usage", name), "utf8");
/** 2026-10-07 00:30 in Chicago (CDT, UTC-5). */
const NOW = Date.parse("2026-10-07T05:30:00Z");

describe("what /usage says", () => {
  it("reads the session, the week and every model's week, with their resets", async () => {
    const reading = parseUsage(await fixture("subscription-minutes.txt"), NOW);
    expect(reading.session).toEqual({
      percent: 82,
      resets: "Oct 7 at 1:59am (America/Chicago)",
      resetsAt: "2026-10-07T06:59:00.000Z",
    });
    expect(reading.week?.percent).toBe(44);
    expect(reading.week?.resetsAt).toBe("2026-10-07T10:59:00.000Z");
    expect(reading.models).toEqual([
      {
        model: "Fable",
        percent: 32,
        resets: "Oct 7 at 5:59am (America/Chicago)",
        resetsAt: "2026-10-07T10:59:00.000Z",
      },
    ]);
    expect(reading.readAt).toBe(new Date(NOW).toISOString());
  });

  it("reads a reset on the hour, without minutes", async () => {
    const reading = parseUsage(await fixture("subscription-max.txt"), NOW);
    expect(reading.session?.resetsAt).toBe("2026-10-07T07:00:00.000Z");
    expect(reading.week?.resetsAt).toBe("2026-10-07T11:00:00.000Z");
  });

  it("keeps what is there when lines are missing", async () => {
    const noModels = parseUsage(await fixture("subscription-no-model-week.txt"), NOW);
    expect(noModels.week?.percent).toBe(44);
    expect(noModels.models).toEqual([]);
    const sessionOnly = parseUsage(await fixture("subscription-session-only.txt"), NOW);
    expect(sessionOnly.session?.percent).toBe(82);
    expect(sessionOnly.week).toBeUndefined();
    expect(sessionOnly.models).toEqual([]);
  });

  it("finds no limits for an API key or a logged-out CLI", async () => {
    for (const name of ["api-key.txt", "not-logged-in.txt"]) {
      const reading = parseUsage(await fixture(name), NOW);
      expect(reading.session).toBeUndefined();
      expect(reading.week).toBeUndefined();
      expect(reading.models).toEqual([]);
    }
  });

  it("tolerates other wording, colours and bullets around a line", () => {
    const reading = parseUsage(
      "│ \u001b[1mCurrent session\u001b[0m — 7.5% used, resets in 3h 20m\n  • Current week (Sonnet only): 12% used\n",
      NOW,
    );
    expect(reading.session).toMatchObject({ percent: 7.5, resetsAt: new Date(NOW + 200 * 60_000).toISOString() });
    expect(reading.models).toEqual([{ model: "Sonnet only", percent: 12 }]);
  });

  it("reads a week that resets on another day", async () => {
    const reading = parseUsage(await fixture("subscription-other-week.txt"), NOW);
    expect(reading.session).toMatchObject({ percent: 23, resetsAt: "2026-10-07T07:39:00.000Z" });
    expect(reading.week).toMatchObject({ percent: 47, resetsAt: "2026-10-08T21:59:00.000Z" });
    expect(reading.models).toMatchObject([{ model: "Fable", percent: 27, resetsAt: "2026-10-08T21:59:00.000Z" }]);
  });

  it("puts a reset with no year in the coming months, and one it cannot read nowhere", () => {
    expect(parseReset("Jan 2 at 9am (America/Chicago)", NOW)).toBe("2027-01-02T15:00:00.000Z");
    expect(parseReset("whenever", NOW)).toBeUndefined();
  });
});

describe("what claude auth status says", () => {
  it("names the full email address and the plan", async () => {
    expect(parseAuthStatus(await fixture("auth-status-max.json"))).toEqual({
      email: "person@example.com",
      plan: "max",
    });
  });

  it("names nothing when logged out or unreadable", async () => {
    expect(parseAuthStatus(await fixture("auth-status-logged-out.json"))).toBeNull();
    expect(parseAuthStatus("Not logged in")).toBeNull();
  });
});

describe("when the wrapper reads usage", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  function schedule(read: () => Promise<void> = async () => {}) {
    const reads: number[] = [];
    const s = new UsageSchedule(async () => {
      reads.push(Date.now() - NOW);
      await read();
    });
    return { s, reads };
  }
  const MIN = 60_000;

  it("reads at the start, then every 5 minutes", async () => {
    const { s, reads } = schedule();
    s.start();
    await vi.advanceTimersByTimeAsync(16 * MIN);
    expect(reads).toEqual([0, 5 * MIN, 10 * MIN, 15 * MIN]);
    s.stop();
  });

  it("reads after a turn ends, but never within a minute of the last read", async () => {
    const { s, reads } = schedule();
    s.start();
    await vi.advanceTimersByTimeAsync(20_000);
    s.turnEnded();
    s.turnEnded();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(reads).toEqual([0, MIN]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    s.turnEnded();
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toEqual([0, MIN, 3 * MIN + 20_000]);
    // The cadence goes on from the latest read.
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(reads.at(-1)).toBe(8 * MIN + 20_000);
    s.stop();
  });

  it("keeps reading after a read fails", async () => {
    let calls = 0;
    const { s, reads } = schedule(async () => {
      calls += 1;
      if (calls === 1) throw new Error("claude not found");
    });
    s.start();
    await vi.advanceTimersByTimeAsync(5 * MIN + 1);
    expect(reads).toEqual([0, 5 * MIN]);
    s.stop();
  });

  it("reads once more when the session ends after a turn, even within the minute", async () => {
    const { s, reads } = schedule();
    s.start();
    await vi.advanceTimersByTimeAsync(5_000);
    s.turnEnded();
    await s.finish(1000);
    expect(reads).toEqual([0, 5_000]);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(reads).toEqual([0, 5_000]);
  });

  it("does not read again at the end when nothing happened since the last read", async () => {
    const { s, reads } = schedule();
    s.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await s.finish(1000);
    expect(reads).toEqual([0]);
  });

  it("reads once when a session ends before its first read, and stops", async () => {
    const { s, reads } = schedule();
    await s.finish(1000);
    expect(reads).toEqual([0]);
    s.turnEnded();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(reads).toEqual([0]);
  });
});

describe("what a session used, from its transcript", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sb-usage-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const response = (requestId: string, model: string, usage: Record<string, unknown>) =>
    `${JSON.stringify({ type: "assistant", requestId, message: { id: `msg_${requestId}`, model, usage } })}\n`;

  it("counts each request once, its subagents' too, and what was added since", async () => {
    const transcript = join(dir, "s1.jsonl");
    // A streamed response is written twice; the last entry is the whole one.
    await writeFile(
      transcript,
      `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n` +
        response("r1", "claude-opus-5-5", { input_tokens: 10, output_tokens: 5 }) +
        response("r1", "claude-opus-5-5", { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000 }),
    );
    await mkdir(join(dir, "s1", "subagents"), { recursive: true });
    await writeFile(
      join(dir, "s1", "subagents", "a.jsonl"),
      response("r2", "claude-haiku-4-5", { input_tokens: 1_000_000, output_tokens: 0 }),
    );
    const tally = new SessionTally(transcript);
    expect(await tally.read()).toEqual({
      requests: 2,
      inputTokens: 1_000_010,
      outputTokens: 100,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      // Haiku: $1 for 1M input. Opus 5.5: 10 x $4/M + 100 x $20/M + 1000 x $0.2/M, to 4 places.
      costUsd: 1.0022,
    });
    await appendFile(transcript, response("r3", "claude-opus-5-5", { input_tokens: 0, output_tokens: 50 }));
    expect((await tally.read()).requests).toBe(3);
  });

  it("counts nothing for a transcript that is not there yet, and no cost for an unknown model", async () => {
    const tally = new SessionTally(join(dir, "missing.jsonl"));
    expect(await tally.read()).toEqual({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    await writeFile(
      join(dir, "missing.jsonl"),
      response("r1", "some-other-model", { input_tokens: 5, output_tokens: 5 }),
    );
    expect((await tally.read()).costUsd).toBeUndefined();
  });
});

describe("one usage report", () => {
  it("keeps the last limits when /usage fails, and reports the account and session", async () => {
    const reports: ReportedUsage[] = [];
    const limits = { readAt: new Date(NOW).toISOString(), session: { percent: 50 }, models: [] };
    let fail = false;
    const watch = new UsageWatch(
      async () => {
        if (fail) throw new Error("timed out");
        return { email: "person@example.com", plan: "max", limits };
      },
      {
        read: async () => ({ requests: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      } as SessionTally,
      (usage) => reports.push(usage),
    );
    await watch.read();
    fail = true;
    await watch.read();
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual({
      email: "person@example.com",
      plan: "max",
      limits,
      session: { requests: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });
});
