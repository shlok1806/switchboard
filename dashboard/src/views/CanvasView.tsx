/*
 * The canvas (ADR 0020): the Channel's Agents as nodes in one lane per Person, each Task
 * an Agent holds as a frame around it, and an edge from a lead to each Agent it started.
 * It draws the Channel and creates nothing; a node opens its Agent's page. Where nodes
 * sit and the camera are this browser's view state, per Channel.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize, Minus, Plus, RotateCcw, X } from "lucide-react";
import type { Agent, AgentId, Task } from "@shared/index";
import { buttonVariants } from "@/components/atoms/Button";
import { AgentBrief, ContextWindow } from "@/components/domain/context";
import { LeadLabel } from "@/components/domain/agent-role";
import { Pending } from "@/components/domain/pending";
import { ModelLabel, TaskLink } from "@/components/domain/pills";
import { PageHead } from "@/components/shell/page-head";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChannel, useIndex, useMe } from "@/data/store";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  FRAME_TOP,
  LANE_LABEL,
  NODE_H,
  NODE_W,
  bounds,
  claimsByAgent,
  fit,
  lanes as laneOrder,
  place,
  slotRect,
  zoomAt,
  type Camera,
  type Point,
} from "@/lib/canvas-layout";
import { CLI_LABEL } from "@/lib/format";
import { go, href } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Glyph, State, useAgentStates, useNeedsYou } from "@/components/domain/state";
import { countStates, needsPerson, stateWord, type AgentState } from "@/lib/state";

const STATE_HINT: Record<AgentState, string> = {
  needs: "A permission prompt is waiting for you",
  "needs-other": "A permission prompt is waiting for its Person",
  stale: "Gone while holding a Claim; a Person can take it over",
  running: "Live: working now",
  idle: "Idle: connected, between turns",
  gone: "Gone: silent for about ten minutes",
};

interface View {
  positions: Record<string, Point>;
  camera?: Camera;
}

const viewKey = (repo: string) => `switchboard.canvas.${repo}`;

function loadView(repo: string): View {
  try {
    const raw = window.localStorage.getItem(viewKey(repo));
    const parsed = raw ? (JSON.parse(raw) as Partial<View>) : {};
    return { positions: parsed.positions ?? {}, camera: parsed.camera };
  } catch {
    return { positions: {} };
  }
}

function saveView(repo: string, view: View) {
  try {
    window.localStorage.setItem(viewKey(repo), JSON.stringify(view));
  } catch {
    // Storage blocked: the layout lasts as long as the page.
  }
}

/** The first view is at 100%, where a node's text is its full size; what does not fit starts at the top left. */
const FIRST_ZOOM = 1;

const name = (a: Agent) => a.nickname ?? a.id;

const ORIGIN: Point = { x: 0, y: 0 };

function percentOf(a: Agent): number | undefined {
  const c = a.context;
  return c?.tokens !== undefined && c.window ? (c.tokens / c.window) * 100 : undefined;
}

/** The context meter (design.md): a 56x4 track, an ink fill, and the figure. A high reading is a number, not a colour. */
function Meter({ agent }: { agent: Agent }) {
  const p = percentOf(agent);
  if (p === undefined) return <span className="text-small text-ink-3">No context reading</span>;
  return (
    <span className="inline-flex items-center gap-2 text-small text-ink-2 tabular-nums">
      {Math.round(p)}% context
      <span aria-hidden className="h-1 w-14 bg-rule">
        <span className="block h-full bg-ink-2" style={{ width: `${Math.min(100, p)}%` }} />
      </span>
    </span>
  );
}

/**
 * One Agent's node. Memoised, with handlers that never change, so panning, which moves
 * only the camera, renders no node again.
 */
const Node = memo(function Node({
  agent,
  state,
  at,
  selected,
  faded,
  onPointerDown,
  onSelect,
  onFocus,
}: {
  agent: Agent;
  state: AgentState;
  at: Point;
  selected: boolean;
  faded: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>, id: AgentId) => void;
  onSelect: (id: AgentId) => void;
  onFocus: (e: ReactFocusEvent<HTMLButtonElement>, id: AgentId) => void;
}) {
  const activity = agent.context?.activity ?? agent.context?.task;
  return (
    <button
      type="button"
      data-node={agent.id}
      aria-pressed={selected}
      aria-label={`${name(agent)}, ${agent.person}'s ${CLI_LABEL[agent.cli]} Agent, ${stateWord(state, agent.person)}`}
      onPointerDown={(e) => onPointerDown(e, agent.id)}
      onClick={() => onSelect(agent.id)}
      onFocus={(e) => onFocus(e, agent.id)}
      style={{ left: at.x, top: at.y, width: NODE_W, height: NODE_H }}
      className={cn(
        "absolute flex cursor-grab flex-col gap-1.5 rounded-[var(--r)] border border-rule-2 bg-paper p-3 text-left transition-[opacity,background-color] duration-[var(--dur)] select-none active:cursor-grabbing",
        "hover:bg-paper-2",
        state === "needs" && "border-2 border-signal p-[11px]",
        selected && "border-2 border-ink p-[11px]",
        faded && "opacity-55",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Glyph state={state} />
        <span className="min-w-0 flex-1 truncate text-row font-semibold text-ink">{name(agent)}</span>
        {agent.role === "lead" && <LeadLabel />}
      </span>
      <span className="flex min-w-0 items-center gap-2 text-small">
        <span className={cn("shrink-0", needsPerson(state) ? "font-semibold text-signal" : "font-medium text-ink")}>{stateWord(state, agent.person)}</span>
        {agent.model && <ModelLabel model={agent.model} effort={agent.effort} className="inline-flex min-w-0 items-center gap-1 text-ink-3" />}
      </span>
      <span className={cn("min-w-0 truncate text-small", activity ? "text-ink-2" : "text-ink-3")}>{activity ?? "No activity yet"}</span>
      <span className="mt-auto">
        <Meter agent={agent} />
      </span>
    </button>
  );
});

function Frame({ tasks, at }: { tasks: Task[]; at: Point }) {
  const [first, ...more] = tasks;
  const r = slotRect(at);
  return (
    <div
      aria-hidden
      data-ground
      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
      className="absolute rounded-[var(--r)] border border-rule bg-paper"
    >
      <span className="flex h-[var(--frame-top)] flex-col justify-center px-3 text-small text-frame-label" style={{ ["--frame-top" as string]: `${FRAME_TOP - 4}px` }}>
        <span className="flex min-w-0 items-baseline gap-1.5 leading-[1.3]">
          <span className="font-medium text-ink-2 tabular-nums">#{first.number}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{first.title}</span>
          {more.length > 0 && <span className="shrink-0 tabular-nums">+{more.length}</span>}
        </span>
        {first.branch ? (
          <code className="min-w-0 [overflow-wrap:anywhere] font-mono">{first.branch}</code> /* taste-skill-ignore: a branch name is code */
        ) : (
          <span className="min-w-0 [overflow-wrap:anywhere]">No branch yet</span>
        )}
      </span>
    </div>
  );
}

/** A lead's line to an Agent it started: out of the lead's right side, into the Agent's left. */
function edgePath(from: Point, to: Point): string {
  const a = { x: from.x + NODE_W, y: from.y + NODE_H / 2 };
  const b = { x: to.x, y: to.y + NODE_H / 2 };
  const bend = Math.max(48, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
}

function Panel({ agent, state, tasks, onClose, sheet }: { agent: Agent; state: AgentState; tasks: Task[]; onClose: () => void; sheet: boolean }) {
  const { agentById } = useIndex();
  const parent = agent.parent ? agentById.get(agent.parent) : undefined;
  return (
    <aside
      aria-label={`${name(agent)} on the canvas`}
      className={cn(
        "flex min-h-0 flex-col gap-5 overflow-y-auto bg-page p-5",
        sheet ? "absolute inset-x-0 bottom-0 z-10 max-h-[60%] rounded-t-md shadow-float" : "w-[360px] shrink-0",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="flex min-w-0 items-center gap-2 text-lead font-semibold text-ink">
            <Glyph state={state} />
            <span className="truncate">{name(agent)}</span>
          </h2>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-3">
            <span title={STATE_HINT[state]}>
              <State state={state} person={agent.person} />
            </span>
            <span>
              {agent.person}'s {CLI_LABEL[agent.cli]}
            </span>
            {agent.nickname && <span className="tabular-nums">{agent.id}</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "size-8 px-0")}
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      {(agent.role === "lead" || parent) && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-3">
          {agent.role === "lead" && <LeadLabel />}
          {parent && (
            <span>
              Started by{" "}
              <a href={href({ view: "canvas", agent: parent.id })} className="text-ink hover:underline">
                {name(parent)}
              </a>
            </span>
          )}
        </p>
      )}
      <AgentBrief agent={agent} />
      {tasks.length > 0 && (
        <section aria-label="Claims" className="flex flex-col gap-1.5 text-small">
          <span className="text-ink-3">{tasks.length === 1 ? "Holds" : `Holds ${tasks.length} Tasks`}</span>
          {tasks.map((t) => (
            <TaskLink key={t.number} number={t.number} title={t.title} className="text-body" />
          ))}
        </section>
      )}
      <ContextWindow agent={agent} />
      <a href={href({ view: "agent", id: agent.id })} className={cn(buttonVariants({ variant: "primary", size: "md" }), "w-full")}>
        Open Agent page
      </a>
    </aside>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} onClick={onClick} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "size-8 px-0")}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function CanvasView({ selected }: { selected?: string }) {
  const { agents, tasks, snapshot } = useChannel();
  const me = useMe();
  const repo = snapshot?.channel.repo ?? "channel";
  const mobile = useIsMobile();
  const [view, setView] = useState<View>(() => loadView(repo));
  // Another Channel, or the first snapshot naming this one: its own saved layout.
  const [viewRepo, setViewRepo] = useState(repo);
  if (viewRepo !== repo) {
    setViewRepo(repo);
    setView(loadView(repo));
  }
  const [size, setSize] = useState({ w: 0, h: 0 });
  const viewport = useRef<HTMLDivElement>(null);

  const claims = useMemo(() => claimsByAgent(tasks), [tasks]);
  const states = useAgentStates();
  const laneList = useMemo(() => laneOrder(agents, tasks, me), [agents, tasks, me]);
  const at = useMemo(() => place(laneList, view.positions), [laneList, view.positions]);
  const allRects = useMemo(() => [...at.values()].map(slotRect), [at]);

  // A node keeps the place it was first drawn in: pin every newly placed node.
  useEffect(() => {
    const fresh = [...at].filter(([id]) => !view.positions[id]);
    if (fresh.length === 0) return;
    setView((v) => ({ ...v, positions: { ...v.positions, ...Object.fromEntries(fresh) } }));
  }, [at, view.positions]);

  useEffect(() => {
    if (viewRepo === repo) saveView(repo, view);
  }, [repo, viewRepo, view]);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The first time there is room and nodes, frame them all. After that the camera moves only when the Person moves it.
  const camera = view.camera ?? (size.w ? fit(bounds(allRects), size.w, size.h, FIRST_ZOOM) : { x: 0, y: 0, k: 1 });
  const setCamera = useCallback((next: Camera | ((c: Camera) => Camera)) => {
    setView((v) => {
      const current = v.camera ?? camera;
      return { ...v, camera: typeof next === "function" ? next(current) : next };
    });
  }, [camera]);
  useEffect(() => {
    if (!view.camera && size.w && allRects.length) setView((v) => (v.camera ? v : { ...v, camera: fit(bounds(allRects), size.w, size.h, FIRST_ZOOM) }));
  }, [view.camera, size, allRects]);
  const fitAll = () => setCamera(fit(bounds(allRects), size.w, size.h));
  const zoomBy = (factor: number) => setCamera((c) => zoomAt(c, factor, { x: size.w / 2, y: size.h / 2 }));

  // Wheel: scroll pans, ctrl or a pinch on a trackpad zooms about the pointer. Not passive, so the page never scrolls.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) setCamera((c) => zoomAt(c, Math.exp(-e.deltaY * 0.01), { x: e.clientX - box.left, y: e.clientY - box.top }));
      else setCamera((c) => ({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setCamera]);

  // Pointers: one on the ground pans, two pinch, one on a node drags it once it moves a few pixels.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<
    | { kind: "pan"; last: Point; travel: number }
    | { kind: "pinch"; distance: number }
    | { kind: "node"; id: AgentId; start: Point; origin: Point; moved: boolean }
    | null
  >(null);
  const suppressClick = useRef(false);

  const distance = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onDown = (e: ReactPointerEvent<HTMLElement>, node?: AgentId) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Captured by what was pressed, so a press and release on a node still click that node.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 2) gesture.current = { kind: "pinch", distance: distance() };
    else if (node) gesture.current = { kind: "node", id: node, start: { x: e.clientX, y: e.clientY }, origin: at.get(node) ?? { x: 0, y: 0 }, moved: false };
    else gesture.current = { kind: "pan", last: { x: e.clientX, y: e.clientY }, travel: 0 };
  };

  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      const dx = e.clientX - g.last.x;
      const dy = e.clientY - g.last.y;
      g.last = { x: e.clientX, y: e.clientY };
      g.travel += Math.hypot(dx, dy);
      setCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
    } else if (g.kind === "pinch") {
      const d = distance();
      const [a, b] = [...pointers.current.values()];
      const box = viewport.current?.getBoundingClientRect();
      if (!d || !a || !b || !box) return;
      const mid = { x: (a.x + b.x) / 2 - box.left, y: (a.y + b.y) / 2 - box.top };
      // Read before the update runs: by then the gesture holds the new distance.
      const factor = d / g.distance;
      g.distance = d;
      setCamera((c) => zoomAt(c, factor, mid));
    } else {
      const dx = (e.clientX - g.start.x) / camera.k;
      const dy = (e.clientY - g.start.y) / camera.k;
      if (!g.moved && Math.hypot(dx, dy) * camera.k < 4) return;
      g.moved = true;
      const id = g.id;
      const p = { x: Math.round(g.origin.x + dx), y: Math.round(g.origin.y + dy) };
      setView((v) => ({ ...v, positions: { ...v.positions, [id]: p } }));
    }
  };

  const onUp = (e: ReactPointerEvent<HTMLElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if ((g?.kind === "node" && g.moved) || (g?.kind === "pan" && g.travel > 4) || g?.kind === "pinch") suppressClick.current = true;
    const rest = [...pointers.current.values()][0];
    gesture.current = rest ? { kind: "pan", last: rest, travel: 0 } : null;
  };

  const isGround = (target: EventTarget) =>
    target === viewport.current || ((target as HTMLElement).closest?.("[data-ground]") && !(target as HTMLElement).closest("[data-node]"));

  const select = (id?: AgentId) => go({ view: "canvas", agent: id });

  const onKey = (e: React.KeyboardEvent) => {
    // Escape closes the Agent from anywhere on the canvas; the rest is for the canvas itself.
    if (e.key === "Escape" && selected) {
      select();
      e.preventDefault();
      return;
    }
    if (e.target !== viewport.current) return;
    const step = 64;
    const moves: Record<string, Point> = { ArrowLeft: { x: step, y: 0 }, ArrowRight: { x: -step, y: 0 }, ArrowUp: { x: 0, y: step }, ArrowDown: { x: 0, y: -step } };
    if (moves[e.key]) {
      const m = moves[e.key]!;
      setCamera((c) => ({ ...c, x: c.x + m.x, y: c.y + m.y }));
    } else if (e.key === "+" || e.key === "=") zoomBy(1.2);
    else if (e.key === "-") zoomBy(1 / 1.2);
    else if (e.key === "0") fitAll();
    else return;
    e.preventDefault();
  };

  // Tabbing to a node the camera does not show brings it into view: the viewport clips
  // and never scrolls, so the camera is the only thing that can move.
  const reveal = (e: ReactFocusEvent<HTMLButtonElement>, id: AgentId) => {
    const p = at.get(id);
    if (!p || !size.w || !e.currentTarget.matches(":focus-visible")) return;
    const margin = 24;
    const k = camera.k;
    const left = camera.x + p.x * k;
    const top = camera.y + p.y * k;
    const dx = left < margin ? margin - left : left + NODE_W * k > size.w - margin ? size.w - margin - (left + NODE_W * k) : 0;
    const dy = top < margin ? margin - top : top + NODE_H * k > size.h - margin ? size.h - margin - (top + NODE_H * k) : 0;
    if (dx || dy) setCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
  };

  // Each node gets handlers that never change, calling the latest of these, so a node
  // renders again only when what it shows changes.
  const latest = useRef({ onDown, select, reveal, selected });
  latest.current = { onDown, select, reveal, selected };
  const onNodeDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>, id: AgentId) => latest.current.onDown(e, id), []);
  const onNodeFocus = useCallback((e: ReactFocusEvent<HTMLButtonElement>, id: AgentId) => latest.current.reveal(e, id), []);
  const onNodeSelect = useCallback((id: AgentId) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    latest.current.select(latest.current.selected === id ? undefined : id);
  }, []);

  const chosen = selected ? agents.find((a) => a.id === selected) : undefined;
  const n = countStates(states.values());
  const mine = useNeedsYou();
  const held = agents.filter((a) => claims.has(a.id)).length;

  if (agents.length === 0) {
    return (
      <Pending title="No Agents on the canvas yet" className="h-full">
        Run <code className="font-mono text-ink-2">switchboard run claude</code> and its Agent appears here.
      </Pending>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-[var(--gutter)] pt-6 pb-4 sm:pt-8">
        <PageHead
          title="Canvas"
          actions={
            <span className="flex items-center gap-0.5">
              <IconButton label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
                <Minus className="size-4" aria-hidden />
              </IconButton>
              <span className="w-12 text-center text-small text-ink-3 tabular-nums" aria-live="polite">
                {Math.round(camera.k * 100)}%
              </span>
              <IconButton label="Zoom in" onClick={() => zoomBy(1.2)}>
                <Plus className="size-4" aria-hidden />
              </IconButton>
              <IconButton label="Fit every Agent" onClick={fitAll}>
                <Maximize className="size-4" aria-hidden />
              </IconButton>
              <IconButton label="Reset layout" onClick={() => setView({ positions: {} })}>
                <RotateCcw className="size-4" aria-hidden />
              </IconButton>
            </span>
          }
          facts={[
            `${agents.length} ${agents.length === 1 ? "Agent" : "Agents"}`,
            `${n.running} running`,
            mine > 0 && <span className="font-semibold text-signal">{mine} {mine === 1 ? "needs" : "need"} you</span>,
            `${held} holding a Task`,
            "a line is who started whom",
          ]}
        />
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={viewport}
          role="application"
          aria-roledescription="canvas"
          aria-label="Agents on the Channel. Drag to pan, arrow keys to move, plus and minus to zoom, 0 to fit."
          tabIndex={0}
          onKeyDown={onKey}
          onPointerDown={(e) => {
            if (isGround(e.target)) onDown(e);
          }}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onClick={(e) => {
            if (!isGround(e.target)) return;
            if (suppressClick.current) suppressClick.current = false;
            else select();
          }}
          className="relative min-w-0 flex-1 cursor-default touch-none overflow-clip bg-canvas-bg focus-visible:-outline-offset-2"
        >
          <div
            data-ground
            className="absolute top-0 left-0 origin-top-left"
            style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.k})` }}
          >
            {laneList.map((lane) => {
              const box = bounds(lane.agents.map((a) => slotRect(at.get(a.id) ?? { x: 0, y: 0 })));
              if (!box) return null;
              return (
                <span
                  key={lane.person}
                  data-ground
                  data-lane={lane.person}
                  className="absolute flex items-baseline gap-2 text-body whitespace-nowrap"
                  style={{ left: box.x, top: box.y - LANE_LABEL }}
                >
                  <span className="font-semibold text-ink">{lane.person === me ? `${lane.person} (you)` : lane.person}</span>
                  <span className="text-small text-ink-3 tabular-nums">
                    {lane.agents.length} {lane.agents.length === 1 ? "Agent" : "Agents"}
                  </span>
                </span>
              );
            })}
            {agents.map((a) => {
              const held = claims.get(a.id);
              const p = at.get(a.id);
              return held && p ? <Frame key={`frame-${a.id}`} tasks={held} at={p} /> : null;
            })}
            <svg aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1">
              {agents.map((a) => {
                const from = a.parent ? at.get(a.parent) : undefined;
                const to = at.get(a.id);
                if (!from || !to) return null;
                const active = selected === a.id || selected === a.parent;
                return (
                  <path
                    key={`edge-${a.id}`}
                    data-edge={`${a.parent} ${a.id}`}
                    d={edgePath(from, to)}
                    fill="none"
                    strokeWidth={active ? 2 : 1.5}
                    className={active ? "stroke-edge-active" : "stroke-edge"}
                  />
                );
              })}
            </svg>
            {/* In lane order, so Tab moves through the canvas the way it reads. */}
            {laneList.flatMap((lane) => lane.agents).map((a) => {
              const state = states.get(a.id) ?? "gone";
              return (
                <Node
                  key={a.id}
                  agent={a}
                  state={state}
                  at={at.get(a.id) ?? ORIGIN}
                  selected={selected === a.id}
                  faded={state === "gone" && !claims.has(a.id)}
                  onPointerDown={onNodeDown}
                  onSelect={onNodeSelect}
                  onFocus={onNodeFocus}
                />
              );
            })}
          </div>
        </div>
        {chosen && (
          <Panel
            agent={chosen}
            state={states.get(chosen.id) ?? "gone"}
            tasks={claims.get(chosen.id) ?? []}
            onClose={() => select()}
            sheet={mobile}
          />
        )}
      </div>
    </div>
  );
}
