// Where the canvas puts each Agent (ADR 0020): frames per Host, a lead's Agents after
// it, and nothing drawn ever moving when others join.

import { describe, expect, it } from "vitest";
import type { Agent, AgentId, HostId, Task } from "@shared/index";
import { edgePoints, fit, frameRect, groups, nodeRect, place, zoomAt, type Point, type Rect } from "@/lib/canvas-layout";
import { stateOf } from "@/lib/state";

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
  const rects = [...at.values()].map(nodeRect);
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) expect(apart(rects[i]!, rects[j]!), `${i} and ${j}`).toBe(true);
}

describe("canvas frames", () => {
  it("puts each Host in its own frame and a Person's hand-started Agents in one, the signed-in Person first", () => {
    const zoe = agent("zoe");
    const anaHost = agent("ana", { host: "ana/box" as HostId });
    const ana = agent("ana");
    const meHost = agent("shlok", { host: "shlok/studio" as HostId });
    const me = agent("shlok");
    const list = groups([zoe, ana, anaHost, me, meHost], [], "shlok");
    expect(list.map((g) => [g.person, g.host ?? "terminals"])).toEqual([
      ["shlok", "shlok/studio"],
      ["shlok", "terminals"],
      ["ana", "ana/box"],
      ["ana", "terminals"],
      ["zoe", "terminals"],
    ]);
  });

  it("draws a lead's Agents right after it, and Agents holding a Task before those without", () => {
    const lead = agent("shlok", { role: "lead" });
    const loose = agent("shlok");
    const holder = agent("shlok");
    const child = agent("shlok", { parent: lead.id });
    const grandchild = agent("shlok", { parent: child.id });
    const order = groups([loose, grandchild, child, holder, lead], [task(1, holder)], "shlok");
    expect(ids(order)).toEqual([[holder.id, lead.id, child.id, grandchild.id, loose.id]]);
  });

  it("still draws an Agent whose lead is Gone from the Channel, or in a loop of parents", () => {
    const orphan = agent("shlok", { parent: "shlok/claude/dead" as AgentId });
    const a = agent("maya");
    const b = agent("maya", { parent: a.id });
    a.parent = b.id;
    expect(ids(groups([orphan, a, b], [], "shlok")).flat().sort()).toEqual([orphan.id, a.id, b.id].sort());
  });

  it("draws a frame around its nodes, so a dragged node takes its frame with it", () => {
    const at = place(groups([agent("shlok"), agent("shlok")], [], "shlok"), {});
    const nodes = [...at.values()];
    const frame = frameRect(nodes)!;
    for (const p of nodes) {
      expect(p.x).toBeGreaterThan(frame.x);
      expect(p.y).toBeGreaterThan(frame.y);
      expect(p.x + nodeRect(p).w).toBeLessThan(frame.x + frame.w);
    }
    const moved = frameRect([nodes[0]!, { x: 2000, y: 900 }])!;
    expect(moved.x + moved.w).toBeGreaterThan(2000 + nodeRect(nodes[0]!).w);
  });
});

describe("placing nodes", () => {
  it("never moves a placed node when another joins its frame, and never lets them overlap", () => {
    const first = [agent("shlok"), agent("shlok"), agent("maya")];
    const before = place(groups(first, [], "shlok"), {});
    expectNoOverlap(before);
    // The first Agent leaves and two join: one in shlok's frame, one for a new Person.
    const joined = agent("shlok");
    const dev = agent("dev");
    const now = [first[1]!, first[2]!, joined, dev];
    const after = place(groups(now, [], "shlok"), Object.fromEntries(before));
    for (const a of now.slice(0, 2)) expect(after.get(a.id)).toEqual(before.get(a.id));
    expectNoOverlap(after);
    // A frame new to a drawn canvas opens below everything, not between the others.
    const bottom = Math.max(...[...before.values()].map((p) => nodeRect(p).y + nodeRect(p).h));
    expect(after.get(dev.id)!.y).toBeGreaterThan(bottom);
  });

  it("lays a large frame out in rows of three, and wraps a row of frames", () => {
    const many = Array.from({ length: 9 }, () => agent("shlok"));
    const at = place(groups(many, [], "shlok"), {});
    expectNoOverlap(at);
    expect(new Set([...at.values()].map((p) => p.y)).size).toBe(3);
    const hosts = ["a", "b", "c", "d", "e", "f"].map((h) => agent("shlok", { host: `shlok/${h}` as HostId }));
    const spread = place(groups(hosts, [], "shlok"), {});
    expectNoOverlap(spread);
    expect(new Set([...spread.values()].map((p) => p.y)).size).toBeGreaterThan(1);
  });
});

describe("a lead's line", () => {
  it("runs down through the gutter to an Agent below, and sideways to one beside, in straight segments", () => {
    const down = edgePoints({ x: 0, y: 0 }, { x: 300, y: 300 });
    expect(down.at(-1)).toEqual({ x: 300 + 106, y: 300 });
    const side = edgePoints({ x: 0, y: 0 }, { x: 400, y: 20 });
    expect(side[0]).toEqual({ x: 212, y: 64 });
    expect(side.at(-1)).toEqual({ x: 400, y: 84 });
    // Every segment is horizontal or vertical.
    for (const pts of [down, side]) for (let i = 1; i < pts.length; i++) expect(pts[i]!.x === pts[i - 1]!.x || pts[i]!.y === pts[i - 1]!.y).toBe(true);
  });
});

describe("an Agent's state", () => {
  const approval = { id: "p", tool: "Bash", openedAt: "", deniable: false } as Agent["approval"];
  it("shows a waiting prompt first, then a Stale Claim, then Presence", () => {
    const goneAsking = agent("shlok", { presence: "gone", approval });
    const stale = agent("shlok", { presence: "gone" });
    const gone = agent("shlok", { presence: "gone" });
    expect(stateOf(agent("shlok", { approval }), [], "shlok")).toBe("needs");
    // A Gone Agent's prompt can no longer be answered: its Stale Claim is what waits.
    expect(stateOf(goneAsking, [task(1, goneAsking, true)], "shlok")).toBe("stale");
    expect(stateOf(stale, [task(2, stale, true)], "shlok")).toBe("stale");
    expect(stateOf(gone, [task(3, gone)], "shlok")).toBe("gone");
    expect(stateOf(agent("shlok", { presence: "idle" }), [], "shlok")).toBe("idle");
    expect(stateOf(agent("shlok"), [], "shlok")).toBe("running");
  });

  it("names whose prompt it is: yours, or another Person's", () => {
    expect(stateOf(agent("maya", { approval }), [], "shlok")).toBe("needs-other");
    expect(stateOf(agent("maya", { approval }), [], "maya")).toBe("needs");
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
