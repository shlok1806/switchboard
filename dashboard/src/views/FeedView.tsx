import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import type { AgentId, ChannelEvent } from "@shared/index";
import { useCapabilities, useChannel, useIndex } from "@/data/store";
import { EventDetail, EventRow } from "@/components/domain/event";
import { EMPTY_FILTERS, FilterSelect, activeCount, matches, type FeedFilters } from "@/components/domain/filters";
import { Composer } from "@/components/domain/composer";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useIsMobile } from "@/hooks/use-mobile";
import { CAPTURE_LABEL, VERDICT_LABEL, VERDICT_OPTIONS } from "@/lib/format";
import { go } from "@/lib/router";

const SHOW = 250;
// How close to the bottom (px) still counts as "following" the live feed.
const FOLLOW_SLACK = 80;

/** Two Events from the same sender within two minutes read as one chat group. */
function continues(prev: ChannelEvent | undefined, e: ChannelEvent): boolean {
  if (!prev || e.type === "directive") return false;
  const who = (x: ChannelEvent) => (x.actor.kind === "agent" ? x.actor.agentId : x.actor.kind === "person" ? `p:${x.actor.person}` : x.actor.kind);
  return who(prev) === who(e) && Date.parse(e.at) - Date.parse(prev.at) < 120_000;
}

export function FeedView({ selected }: { selected?: string }) {
  const { events, verdictsByEvent, agents, tasks, snapshot, fresh } = useChannel();
  const { agentById, taskByNumber } = useIndex();
  const mobile = useIsMobile();
  const can = useCapabilities();
  const [filters, setFilters] = useState<FeedFilters>(EMPTY_FILTERS);
  const threshold = snapshot?.relay.interruptThreshold ?? 0.6;

  const shown = useMemo(() => {
    const out = [];
    for (let i = events.length - 1; i >= 0 && out.length < SHOW; i--) {
      const e = events[i];
      if (matches(e, verdictsByEvent.get(e.id) ?? [], filters)) out.push(e);
    }
    // Chat order: oldest at the top, newest at the bottom.
    return out.reverse();
  }, [events, verdictsByEvent, filters]);

  // Follow new Events like a chat, unless the Person has scrolled up to read.
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const newestId = shown.at(-1)?.id;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [newestId]);
  useLayoutEffect(() => {
    following.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    // On a phone the list remounts when the Person comes back from an Event.
  }, [filters, mobile, mobile && !!selected]);

  const selectedEvent = selected ? events.find((e) => e.id === selected) : undefined;
  const set = (k: keyof FeedFilters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const n = activeCount(filters);

  const filterBar = (
    <div className="shrink-0 border-b border-line px-3 py-2.5 sm:px-6">
      {/* Lines up with the feed and the composer below it. */}
      <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-wrap items-center gap-1.5 md:flex-nowrap md:gap-2 md:overflow-x-auto">
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
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[13px] text-ink-3 hover:bg-hover hover:text-ink"
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
      }}
      className="min-h-0 flex-1 overflow-y-auto"
      aria-live="polite"
      aria-relevant="additions"
    >
      {shown.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-1 text-center">
          <p className="text-[14px] text-ink-2">Nothing matches</p>
          <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} className="text-[13px] text-accent-ink hover:underline">
            Clear filters
          </button>
        </div>
      ) : (
        <ul className="mx-auto flex max-w-4xl flex-col px-2 py-2 sm:px-3">
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
      woken={wokenFor(events, selectedEvent.id)}
      agentById={agentById}
      taskByNumber={taskByNumber}
      threshold={threshold}
      verdictsLive={can.verdicts}
      onClose={mobile ? undefined : () => go({ view: "feed" })}
    />
  ) : null;

  const composer = (
    <div className="shrink-0 border-t border-line bg-page px-3 py-3 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <Composer />
      </div>
    </div>
  );

  // A phone shows one thing at a time: the feed, or the Event it opened.
  if (mobile) {
    if (selectedEvent)
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-11 shrink-0 items-center border-b border-line px-2">
            <button
              type="button"
              onClick={() => go({ view: "feed" })}
              className="inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-[14px] text-ink-2 hover:bg-hover"
            >
              <ArrowLeft className="size-4" aria-hidden /> Activity
            </button>
          </div>
          {/* Keyed, so React never reuses the feed's scroller (scrolled to the bottom) for the Event. */}
          <div key={`event-${selectedEvent.id}`} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {detail}
          </div>
        </div>
      );
    return (
      <div className="flex h-full min-h-0 flex-col">
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
        {filterBar}
        {list}
        {composer}
      </ResizablePanel>
      {detail && (
        <>
          <ResizableHandle />
          <ResizablePanel id="event" defaultSize="42" minSize="28" className="min-h-0">
            {/* Keyed per Event, so a newly picked Event opens at its top. */}
            <div key={selectedEvent?.id} className="h-full overflow-y-auto bg-surface px-6 py-5">
              {detail}
            </div>
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

/** The Agents a Wake delivered Event `id` to: their Queue on it did not wait for their next turn. */
function wokenFor(events: readonly ChannelEvent[], id: string): Set<AgentId> {
  const woken = new Set<AgentId>();
  for (const e of events) {
    if (e.type === "wake" && e.actor.kind === "agent" && e.payload.events.includes(id)) woken.add(e.actor.agentId);
  }
  return woken;
}
