// Where the canvas puts each Agent (ADR 0020): lanes per Person, a lead's Agents after
// it, and nothing drawn ever moving when others join.

import { describe, expect, it } from "vitest";
import type { Agent, AgentId, Task } from "@shared/index";
import { fit, lanes, nodeState, place, slotRect, zoomAt, type Point, type Rect } from "@/lib/canvas-layout";

let n = 0;
function agent(person: string, extra: Partial<Agent> = {}): Agent {
  n += 1;
  return {
    id: `${person}/claude/${n.toString(16).padStart(4, "0")}` as AgentId,
    person,
    cli: "claude-code",
    presence: "live",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: true,
    lastSeenAt: "2026-10-15T10:00:00.000Z",
    startedAt: `2026-10-15T09:${n.toString().padStart(2, "0")}:00.000Z`,
    ...extra,
  } as Agent;
}

function task(number: number, holder: Agent, stale = false): Task {
  return {
    number,
    title: `Task ${number}`,
    claim: { task: number, holder: { kind: "agent", agentId: holder.id }, claimedAt: "2026-10-15T09:00:00.000Z", stale },
  } as Task;
}

const ids = (list: { agents: Agent[] }[]) => list.map((l) => l.agents.map((a) => a.id));

function apart(a: Rect, b: Rect) {
  return a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
}

function expectNoOverlap(at: Map<AgentId, Point>) {
  const rects = [...at.values()].map(slotRect);
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) expect(apart(rects[i]!, rects[j]!), `${i} and ${j}`).toBe(true);
}

describe("canvas lanes", () => {
  it("puts the signed-in Person's lane first, then the others by name", () => {
    const zoe = agent("zoe");
    const ana = agent("ana");
    const me = agent("shlok");
    expect(lanes([zoe, ana, me], [], "shlok").map((l) => l.person)).toEqual(["shlok", "ana", "zoe"]);
  });

  it("draws a lead's Agents right after it, and Agents holding a Task before those without", () => {
    const lead = agent("shlok", { role: "lead" });
    const loose = agent("shlok");
    const holder = agent("shlok");
    const child = agent("shlok", { parent: lead.id });
    const grandchild = agent("shlok", { parent: child.id });
    const order = lanes([loose, grandchild, child, holder, lead], [task(1, holder)], "shlok");
    expect(ids(order)).toEqual([[holder.id, lead.id, child.id, grandchild.id, loose.id]]);
  });

  it("still draws an Agent whose lead is Gone from the Channel, or in a loop of parents", () => {
    const orphan = agent("shlok", { parent: "shlok/claude/dead" as AgentId });
    const a = agent("maya");
    const b = agent("maya", { parent: a.id });
    a.parent = b.id;
    expect(ids(lanes([orphan, a, b], [], "shlok")).flat().sort()).toEqual([orphan.id, a.id, b.id].sort());
  });
});

describe("placing nodes", () => {
  it("never moves a placed node when another joins its lane, and never lets them overlap", () => {
    const first = [agent("shlok"), agent("shlok"), agent("maya")];
    const before = place(lanes(first, [], "shlok"), {});
    expectNoOverlap(before);
    // The first Agent leaves and two join: one in shlok's lane, one for a new Person.
    const joined = agent("shlok");
    const dev = agent("dev");
    const now = [first[1]!, first[2]!, joined, dev];
    const after = place(lanes(now, [], "shlok"), Object.fromEntries(before));
    for (const a of now.slice(0, 2)) expect(after.get(a.id)).toEqual(before.get(a.id));
    // The place the leaver had is free again; nothing else is shared.
    expectNoOverlap(after);
    // A Person new to a drawn canvas gets a lane below everything, not between the others.
    const bottom = Math.max(...[...before.values()].map((p) => slotRect(p).y + slotRect(p).h));
    expect(after.get(dev.id)!.y).toBeGreaterThan(bottom);
  });

  it("wraps a long lane into rows instead of one endless line", () => {
    const many = Array.from({ length: 12 }, () => agent("shlok"));
    const at = place(lanes(many, [], "shlok"), {});
    expectNoOverlap(at);
    expect(new Set([...at.values()].map((p) => p.y)).size).toBe(3);
  });
});

describe("node state", () => {
  it("shows a waiting prompt first, then a Stale Claim, then Presence", () => {
    const needs = agent("shlok", { presence: "gone", approval: { id: "p", tool: "Bash", openedAt: "", deniable: false } as Agent["approval"] });
    const stale = agent("shlok", { presence: "gone" });
    const gone = agent("shlok", { presence: "gone" });
    expect(nodeState(needs, [task(1, needs, true)])).toBe("needs");
    expect(nodeState(stale, [task(2, stale, true)])).toBe("stale");
    expect(nodeState(gone, [])).toBe("gone");
    expect(nodeState(agent("shlok", { presence: "idle" }), [])).toBe("idle");
  });
});

describe("the camera", () => {
  it("fits a small canvas whole, and starts a large one readable at the top left", () => {
    const small = fit({ x: 0, y: 0, w: 400, h: 200 }, 1000, 800);
    expect(small.k).toBe(1);
    const large = fit({ x: 0, y: 0, w: 4000, h: 3000 }, 1000, 800, 0.85);
    expect(large.k).toBe(0.85);
    expect(large.y).toBe(40);
    // Fitting without a floor zooms out instead.
    expect(fit({ x: 0, y: 0, w: 4000, h: 3000 }, 1000, 800).k).toBeLessThan(0.85);
  });

  it("zooms about the pointer, which stays over the same spot", () => {
    const cam = { x: 120, y: -40, k: 0.8 };
    const at = { x: 500, y: 300 };
    const world = { x: (at.x - cam.x) / cam.k, y: (at.y - cam.y) / cam.k };
    const next = zoomAt(cam, 1.5, at);
    expect(next.k).toBeCloseTo(1.2);
    expect(world.x * next.k + next.x).toBeCloseTo(at.x);
    expect(world.y * next.k + next.y).toBeCloseTo(at.y);
  });
});
