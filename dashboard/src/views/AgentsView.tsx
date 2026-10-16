/*
 * The Agents view (design.md's Workbench): one table of every Agent, grouped by Person,
 * each row a line with its state first and a menu last, and an inspector at the right for
 * the selected row. The selection is in the address (#/agents/select/<id>), so a reload or a
 * dropped connection comes back to the same Agent. A long fleet renders only the rows near
 * the screen. The table drops Host, then Context, as the space beside the inspector narrows
 * (a container query, since the inspector takes its width whatever the window). Below 640px
 * the rows stack, the inspector is not on the page, and a row opens
 * the Agent as a sheet.
 */
import { Rows3 } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { Person } from "@shared/index";
import { Button, buttonVariants } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { PendingApproval } from "@/components/domain/approval";
import { ContextWindow } from "@/components/domain/context";
import { IssueButton } from "@/components/domain/pending";
import { EmptyState, EmptyView } from "@/components/shell/states";
import { RenameDialog } from "@/components/domain/rename";
import { FirstAgentAction, PauseResumeButton, StartAgentButton, StopAgentButton, useMayControl } from "@/components/domain/start-agent";
import { GroupLine, Secondary, StackedRow, agentName, groupByPerson, shortName, since, useLines, type Line } from "@/components/domain/fleet";
import { Glyph, State, useNeedsYou } from "@/components/domain/state";
import { AgentUsage } from "@/components/domain/usage";
import { InspectorFrame, SheetClose } from "@/components/shell/inspector";
import { PageHead } from "@/components/shell/page-head";
import { Section } from "@/components/shell/section";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCapabilities, useChannel, useIndex, useMe, useStore } from "@/data/store";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/use-mobile";
import { setDensity, useDensity } from "@/lib/density";
import { CLI_LABEL, ago, elapsed, hostName } from "@/lib/format";
import { go, href, replace } from "@/lib/router";
import { countStates, isNeedsYou } from "@/lib/state";
import { modelLabel } from "@shared/index";
import { cn } from "@/lib/utils";

type Filter = "all" | "needs" | "running" | "idle" | "gone" | "mine";

// Past this many rows (Agents and their Person lines) only the rows near the screen render.
const VIRTUAL_FROM = 80;
const COLUMNS = 7;

/**
 * What the row menu asks the page to do: rename the Agent, or open Stop's question. `back` is
 * the menu's button, where focus returns once the dialog or the question closes.
 */
interface RowActions {
  rename: (id: string, back: HTMLElement | null) => void;
  stop: (id: string, back: HTMLElement | null) => void;
}

export function AgentsView({ selected: selectedId }: { selected?: string }) {
  const { agents, snapshot } = useChannel();
  const me = useMe();
  const can = useCapabilities();
  const mobile = useIsMobile();
  const density = useDensity();
  const [filter, setFilter] = useState<Filter>("all");
  const [find, setFind] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; back: HTMLElement | null } | null>(null);
  // The menu's Stop opens the question in the inspector; a new number asks again.
  const [stopAsk, setStopAsk] = useState<{ id: string; n: number; back: HTMLElement | null }>();
  // State, not a ref: the table's virtualiser reads it in its own layout effect, which runs
  // before this element's ref would be attached, and must render again once it exists.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // The same functions every render, so the memoised rows are not rendered again for them.
  const rowActions = useMemo<RowActions>(
    () => ({
      rename: (id, back) => setRenaming({ id, back }),
      stop: (id, back) => {
        go({ view: "agents", selected: id });
        setStopAsk({ id, n: Date.now(), back });
      },
    }),
    [],
  );

  const lines = useLines();
  const needYou = useNeedsYou();
  const q = find.trim().toLowerCase();
  const shown = useMemo(
    () =>
      lines.filter((l) => {
        const keep =
          filter === "all" ||
          (filter === "needs" && isNeedsYou(l.state)) ||
          (filter === "mine" && l.agent.person === me) ||
          l.state === filter;
        if (!keep || !q) return keep;
        return [l.agent.id, l.agent.nickname, l.agent.host, ...l.claims.map((t) => `#${t.number} ${t.title}`)].some((s) => s?.toLowerCase().includes(q));
      }),
    [lines, filter, me, q],
  );
  const byPerson = useMemo(() => groupByPerson(shown, me), [shown, me]);
  // A Stop asked from the menu belongs to that Agent: picking another lets it go.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of selection lets it go.
  useEffect(() => {
    setStopAsk((ask) => (ask && ask.id !== selectedId ? undefined : ask));
  }, [selectedId]);
  // An address naming an Agent the Channel does not have (stopped and gone from the list, or
  // mistyped) is corrected to the plain view once the Channel has loaded, so it never says one
  // Agent while showing another.
  const unknown = selectedId !== undefined && snapshot !== undefined && agents.length > 0 && !lines.some((l) => l.agent.id === selectedId);
  useEffect(() => {
    if (unknown) replace({ view: "agents" });
  }, [unknown]);

  if (agents.length === 0) {
    return can.agents ? (
      <EmptyView view="Agents" title="No Agents yet" action={<FirstAgentAction />}>
        An Agent joins when someone runs it with <code className="text-ink-2">switchboard run</code>, or starts it on one of their Hosts.
      </EmptyView>
    ) : (
      <EmptyView view="Agents" title="Agents are not on this Channel yet" action={<IssueButton capability="agents" label="Follow the issue" />}>
        This Channel's Worker does not serve Agents. They appear once its issue lands.
      </EmptyView>
    );
  }

  const n = countStates(lines.map((l) => l.state));
  const persons = new Set(agents.map((a) => a.person)).size;
  const chips: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "All", n: lines.length },
    { id: "needs", label: "Needs you", n: lines.filter((l) => isNeedsYou(l.state)).length },
    { id: "running", label: "Live", n: n.running },
    { id: "idle", label: "Idle", n: n.idle },
    { id: "gone", label: "Gone", n: n.gone },
    { id: "mine", label: "Mine", n: lines.filter((l) => l.agent.person === me).length },
  ];
  // The Agent the address names, even when a chip or the search hides its row; otherwise the
  // table's top row on a wide screen, and nothing on a phone until a row is tapped.
  const named = lines.find((l) => l.agent.id === selectedId);
  const selected = named ?? (mobile ? undefined : byPerson[0]?.[1][0]);
  const close = () => go({ view: "agents" });
  const zones = new Map((snapshot?.persons ?? []).map((p: Person) => [p.name, p.timeZone]));
  const renamed = renaming ? agents.find((a) => a.id === renaming.id) : undefined;

  return (
    <div className="flex h-full min-h-0">
      <div ref={setScroller} className="@container flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-[var(--gutter)] pt-5 pb-12">
        <PageHead
          title="Agents"
          facts={[
            `${lines.length} for ${persons} ${persons === 1 ? "Person" : "People"}`,
            `${n.running} live`,
            needYou > 0 && `${needYou} ${needYou === 1 ? "needs" : "need"} you`,
          ]}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <Chip key={c.id} on={filter === c.id} onClick={() => setFilter(c.id)} count={c.n}>
                {c.label}
              </Chip>
            ))}
          </div>
          <label className="ml-auto flex items-center gap-2 text-small text-ink-3 max-sm:w-full">
            <span>Find</span>
            <input
              type="search"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="name, Task or Host"
              className="h-[30px] w-56 min-w-0 rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 text-row text-ink placeholder:text-ink-4 hover:bg-paper-2 max-sm:flex-1 max-sm:text-[16px]"
            />
          </label>
          {/* A view control, not a filter: compact rows are one line each, 30px. */}
          <Button
            variant="ghost"
            aria-pressed={density === "compact"}
            onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}
            className="gap-1.5 aria-pressed:bg-paper-3 max-sm:hidden"
          >
            <Rows3 className="size-3.5" aria-hidden />
            Compact rows
          </Button>
          <StartAgentButton />
        </div>

        {shown.length === 0 ? (
          <EmptyState
            title="No Agent matches"
            action={
              <Button
                onClick={() => {
                  setFilter("all");
                  setFind("");
                }}
              >
                {find.trim() ? "Clear the search" : "Clear the filter"}
              </Button>
            }
          >
            {find.trim() ? <>No Agent{filter !== "all" ? " in this filter" : ""} has “{find.trim()}” in its name, Task or Host.</> : <>None of the {lines.length} Agents is in this filter.</>}
          </EmptyState>
        ) : mobile ? (
          <ul className="flex flex-col">
            {byPerson.map(([person, group]) => (
              <li key={person}>
                <GroupLine person={person} me={me} zone={zones.get(person)} count={group.length} />
                <ul>
                  {group.map((l) => (
                    <StackedRow key={l.agent.id} line={l} onOpen={() => go({ view: "agents", selected: l.agent.id })} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <AgentTable
            groups={byPerson}
            selected={selected?.agent.id}
            scroller={scroller}
            me={me}
            zones={zones}
            compact={density === "compact"}
            actions={rowActions}
            target={named ? selectedId : undefined}
          />
        )}
      </div>
      {selected && (
        <Inspector
          key={selected.agent.id}
          line={selected}
          onClose={mobile ? close : undefined}
          stopAsk={stopAsk?.id === selected.agent.id ? stopAsk : undefined}
        />
      )}
      {renamed && <RenameDialog agent={renamed} open onOpenChange={(open) => !open && setRenaming(null)} returnFocusTo={renaming?.back} />}
    </div>
  );
}

type Item = { kind: "group"; person: string; count: number } | { kind: "agent"; line: Line };

/**
 * The table: one row group per Person. A long fleet is virtualised: rows near the screen
 * render between spacer rows that keep the scroll height, each measured as it renders, and
 * the row holding focus stays rendered when it scrolls away, so focus is never dropped.
 */
function AgentTable({
  groups,
  selected,
  target,
  scroller,
  me,
  zones,
  compact,
  actions,
}: {
  groups: [string, Line[]][];
  selected?: string;
  /** The Agent the address names: scrolled into view when the address names it. */
  target?: string;
  scroller: HTMLDivElement | null;
  me: string;
  zones: Map<string, string | undefined>;
  compact: boolean;
  actions: RowActions;
}) {
  const items = useMemo<Item[]>(
    () => groups.flatMap(([person, g]): Item[] => [{ kind: "group", person, count: g.length }, ...g.map((line): Item => ({ kind: "agent", line }))]),
    [groups],
  );
  const virtual = items.length > VIRTUAL_FROM;
  const head = useRef<HTMLTableSectionElement>(null);
  // Where the rows start inside the scroller: under the page head, the toolbar and the column heads.
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const el = scroller;
    const thead = head.current;
    if (!virtual || !el || !thead) return;
    // From the table's top, which scrolls: the head is sticky, so its own place does not.
    const table = thead.parentElement!;
    const measure = () => setMargin(Math.round(table.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop + thead.offsetHeight));
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, [virtual, scroller]);

  // The row that holds focus, by key: it stays in the rendered range wherever it scrolls.
  const [focused, setFocused] = useState<string>();
  const keyOf = (it: Item) => (it.kind === "group" ? `group:${it.person}` : it.line.agent.id);
  const focusedAt = focused === undefined ? -1 : items.findIndex((it) => keyOf(it) === focused);
  const rows = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scroller,
    // As measured: a Person line, a compact row, a comfortable row with its second line.
    estimateSize: (i) => (items[i]?.kind === "group" ? 44 : compact ? 30 : 56),
    getItemKey: (i) => keyOf(items[i]!),
    overscan: 10,
    scrollMargin: margin,
    rangeExtractor: (range: Range) => {
      const shown = defaultRangeExtractor(range);
      return focusedAt < 0 || shown.includes(focusedAt) ? shown : [...shown, focusedAt].sort((a, b) => a - b);
    },
  });

  // The Agent the address names is scrolled to each time the address names a new one: on
  // opening the page, and on following a link to another. A row already in view stays put. It
  // waits for the scroller, and in a long fleet for the rows' place in it, before it scrolls.
  const scrolledTo = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!target || target === scrolledTo.current || !scroller || (virtual && margin === 0)) return;
    const at = items.findIndex((it) => it.kind === "agent" && it.line.agent.id === target);
    if (at < 0) return;
    scrolledTo.current = target;
    const el = document.getElementById(rowId(target));
    if (el) {
      const box = el.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      const under = head.current?.getBoundingClientRect().bottom ?? view.top;
      if (box.top >= under && box.bottom <= view.bottom) return;
    }
    if (virtual) rows.scrollToIndex(at, { align: "center" });
    else el?.scrollIntoView({ block: "center" });
  }, [target, items, virtual, scroller, margin, rows]);

  // In a virtualised table the rows carry their place, so a screen reader counts all of them.
  const rowIndex = (index?: number) => (virtual && index !== undefined ? index + 2 : undefined);
  const row = (it: Item, measure?: { index: number; ref: Ref<HTMLTableRowElement> }) =>
    it.kind === "group" ? (
      <tr key={`group:${it.person}`} data-index={measure?.index} ref={measure?.ref} aria-rowindex={rowIndex(measure?.index)}>
        {/* A rowgroup head only where the Person has its own row group. */}
        <th scope={virtual ? undefined : "rowgroup"} colSpan={COLUMNS} className="p-0 text-left font-normal">
          <GroupLine person={it.person} me={me} zone={zones.get(it.person)} count={it.count} />
        </th>
      </tr>
    ) : (
      <Row
        key={it.line.agent.id}
        line={it.line}
        selected={it.line.agent.id === selected}
        compact={compact}
        actions={actions}
        index={measure?.index}
        rowIndex={rowIndex(measure?.index)}
        ref={measure?.ref}
      />
    );

  // Rendered rows with a spacer wherever rows are skipped: before the first, after the last,
  // and around a focused row kept rendered far from the others.
  const body: ReactNode[] = [];
  if (virtual) {
    let end = margin;
    for (const v of rows.getVirtualItems()) {
      if (v.start > end) body.push(<Spacer key={`gap:${v.index}`} height={v.start - end} />);
      body.push(row(items[v.index]!, { index: v.index, ref: rows.measureElement }));
      end = v.end;
    }
    const total = rows.getTotalSize() + margin;
    if (total > end) body.push(<Spacer key="gap:end" height={total - end} />);
  }

  return (
    <table className="w-full border-collapse text-left" aria-rowcount={virtual ? items.length + 1 : undefined}>
      {/* The head stays in view over a long fleet. A collapsed border scrolls away from a sticky
          head, so its rule is drawn inside it. It sticks at the scroller's edge, over its pt-5. */}
      <thead ref={head} className="sticky -top-5 z-10 bg-page shadow-[inset_0_-1px_0_var(--rule)]">
        <tr className="text-label font-medium text-ink-3" aria-rowindex={virtual ? 1 : undefined}>
          <th scope="col" className="w-[9.5rem] py-2 pr-3 pl-3 font-medium @max-[40rem]:w-[7.5rem]">State</th>
          <th scope="col" className="min-w-[8rem] py-2 pr-3 font-medium">Agent</th>
          <th scope="col" className="py-2 pr-3 font-medium">Working on</th>
          <th scope="col" className="w-[7.5rem] py-2 pr-3 text-right font-medium @max-[40rem]:w-16">Context</th>
          <th scope="col" className="py-2 pr-3 font-medium @max-[52rem]:hidden">Host</th>
          <th scope="col" className="w-20 py-2 pr-3 text-right font-medium">Since</th>
          <th scope="col" className="w-10 py-2 pr-1">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      {virtual ? (
        <tbody
          onFocus={(e) => {
            const tr = (e.target as Element).closest("tr[data-index]");
            const at = tr ? Number(tr.getAttribute("data-index")) : -1;
            if (items[at]) setFocused(keyOf(items[at]));
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(undefined);
          }}
        >
          {body}
        </tbody>
      ) : (
        groups.map(([person, group]) => (
          <tbody key={person}>
            {row({ kind: "group", person, count: group.length })}
            {group.map((line) => row({ kind: "agent", line }))}
          </tbody>
        ))
      )}
    </table>
  );
}

/** Keeps the scroll height of the rows a virtualised table is not rendering. */
function Spacer({ height }: { height: number }) {
  return (
    <tr aria-hidden style={{ height }}>
      <td colSpan={COLUMNS} className="p-0" />
    </tr>
  );
}

const rowId = (id: string) => `agent-row-${id}`;

/** What the Agent works on: its Claim, and a line on where that stands. */
function WorkingOn({ line, note: withNote = true }: { line: Line; note?: boolean }) {
  const { agent: a, state, claims } = line;
  const [first, ...rest] = claims;
  const note =
    a.approval && (state === "needs" || state === "needs-other")
      ? // The time holds together: "28 s ago" never breaks between its words.
        `Asked to run ${a.approval.tool} ${`${elapsed(a.approval.openedAt)} ago`.replaceAll(" ", "\u00a0")}`
      : state === "stale" && first
        ? `${first.stepsDone} of ${first.steps.length} Steps done. Anyone can take it over.`
        : (a.context?.activity ?? a.context?.task);
  return (
    <>
      {first ? (
        <a href={href({ view: "task", number: first.number })} onClick={(e) => e.stopPropagation()} className="text-row text-ink hover:underline">
          #{first.number} {first.title}
          {rest.length > 0 && `, and ${rest.map((t) => `#${t.number}`).join(", ")}`}
        </a>
      ) : (
        <span className="text-row text-ink-3">No Claim</span>
      )}
      {withNote && note && <span className="block text-small text-ink-3">{note}</span>}
    </>
  );
}

// Memoised: scrolling a long fleet renders the table again each frame, and only the rows that
// came on screen need rendering.
const Row = memo(function Row({
  line,
  selected,
  compact,
  actions,
  index,
  rowIndex,
  ref,
}: {
  line: Line;
  selected: boolean;
  compact: boolean;
  actions: RowActions;
  /** Set when the table is virtualised, for measuring the row. */
  index?: number;
  /** Its place among all the rows, when the table is virtualised (aria-rowindex). */
  rowIndex?: number;
  ref?: Ref<HTMLTableRowElement>;
}) {
  const { agent: a, state } = line;
  const select = () => go({ view: "agents", selected: a.id });
  // Compact rows are one line: the second line under the name and the Task goes.
  const cell = compact ? "py-1 pr-3" : "py-2 pr-3";
  return (
    <tr
      ref={ref}
      id={rowId(a.id)}
      data-index={index}
      aria-rowindex={rowIndex}
      tabIndex={0}
      aria-selected={selected}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === "Enter") go({ view: "agent", id: a.id });
        if (e.key === " ") {
          e.preventDefault();
          select();
        }
      }}
      className={cn(
        "h-[var(--row)] cursor-pointer border-b border-rule align-top transition-colors duration-[var(--dur)] focus-visible:-outline-offset-2",
        selected ? "bg-paper-3" : "hover:bg-paper-2",
      )}
    >
      <td className={cn(cell, "pl-3")}>
        <State state={state} person={a.person} />
      </td>
      <td className={cell}>
        <a
          href={href({ view: "agent", id: a.id })}
          onClick={(e) => e.stopPropagation()}
          className={cn("text-row font-semibold [overflow-wrap:anywhere] hover:underline", state === "gone" ? "text-ink-2" : "text-ink")}
        >
          {shortName(a)}
        </a>
        {!compact && <Secondary agent={a} />}
      </td>
      <td className={cell}>
        <WorkingOn line={line} note={!compact} />
      </td>
      <td className={cn(cell, "text-right text-row")}>
        <ContextWindow agent={a} compact />
      </td>
      <td className={cn(cell, "text-row whitespace-nowrap text-ink-2 @max-[52rem]:hidden")}>{a.host ? hostName(a.host) : "terminal"}</td>
      <td className={cn(cell, "text-right text-row text-ink-3 tabular-nums")}>{elapsed(since(a))}</td>
      <td
        className={cn(compact ? "py-0.5" : "py-1", "pr-1 text-right")}
        // The button sits on the row's first line. The menu is its own control: nothing in it selects or opens the row. Its items are
        // in a portal, but their events still bubble here through React.
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <RowMenu line={line} actions={actions} compact={compact} />
      </td>
    </tr>
  );
});

/** The row's menu: what a Person does to one Agent without opening its page. */
function RowMenu({ line, actions, compact }: { line: Line; actions: RowActions; compact: boolean }) {
  const { agent: a } = line;
  const mayControl = useMayControl();
  const store = useStore();
  const can = useCapabilities();
  const name = agentName(a);
  const trigger = useRef<HTMLButtonElement>(null);
  // An item that moves focus on (Stop's question, the rename dialog) runs once the menu has
  // closed: while the menu is open it holds focus, and closing would put focus back on this
  // button, over the field the item opened.
  const then = useRef<(() => void) | null>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button ref={trigger} type="button" aria-label={`Actions for ${name}`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "w-7 px-0", compact && "h-6")}>
          ···
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="w-48"
        onCloseAutoFocus={(e) => {
          const run = then.current;
          if (!run) return;
          then.current = null;
          e.preventDefault();
          run();
        }}
      >
        <DropdownMenuItem onSelect={() => go({ view: "agent", id: a.id })}>Open</DropdownMenuItem>
        {can.directives && a.presence !== "gone" && (
          <DropdownMenuItem onSelect={() => go({ view: "agent", id: a.id, focus: "directive" })}>Directive</DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => {
            then.current = () => actions.rename(a.id, trigger.current);
          }}
        >
          Rename
        </DropdownMenuItem>
        {mayControl(a) && (
          <DropdownMenuItem
            onSelect={() => {
              then.current = () => actions.stop(a.id, trigger.current);
            }}
          >
            Stop
          </DropdownMenuItem>
        )}
        {mayControl(a) && a.presence !== "gone" && (
          <DropdownMenuItem
            onSelect={async () => {
              const r = await (a.presence === "paused" ? store.source.resumeAgent(a.id) : store.source.pauseAgent(a.id));
              if (!r.ok) toast.error(r.reason);
            }}
          >
            {a.presence === "paused" ? "Resume" : "Pause"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The selected Agent, read without leaving the list. */
function Inspector({
  line,
  onClose,
  stopAsk,
}: {
  line: Line;
  onClose?: () => void;
  /** Stop asked from the row menu: `n` asks, and `back` is where focus goes when it is taken back. */
  stopAsk?: { n: number; back: HTMLElement | null };
}) {
  const { agent: a, state, claims } = line;
  const can = useCapabilities();
  // While Stop asks, its question holds the inspector's one primary.
  const [stopAsking, setStopAsking] = useState(false);
  const me = useMe();
  const { agents } = useChannel();
  const { agentById } = useIndex();
  const led = agents.filter((x) => x.parent === a.id);
  const parent = a.parent ? agentById.get(a.parent) : undefined;
  const task = claims[0];
  const firstOpen = task?.steps.findIndex((s) => !s.done) ?? -1;
  const fact = [
    `${a.person === me ? "Your" : `${a.person}'s`} ${CLI_LABEL[a.cli]} ${a.host ? `on ${hostName(a.host)}` : "in a terminal"}.`,
    a.model && `${modelLabel(a.model)}${a.effort ? `, ${a.effort} effort` : ""}.`,
    `Started ${ago(a.startedAt)}${led.length ? `, leads ${led.map(agentName).join(", ")}` : ""}${parent ? `, started by ${agentName(parent)}` : ""}.`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <InspectorFrame label={`${agentName(a)}, in the inspector`} onClose={onClose}>
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <h2 className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-title font-semibold [overflow-wrap:anywhere] text-ink">
            <Glyph state={state} />
            {agentName(a)}
            <State state={state} person={a.person} glyph={false} />
          </h2>
          <SheetClose onClose={onClose} />
        </div>
        <p className="text-row text-ink-2">{fact}</p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {!stopAsking && (
            <>
              <a href={href({ view: "agent", id: a.id })} className={buttonVariants({ variant: "primary" })}>
                Open the terminal
              </a>
              {can.directives && a.presence !== "gone" && (
                <a href={href({ view: "agent", id: a.id, focus: "directive" })} className={buttonVariants({ variant: "secondary" })}>
                  Directive
                </a>
              )}
            </>
          )}
          {!stopAsking && <PauseResumeButton agent={a} />}
          <StopAgentButton agent={a} ask={stopAsk?.n} returnFocusTo={stopAsk?.back} onAsking={setStopAsking} />
        </div>
      </div>
      <PendingApproval agent={a} />
      {task && (
        <Section
          title={
            <a href={href({ view: "task", number: task.number })} className="hover:underline">
              #{task.number} {task.title}
            </a>
          }
          meta={task.steps.length > 0 && `${task.stepsDone} of ${task.steps.length}`}
          bodyClassName="pt-0"
        >
          {task.steps.length > 0 ? (
            <ul>
              {task.steps.map((s, i) => (
                <li key={s.index} className={cn("flex items-baseline gap-2.5 border-b border-rule py-2 text-row", s.done || i === firstOpen ? "text-ink" : "text-ink-3")}>
                  <Glyph state={s.done ? "done" : i === firstOpen ? "running" : "idle"} className="relative top-px text-ink" />
                  <span className="sr-only">{s.done ? "Done:" : i === firstOpen ? "Next:" : "Open:"}</span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{s.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pt-3 text-small text-ink-3">No Steps on this Task.</p>
          )}
        </Section>
      )}
      <Section title="Context window">
        <ContextWindow agent={a} />
      </Section>
      {a.usage && (
        <Section title="Account">
          <AgentUsage agent={a} />
        </Section>
      )}
      <Section title="Where">
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-row">
          <dt className="text-ink-3">Host</dt>
          <dd>{a.host ? hostName(a.host) : "a terminal"}</dd>
          {a.context?.cwd && (
            <>
              <dt className="text-ink-3">Folder</dt>
              <dd>
                <code className="[overflow-wrap:anywhere]">{a.context.cwd}</code>
              </dd>
            </>
          )}
          {a.context?.branch && (
            <>
              <dt className="text-ink-3">Branch</dt>
              <dd>
                <code className="[overflow-wrap:anywhere]">{a.context.branch}</code>
              </dd>
            </>
          )}
          {led.length > 0 && (
            <>
              <dt className="text-ink-3">Leads</dt>
              <dd>{led.map(agentName).join(", ")}</dd>
            </>
          )}
        </dl>
      </Section>
    </InspectorFrame>
  );
}
