// The wrapper's idle wake: what deserves one, what it takes, when it types, and the cap.

import { describe, expect, it } from "vitest";
import type { Delivery, DirectiveDelivery } from "../../shared/src/index";
import { NextTurn, type WakeBatch } from "../src/next-turn";
import { type WakeOutcome, Waker } from "../src/wake";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ON_TASK = "it is about Task #4, which you hold";

function delivery(id: string, seq: number, over: Partial<Delivery> = {}): Delivery {
  return {
    id,
    event: `event-${id}`,
    seq,
    at: "2026-10-01T09:00:00.000Z",
    sender: { kind: "agent", agentId: "maya/claude/2b8d" },
    type: "update",
    summary: `posted an Update: "${id}"`,
    files: [],
    overlap: { files: [], symbols: [] },
    verdict: { option: "queue", delivered: "queue" },
    ...over,
  };
}

const directive: DirectiveDelivery = {
  id: "directive-1",
  seq: 9,
  at: "2026-10-01T09:00:00.000Z",
  from: "shlok",
  to: "shlok/claude/7f3a",
  text: "Rebase onto main.",
};

describe("what deserves a Wake", () => {
  function deserves(deliveries: Delivery[], directives: DirectiveDelivery[] = []): boolean {
    const next = new NextTurn();
    next.add({ deliveries, directives });
    return next.wakeWorthy;
  }

  it("is a Directive, an Update on the Agent's Task, or overlap on files it touched", () => {
    expect(deserves([], [directive])).toBe(true);
    expect(deserves([delivery("a", 1, { overlap: { files: [], symbols: [], addressed: ON_TASK } })])).toBe(true);
    expect(deserves([delivery("b", 1, { type: "push", overlap: { files: ["src/app.ts"], symbols: [] } })])).toBe(true);
  });

  it("is nothing else: those wait for the next turn", () => {
    expect(deserves([delivery("c", 1)])).toBe(false);
    expect(
      deserves([delivery("d", 1, { type: "task.change", overlap: { files: [], symbols: [], addressed: ON_TASK } })]),
    ).toBe(false);
    expect(deserves([delivery("e", 1, { type: "push", overlap: { files: [], symbols: ["formatName"] } })])).toBe(false);
  });

  it("takes everything held, in order and once, and nothing while nothing deserves a Wake", () => {
    const next = new NextTurn();
    next.add({ deliveries: [delivery("later", 2), delivery("first", 1)] });
    expect(next.takeForWake()).toBeNull();
    next.add({ directives: [directive] });
    const batch = next.takeForWake();
    expect(batch?.deliveries.sort()).toEqual(["first", "later"]);
    expect(batch?.directives).toEqual(["directive-1"]);
    expect(batch?.text.indexOf('"first"')).toBeLessThan(batch?.text.indexOf('"later"') ?? -1);
    expect(batch?.text).toContain("[Switchboard] Directive from shlok");
    // Taken: neither another Wake nor the next turn's hook repeats it.
    expect(next.takeForWake()).toBeNull();
    expect(next.take("UserPromptSubmit")).toBe("");
  });
});

/** A Waker over a fake session; `state.answer` says how each try to type goes. */
function waker({ cap = 3, windowMs = 60_000 } = {}) {
  const clock = { now: 0 };
  const state = { pending: true, answer: { typed: true } as WakeOutcome };
  const typed: string[] = [];
  const woke: WakeBatch[] = [];
  let capped = 0;
  const w = new Waker({
    type: async (produce) => {
      if (!state.answer.typed) return state.answer;
      const text = produce();
      if (text === null) return { typed: false, reason: "empty" };
      typed.push(text);
      return { typed: true };
    },
    pending: () => state.pending,
    take: () => ({ text: "held", deliveries: ["v1"], directives: [] }),
    woke: (batch) => woke.push(batch),
    capped: () => {
      capped += 1;
    },
    log: () => {},
    now: () => clock.now,
    cap,
    windowMs,
    settleMs: 20,
  });
  return { w, clock, state, typed, woke, capped: () => capped };
}

describe("Waker", () => {
  it("wakes after a short settle, as one prompt under the Wake line", async () => {
    const { w, typed, woke } = waker();
    w.poke();
    w.poke();
    expect(typed).toEqual([]);
    await sleep(80);
    expect(typed).toHaveLength(1);
    expect(typed[0]?.split("\n")[0]).toMatch(/^\[Switchboard\] Wake: /);
    expect(typed[0]?.endsWith("\n\nheld")).toBe(true);
    expect(woke).toEqual([{ text: "held", deliveries: ["v1"], directives: [] }]);
    w.stop();
  });

  it("does nothing while nothing held deserves a Wake", async () => {
    const { w, state, typed } = waker();
    state.pending = false;
    w.poke();
    await sleep(80);
    expect(typed).toEqual([]);
    w.stop();
  });

  it("tries again shortly while its Person types; while the Agent works, waits for its turn to end", async () => {
    const { w, state, typed } = waker();
    state.answer = { typed: false, reason: "person-typing" };
    w.poke();
    await sleep(80);
    state.answer = { typed: true };
    await sleep(700);
    expect(typed).toHaveLength(1);

    state.answer = { typed: false, reason: "busy" };
    w.poke();
    await sleep(80);
    state.answer = { typed: true };
    await sleep(700);
    // Nothing tries again until something pokes it: the turn's end.
    expect(typed).toHaveLength(1);
    w.poke();
    await sleep(80);
    expect(typed).toHaveLength(2);
    w.stop();
  });

  it("stops at the cap and says so once; the Person's prompt or Directive lets it wake again", async () => {
    const { w, clock, typed, capped } = waker({ cap: 3 });
    for (let i = 0; i < 5; i++) {
      clock.now += 1000;
      w.poke();
      await sleep(60);
    }
    expect(typed).toHaveLength(3);
    expect(capped()).toBe(1);
    w.reset("the Person sent a prompt");
    await sleep(60);
    expect(typed).toHaveLength(4);
    w.stop();
  });

  it("counts only the Wakes within the window", async () => {
    const { w, clock, typed, capped } = waker({ cap: 2, windowMs: 10_000 });
    w.poke();
    await sleep(60);
    clock.now += 4000;
    w.poke();
    await sleep(60);
    w.poke();
    await sleep(60);
    expect(typed).toHaveLength(2);
    expect(capped()).toBe(1);
    // The first Wake leaves the window.
    clock.now += 7000;
    w.poke();
    await sleep(60);
    expect(typed).toHaveLength(3);
    w.stop();
  });

  it("never wakes after the session ended", async () => {
    const { w, typed } = waker();
    w.poke();
    w.stop();
    await sleep(80);
    expect(typed).toEqual([]);
  });
});
