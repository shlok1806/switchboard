// The digest of others' notes an Agent gets at its next turn (ADR 0019): newest first,
// within its cap, decisions before anything else, and what is left out counted.

import { describe, expect, it } from "vitest";
import type { AgentId, MemoryNote, MemoryTag } from "../../shared/src/index";
import { MEMORY_DIGEST_HEADING, memoryDigest } from "../../shared/src/index";
import { compactionPoint } from "../src/memory";

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

describe("where Claude Code compacts", () => {
  it("is the window less the room it keeps, or the share CLAUDE_AUTOCOMPACT_PCT_OVERRIDE names", () => {
    expect(compactionPoint(200_000, {})).toBe(167_000);
    expect(compactionPoint(1_000_000, {})).toBe(967_000);
    expect(compactionPoint(200_000, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" })).toBe(100_000);
  });
});
