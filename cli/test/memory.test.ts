// The digest of others' notes an Agent gets at its next turn (ADR 0019): newest first,
// within its cap, decisions before anything else, and what is left out counted.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentId, MemoryNote, MemoryTag } from "../../shared/src/index";
import { MEMORY_DIGEST_HEADING, memoryDigest } from "../../shared/src/index";
import type { ClaudeHookInput } from "../src/hooks/summarize";
import { COMPACTION_NUDGE, compactionPoint, MemoryInbox, MemoryNudges } from "../src/memory";

function note(seq: number, tag: MemoryTag, text = `Note ${seq}`): MemoryNote {
  return {
    seq,
    id: `n${seq}`,
    at: "2026-10-15T00:00:00.000Z",
    author: "maya/claude/2b8d" as AgentId,
    person: "maya",
    tags: [tag],
    text,
  };
}

describe("the memory digest", () => {
  it("is nothing when there are no notes", () => {
    expect(memoryDigest([])).toBe("");
  });

  it("lists the notes newest first, one line each, cut to one line", () => {
    const digest = memoryDigest([
      note(1, "fact", "First\nline two"),
      { ...note(2, "decision"), task: 12, nickname: "scout" },
    ]);
    expect(digest.split("\n")).toEqual([
      MEMORY_DIGEST_HEADING,
      '- [decision] Note 2 (maya/claude/2b8d "scout", #12)',
      "- [fact] First line two (maya/claude/2b8d)",
    ]);
  });

  it("stays within its cap, keeps every decision over newer notes of other kinds, and counts the rest", () => {
    const long = "x".repeat(250);
    const notes = [
      note(1, "decision", `Old decision ${long}`),
      note(2, "decision", `Older decision ${long}`),
      ...Array.from({ length: 40 }, (_, i) => note(10 + i, "fact", `Fact ${i} ${long}`)),
    ];
    const digest = memoryDigest(notes, 2000);
    expect(digest.length).toBeLessThanOrEqual(2000);
    const lines = digest.split("\n").slice(1);
    expect(lines.filter((line) => line.startsWith("- [decision]"))).toHaveLength(2);
    const facts = lines.filter((line) => line.startsWith("- [fact]"));
    expect(facts.length).toBeGreaterThan(0);
    // The facts that fit are the newest, and they still come before the older decisions.
    expect(facts[0]).toContain("Fact 39 ");
    expect(lines.indexOf(facts[0] ?? "")).toBeLessThan(lines.findIndex((line) => line.startsWith("- [decision]")));
    expect(lines.at(-1)).toBe(`- ${42 - 2 - facts.length} more notes not shown: memory_recent lists them.`);
  });
});

describe("catching up after a session was away", () => {
  const AWAY = "older notes from while this session was away not shown: memory_recent lists them.";

  it("says older notes were left out when more came than it fetched, once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-inbox-"));
    const inbox = new MemoryInbox({
      dir,
      read: async () => ({ notes: [note(90, "fact")], more: true }),
      log: () => {},
    });
    await inbox.registered("shlok/claude/7f3a" as AgentId);
    expect(inbox.take().split("\n").at(-1)).toBe(`- ${AWAY}`);
    inbox.event({
      seq: 91,
      id: "n91",
      at: "2026-10-15T00:00:00.000Z",
      type: "memory.note",
      actor: { kind: "agent", agentId: "maya/claude/2b8d" as AgentId },
      capture: "tool",
      payload: { text: "Later", tags: ["fact"] },
    } as never);
    expect(inbox.take()).not.toContain("away");
  });

  it("counts what did not fit as well", () => {
    const notes = Array.from({ length: 30 }, (_, i) => note(i + 1, "fact", `Fact ${i} ${"x".repeat(250)}`));
    const last = memoryDigest(notes, 2000, true).split("\n").at(-1);
    expect(last).toMatch(/^- \d+ more notes, and older notes from while this session was away not shown/);
  });
});

describe("the compaction ask", () => {
  const stop = { hook_event_name: "Stop" } as ClaudeHookInput;

  it("is asked once per context: again after /clear or a compaction, not before", async () => {
    const nudges = new MemoryNudges({
      context: async () => ({ tokens: 160_000, window: 200_000 }) as never,
      env: {},
      log: () => {},
    });
    expect(await nudges.decide(stop)).toContain("close to compacting");
    expect(await nudges.decide(stop)).toBeNull();
    for (const source of ["clear", "compact"]) {
      nudges.hook({ hook_event_name: "SessionStart", source } as ClaudeHookInput);
      expect(JSON.parse((await nudges.decide(stop)) ?? "{}").reason, source).toBe(COMPACTION_NUDGE);
    }
    nudges.hook({ hook_event_name: "SessionStart", source: "resume" } as ClaudeHookInput);
    expect(await nudges.decide(stop)).toBeNull();
  });
});

describe("where Claude Code compacts", () => {
  it("is the window less the room it keeps, or the share CLAUDE_AUTOCOMPACT_PCT_OVERRIDE names", () => {
    expect(compactionPoint(200_000, {})).toBe(167_000);
    expect(compactionPoint(1_000_000, {})).toBe(967_000);
    expect(compactionPoint(200_000, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" })).toBe(100_000);
  });
});
