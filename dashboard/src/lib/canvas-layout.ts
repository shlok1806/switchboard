/*
 * Where the canvas draws each Agent (ADR 0020). Lanes are Persons, the signed-in Person
 * first; in a lane a lead's Agents follow it, and Agents holding a Claim come before
 * those without one. A node that has a place keeps it: a new Agent takes its lane's next
 * slot that no node covers, and a new Person's lane opens below everything drawn.
 */
import type { Agent, AgentId, Task } from "@shared/index";

export const NODE_W = 280;
export const NODE_H = 128;
/** A Task frame's margin around its node, and the band above the node for its label: the Task, then its branch. */
export const FRAME_PAD = 12;
export const FRAME_TOP = 60;
/** The band above a lane's first row for the Person's name. */
export const LANE_LABEL = 36;
const SLOT_W = NODE_W + FRAME_PAD * 2;
const SLOT_H = NODE_H + FRAME_TOP + FRAME_PAD;
const GAP_X = 32;
const GAP_Y = 32;
const LANE_GAP = 48;
/** Slots in one row of a lane before it wraps. */
export const LANE_COLUMNS = 5;

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  w: number;
  h: number;
}

/** Every Task each Agent holds, oldest Claim first. */
export function claimsByAgent(tasks: Task[]): Map<AgentId, Task[]> {
  const m = new Map<AgentId, Task[]>();
  for (const t of tasks) {
    if (t.claim?.holder.kind !== "agent") continue;
    const id = t.claim.holder.agentId;
    m.set(id, [...(m.get(id) ?? []), t]);
  }
  for (const list of m.values()) list.sort((a, b) => (a.claim?.claimedAt ?? "").localeCompare(b.claim?.claimedAt ?? ""));
  return m;
}

export interface Lane {
  person: string;
  agents: Agent[];
}

/** The lanes in order: `me` first, then by name; each lane's Agents in drawing order. */
export function lanes(agents: Agent[], tasks: Task[], me: string): Lane[] {
  const claims = claimsByAgent(tasks);
  const people = [...new Set(agents.map((a) => a.person))].sort((a, b) =>
    a === me ? -1 : b === me ? 1 : a.localeCompare(b),
  );
  return people.map((person) => {
    const mine = agents.filter((a) => a.person === person);
    // Roots: Agents whose lead is not drawn in this lane. Holders of a Claim first, then by start.
    const rank = (a: Agent) => (claims.has(a.id) ? 0 : 1);
    const byStart = (a: Agent, b: Agent) => rank(a) - rank(b) || a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id);
    const children = (id: AgentId) => mine.filter((a) => a.parent === id).sort(byStart);
    const ordered: Agent[] = [];
    const visit = (a: Agent) => {
      if (ordered.includes(a)) return;
      ordered.push(a);
      for (const c of children(a.id)) visit(c);
    };
    for (const a of mine.filter((a) => !a.parent || !mine.some((m) => m.id === a.parent)).sort(byStart)) visit(a);
    // A cycle of parents has no root; draw what is left rather than lose it.
    for (const a of [...mine].sort(byStart)) visit(a);
    return { person, agents: ordered };
  });
}

/** The box a node and its frame take, for overlap. */
export function slotRect(p: Point): Rect {
  return { x: p.x - FRAME_PAD, y: p.y - FRAME_TOP, w: SLOT_W, h: SLOT_H };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w + GAP_X / 2 && b.x < a.x + a.w + GAP_X / 2 && a.y < b.y + b.h + GAP_Y / 2 && b.y < a.y + a.h + GAP_Y / 2;
}

/** The node position of slot `i` in a lane whose first row's slots start at `top`. */
function slot(top: number, i: number): Point {
  const col = i % LANE_COLUMNS;
  const row = Math.floor(i / LANE_COLUMNS);
  return { x: col * (SLOT_W + GAP_X) + FRAME_PAD, y: top + row * (SLOT_H + GAP_Y) + FRAME_TOP };
}

function rows(n: number): number {
  return Math.max(1, Math.ceil(n / LANE_COLUMNS));
}

/**
 * A position for every Agent: its `saved` one if it has one, else the first free slot of
 * its lane. Lanes with no saved node open below everything already placed.
 */
export function place(laneList: Lane[], saved: Record<string, Point>): Map<AgentId, Point> {
  const out = new Map<AgentId, Point>();
  const taken: Rect[] = [];
  for (const lane of laneList)
    for (const a of lane.agents) {
      const p = saved[a.id];
      if (p) {
        out.set(a.id, p);
        taken.push(slotRect(p));
      }
    }
  const anySaved = taken.length > 0;
  let top = 0;
  for (const lane of laneList) {
    const laneTop = top + LANE_LABEL;
    top = laneTop + rows(lane.agents.length) * (SLOT_H + GAP_Y) - GAP_Y + LANE_GAP;
    const fresh = lane.agents.filter((a) => !out.has(a.id));
    if (fresh.length === 0) continue;
    const hasSaved = lane.agents.some((a) => out.has(a.id));
    // A lane that is new to a drawn canvas opens under it, so it never lands in another lane.
    const start = hasSaved || !anySaved ? laneTop : Math.max(...taken.map((r) => r.y + r.h)) + LANE_GAP + LANE_LABEL;
    let i = 0;
    for (const a of fresh) {
      for (;; i++) {
        const p = slot(start, i);
        if (!taken.some((r) => overlaps(r, slotRect(p)))) {
          out.set(a.id, p);
          taken.push(slotRect(p));
          i++;
          break;
        }
      }
    }
  }
  return out;
}

/** The smallest box around `rects`, or null when there are none. */
export function bounds(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
}

export interface Camera {
  x: number;
  y: number;
  k: number;
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 1.6;

export const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/**
 * The camera that shows all of `box` in a `w` by `h` viewport, never past 100%. With a
 * `floor`, it never zooms out below it: what does not fit then starts at the top left.
 */
export function fit(box: Rect | null, w: number, h: number, floor = MIN_ZOOM, margin = 40): Camera {
  if (!box) return { x: margin, y: margin, k: 1 };
  const k = clampZoom(Math.min(1, (w - margin * 2) / box.w, (h - margin * 2) / box.h));
  if (k < floor) return { k: floor, x: Math.max(margin, (w - box.w * floor) / 2) - box.x * floor, y: margin - box.y * floor };
  return { x: (w - box.w * k) / 2 - box.x * k, y: (h - box.h * k) / 2 - box.y * k, k };
}

/** `camera` zoomed by `factor` about the viewport point `at`, which stays where it is. */
export function zoomAt(camera: Camera, factor: number, at: Point): Camera {
  const k = clampZoom(camera.k * factor);
  const f = k / camera.k;
  return { k, x: at.x - (at.x - camera.x) * f, y: at.y - (at.y - camera.y) * f };
}
