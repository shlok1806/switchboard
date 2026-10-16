/*
 * Activity (plan slice 9): the Channel's Events as one dense log, oldest at the top and the
 * newest by the composer, a row each: when, who, what kind, what. It reads three ways: flat,
 * by model turn (what Compare was: a turn's Proxy, Hook and Tool Captures side by side when
 * the turn is opened), or by Agent. An Interrupt the Relay typed into a session is a row of
 * its own, not a toast, and counts on the Activity key until it has been read here. The log
 * never jumps while it is being read: new Events wait under a "new Events" button. A row
 * opens its Event in the inspector, or on a phone in a sheet.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentId, ChannelEvent, Verdict } from "@shared/index";
import { Button } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { Composer } from "@/components/domain/composer";
import { EventDetail } from "@/components/domain/event";
import { EMPTY_FILTERS, FilterSelect, activeCount, matches, type FeedFilters } from "@/components/domain/filters";
import { shortName } from "@/components/domain/fleet";
import { CAPTURES, EventRow, InterruptRow, LogHead, TurnRow, type TurnItem } from "@/components/domain/log";
import { HolderLabel } from "@/components/domain/task";
import { InspectorFrame, InspectorMissing } from "@/components/shell/inspector";
import { EmptyState } from "@/components/shell/states";
import { PageHead } from "@/components/shell/page-head";
import { useEventDetail } from "@/data/history";
import { interruptKey, isInterrupt, markSeen, useInterrupts } from "@/data/interrupts";
import { useCapabilities, useChannel, useIndex, useStore } from "@/data/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { CAPTURE_LABEL, EVENT_TYPE_LABEL, VERDICT_LABEL, VERDICT_OPTIONS } from "@/lib/format";
import { go } from "@/lib/router";
import { cn } from "@/lib/utils";

// How many more Events each "Show older" adds.
const SHOW = 250;
// How close to the bottom (px) still counts as reading the newest.
const FOLLOW_SLACK = 80;

type Group = "flat" | "turn" | "agent";

type Item =
  | { kind: "event"; key: string; seq: number; event: ChannelEvent }
  | { kind: "interrupt"; key: string; seq: number; verdict: Verdict; event: ChannelEvent }
  | TurnItem;

/** Who an Event names: an Agent by its Person and short name, a Person, GitHub or the Relay. */
const whoKey = (e: ChannelEvent) => (e.actor.kind === "agent" ? e.actor.agentId : e.actor.kind === "person" ? `person:${e.actor.person}` : e.actor.kind);

export function ActivityView({ selected, byTurn = false, turn }: { selected?: string; byTurn?: boolean; turn?: string }) {
  const { events, verdictsByEvent, agents, tasks, snapshot, fresh, olderBefore, loadingOlder } = useChannel();
  const store = useStore();
  const { agentById, taskByNumber } = useIndex();
  const mobile = useIsMobile();
  const can = useCapabilities();
  const [filters, setFilters] = useState<FeedFilters>(EMPTY_FILTERS);
  const [group, setGroup] = useState<Group>(byTurn ? "turn" : "flat");
  const [open, setOpen] = useState<Set<string>>(() => new Set(turn ? [turn] : []));
  const [limit, setLimit] = useState(SHOW);
  const threshold = snapshot?.relay.interruptThreshold ?? 0.6;

  // A link to a turn (or an old Compare link) opens the log by turn with that turn open.
  useEffect(() => {
    if (!byTurn) return;
    setGroup("turn");
    if (turn) setOpen((o) => new Set(o).add(turn));
  }, [byTurn, turn]);

  // The newest `limit` Events that match, oldest first.
  const { shown, all } = useMemo(() => {
    const out: ChannelEvent[] = [];
    let i = events.length - 1;
    for (; i >= 0 && out.length < limit; i--) {
      const e = events[i]!;
      if (matches(e, verdictsByEvent.get(e.id) ?? [], filters)) out.push(e);
    }
    return { shown: out.reverse(), all: i < 0 };
  }, [events, verdictsByEvent, filters, limit]);
  const older = !all || olderBefore !== undefined;

  // Interrupts follow the Event they typed in; an Agent filter keeps those aimed at that Agent.
  const items = useMemo(() => {
    const out: Item[] = [];
    const turns = new Map<string, TurnItem>();
    for (const e of shown) {
      if (group === "turn" && e.turn && e.actor.kind === "agent") {
        const t = turns.get(e.turn);
        if (t) t.events.push(e);
        else {
          const item: TurnItem = { kind: "turn", key: `turn:${e.turn}`, seq: e.seq, turn: e.turn, agent: e.actor.agentId, events: [e] };
          turns.set(e.turn, item);
          out.push(item);
        }
      } else out.push({ kind: "event", key: e.id, seq: e.seq, event: e });
      for (const v of verdictsByEvent.get(e.id) ?? []) {
        if (isInterrupt(v) && (!filters.agent || v.agent === filters.agent || whoKey(e) === filters.agent)) {
          out.push({ kind: "interrupt", key: `interrupt:${e.id}:${v.agent}`, seq: e.seq + 0.5, verdict: v, event: e });
        }
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  }, [shown, verdictsByEvent, group, filters.agent]);

  // By Agent: one section per Agent (or Person), the most recently active last, by the composer.
  const sections = useMemo(() => {
    if (group !== "agent") return [];
    const by = new Map<string, Item[]>();
    for (const it of items) {
      const key = it.kind === "interrupt" ? it.verdict.agent : it.kind === "turn" ? it.agent : whoKey(it.event);
      by.set(key, [...(by.get(key) ?? []), it]);
    }
    return [...by.entries()].sort((a, b) => a[1].at(-1)!.seq - b[1].at(-1)!.seq);
  }, [items, group]);

  // Read here means read: the Activity key stops counting the Interrupts shown as rows, and
  // only those, so one a filter hides or that is not loaded still counts.
  const interrupts = useInterrupts();
  const channel = snapshot?.channel.repo ?? "";
  const shownInterrupts = items.flatMap((it) => (it.kind === "interrupt" ? [interruptKey(it.verdict)] : [])).join(" ");
  useEffect(() => {
    if (shownInterrupts) markSeen(channel, shownInterrupts.split(" "));
  }, [channel, shownInterrupts]);

  // Follow the newest while the log is at its bottom; otherwise count what arrives under a button.
  const scroller = useRef<HTMLDivElement>(null);
  // State, so the "new Events" count renders from it; the ref is what layout effects read.
  const [followingNow, setFollowingNow] = useState(true);
  const following = useRef(true);
  // The highest seq shown: what "read up to" means when the log stops following. Events are
  // kept in arrival order, which is not always seq order, so it is the max, not the last.
  const maxSeq = useMemo(() => shown.reduce((m, e) => Math.max(m, e.seq), 0), [shown]);
  const maxSeqNow = useRef(maxSeq);
  useLayoutEffect(() => {
    maxSeqNow.current = maxSeq;
  }, [maxSeq]);
  const [readTo, setReadTo] = useState(0);
  const follow = (on: boolean) => {
    // Everything on the log when it stops following has been read; only what comes after counts.
    if (!on && following.current) setReadTo(maxSeqNow.current);
    following.current = on;
    setFollowingNow(on);
  };
  const fromBottom = useRef(0);
  // A scroll the log made itself (to a turn) is not the Person scrolling: it must not turn
  // following back on. Cleared after two frames in case the scroll moved nothing.
  const ownScroll = useRef(false);
  // The Person scrolled since the log last scrolled to a turn: a later change of the rows'
  // shape (the window crossing 640px) leaves the log where they put it.
  const movedSinceTurn = useRef(false);
  const newest = shown.at(-1);
  const oldestId = shown[0]?.id;
  const unread = followingNow ? 0 : shown.filter((e) => e.seq > readTo).length;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following.current) {
      el.scrollTop = el.scrollHeight;
      setReadTo(maxSeq);
    }
  }, [newest, maxSeq]);
  // Older Events loaded above: keep the rows being read where they were. Only a change of the
  // oldest row counts, not React running the effect again.
  const oldestSeen = useRef(oldestId);
  useLayoutEffect(() => {
    if (oldestSeen.current === oldestId) return;
    oldestSeen.current = oldestId;
    const el = scroller.current;
    if (el && !following.current) el.scrollTop = el.scrollHeight - fromBottom.current;
  }, [oldestId]);
  // A new filter or grouping starts at the newest again. Only a change counts: on mount (and
  // React's second run of it in development) the log is already at the newest, or at a turn.
  const grouped = useRef<{ filters: FeedFilters; group: Group } | undefined>(undefined);
  useLayoutEffect(() => {
    const was = grouped.current;
    grouped.current = { filters, group };
    if (!was || (was.filters === filters && was.group === group)) return;
    follow(true);
    setLimit(SHOW);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filters, group]);
  // A link to a turn scrolls to it once, when it names a new turn: picking an Event inside the
  // turn, or new Events arriving, leaves the log where it is. On a phone the rows change shape
  // once the width is known, so the turn is scrolled to again then, unless the Person has
  // scrolled away from it.
  const shownTurn = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const at = turn && `${turn}|${mobile}`;
    if (!at || at === shownTurn.current) return;
    const target = document.getElementById(`turn-${turn}`);
    if (!target) return;
    const sameTurn = shownTurn.current?.startsWith(`${turn}|`);
    shownTurn.current = at;
    if (sameTurn && movedSinceTurn.current) return;
    movedSinceTurn.current = false;
    follow(false);
    ownScroll.current = true;
    target.scrollIntoView({ block: "start" });
    const el = scroller.current;
    if (el) fromBottom.current = el.scrollHeight - el.scrollTop;
    requestAnimationFrame(() => requestAnimationFrame(() => (ownScroll.current = false)));
  }, [turn, items, mobile]);
  const toNewest = () => {
    const el = scroller.current;
    follow(true);
    if (el) el.scrollTop = el.scrollHeight;
    setReadTo(maxSeq);
  };

  const showOlder = () => {
    if (loadingOlder || !older) return;
    setLimit((l) => l + SHOW);
    if (all) void store.loadOlder();
  };

  const { event: selectedEvent, woken, loaded: selectedLoaded, status: selectedStatus } = useEventDetail(selected);
  const set = (k: keyof FeedFilters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const filtered = activeCount(filters) > 0;
  const bare = events.length === 0 && !filtered;
  // Inside a turn link, the picked Event stays under that turn.
  const pick = (id: string) => go(turn ? { view: "feed", by: "turn", turn, event: id } : { view: "feed", event: id });
  const close = () => go(turn ? { view: "feed", by: "turn", turn } : { view: "feed" });
  const toggle = (t: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(t)) next.add(t);
      return next;
    });
  const noTurns = group === "turn" && shown.length > 0 && !items.some((it) => it.kind === "turn");
  const missingTurn = !noTurns && turn !== undefined && group === "turn" && !items.some((it) => it.kind === "turn" && it.turn === turn);

  const live = agents.filter((a) => a.presence === "live").length;
  const turnCount = new Set(shown.filter((e) => e.turn).map((e) => e.turn)).size;
  const row = (it: Item) =>
    it.kind === "turn" ? (
      <TurnRow key={it.key} item={it} open={open.has(it.turn)} onToggle={() => toggle(it.turn)} selected={selected} onPick={pick} mobile={mobile} />
    ) : it.kind === "interrupt" ? (
      <InterruptRow key={it.key} verdict={it.verdict} event={it.event} selected={it.event.id === selected} onPick={() => pick(it.event.id)} mobile={mobile} />
    ) : (
      <EventRow
        key={it.key}
        event={it.event}
        verdicts={verdictsByEvent.get(it.event.id) ?? []}
        selected={it.event.id === selected}
        fresh={fresh.has(it.event.id)}
        onPick={() => pick(it.event.id)}
        mobile={mobile}
      />
    );

  const detail = selectedStatus === "missing" ? (
    <InspectorMissing title="No such Event" sheet={mobile} onClose={close}>
      This Channel has no Event with that address. It may be from another Channel, or the link was cut short.
    </InspectorMissing>
  ) : selectedStatus === "failed" ? (
    <InspectorMissing title="Could not read the Event" sheet={mobile} onClose={close}>
      The Channel did not answer. The Event is still there; open it again in a moment.
    </InspectorMissing>
  ) : selectedEvent && (
    <InspectorFrame label={`${EVENT_TYPE_LABEL[selectedEvent.type]}, in the inspector`} onClose={mobile ? close : undefined}>
      <EventDetail
        key={selectedEvent.id}
        event={selectedEvent}
        verdicts={verdictsByEvent.get(selectedEvent.id) ?? []}
        woken={woken}
        taskByNumber={taskByNumber}
        threshold={threshold}
        verdictsLive={can.verdicts}
        verdictsLoaded={selectedLoaded}
        onClose={close}
      />
    </InspectorFrame>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-col gap-4 px-[var(--gutter)] pt-5 pb-3">
          <PageHead
            title="Activity"
            facts={bare ? [] : [
              `${events.length} Events`,
              group === "turn" && turnCount > 0 ? `${turnCount} model ${turnCount === 1 ? "turn" : "turns"}` : `${live} ${live === 1 ? "Agent" : "Agents"} live`,
              interrupts.length > 0 && `${interrupts.length} ${interrupts.length === 1 ? "Interrupt" : "Interrupts"}`,
            ]}
          />
          {/* A Channel with no Events has nothing to group or filter. */}
          <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2.5", bare && "hidden")}>
            <div role="group" aria-label="Group" className="flex gap-1.5">
              <Chip on={group === "flat"} onClick={() => setGroup("flat")}>
                Flat
              </Chip>
              <Chip on={group === "turn"} onClick={() => setGroup("turn")}>
                By turn
              </Chip>
              <Chip on={group === "agent"} onClick={() => setGroup("agent")}>
                By Agent
              </Chip>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <FilterSelect
                label="Person"
                value={filters.person}
                onChange={set("person")}
                allLabel="Any Person"
                options={(snapshot?.persons ?? []).map((p) => ({ value: p.name, label: p.name }))}
              />
              <FilterSelect
                label="Agent"
                value={filters.agent}
                onChange={set("agent")}
                allLabel="Any Agent"
                options={agents.map((a) => ({ value: a.id, label: a.nickname ? `${a.id} (${a.nickname})` : a.id, short: `${a.person}/${shortName(a)}` }))}
              />
              <FilterSelect
                label="Task"
                value={filters.task}
                onChange={set("task")}
                allLabel="Any Task"
                options={[...tasks]
                  .sort((a, b) => a.number - b.number)
                  .map((t) => ({ value: String(t.number), label: `#${t.number} ${t.title}`, short: `#${t.number}` }))}
              />
              <FilterSelect
                label="Capture"
                value={filters.capture}
                onChange={set("capture")}
                allLabel="Any Capture"
                options={[...CAPTURES.map((c) => ({ value: c, label: CAPTURE_LABEL[c] })), { value: "none", label: "None: the Dashboard or GitHub", short: "No Capture" }]}
              />
              {can.verdicts && (
                <FilterSelect
                  label="Verdict"
                  value={filters.verdict}
                  onChange={set("verdict")}
                  allLabel="Any Verdict"
                  options={[...VERDICT_OPTIONS].reverse().map((o) => ({ value: o, label: `Any ${VERDICT_LABEL[o]}`, short: VERDICT_LABEL[o] }))}
                />
              )}
              {filtered && (
                <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} className="h-[26px] px-1.5 text-label font-medium text-ink hover:underline">
                  Clear
                </button>
              )}
            </div>
          </div>
          {noTurns && (
            <p role="status" className="text-small text-ink-3">
              No model turn among the {shown.length} newest Events{filtered ? " that match" : ""}, so the rows below are Events outside any turn.
            </p>
          )}
          {missingTurn && (
            <p role="status" className="text-small text-ink-3">
              Model turn <code className="text-ink-2">{turn}</code> is not among the loaded Events.
            </p>
          )}
        </div>

        {!mobile && items.length > 0 && (
          <div className="shrink-0 px-[var(--gutter)]">
            <LogHead />
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              fromBottom.current = el.scrollHeight - el.scrollTop;
              if (ownScroll.current) {
                ownScroll.current = false;
                return;
              }
              movedSinceTurn.current = true;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK;
              if (atBottom !== following.current) follow(atBottom);
              if (atBottom && maxSeq > readTo) setReadTo(maxSeq);
            }}
            className="absolute inset-0 overflow-y-auto px-[var(--gutter)]"
            aria-label="Events"
            role="region"
          >
            {older && (
              <div className="py-2">
                <button type="button" onClick={showOlder} disabled={loadingOlder} className="text-small text-ink hover:underline disabled:text-ink-3 disabled:no-underline">
                  {loadingOlder ? "Reading older Events" : "Show older Events"}
                </button>
              </div>
            )}
            {items.length === 0 ? (
              filtered ? (
                <EmptyState
                  title="No Event matches these filters"
                  action={<Button onClick={() => setFilters(EMPTY_FILTERS)}>Clear the filters</Button>}
                  className="mt-2"
                >
                  {activeCount(filters) === 1 ? "One filter is" : `${activeCount(filters)} filters are`} on, and no Event on the Channel passes {activeCount(filters) === 1 ? "it" : "them all"}.
                </EmptyState>
              ) : (
                <EmptyState
                  title="No Events yet"
                  action={
                    <Button variant="primary" onClick={() => document.getElementById("composer-text")?.focus()}>
                      Post an Update
                    </Button>
                  }
                  className="mt-2"
                >
                  Every Update, Directive, claim and Verdict on the Channel lands here as a row, newest at the bottom.
                </EmptyState>
              )
            ) : (
              <>
                {group === "agent" ? (
                  sections.map(([key, its]) => (
                    <section key={key} aria-label={sectionName(key, agentById)}>
                      <h2 className="flex flex-wrap items-baseline gap-x-2 border-b border-rule-2 px-3 pt-4 pb-2 text-small text-ink-3">
                        <span className="font-semibold text-ink">
                          {key.includes("/") ? <HolderLabel holder={{ kind: "agent", agentId: key as AgentId }} /> : sectionName(key, agentById)}
                        </span>
                        {its.length} {its.length === 1 ? "row" : "rows"}
                      </h2>
                      <ol>{its.map(row)}</ol>
                    </section>
                  ))
                ) : (
                  <ol>{items.map(row)}</ol>
                )}
              </>
            )}
            {/* Room under the last row, so the "new Events" button never covers it. */}
            <div className={unread > 0 ? "h-14" : "h-4"} />
          </div>
          {unread > 0 && (
            <Button onClick={toNewest} className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-paper">
              {unread} new {unread === 1 ? "Event" : "Events"}
            </Button>
          )}
        </div>

        <div className="shrink-0 border-t border-rule px-[var(--gutter)] pt-3 pb-4">
          <Composer />
        </div>
      </div>
      {detail}
    </div>
  );
}

function sectionName(key: string, agentById: Map<AgentId, { person: string }>): string {
  if (key.startsWith("person:")) return key.slice("person:".length);
  if (key === "github") return "GitHub";
  if (key === "relay") return "The Relay";
  const a = agentById.get(key as AgentId);
  return a ? `${a.person}'s Agent ${key}` : key;
}
