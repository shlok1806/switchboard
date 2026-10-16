/*
 * The rows of a log (Activity, an Agent's History): design.md's row, 36px at least, when,
 * who, what kind and what, cells that wrap and never cut. A row opens its Event; a link in
 * it keeps its own click. On a phone a row is two lines: who and kind with the age, then what.
 */
import type { ReactNode } from "react";
import type { AgentId, Capture, ChannelEvent, Verdict } from "@shared/index";
import { ownedName } from "@/components/domain/fleet";
import { HolderLabel } from "@/components/domain/task";
import { useIndex } from "@/data/store";
import { CAPTURE_LABEL, DOWNGRADE_LABEL, EVENT_TYPE_LABEL, ago, clock, prob, summarize } from "@/lib/format";
import { cn } from "@/lib/utils";

export const CAPTURES: Capture[] = ["proxy", "hook", "tool"];

/** One model turn by one Agent, as the log groups it. */
export type TurnItem = { kind: "turn"; key: string; seq: number; turn: string; agent: AgentId; events: ChannelEvent[] };

/** The log's column heads, as on a table. */
export function LogHead() {
  return (
    <div aria-hidden className={cn(GRID, "border-b border-rule py-2 text-label font-medium text-ink-3")}>
      <span>When</span>
      <span>Who</span>
      <span>Kind</span>
      <span>What</span>
      <span />
    </div>
  );
}

const GRID = "grid grid-cols-[4.75rem_minmax(0,12rem)_8rem_minmax(0,1fr)_auto] items-baseline gap-x-3 px-3";

/** A clickable row: a button to assistive tech, Enter or Space opens it; a link inside it keeps its own click. */
export function RowFrame({
  selected,
  fresh,
  onPick,
  className,
  children,
}: {
  selected: boolean;
  fresh?: boolean;
  onPick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <li className={cn("list-none border-b border-rule", fresh && "row-fresh")}>
      {/* biome-ignore lint/a11y/useSemanticElements: a row holds links, which a button cannot. */}
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a,button")) return;
          onPick();
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPick();
          }
        }}
        className={cn(
          "min-h-9 cursor-pointer py-2 text-row transition-colors duration-[var(--dur)] focus-visible:-outline-offset-2",
          selected ? "bg-paper-3" : "hover:bg-paper-2",
          className,
        )}
      >
        {children}
      </div>
    </li>
  );
}

/** Who an Event names: an Agent as a link to it, a Person, GitHub or the Relay. */
export function Who({ event }: { event: ChannelEvent }) {
  const a = event.actor;
  if (a.kind === "agent") return <HolderLabel holder={{ kind: "agent", agentId: a.agentId }} />;
  if (a.kind === "person") return <span className="text-ink">{a.person}</span>;
  return <span className="text-ink-2">{a.kind === "github" ? "GitHub" : "The Relay"}</span>;
}

/** What an Event says, with code set as code and a Directive or an addressed Update naming whom it is for. */
function What({ event }: { event: ChannelEvent }) {
  const { agentById } = useIndex();
  if (event.type === "command" || event.type === "tool.call" || event.type === "file.edit")
    return <code className="max-w-[72ch] text-small [overflow-wrap:anywhere] text-ink">{summarize(event)}</code>;
  if (event.type === "directive") {
    const to = agentById.get(event.payload.to);
    return (
      <span className="max-w-[72ch] [overflow-wrap:anywhere] text-ink">
        <span className="text-ink-3">to {to ? ownedName(to) : event.payload.to}: </span>
        {event.payload.text}
      </span>
    );
  }
  if (event.type === "update" && event.payload.to) {
    const names = event.payload.to.map((id) => {
      const to = agentById.get(id);
      return to ? ownedName(to) : id;
    });
    return (
      <span className="max-w-[72ch] [overflow-wrap:anywhere] text-ink">
        <span className="text-ink-3">to {names.join(", ")}: </span>
        {event.payload.text}
      </span>
    );
  }
  return <span className="max-w-[72ch] [overflow-wrap:anywhere] text-ink">{summarize(event)}</span>;
}

/** The Task an Event is on, and what the Relay did with it, in words. */
function Marks({ event, verdicts }: { event: ChannelEvent; verdicts: Verdict[] }) {
  const q = verdicts.filter((v) => v.option === "queue" && !v.downgraded).length;
  const parts = [event.task !== undefined && `#${event.task}`, q > 0 && `${q} Queued`].filter(Boolean);
  if (parts.length === 0) return null;
  return <span className="text-small whitespace-nowrap text-ink-3 tabular-nums">{parts.join(" · ")}</span>;
}

export function EventRow({
  event: e,
  verdicts,
  selected,
  fresh,
  onPick,
  mobile,
}: {
  event: ChannelEvent;
  verdicts: Verdict[];
  selected: boolean;
  fresh: boolean;
  onPick: () => void;
  mobile: boolean;
}) {
  if (mobile)
    return (
      <RowFrame selected={selected} fresh={fresh} onPick={onPick} className="flex flex-col gap-1 px-1">
        <span className="flex items-baseline gap-2 text-small">
          <span className="min-w-0 flex-1">
            <Who event={e} /> <span className="text-ink-3">· {EVENT_TYPE_LABEL[e.type]}</span>
          </span>
          <span className="flex shrink-0 items-baseline gap-2">
            <Marks event={e} verdicts={verdicts} />
            <time dateTime={e.at} className="text-ink-3 tabular-nums">
              {ago(e.at)}
            </time>
          </span>
        </span>
        <What event={e} />
      </RowFrame>
    );
  return (
    <RowFrame selected={selected} fresh={fresh} onPick={onPick} className={GRID}>
      <time dateTime={e.at} title={ago(e.at)} className="text-small text-ink-3 tabular-nums">
        {clock(e.at)}
      </time>
      <span className="min-w-0 text-small">
        <Who event={e} />
      </span>
      <span className="text-small font-medium text-ink-2">{EVENT_TYPE_LABEL[e.type]}</span>
      <What event={e} />
      <Marks event={e} verdicts={verdicts} />
    </RowFrame>
  );
}

/** The Relay typed an Event into an Agent's running session, or meant to and queued it instead. */
export function InterruptRow({ verdict: v, event: e, selected, onPick, mobile }: { verdict: Verdict; event: ChannelEvent; selected: boolean; onPick: () => void; mobile: boolean }) {
  const kind = v.downgraded ? "Queued instead" : "Interrupt";
  const odds = v.probabilities ? `Jev ${prob(v.probabilities.interrupt)}` : undefined;
  const said = `${whoName(e)}'s ${EVENT_TYPE_LABEL[e.type].toLowerCase()}`;
  const what = v.downgraded
    ? `Queued ${said} instead of typing it in: ${DOWNGRADE_LABEL[v.downgraded.reason].replace(/^./, (c) => c.toLowerCase())}.`
    : `Typed ${said} into its running session.`;
  if (mobile)
    return (
      <RowFrame selected={selected} onPick={onPick} className="flex flex-col gap-1 px-1">
        <span className="flex items-baseline gap-2 text-small">
          <span className="min-w-0 flex-1">
            <HolderLabel holder={{ kind: "agent", agentId: v.agent }} /> <span className="font-semibold text-ink">· {kind}</span>
          </span>
          <span className="flex shrink-0 items-baseline gap-2 text-ink-3 tabular-nums">
            {odds && <span>{odds}</span>}
            <time dateTime={v.at}>{ago(v.at)}</time>
          </span>
        </span>
        <span className="text-ink">{what}</span>
      </RowFrame>
    );
  return (
    <RowFrame selected={selected} onPick={onPick} className={GRID}>
      <time dateTime={v.at} title={ago(v.at)} className="text-small text-ink-3 tabular-nums">
        {clock(v.at)}
      </time>
      <span className="min-w-0 text-small">
        <HolderLabel holder={{ kind: "agent", agentId: v.agent }} />
      </span>
      <span className="text-small font-semibold text-ink">{kind}</span>
      <span className="max-w-[72ch] [overflow-wrap:anywhere] text-ink">{what}</span>
      {odds ? <span className="text-small whitespace-nowrap text-ink-3 tabular-nums">{odds}</span> : <span />}
    </RowFrame>
  );
}

function whoName(e: ChannelEvent): string {
  if (e.actor.kind === "agent") return e.actor.agentId.split("/")[0]!;
  if (e.actor.kind === "person") return e.actor.person;
  return e.actor.kind === "github" ? "GitHub" : "the Relay";
}

/** One model turn by one Agent; opened, its three Captures side by side. */
export function TurnRow({
  item,
  open,
  onToggle,
  selected,
  onPick,
  mobile,
}: {
  item: TurnItem;
  open: boolean;
  onToggle: () => void;
  selected?: string;
  onPick: (id: string) => void;
  mobile: boolean;
}) {
  const first = item.events[0]!;
  const by = (c: Capture) => item.events.filter((e) => e.capture === c);
  const counts = CAPTURES.filter((c) => by(c).length > 0)
    .map((c) => `${by(c).length} ${CAPTURE_LABEL[c]}`)
    .join(", ");
  // What the turn said: its Update, or its model's last reply. A model call that only asked for tools said nothing.
  const said = [...item.events]
    .reverse()
    .find((e) => e.type === "update" || ((e.type === "proxy.digest" || e.type === "proxy.raw") && e.payload.reply !== ""));
  const what = said ? summarize(said) : summarize(item.events.at(-1)!);
  const toggle = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      // On a phone the word is a 44px thumb target; the row keeps its height.
      className={cn("text-small font-medium whitespace-nowrap text-ink hover:underline", mobile && "-my-3 -mr-1 inline-flex min-h-11 items-center px-1")}
    >
      {open ? "Close" : "Compare"}
    </button>
  );
  return (
    <li id={`turn-${item.turn}`} className="list-none border-b border-rule">
      {mobile ? (
        <div className="flex flex-col gap-1 px-1 py-2 text-row">
          <span className="flex items-baseline gap-2 text-small">
            <span className="min-w-0 flex-1">
              <HolderLabel holder={{ kind: "agent", agentId: item.agent }} /> <span className="font-semibold text-ink">· Turn</span>
            </span>
            <time dateTime={first.at} className="shrink-0 text-ink-3 tabular-nums">
              {ago(first.at)}
            </time>
          </span>
          <span className="max-w-[72ch] [overflow-wrap:anywhere] text-ink">{what}</span>
          <span className="flex items-baseline justify-between gap-3 text-small text-ink-3 tabular-nums">
            {counts}
            {toggle}
          </span>
        </div>
      ) : (
        <div className={cn(GRID, "min-h-9 py-2 text-row")}>
          <time dateTime={first.at} title={ago(first.at)} className="text-small text-ink-3 tabular-nums">
            {clock(first.at)}
          </time>
          <span className="min-w-0 text-small">
            <HolderLabel holder={{ kind: "agent", agentId: item.agent }} />
          </span>
          <span className="text-small font-semibold text-ink">Turn</span>
          <span className="min-w-0">
            <span className="block max-w-[72ch] [overflow-wrap:anywhere] text-ink">{what}</span>
            <span className="block text-small text-ink-3 tabular-nums">
              {item.events.length} Events: {counts}
              {first.task !== undefined && ` · #${first.task}`}
            </span>
          </span>
          {toggle}
        </div>
      )}
      {open && (
        <>
          <h2 className="sr-only">
            Model turn {item.turn}, by its Capture
          </h2>
        <div className="grid gap-x-4 gap-y-3 pb-3 sm:grid-cols-3 sm:pl-[calc(4.75rem+0.75rem+0.75rem)]">
          {CAPTURES.map((c) => (
            <section key={c} aria-label={`${CAPTURE_LABEL[c]} Capture`} className="min-w-0">
              <h3 className="border-b border-rule-2 pb-1.5 text-small font-semibold text-ink">
                {CAPTURE_LABEL[c]} <span className="font-normal text-ink-3 tabular-nums">{by(c).length}</span>
              </h3>
              {by(c).length === 0 ? (
                <p className="py-2 text-small text-ink-3">Nothing from this Capture.</p>
              ) : (
                <ol>
                  {by(c).map((e) => (
                    <RowFrame key={e.id} selected={e.id === selected} onPick={() => onPick(e.id)} className="flex flex-col gap-0.5 px-1.5">
                      <span className="text-small font-medium text-ink-2">{EVENT_TYPE_LABEL[e.type]}</span>
                      <What event={e} />
                    </RowFrame>
                  ))}
                </ol>
              )}
            </section>
          ))}
        </div>
        </>
      )}
    </li>
  );
}

