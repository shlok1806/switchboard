// The digest of others' notes an Agent gets at its next turn (ADR 0019, ADR 0024): what
// it works on first, then decisions and dead ends, newest first among equals, within its
// cap, and what is left out counted.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AgentId, MemoryNote, MemoryTag } from "../../shared/src/index";
import { MEMORY_DIGEST_HEADING, memoryDigest } from "../../shared/src/index";
import type { ClaudeHookInput } from "../src/hooks/summarize";
import { COMPACTION_NUDGE, compactionPoint, MemoryInbox, MemoryNudges } from "../src/memory";

/** A temp dir the current test removes when it finishes. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

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

  it("lists the notes one line each, cut to one line", () => {
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

  it("stays within its cap, ranks decisions and dead ends over newer notes of other kinds, and counts the rest", () => {
    const long = "x".repeat(250);
    const notes = [
      note(1, "decision", `Old decision ${long}`),
      note(2, "dead-end", `Old dead end ${long}`),
      ...Array.from({ length: 40 }, (_, i) => note(10 + i, "fact", `Fact ${i} ${long}`)),
    ];
    const digest = memoryDigest(notes, 2000);
    expect(digest.length).toBeLessThanOrEqual(2000);
    const lines = digest.split("\n").slice(1);
    expect(lines.slice(0, 2).map((line) => line.slice(0, 16))).toEqual(["- [dead-end] Old", "- [decision] Old"]);
    const facts = lines.filter((line) => line.startsWith("- [fact]"));
    expect(facts.length).toBeGreaterThan(0);
    // The facts that fit are the newest.
    expect(facts[0]).toContain("Fact 39 ");
    expect(lines.at(-1)).toBe(`- ${42 - 2 - facts.length} more notes not shown: memory_recent lists them.`);
  });

  it("puts notes on the Agent's own Tasks and files first, then decisions and dead ends, then questions", () => {
    const digest = memoryDigest(
      [
        note(1, "fact", "On my Task"),
        { ...note(2, "fact", "On my file"), files: ["./web/src/login.ts"] },
        // The same file name in another folder is another file.
        { ...note(0, "fact", "On another login.ts"), files: ["api/src/login.ts"] },
        note(3, "question", "An open question"),
        note(4, "decision", "A decision elsewhere"),
        note(5, "fact", "A newer fact elsewhere"),
        { ...note(6, "fact", "On another Task"), task: 99 },
      ].map((n) => (n.seq === 1 ? { ...n, task: 12 } : n)),
      undefined,
      false,
      { tasks: [12], files: ["/Users/shlok/code/app/web/src/login.ts"] },
    );
    expect(
      digest
        .split("\n")
        .slice(1)
        .map((line) => line.replace(/ \(maya.*$/, "")),
    ).toEqual([
      "- [fact] On my Task",
      "- [fact] On my file",
      "- [decision] A decision elsewhere",
      "- [question] An open question",
      "- [fact] On another Task",
      "- [fact] A newer fact elsewhere",
      "- [fact] On another login.ts",
    ]);
  });
});

describe("what the inbox weights the digest toward", () => {
  const me = "shlok/claude/7f3a" as AgentId;
  let seq = 100;
  const event = (fields: Record<string, unknown>) => ({
    seq: ++seq,
    id: `e${seq}`,
    at: "2026-10-15T00:00:00.000Z",
    capture: null,
    ...fields,
  });
  const noteEvent = (text: string, extra: Record<string, unknown> = {}) =>
    event({
      type: "memory.note",
      actor: { kind: "agent", agentId: "maya/claude/2b8d" },
      capture: "tool",
      payload: { text, tags: ["fact"], ...extra },
    });

  it("follows the Tasks it claims and releases and the files it edits, from where it was before", async () => {
    const dir = await tempDir("memory-inbox-");
    const inbox = new MemoryInbox({
      dir,
      read: async () => ({ notes: [] }),
      summary: async () => ({ tasks: [{ number: 3 }], files: ["api/old.ts"] }) as never,
      log: () => {},
    });
    await inbox.registered(me);
    const holder = { kind: "agent", agentId: me };
    inbox.event(event({ type: "claim", actor: holder, task: 7, payload: { holder } }) as never);
    inbox.event(event({ type: "claim.release", actor: holder, task: 3, payload: { holder } }) as never);
    inbox.event(event({ type: "file.edit", actor: holder, capture: "hook", payload: { path: "web/a.ts" } }) as never);
    // Another Agent's edit is not this one's.
    inbox.event(
      event({
        type: "file.edit",
        actor: { kind: "agent", agentId: "maya/claude/2b8d" },
        capture: "hook",
        payload: { path: "web/b.ts" },
      }) as never,
    );
    expect(inbox.currentFocus).toEqual({ tasks: [7], files: ["web/a.ts", "api/old.ts"] });

    for (const [text, extra] of [
      ["On the released Task", { task: 3 }],
      ["On web/b.ts", { files: ["web/b.ts"] }],
      ["On my Task", { task: 7 }],
      ["On my file", { files: ["web/a.ts"] }],
      ["Newest, about nothing of mine", {}],
    ] as const) {
      inbox.event({ ...noteEvent(text, extra), ...("task" in extra ? { task: extra.task } : {}) } as never);
    }
    const lines = inbox.take().split("\n").slice(1, 3);
    expect(lines.map((line) => line.replace(/ \(maya.*$/, ""))).toEqual(["- [fact] On my Task", "- [fact] On my file"]);
  });
});

describe("catching up after a session was away", () => {
  const AWAY = "older notes from while this session was away not shown: memory_recent lists them.";

  it("says older notes were left out when more came than it fetched, once", async () => {
    const dir = await tempDir("memory-inbox-");
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
