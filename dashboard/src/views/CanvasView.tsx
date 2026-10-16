/*
 * The canvas (ADR 0020, design.md's Canvas board): the Channel's Agents as nodes, laid out
 * by Host. Each Host is a frame; the Agents a Person started by hand share one frame for
 * that Person's terminals. A line runs from a lead to each Agent it started. It draws the
 * Channel and creates nothing; a node opens its Agent in the inspector. Where nodes sit and
 * the camera are this browser's view state, per Channel.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import type { Agent, AgentId, Task } from "@shared/index";
import { modelLabel } from "@shared/index";
import { Button, buttonVariants } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { Facts, Steps } from "@/components/domain/agent-sections";
import { DenyAction, PendingApproval } from "@/components/domain/approval";
import { contextPercent, shortName } from "@/components/domain/fleet";
import { InspectorFrame } from "@/components/shell/inspector";
import { EmptyView } from "@/components/shell/states";
import { FirstAgentAction, StartAgentButton } from "@/components/domain/start-agent";
import { Glyph, State, useAgentStates, useNeedsYou } from "@/components/domain/state";
import { TakeoverAction } from "@/components/domain/takeover";
import { PageHead } from "@/components/shell/page-head";
import { Section } from "@/components/shell/section";
import { useChannel, useMe } from "@/data/store";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  NODE_H,
  NODE_W,
  bounds,
  claimsByAgent,
  edgePoints,
  fit,
  frameRect,
  groups as groupOrder,
  place,
  zoomAt,
  type Camera,
  type Group,
  type Point,
  type Rect,
} from "@/lib/canvas-layout";
import { CLI_LABEL, ago, elapsed, hostName } from "@/lib/format";
import { go, href } from "@/lib/router";
import { needsPerson, stateWord, type AgentState } from "@/lib/state";
import { cn } from "@/lib/utils";

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
const ORIGIN: Point = { x: 0, y: 0 };
const name = (a: Agent) => a.nickname ?? a.id;

type Filter = "everyone" | "mine" | "needs";

/** The age a node shows: how long a prompt has waited, how long it has been Gone, else how long it has run. */
function age(a: Agent, state: AgentState): string {
  if ((state === "needs" || state === "needs-other") && a.approval) return elapsed(a.approval.openedAt);
  if (state === "gone" || state === "stale") return elapsed(a.lastSeenAt);
  return elapsed(a.startedAt);
}

/**
 * A Task's title cut at a word to fit a node's line, never with an ellipsis (design.md); the
 * whole title is in the node's label and the inspector.
 */
export function shortTitle(title: string, max = 26): string {
  if (title.length <= max) return title;
  const words = title.split(/\s+/);
  // A first word too long for the line is cut where the line ends.
  let out = words[0]!.slice(0, max);
  for (const w of words.slice(1)) {
    if (out.length + 1 + w.length > max) break;
    out += ` ${w}`;
  }
  return out;
}

/** A frame's name: the Host, or the Person's terminals for Agents started by hand. */
const frameName = (g: Group) => (g.host ? hostName(g.host) : "terminals");

/**
 * One Agent's node (design.md): glyph, name and lead tag; its Task; the state word, age and
 * context; and two controls matching the Ask. Memoised, with handlers that never change, so
 * panning, which moves only the camera, renders no node again.
 */
const Node = memo(function Node({
  agent,
  state,
  task,
  repo,
  at,
  selected,
  filtered,
  muted,
  onPointerDown,
  onSelect,
  onFocus,
}: {
  agent: Agent;
  state: AgentState;
  task?: Task;
  repo?: string;
  at: Point;
  selected: boolean;
  /** Left out by the filter: not drawn, and out of the Tab order, but keeping its place. */
  filtered: boolean;
  /** Gone with nothing held: drawn quieter. */
  muted: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, id: AgentId) => void;
  onSelect: (id: AgentId) => void;
  onFocus: (e: ReactFocusEvent<HTMLButtonElement>, id: AgentId) => void;
}) {
  const percent = contextPercent(agent);
  const asking = state === "needs" ? agent.approval : undefined;
  const review = task?.status === "review" && task.pr !== undefined ? task.pr : undefined;
  return (
    <div
      data-node={agent.id}
      hidden={filtered}
      onPointerDown={(e) => onPointerDown(e, agent.id)}
      style={{ left: at.x, top: at.y, width: NODE_W, height: NODE_H }}
      className={cn(
        "group absolute rounded-[var(--r)] border border-rule-2 bg-paper transition-opacity duration-[var(--dur)] select-none hover:bg-paper-2",
        state === "needs" || state === "needs-other" || state === "stale" ? "border-2 border-signal" : undefined,
        selected && "outline-2 outline-offset-2 outline-ink outline-solid",
        // Gone with nothing held: only its outline goes quiet, its words stay readable.
        muted && "border-rule",
      )}
    >
      {/* The whole node selects it; the controls sit above this. */}
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${name(agent)}, ${agent.person}'s ${CLI_LABEL[agent.cli]} Agent, ${stateWord(state, agent.person)}${task ? `, #${task.number} ${task.title}` : ""}`}
        onClick={() => onSelect(agent.id)}
        onFocus={(e) => onFocus(e, agent.id)}
        className="absolute inset-0 cursor-grab rounded-[var(--r)] active:cursor-grabbing"
      />
      <div className={cn("pointer-events-none relative flex h-full flex-col gap-1 text-small", state === "needs" || state === "needs-other" || state === "stale" ? "p-[11px]" : "p-3")}>
        <span className="flex min-w-0 items-center gap-2">
          <Glyph state={state} />
          <span className={cn("min-w-0 flex-1 truncate text-row font-semibold", state === "gone" ? "text-ink-3" : "text-ink")}>{shortName(agent)}</span>
          {agent.role === "lead" && <span className="shrink-0 rounded-[var(--r)] border border-rule-2 px-1.5 text-ink-3">lead</span>}
        </span>
        <span className="min-w-0 overflow-hidden whitespace-nowrap text-ink-3" title={task?.title}>
          {task ? `#${task.number} ${shortTitle(task.title)}` : "No Claim"}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-ink-3 tabular-nums">
          <span className={needsPerson(state) ? "font-semibold text-signal" : "font-medium text-ink"}>{stateWord(state, agent.person)}</span>
          <span aria-hidden>·</span>
          {age(agent, state)}
          {percent !== undefined && (
            <>
              <span aria-hidden>·</span>
              <span>{percent}%</span>
              <span aria-hidden className="h-1 w-10 bg-rule">
                <span className="block h-full bg-ink-2" style={{ width: `${Math.min(100, percent)}%` }} />
              </span>
            </>
          )}
        </span>
        <span className="pointer-events-auto mt-auto flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
          {asking?.deniable && !asking.deniedBy && <DenyAction agent={agent} id={asking.id} tool={asking.tool} size="sm" />}
          {state === "stale" && task && <TakeoverAction task={task} line size="sm" />}
          {review !== undefined && repo && (
            <a href={`https://github.com/${repo}/pull/${review}`} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm" })}>
              Review PR #{review}
            </a>
          )}
          <a href={href({ view: "agent", id: agent.id })} className={buttonVariants({ variant: state === "running" || state === "idle" || state === "needs-other" ? "secondary" : "ghost", size: "sm" })}>
            {state === "needs" ? "Open the terminal" : state === "running" || state === "idle" || state === "needs-other" ? "Watch" : "Open"}
          </a>
        </span>
      </div>
    </div>
  );
});

/**
 * A Host's frame: a rule-2 outline with its name and Person on the top rule. design.md puts
 * the Host's capacity there ("shlok · 3 of 8"), but a Host does not report how many Agents
 * it may run, only the Channel's cap across all Hosts, so the frame counts its Agents.
 */
function Frame({ group, rect, me }: { group: Group; rect: Rect; me: string }) {
  return (
    <div data-ground data-frame={group.key} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} className="absolute rounded-[var(--r)] border border-rule-2">
      <span data-ground className="absolute -top-[0.75em] left-3 flex items-baseline gap-1.5 bg-paper px-1.5 text-small whitespace-nowrap">
        <span className="font-semibold text-ink">{frameName(group)}</span>
        <span className="text-ink-3 tabular-nums">
          {group.person === me ? `${group.person} (you)` : group.person} · {group.agents.length} {group.agents.length === 1 ? "Agent" : "Agents"}
        </span>
      </span>
    </div>
  );
}

const LEGEND: [AgentState, string][] = [
  ["needs", "needs you"],
  ["needs-other", "needs someone else"],
  ["stale", "stale Claim"],
  ["running", "running"],
  ["idle", "idle"],
  ["gone", "gone"],
];

/** The canvas's key to its glyphs. */
function Legend() {
  return (
    <ul aria-label="Key" className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[var(--r)] border border-rule bg-paper px-3 py-2 text-small text-ink-2">
      {LEGEND.map(([s, word]) => (
        <li key={s} className="flex items-center gap-1.5">
          <Glyph state={s} />
          {word}
        </li>
      ))}
    </ul>
  );
}

/** The frames in miniature and the part the camera shows. A press moves the view there. */
function Minimap({ frames, camera, size, onMove }: { frames: Rect[]; camera: Camera; size: { w: number; h: number }; onMove: (world: Point) => void }) {
  const seen: Rect = { x: -camera.x / camera.k, y: -camera.y / camera.k, w: size.w / camera.k, h: size.h / camera.k };
  const world = bounds([...frames, seen]);
  if (!world) return null;
  const W = 128;
  const H = 80;
  const s = Math.min(W / world.w, H / world.h);
  const box = (r: Rect) => ({ left: (r.x - world.x) * s, top: (r.y - world.y) * s, width: Math.max(2, r.w * s), height: Math.max(2, r.h * s) });
  const press = (e: ReactPointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    onMove({ x: world.x + (e.clientX - b.left) / s, y: world.y + (e.clientY - b.top) / s });
  };
  return (
    <div aria-hidden onPointerDown={press} className="relative cursor-pointer rounded-[var(--r)] border border-rule-2 bg-paper" style={{ width: W + 2, height: H + 2 }}>
      {frames.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: frames keep their order
        <span key={i} className="absolute border border-rule-2" style={box(r)} />
      ))}
      <span className="absolute border border-ink" style={box(seen)} />
    </div>
  );
}

/**
 * A phone's canvas (design.md): the same frames as lanes in a list, each Agent a two-line row,
 * and an Agent its lead started set in under that lead, which is what a line says on the canvas.
 * A row opens the Agent in the inspector's sheet.
 */
function Lanes({
  groups,
  states,
  claims,
  me,
  selected,
  shown,
}: {
  groups: Group[];
  states: Map<string, AgentState>;
  claims: Map<string, Task[]>;
  me: string;
  selected?: string;
  shown: (a: Agent) => boolean;
}) {
  const lanes = groups.map((g) => ({ group: g, agents: g.agents.filter(shown) })).filter((l) => l.agents.length > 0);
  if (lanes.length === 0) return <p className="pt-2 text-row text-ink-2">No Agent here passes the filter.</p>;
  return (
    <div className="flex flex-col gap-6">
      {lanes.map(({ group, agents }) => {
        // In the lane's order, each lead followed by the Agents it started, however deep.
        const inLane = new Set(agents.map((a) => a.id));
        const rows: { agent: Agent; depth: number }[] = [];
        const add = (a: Agent, depth: number) => {
          rows.push({ agent: a, depth });
          for (const c of agents) if (c.parent === a.id) add(c, depth + 1);
        };
        for (const a of agents) if (!a.parent || !inLane.has(a.parent)) add(a, 0);
        return (
          <section key={group.key} aria-labelledby={`lane-${group.key}`}>
            <h2 id={`lane-${group.key}`} className="flex items-baseline gap-1.5 border-b border-rule-2 pb-2 text-small" /* taste-skill-ignore: the phone list's group rule, as the fleet's */>
              <span className="text-title font-semibold text-ink">{frameName(group)}</span>
              <span className="text-ink-3 tabular-nums">
                {group.person === me ? `${group.person} (you)` : group.person} · {agents.length} {agents.length === 1 ? "Agent" : "Agents"}
              </span>
            </h2>
            <ul>
              {rows.map(({ agent, depth }) => {
                const state = states.get(agent.id) ?? "gone";
                const task = claims.get(agent.id)?.[0];
                const lead = agent.parent ? agents.find((p) => p.id === agent.parent) : undefined;
                return (
                  <li key={agent.id} className="border-b border-rule" /* taste-skill-ignore: the phone list's row rule, as the fleet's */ style={{ paddingLeft: Math.min(depth, 3) * 20 }}>
                    <a
                      href={href({ view: "canvas", agent: agent.id })}
                      aria-current={selected === agent.id ? "true" : undefined}
                      className="flex min-h-11 w-full flex-col gap-0.5 py-2.5 text-left hover:bg-paper-2 hover:no-underline focus-visible:-outline-offset-2"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Glyph state={state} />
                        <span className={cn("min-w-0 flex-1 text-row font-semibold [overflow-wrap:anywhere]", state === "gone" ? "text-ink-3" : "text-ink")}>{shortName(agent)}</span>
                        <span className={cn("shrink-0 text-small tabular-nums", needsPerson(state) ? "font-semibold text-signal" : "text-ink-3")}>
                          {stateWord(state, agent.person)} · {age(agent, state)}
                        </span>
                      </span>
                      <span className="pl-5 text-small [overflow-wrap:anywhere] text-ink-3">
                        {task ? `#${task.number} ${task.title}` : "No Claim"}
                        {lead && ` · started by ${shortName(lead)}`}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** The open Agent (design.md's inspector): who and where, its Ask, its Task's Steps, and where it runs. */
function Inspector({ agent, state, tasks, sheet, onClose }: { agent: Agent; state: AgentState; tasks: Task[]; sheet: boolean; onClose: () => void }) {
  const me = useMe();
  const { agents } = useChannel();
  const parent = agent.parent ? agents.find((a) => a.id === agent.parent) : undefined;
  const children = agents.filter((a) => a.parent === agent.id);
  const percent = contextPercent(agent);
  const mine = agent.person === me;
  const fact = [
    `${mine ? "Your" : `${agent.person}'s`} ${CLI_LABEL[agent.cli]} ${agent.host ? `on ${hostName(agent.host)}` : "in a terminal"}.`,
    agent.model && `${modelLabel(agent.model)}.`,
    `Started ${ago(agent.startedAt)}${children.length ? `, leads ${children.map(shortName).join(", ")}` : ""}.`,
  ]
    .filter(Boolean)
    .join(" ");
  const label = `${name(agent)} on the canvas`;
  const body = (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <h2 className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-title font-semibold [overflow-wrap:anywhere] text-ink">
            <Glyph state={state} />
            {name(agent)}
            <State state={state} person={agent.person} glyph={false} className="text-small" />
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "size-7 px-0 max-sm:size-11")}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <p className="text-row text-ink-2">{fact}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <a href={href({ view: "agent", id: agent.id })} className={buttonVariants({ variant: "primary" })}>
            {mine ? "Open the terminal" : "Watch"}
          </a>
        </div>
      </div>
      {agent.approval && agent.presence !== "gone" && <PendingApproval agent={agent} openLink={false} />}
      {tasks.map((t) => (
        <Steps key={t.number} task={t} as="h3" />
      ))}
      <Section title="Where" as="h3">
        <Facts
          rows={[
            ["Host", agent.host ? hostName(agent.host) : "a terminal", !agent.host && "started by hand"],
            tasks[0]?.branch && ["Branch", <code key="b">{tasks[0].branch}</code>],
            percent !== undefined && ["Context", `${percent}%`, agent.context?.tokens !== undefined && agent.context.window ? `${Math.round(agent.context.tokens / 1000)}k of ${agent.context.window >= 1_000_000 ? `${agent.context.window / 1_000_000}M` : `${Math.round(agent.context.window / 1000)}k`} tokens` : undefined],
            ["Started by", parent ? shortName(parent) : agent.person, parent && "a lead"],
          ]}
        />
      </Section>
    </>
  );
  // On a phone the inspector is a sheet over the list, as every view's is.
  if (sheet) {
    return (
      <InspectorFrame label={label} onClose={onClose}>
        {body}
      </InspectorFrame>
    );
  }
  return (
    <aside
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="flex min-h-0 w-[320px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-rule bg-paper pl-5"
    >
      {body}
    </aside>
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
  const [filter, setFilter] = useState<Filter>("everyone");
  const viewport = useRef<HTMLDivElement>(null);

  const claims = useMemo(() => claimsByAgent(tasks), [tasks]);
  const states = useAgentStates();
  const groupList = useMemo(() => groupOrder(agents, tasks, me), [agents, tasks, me]);
  const at = useMemo(() => place(groupList, view.positions), [groupList, view.positions]);
  const frames = useMemo(
    () => groupList.map((g) => ({ group: g, rect: frameRect(g.agents.map((a) => at.get(a.id) ?? ORIGIN)) })).filter((f): f is { group: Group; rect: Rect } => f.rect !== null),
    [groupList, at],
  );
  const allRects = useMemo(() => frames.map((f) => f.rect), [frames]);

  // A node keeps the place it was first drawn in: pin every newly placed node.
  useEffect(() => {
    const fresh = [...at].filter(([id]) => !view.positions[id]);
    if (fresh.length === 0) return;
    setView((v) => ({ ...v, positions: { ...v.positions, ...Object.fromEntries(fresh) } }));
  }, [at, view.positions]);

  useEffect(() => {
    if (viewRepo === repo) saveView(repo, view);
  }, [repo, viewRepo, view]);

  // The viewport is on the page only once there are Agents: measure it from then on.
  const empty = agents.length === 0;
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [empty, mobile]);

  // The canvas starts readable, at 100%.
  const firstView = useCallback(() => fit(bounds(allRects), size.w, size.h, FIRST_ZOOM, 32, "start"), [allRects, size]);
  // The first time there is room and nodes, frame them all. After that the camera moves only when the Person moves it.
  const saved = view.camera;
  const camera = saved ?? (size.w ? firstView() : { x: 0, y: 0, k: 1 });
  const setCamera = useCallback(
    (next: Camera | ((c: Camera) => Camera)) => {
      setView((v) => {
        const current = v.camera ?? camera;
        return { ...v, camera: typeof next === "function" ? next(current) : next };
      });
    },
    [camera],
  );
  useEffect(() => {
    if (!saved && size.w && allRects.length) setView((v) => (v.camera ? v : { ...v, camera: firstView() }));
  }, [saved, size, allRects, firstView]);
  const fitAll = () => setCamera(fit(bounds(allRects), size.w, size.h));
  const zoomBy = (factor: number) => setCamera((c) => zoomAt(c, factor, { x: size.w / 2, y: size.h / 2 }));
  const centerOn = (p: Point) => setCamera((c) => ({ ...c, x: size.w / 2 - p.x * c.k, y: size.h / 2 - p.y * c.k }));

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
  }, [setCamera, mobile]);

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
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 2) gesture.current = { kind: "pinch", distance: distance() };
    else if (node) gesture.current = { kind: "node", id: node, start: { x: e.clientX, y: e.clientY }, origin: at.get(node) ?? ORIGIN, moved: false };
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
  const onNodeDown = useCallback((e: ReactPointerEvent<HTMLElement>, id: AgentId) => latest.current.onDown(e, id), []);
  const onNodeFocus = useCallback((e: ReactFocusEvent<HTMLButtonElement>, id: AgentId) => latest.current.reveal(e, id), []);
  const onNodeSelect = useCallback((id: AgentId) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    latest.current.select(latest.current.selected === id ? undefined : id);
  }, []);

  const chosen = selected ? agents.find((a) => a.id === selected) : undefined;
  const needsYou = useNeedsYou();
  const mineCount = agents.filter((a) => a.person === me).length;
  const needsCount = agents.filter((a) => needsPerson(states.get(a.id) ?? "gone")).length;
  const hostCount = new Set(agents.flatMap((a) => (a.host ? [a.host] : []))).size;
  const shown = (a: Agent) => filter === "everyone" || (filter === "mine" ? a.person === me : needsPerson(states.get(a.id) ?? "gone"));

  if (agents.length === 0) {
    return (
      <EmptyView view="Canvas" title="No Agents on the canvas yet" action={<FirstAgentAction />}>
        Each Agent is a box here, grouped by its Host, with a line to the Agent that started it.
      </EmptyView>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col gap-4 px-[var(--gutter)] pt-4 pb-6", mobile && "overflow-y-auto pb-12")}>
      <PageHead
        title="Canvas"
        facts={[
          hostCount > 0 && `${hostCount} ${hostCount === 1 ? "Host" : "Hosts"}`,
          `${agents.length} ${agents.length === 1 ? "Agent" : "Agents"}`,
          needsYou > 0 && <span className="font-semibold text-signal">{needsYou} {needsYou === 1 ? "needs" : "need"} you</span>,
          mobile ? "set in under the Agent that started it" : "a line is who started whom",
          !mobile && "positions are yours and kept in this browser",
        ]}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
          <Chip on={filter === "everyone"} onClick={() => setFilter("everyone")}>
            Everyone
          </Chip>
          <Chip on={filter === "mine"} onClick={() => setFilter("mine")} count={mineCount}>
            Mine
          </Chip>
          <Chip on={filter === "needs"} onClick={() => setFilter("needs")} count={needsCount}>
            Needs a Person
          </Chip>
        </div>
        <span className="text-small font-medium text-ink-2 max-sm:hidden">Laid out by Host</span>
        <div className="ml-auto flex flex-wrap items-center gap-2 max-sm:ml-0">
          {!mobile && <Button onClick={fitAll}>Fit</Button>}
          {!mobile && <Button onClick={() => setView({ positions: {} })}>Reset layout</Button>}
          <StartAgentButton />
        </div>
      </div>
      {mobile ? (
        <Lanes groups={groupList} states={states} claims={claims} me={me} selected={selected} shown={shown} />
      ) : (
        <div className="relative flex min-h-[420px] flex-1 gap-6">
          <div className="relative min-w-0 flex-1 overflow-hidden rounded-[var(--r)] border border-rule">
            <div
              ref={viewport}
              role="application"
              aria-roledescription="canvas"
              aria-label="Agents on the Channel, by Host. Drag to pan, arrow keys to move, plus and minus to zoom, 0 to fit."
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
              className="absolute inset-0 cursor-default touch-none overflow-clip bg-paper focus-visible:-outline-offset-2"
            >
              {/* The 24px dot grid (design.md), moving with the camera. */}
              <svg aria-hidden data-ground className="absolute inset-0 size-full">
                <pattern id="canvas-dots" patternUnits="userSpaceOnUse" width={24 * camera.k} height={24 * camera.k} x={camera.x} y={camera.y}>
                  <circle cx={1.2} cy={1.2} r={1.1} style={{ fill: "var(--rule)" }} />
                </pattern>
                <rect width="100%" height="100%" fill="url(#canvas-dots)" />
              </svg>
              <div data-ground className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.k})` }}>
                {frames.map((f) => (
                  <Frame key={f.group.key} group={f.group} rect={f.rect} me={me} />
                ))}
                <svg aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1">
                  <defs>
                    <marker id="lead-head" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                      <path d="M0 0 L8 4 L0 8 z" className="fill-edge" />
                    </marker>
                    <marker id="lead-head-active" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                      <path d="M0 0 L8 4 L0 8 z" className="fill-edge-active" />
                    </marker>
                  </defs>
                  {agents.map((a) => {
                    const from = a.parent ? at.get(a.parent) : undefined;
                    const to = at.get(a.id);
                    if (!from || !to || !shown(a) || !agents.some((p) => p.id === a.parent && shown(p))) return null;
                    const active = selected === a.id || selected === a.parent;
                    return (
                      <polyline
                        key={`edge-${a.id}`}
                        data-edge={`${a.parent} ${a.id}`}
                        points={edgePoints(from, to)
                          .map((p) => `${p.x},${p.y}`)
                          .join(" ")}
                        fill="none"
                        strokeWidth={active ? 2 : 1.5}
                        markerEnd={`url(#${active ? "lead-head-active" : "lead-head"})`}
                        className={active ? "stroke-edge-active" : "stroke-edge"}
                      />
                    );
                  })}
                </svg>
                {/* In frame order, so Tab moves through the canvas the way it reads. */}
                {groupList
                  .flatMap((g) => g.agents)
                  .map((a) => {
                    const state = states.get(a.id) ?? "gone";
                    return (
                      <Node
                        key={a.id}
                        agent={a}
                        state={state}
                        task={claims.get(a.id)?.[0]}
                        repo={snapshot?.channel.repo}
                        at={at.get(a.id) ?? ORIGIN}
                        selected={selected === a.id}
                        filtered={!shown(a)}
                        muted={state === "gone" && !claims.has(a.id)}
                        onPointerDown={onNodeDown}
                        onSelect={onNodeSelect}
                        onFocus={onNodeFocus}
                      />
                    );
                  })}
              </div>
            </div>
            <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-3">
              <div className="pointer-events-auto">
                <Legend />
              </div>
              <div className="pointer-events-auto ml-auto flex flex-col items-end gap-2">
                {size.w > 0 && <Minimap frames={allRects} camera={camera} size={size} onMove={centerOn} />}
                <div className="flex items-center rounded-[var(--r)] border border-rule-2 bg-paper">
                  <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)} className="h-7 w-8 text-row text-ink-2 hover:bg-paper-2 hover:text-ink">
                    −
                  </button>
                  <span className="w-12 text-center text-small text-ink tabular-nums" aria-live="polite">
                    {Math.round(camera.k * 100)}%
                  </span>
                  <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.2)} className="h-7 w-8 text-row text-ink-2 hover:bg-paper-2 hover:text-ink">
                    +
                  </button>
                </div>
              </div>
            </div>
          </div>
          {chosen && <Inspector agent={chosen} state={states.get(chosen.id) ?? "gone"} tasks={claims.get(chosen.id) ?? []} sheet={false} onClose={() => select()} />}
        </div>
      )}
      {mobile && chosen && <Inspector agent={chosen} state={states.get(chosen.id) ?? "gone"} tasks={claims.get(chosen.id) ?? []} sheet onClose={() => select()} />}
    </div>
  );
}

