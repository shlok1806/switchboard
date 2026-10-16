// What a hook adds to the model's context at a turn (ADR 0024): a Hand-off Brief goes in
// the room the Person's Directives and the Channel's notices leave under the hook's cap,
// and the notes digest waits for the next turn.

import { describe, expect, it } from "vitest";
import type { Agent, AgentId, AgentSummary, Delivery, DirectiveDelivery, MemoryNote } from "../../shared/src/index";
import { handoffBrief, STANDING_RULE, SUMMARY_MAX_CHARS } from "../../shared/src/index";
import { HOOK_CONTEXT_MAX_CHARS, NextTurn } from "../src/next-turn";

const predecessor = "shlok/claude/2b8d" as AgentId;

/** A predecessor with enough notes and Updates that its brief fills its own cap. */
const summary: AgentSummary = {
  agent: {
    id: predecessor,
    person: "shlok",
    cli: "claude-code",
    nickname: "scout",
    presence: "gone",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: true,
    startedAt: "2026-10-15T00:00:00.000Z",
    lastSeenAt: "2026-10-15T01:00:00.000Z",
  } as Agent,
  tasks: [],
  updates: Array.from({ length: 5 }, (_, i) => ({
    seq: i,
    at: "2026-10-15T00:30:00.000Z",
    text: `Update ${i} ${"u".repeat(280)}`,
  })),
  files: Array.from({ length: 15 }, (_, i) => `web/src/pages/file-${i}.tsx`),
  notes: Array.from(
    { length: 20 },
    (_, i): MemoryNote => ({
      seq: 100 + i,
      id: `n${i}`,
      at: "2026-10-15T00:40:00.000Z",
      author: predecessor,
      person: "shlok",
      tags: ["fact"],
      text: `Note ${i} ${"n".repeat(280)}`,
    }),
  ),
  successors: [],
};

/** Queued Deliveries long enough that the brief cannot also have its full cap. */
const deliveries: Delivery[] = Array.from({ length: 12 }, (_, i) => ({
  id: `d${i}`,
  event: `event-${i}`,
  seq: i + 1,
  at: "2026-10-15T01:00:00.000Z",
  sender: { kind: "agent", agentId: "maya/claude/9c1e" as AgentId },
  type: "update",
  summary: `posted an Update: "${"x".repeat(250)}"`,
  files: [],
  overlap: { files: [], symbols: [] },
  verdict: { option: "queue", delivered: "queue" },
}));

const directive: DirectiveDelivery = {
  id: "directive-1",
  seq: 50,
  at: "2026-10-15T01:01:00.000Z",
  from: "shlok",
  to: "shlok/claude/7f3a" as AgentId,
  text: "Finish the users page first, then open a pull request against main.",
};

describe("a turn that carries a Hand-off Brief", () => {
  it("keeps the Person's Directive whole and fits the brief in what is left under the cap", () => {
    expect(handoffBrief(summary).length).toBeGreaterThan(SUMMARY_MAX_CHARS - 1000);
    let digests = 0;
    const next = new NextTurn({
      take: () => {
        digests++;
        return "[Switchboard] Notes from other Agents:\n- [fact] Pages are 1-based.";
      },
    });
    next.handOff((max) => handoffBrief(summary, max));
    next.add({ deliveries, directives: [directive] });

    const text = next.take("SessionStart");
    expect(text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS);
    expect(text.startsWith(STANDING_RULE)).toBe(true);
    expect(text).toContain(directive.text);
    // The brief comes last, so a cut of it never reaches the Directive.
    expect(text.indexOf(directive.text)).toBeLessThan(text.indexOf("this session continues the work of"));
    expect(text).toContain("left out to keep this short");
    // The digest waits for the next turn, and is not taken from the inbox meanwhile.
    expect(text).not.toContain("Notes from other Agents");
    expect(digests).toBe(0);

    const later = next.take("UserPromptSubmit");
    expect(later).toContain("Pages are 1-based.");
    expect(later).not.toContain("continues the work of");
  });

  it("waits for the next hook when the Person's words leave too little room for it", () => {
    const next = new NextTurn({ take: () => "" });
    next.handOff((max) => handoffBrief(summary, max));
    const long = { ...directive, text: "y".repeat(HOOK_CONTEXT_MAX_CHARS - 1000) };
    next.add({ directives: [long] });

    const first = next.take("UserPromptSubmit");
    expect(first).toContain(long.text);
    expect(first).not.toContain("continues the work of");
    expect(next.take("UserPromptSubmit")).toContain("this session continues the work of");
  });
});
