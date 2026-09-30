import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageSquarePlus, X } from "@/components/pixel-icon";
import { useCapabilities, useChannel, useIndex } from "@/data/store";
import { EventDetail, EventRow } from "@/components/domain/event";
import { EMPTY_FILTERS, FilterSelect, activeCount, matches, type FeedFilters } from "@/components/domain/filters";
import { Composer } from "@/components/domain/composer";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { CAPTURE_LABEL, VERDICT_LABEL, VERDICT_OPTIONS } from "@/lib/format";
import { go } from "@/lib/router";
import { cn } from "@/lib/utils";

const SHOW = 250;
// How close to the bottom (px) still counts as "following" the live feed.
const FOLLOW_SLACK = 80;

export function FeedView({ selected }: { selected?: string }) {
  const { events, verdictsByEvent, agents, tasks, snapshot, fresh } = useChannel();
  const { agentById, taskByNumber } = useIndex();
  const mobile = useIsMobile();
  const can = useCapabilities();
  const [filters, setFilters] = useState<FeedFilters>(EMPTY_FILTERS);
  const [composeOpen, setComposeOpen] = useState(false);
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
  }, [filters, mobile]);

  const selectedEvent = selected ? events.find((e) => e.id === selected) : undefined;
  const set = (k: keyof FeedFilters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const n = activeCount(filters);

  const filterBar = (
    <div className="no-scrollbar feed-filters flex items-center gap-1.5 overflow-x-auto border-b border-line py-2 pr-8 pl-3 sm:px-4">
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
          className="btn-motif h-[26px] shrink-0 px-2 text-[12px]"
        >
          <X /> Clear {n}
        </button>
      )}
    </div>
  );

  const list = (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK;
      }}
      className={cn("min-h-0 flex-1 overflow-y-auto", mobile && "pb-24")}
      aria-live="polite"
      aria-relevant="additions"
    >
      {shown.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-1 text-center">
          <p className="text-[13px] font-medium text-ink">No Events match these filters</p>
          <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} className="text-[12.5px] text-accent-ink hover:underline">
            Clear filters
          </button>
        </div>
      ) : (
        <ul>
            {shown.map((e) => (
              <EventRow
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
      agentById={agentById}
      taskByNumber={taskByNumber}
      threshold={threshold}
      verdictsLive={can.verdicts}
    />
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-[13px] font-medium text-ink">Pick an Event</p>
      <p className="max-w-xs text-[12.5px] text-ink-3">
        {can.verdicts
          ? "Its payload and the Relay's Verdict for every Agent show here, with Jev's probabilities."
          : "Its payload shows here. Verdicts join it once the Relay lands."}
      </p>
    </div>
  );

  if (mobile) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {filterBar}
        {list}
        <button
          type="button"
          onClick={() => setComposeOpen(true)}
          className="btn-motif fixed right-3 bottom-[calc(var(--panel-h)+37px)] z-20 h-11 px-4 font-semibold outline outline-1 outline-[hsl(var(--foreground))]"
        >
          <MessageSquarePlus /> Post
        </button>
        <Sheet open={!!selectedEvent} onOpenChange={(o) => !o && go({ view: "feed" })}>
          <SheetContent side="bottom" onOpenAutoFocus={(e) => e.preventDefault()} className="max-h-[88dvh] gap-0">
            <SheetHeader>
              <SheetTitle>Event</SheetTitle>
              <SheetDescription className="sr-only">Event detail and Verdicts</SheetDescription>
            </SheetHeader>
            <div className="bevel-in m-[3px] mt-0 min-h-0 overflow-y-auto bg-card px-4 pt-3 pb-[max(2rem,env(safe-area-inset-bottom))] text-card-foreground">
              {detail}
            </div>
          </SheetContent>
        </Sheet>
        <Sheet open={composeOpen} onOpenChange={setComposeOpen}>
          <SheetContent side="bottom" className="gap-0">
            <SheetHeader>
              <SheetTitle>Post to the Channel</SheetTitle>
              <SheetDescription className="sr-only">Write an Update or a Directive</SheetDescription>
            </SheetHeader>
            <div className="p-[3px] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <Composer />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize="56" minSize="36" className="flex min-h-0 flex-col">
        {filterBar}
        {list}
        <div className="border-t border-border bg-secondary p-[3px]">
          <Composer />
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="44" minSize="28" className="min-h-0">
        <div className="h-full overflow-y-auto bg-card p-4 lg:p-5">{detail}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
