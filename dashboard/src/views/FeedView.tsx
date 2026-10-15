import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import type { ChannelEvent } from "@shared/index";
import { useCapabilities, useChannel, useIndex, useStore } from "@/data/store";
import { useEventDetail } from "@/data/history";
import { EventDetail, EventRow } from "@/components/domain/event";
import { EMPTY_FILTERS, FilterSelect, activeCount, matches, type FeedFilters } from "@/components/domain/filters";
import { Composer } from "@/components/domain/composer";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useIsMobile } from "@/hooks/use-mobile";
import { CAPTURE_LABEL, VERDICT_LABEL, VERDICT_OPTIONS } from "@/lib/format";
import { go } from "@/lib/router";
import { PageHead } from "@/components/shell/page-head";

// How many more Events each scroll to the top shows.
const SHOW = 250;
// How close to the bottom (px) still counts as "following" the live feed.
const FOLLOW_SLACK = 80;
// How close to the top (px) shows older Events.
const OLDER_SLACK = 200;

/** Two Events from the same sender within two minutes read as one chat group. */
function continues(prev: ChannelEvent | undefined, e: ChannelEvent): boolean {
  if (!prev || e.type === "directive") return false;
  const who = (x: ChannelEvent) => (x.actor.kind === "agent" ? x.actor.agentId : x.actor.kind === "person" ? `p:${x.actor.person}` : x.actor.kind);
  return who(prev) === who(e) && Date.parse(e.at) - Date.parse(prev.at) < 120_000;
}

export function FeedView({ selected }: { selected?: string }) {
  const { events, verdictsByEvent, agents, tasks, snapshot, fresh, olderBefore, loadingOlder } = useChannel();
  const store = useStore();
  const { agentById, taskByNumber } = useIndex();
  const mobile = useIsMobile();
  const can = useCapabilities();
  const [filters, setFilters] = useState<FeedFilters>(EMPTY_FILTERS);
  const [limit, setLimit] = useState(SHOW);
  const threshold = snapshot?.relay.interruptThreshold ?? 0.6;

  // `all`: every loaded Event that matches is shown.
  const { shown, all } = useMemo(() => {
    const out = [];
    let i = events.length - 1;
    for (; i >= 0 && out.length < limit; i--) {
      const e = events[i];
      if (matches(e, verdictsByEvent.get(e.id) ?? [], filters)) out.push(e);
    }
    // Chat order: oldest at the top, newest at the bottom.
    return { shown: out.reverse(), all: i < 0 };
  }, [events, verdictsByEvent, filters, limit]);
  const older = !all || olderBefore !== undefined;

  /** Near the top: show more, loading the page before the oldest Event once every loaded one is shown. */
  const showOlder = () => {
    if (loadingOlder || !older) return;
    setLimit((l) => l + SHOW);
    if (all) void store.loadOlder();
  };

  // Follow new Events like a chat, unless the Person has scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // Where the Person is, from the bottom, so older Events added above do not move the list.
  const fromBottom = useRef(0);
  const newestId = shown.at(-1)?.id;
  const oldestId = shown[0]?.id;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [newestId]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && !following.current) el.scrollTop = el.scrollHeight - fromBottom.current;
  }, [oldestId]);
  useLayoutEffect(() => {
    following.current = true;
    setLimit(SHOW);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    // On a phone the list remounts when the Person comes back from an Event.
  }, [filters, mobile, mobile && !!selected]);

  const { event: selectedEvent, woken, loaded: selectedLoaded } = useEventDetail(selected);
  const set = (k: keyof FeedFilters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const n = activeCount(filters);

  const live = agents.filter((a) => a.presence === "live").length;
  const open = tasks.filter((t) => t.status !== "done").length;
  const head = (
    <div className="shrink-0 px-[var(--gutter)] pt-6 pb-3 sm:pt-8">
      <div className="mx-auto flex w-full max-w-[var(--column)] min-w-0 flex-col gap-5">
        <PageHead
          title="Activity"
          facts={[`${live} ${live === 1 ? "Agent" : "Agents"} live`, `${open} open ${open === 1 ? "Task" : "Tasks"}`, `${events.length} Events`]}
        />
      </div>
    </div>
  );

  const filterBar = (
    <div className="shrink-0 px-[var(--gutter)] pb-4">
      {/* Lines up with the feed and the composer below it. */}
      <div className="mx-auto flex w-full max-w-[var(--column)] min-w-0 flex-wrap items-center gap-1.5 md:flex-nowrap md:overflow-x-auto">
        <FilterSelect
          label="Person"
          value={filters.person}
          onChange={set("person")}
          allLabel="All Persons"
          options={(snapshot?.persons ?? []).map((p) => ({ value: p.name, label: p.name }))}
        />
        <FilterSelect
          label="Agent"
          value={filters.agent}
          onChange={set("agent")}
          allLabel="All Agents"
          options={agents.map((a) => ({ value: a.id, label: a.nickname ? `${a.id} (${a.nickname})` : a.id }))}
        />
        <FilterSelect
          label="Task"
          value={filters.task}
          onChange={set("task")}
          allLabel="All Tasks"
          options={[...tasks]
            .sort((a, b) => a.number - b.number)
            .map((t) => ({ value: String(t.number), label: `#${t.number} ${t.title}` }))}
        />
        <FilterSelect
          label="Capture"
          value={filters.capture}
          onChange={set("capture")}
          allLabel="All Captures"
          options={[
            ...(["proxy", "hook", "tool"] as const).map((c) => ({ value: c, label: CAPTURE_LABEL[c] })),
            { value: "none", label: "None (Dashboard, GitHub)" },
          ]}
        />
        {can.verdicts && <FilterSelect
          label="Verdict"
          value={filters.verdict}
          onChange={set("verdict")}
          allLabel="Any Verdict"
          options={[...VERDICT_OPTIONS].reverse().map((o) => ({ value: o, label: `Any ${VERDICT_LABEL[o]}` }))}
        />}
        {n > 0 && (
          <button
            type="button"
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2.5 text-small text-ink-3 transition-colors hover:bg-hover hover:text-ink"
          >
            <X className="size-3.5" aria-hidden /> Clear
          </button>
        )}
      </div>
    </div>
  );

  const list = (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK;
        fromBottom.current = el.scrollHeight - el.scrollTop;
        if (el.scrollTop < OLDER_SLACK) showOlder();
      }}
      className="min-h-0 flex-1 overflow-y-auto"
      aria-live="polite"
      aria-relevant="additions"
    >
      {shown.length === 0 ? (
        <div className="mx-auto flex max-w-[var(--column)] flex-col items-start gap-1 px-[var(--gutter)] py-10">
          <p className="text-body text-ink">{loadingOlder ? "Looking through older Events" : "Nothing matches these filters"}</p>
          {olderBefore !== undefined && !loadingOlder && (
            <button type="button" onClick={showOlder} className="text-small text-ink underline-offset-4 hover:underline">
              Look through older Events
            </button>
          )}
          <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} className="text-small text-ink underline-offset-4 hover:underline">
            Clear filters
          </button>
        </div>
      ) : (
        <ul className="mx-auto flex max-w-[calc(var(--column)+1.5rem)] flex-col px-[calc(var(--gutter)-0.75rem)] pt-1 pb-4">
            {older && (
              <li className="flex h-10 items-center px-3 text-small text-ink-3" aria-live="off">
                {loadingOlder ? (
                  <span className="inline-flex items-center gap-2">
                    <span aria-hidden className="size-1.5 rounded-full bg-ink-3" />
                    Loading older Events
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={showOlder}
                    className="inline-flex h-8 items-center rounded-md bg-inset px-3 text-ink-2 transition-colors hover:bg-inset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    Show older Events
                  </button>
                )}
              </li>
            )}
            {shown.map((e, i) => (
              <EventRow
                continued={continues(shown[i - 1], e)}
                key={e.id}
                event={e}
                verdicts={verdictsByEvent.get(e.id) ?? []}
                agentById={agentById}
                taskByNumber={taskByNumber}
                selected={e.id === selected}
                fresh={fresh.has(e.id)}
                onSelect={() => go({ view: "feed", event: e.id })}
              />
            ))}
        </ul>
      )}
    </div>
  );

  const detail = selectedEvent ? (
    <EventDetail
      event={selectedEvent}
      verdicts={verdictsByEvent.get(selectedEvent.id) ?? []}
      woken={woken}
      agentById={agentById}
      taskByNumber={taskByNumber}
      threshold={threshold}
      verdictsLive={can.verdicts}
      verdictsLoaded={selectedLoaded}
      onClose={mobile ? undefined : () => go({ view: "feed" })}
    />
  ) : null;

  const composer = (
    <div className="shrink-0 bg-page px-[var(--gutter)] pt-2 pb-4">
      <div className="mx-auto max-w-[var(--column)]">
        <Composer />
      </div>
    </div>
  );

  // A phone shows one thing at a time: the feed, or the Event it opened.
  if (mobile) {
    if (selectedEvent)
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-12 shrink-0 items-center px-2">
            <button
              type="button"
              onClick={() => go({ view: "feed" })}
              className="inline-flex h-10 items-center gap-1.5 rounded-md px-2 text-body text-ink-2 transition-colors hover:bg-hover"
            >
              <ArrowLeft className="size-4" aria-hidden /> Activity
            </button>
          </div>
          {/* Keyed, so React never reuses the feed's scroller (scrolled to the bottom) for the Event. */}
          <div key={`event-${selectedEvent.id}`} className="min-h-0 flex-1 overflow-y-auto px-[var(--gutter)] pt-2 pb-6">
            {detail}
          </div>
        </div>
      );
    return (
      <div className="flex h-full min-h-0 flex-col">
        {head}
        {filterBar}
        {list}
        {composer}
      </div>
    );
  }

  // On a wide screen the feed takes the full width until an Event is picked;
  // then the Event opens in a resizable pane beside it, never over it.
  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel id="feed" defaultSize={detail ? "58" : "100"} minSize="36" className="flex min-h-0 flex-col">
        {head}
        {filterBar}
        {list}
        {composer}
      </ResizablePanel>
      {detail && (
        <>
          <ResizableHandle />
          <ResizablePanel id="event" defaultSize="42" minSize="28" className="min-h-0">
            {/* Keyed per Event, so a newly picked Event opens at its top. */}
            <div key={selectedEvent?.id} className="h-full overflow-y-auto bg-panel px-6 py-6">
              {detail}
            </div>
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

