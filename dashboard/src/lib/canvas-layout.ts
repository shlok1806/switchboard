/*
 * Where the canvas draws each Agent (ADR 0020, design.md). Hosts are frames: an Agent a
 * Host started sits in that Host's frame, and the Agents a Person started by hand sit in
 * one frame for that Person's terminals. The signed-in Person's frames come first. In a
 * frame a lead's Agents follow it, and Agents holding a Claim come before those without.
 * A node that has a place keeps it: a new Agent takes its frame's next free slot, and a
 * new frame opens below everything drawn.
 */
import type { Agent, AgentId, HostId, Task } from "@shared/index";

export const NODE_W = 212;
export const NODE_H = 128;
/** A frame's margin around its nodes, and the band above its first row for its label. */
export const FRAME_PAD = 16;
export const FRAME_TOP = 24;
/** Between nodes in a frame, and between frames. */
const GAP = 24;
const FRAME_GAP = 24;
/** How wide a row of frames grows before the next frame starts a new row. */
const ROW_WIDTH = 1200;

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

/** One frame: a Host and the Agents it started, or a Person's Agents started in a terminal. */
export interface Group {
  key: string;
  person: string;
  /** Absent for the frame of a Person's terminals. */
  host?: HostId;
  agents: Agent[];
}

const TERMINALS = "~terminals";
export const groupKey = (a: Agent) => a.host ?? `${a.person}/${TERMINALS}`;

/** The frames in order: `me` first, then by Person; a Person's Hosts by name, their terminals last. */
export function groups(agents: Agent[], tasks: Task[], me: string): Group[] {
  const claims = claimsByAgent(tasks);
  const byKey = new Map<string, Agent[]>();
  for (const a of agents) byKey.set(groupKey(a), [...(byKey.get(groupKey(a)) ?? []), a]);
  const out = [...byKey].map(([key, members]): Group => {
    const host = members[0]!.host;
    return { key, person: members[0]!.person, ...(host ? { host } : {}), agents: order(members, claims) };
  });
  return out.sort(
    (x, y) =>
      (x.person === me ? 0 : 1) - (y.person === me ? 0 : 1) ||
      x.person.localeCompare(y.person) ||
      (x.host ? 0 : 1) - (y.host ? 0 : 1) ||
      x.key.localeCompare(y.key),
  );
}

/** A frame's Agents in drawing order: roots by Claim then start, each followed by the Agents it started. */
function order(members: Agent[], claims: Map<AgentId, Task[]>): Agent[] {
  const rank = (a: Agent) => (claims.has(a.id) ? 0 : 1);
  const byStart = (a: Agent, b: Agent) => rank(a) - rank(b) || a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id);
  const children = (id: AgentId) => members.filter((a) => a.parent === id).sort(byStart);
  const ordered: Agent[] = [];
  const visit = (a: Agent) => {
    if (ordered.includes(a)) return;
    ordered.push(a);
    for (const c of children(a.id)) visit(c);
  };
  for (const a of members.filter((a) => !a.parent || !members.some((m) => m.id === a.parent)).sort(byStart)) visit(a);
  // A loop of parents has no root; draw what is left rather than lose it.
  for (const a of [...members].sort(byStart)) visit(a);
  return ordered;
}

/** A node's box. */
export function nodeRect(p: Point): Rect {
  return { x: p.x, y: p.y, w: NODE_W, h: NODE_H };
}

/** A frame around these nodes: its margin, and the band for its label on top. */
export function frameRect(nodes: Point[]): Rect | null {
  const b = bounds(nodes.map(nodeRect));
  return b && { x: b.x - FRAME_PAD, y: b.y - FRAME_TOP, w: b.w + FRAME_PAD * 2, h: b.h + FRAME_TOP + FRAME_PAD };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
}

/** Columns in a frame of `n` Agents: two up to four, then three. */
export function columns(n: number): number {
  return n <= 1 ? 1 : n <= 4 ? 2 : 3;
}

/** The size of a frame of `n` nodes laid out in its grid. */
function frameSize(n: number): { w: number; h: number } {
  const cols = columns(n);
  const rows = Math.max(1, Math.ceil(n / cols));
  return { w: cols * NODE_W + (cols - 1) * GAP + FRAME_PAD * 2, h: rows * NODE_H + (rows - 1) * GAP + FRAME_TOP + FRAME_PAD };
}

/** The node position of slot `i` in a frame of `n` whose top left is `origin`. */
function slot(origin: Point, n: number, i: number): Point {
  const cols = columns(n);
  return { x: origin.x + FRAME_PAD + (i % cols) * (NODE_W + GAP), y: origin.y + FRAME_TOP + Math.floor(i / cols) * (NODE_H + GAP) };
}

function intersects(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/**
 * A position for every Agent: its `saved` one if it has one, else a free slot of its frame.
 * On a canvas with nothing saved, frames sit in rows, left to right. Once positions are
 * saved, nothing drawn moves: a new Agent joins its siblings in the first slot of their
 * grid that keeps its frame clear of every other frame, and a frame with no saved node
 * opens below everything drawn.
 */
export function place(list: Group[], saved: Record<string, Point>): Map<AgentId, Point> {
  const out = new Map<AgentId, Point>();
  for (const g of list)
    for (const a of g.agents) {
      const p = saved[a.id];
      if (p) out.set(a.id, p);
    }
  const anySaved = out.size > 0;
  const nodesOf = (g: Group) => g.agents.flatMap((a) => (out.has(a.id) ? [out.get(a.id)!] : []));
  /** Every other frame as drawn so far. */
  const othersOf = (g: Group) => list.flatMap((h) => (h === g ? [] : [frameRect(nodesOf(h))].filter((r): r is Rect => r !== null)));
  const free = (g: Group, p: Point) =>
    !list.some((h) => nodesOf(h).some((q) => overlaps(nodeRect(q), nodeRect(p)))) &&
    !othersOf(g).some((r) => intersects(r, frameRect([...nodesOf(g), p])!, FRAME_GAP));

  // Where each frame starts on a fresh canvas.
  const flow = { x: 0, y: 0, row: 0 };
  const next = (cursor: typeof flow, size: { w: number; h: number }): Point => {
    if (cursor.x > 0 && cursor.x + size.w > ROW_WIDTH) {
      cursor.x = 0;
      cursor.y += cursor.row + FRAME_GAP;
      cursor.row = 0;
    }
    const at = { x: cursor.x, y: cursor.y };
    cursor.x += size.w + FRAME_GAP;
    cursor.row = Math.max(cursor.row, size.h);
    return at;
  };
  // Where a new frame opens on a drawn canvas: below everything, as it is when first needed.
  let below: typeof flow | null = null;
  const opening = (size: { w: number; h: number }) => {
    if (below === null) {
      const drawn = bounds(list.flatMap((h) => [frameRect(nodesOf(h))].filter((r): r is Rect => r !== null)));
      below = { x: 0, y: drawn ? drawn.y + drawn.h + FRAME_GAP : 0, row: 0 };
    }
    return next(below, size);
  };

  for (const g of list) {
    const size = frameSize(g.agents.length);
    const home = next(flow, size);
    const missing = g.agents.filter((a) => !out.has(a.id));
    if (missing.length === 0) continue;
    const siblings = nodesOf(g);
    if (siblings.length > 0) {
      // Beside its siblings: their frame's own grid, from its top left, as far down as it takes.
      const box = frameRect(siblings)!;
      const origin = { x: box.x, y: box.y };
      for (const a of missing) {
        let at: Point | undefined;
        for (let i = 0; at === undefined && i < 400; i++) {
          const p = slot(origin, g.agents.length, i);
          if (free(g, p)) at = p;
        }
        // Boxed in on every side: put it in the open space below everything. It still belongs
        // to its group, so the group's frame stretches down to hold it, across any frame between.
        at ??= slot(opening(frameSize(1)), 1, 0);
        out.set(a.id, at);
      }
      continue;
    }
    const origin = anySaved ? opening(size) : home;
    let i = 0;
    for (const a of missing)
      for (;; i++) {
        const p = slot(origin, g.agents.length, i);
        if (free(g, p)) {
          out.set(a.id, p);
          i++;
          break;
        }
      }
  }
  return out;
}

/**
 * A lead's line to an Agent it started (design.md): straight segments through the gutter
 * between them, ending at the Agent's edge. Down when the Agent is below, sideways when
 * it is beside.
 */
export function edgePoints(from: Point, to: Point): Point[] {
  const fx = from.x + NODE_W / 2;
  const tx = to.x + NODE_W / 2;
  if (to.y >= from.y + NODE_H + 8) {
    const mid = (from.y + NODE_H + to.y) / 2;
    return [{ x: fx, y: from.y + NODE_H }, { x: fx, y: mid }, { x: tx, y: mid }, { x: tx, y: to.y }];
  }
  if (to.y + NODE_H + 8 <= from.y) {
    const mid = (to.y + NODE_H + from.y) / 2;
    return [{ x: fx, y: from.y }, { x: fx, y: mid }, { x: tx, y: mid }, { x: tx, y: to.y + NODE_H }];
  }
  const fy = from.y + NODE_H / 2;
  const ty = to.y + NODE_H / 2;
  const right = to.x >= from.x + NODE_W;
  const a = right ? from.x + NODE_W : from.x;
  const b = right ? to.x : to.x + NODE_W;
  const mid = (a + b) / 2;
  return [{ x: a, y: fy }, { x: mid, y: fy }, { x: mid, y: ty }, { x: b, y: ty }];
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
export function fit(box: Rect | null, w: number, h: number, floor = MIN_ZOOM, margin = 40, align: "center" | "start" = "center"): Camera {
  if (!box) return { x: margin, y: margin, k: 1 };
  const k = clampZoom(Math.min(1, (w - margin * 2) / box.w, (h - margin * 2) / box.h));
  if (k < floor) return { k: floor, x: Math.max(margin, (w - box.w * floor) / 2) - box.x * floor, y: margin - box.y * floor };
  // `start` reads like a page, from the top left; `center` frames everything in the middle.
  if (align === "start") return { x: margin - box.x * k, y: margin - box.y * k, k };
  return { x: (w - box.w * k) / 2 - box.x * k, y: (h - box.h * k) / 2 - box.y * k, k };
}

/** `camera` zoomed by `factor` about the viewport point `at`, which stays where it is. */
export function zoomAt(camera: Camera, factor: number, at: Point): Camera {
  const k = clampZoom(camera.k * factor);
  const f = k / camera.k;
  return { k, x: at.x - (at.x - camera.x) * f, y: at.y - (at.y - camera.y) * f };
}
