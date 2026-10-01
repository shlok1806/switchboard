import type { Agent, AgentId, ChannelEvent, Task, ToolCall, Verdict } from "@shared/index";
import ToolChips, { type ToolStep } from "@/components/primitives/ToolChips";
import { Tool } from "@/components/ui/tool";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ui/reasoning";
import { EVENT_TYPE_LABEL, TASK_FIELD_LABEL, ago, clock, compact, holderName, summarize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ActorAvatar, AgentLink, CaptureChip, CaptureIcon, RawBadge, TaskLink, VerdictTally } from "./pills";
import { ArrowRight, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FileDiff } from "./diff";
import { VerdictTable } from "./verdict";
import { IssueLink } from "./pending";

const TONE: Partial<Record<ChannelEvent["type"], string>> = {
  update: "text-ink",
  directive: "text-accent-ink",
  "directive.delivery": "text-accent-ink",
  takeover: "text-red",
  push: "text-green",
  merge: "text-green",
  "task.review": "text-green",
  "claim.refused": "text-orange",
  "task.create": "text-green",
  "task.reopen": "text-orange",
  "task.remove": "text-red",
  "mirror.failed": "text-orange",
};

function Actor({ event, agentById, compact }: { event: ChannelEvent; agentById: Map<AgentId, Agent>; compact?: boolean }) {
  const a = event.actor;
  if (a.kind === "agent")
    return <AgentLink id={a.agentId} agent={agentById.get(a.agentId)} nicknameClassName={compact ? "hidden sm:inline" : undefined} />;
  if (a.kind === "person")
    return <span className="truncate text-[13px] font-medium text-ink">{a.person}</span>;
  return <span className="text-[13px] font-medium text-ink-2">GitHub</span>;
}

/** One message in the live feed: who, what, and when, like a chat line. */
export function EventRow({
  event,
  verdicts,
  agentById,
  taskByNumber,
  selected,
  fresh,
  onSelect,
  continued = false,
}: {
  event: ChannelEvent;
  verdicts: Verdict[];
  agentById: Map<AgentId, Agent>;
  taskByNumber: Map<number, Task>;
  selected: boolean;
  fresh: boolean;
  onSelect: () => void;
  /** Same sender as the row above, moments later: the avatar is left out, as in a chat. */
  continued?: boolean;
}) {
  const task = event.task !== undefined ? taskByNumber.get(event.task) : undefined;
  const isMessage = event.type === "update" || event.type === "directive";
  return (
    <li className={cn("list-none", fresh && "row-in")}>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          "group relative grid cursor-pointer grid-cols-[2rem_minmax(0,1fr)] gap-x-3 rounded-lg px-3 text-left outline-none transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
          continued ? "py-1.5" : "pt-3 pb-1.5",
          selected && "bg-accent-tint hover:bg-accent-tint",
        )}
      >
        {continued ? <span aria-hidden /> : <ActorAvatar actor={event.actor} />}
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-start gap-2">
            {/* Who comes first and is never cut off; the type label wraps to the next line before the Agent ID gives way. */}
            <div className="flex min-h-5 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={cn("flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5", continued && "sr-only")}>
                <Actor event={event} agentById={agentById} compact />
                {event.type === "directive" && (
                  <>
                    <ArrowRight className="size-3.5 shrink-0 text-ink-4" aria-label="to" />
                    <AgentLink id={event.payload.to} agent={agentById.get(event.payload.to)} showNickname={false} />
                  </>
                )}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-[12px] text-ink-3">{EVENT_TYPE_LABEL[event.type]}</span>
                {event.type === "proxy.raw" && <RawBadge />}
                {task && <TaskLink number={task.number} className="shrink-0 text-[12px]" />}
              </span>
            </div>
            <span className="flex h-5 shrink-0 items-center gap-2">
              <VerdictTally verdicts={verdicts} />
              <CaptureIcon event={event} />
              <time className="font-mono text-[11.5px] text-ink-3 tabular-nums" dateTime={event.at} title={clock(event.at)}>
                {ago(event.at)}
              </time>
            </span>
          </div>
          <p
            className={cn(
              "line-clamp-2 min-w-0 text-[13.5px] leading-snug text-ink-2",
              TONE[event.type],
              isMessage && "text-ink",
              event.type === "directive" && "text-accent-ink",
              (event.type === "command" || event.type === "tool.call" || event.type === "file.edit") && "font-mono text-[12.5px]",
            )}
          >
            {summarize(event)}
          </p>
        </div>
      </div>
    </li>
  );
}

const ICON: Record<string, string> = { Edit: "write", Write: "write", apply_patch: "write", Read: "read", Grep: "read", Bash: "run" };

export function toolSteps(calls: ToolCall[]): ToolStep[] {
  return calls.map((c) => ({
    icon: ICON[c.name] ?? "think",
    label: c.name,
    chip: c.arg,
    mono: true,
    detailMono: true,
    detail: [{ text: `${c.name}(${c.arg})` }],
  }));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="min-w-0 text-[13px] text-ink">{children}</dd>
    </div>
  );
}

/** The body of one Event, by type. */
export function EventBody({ event }: { event: ChannelEvent }) {
  switch (event.type) {
    case "push":
    case "merge":
      return (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Branch"><span className="font-mono text-[12px]">{event.payload.branch}</span></Field>
            <Field label="Commit"><span className="font-mono text-[12px]">{event.payload.commit.slice(0, 7)}</span></Field>
          </dl>
          {event.type === "push" && event.payload.commits.length > 1 && (
            <ul className="flex flex-col gap-1">
              {event.payload.commits.map((c) => (
                <li key={c.sha} className="flex min-w-0 gap-2 text-[12.5px] text-ink-2">
                  <span className="shrink-0 font-mono text-[12px] text-ink-3">{c.sha.slice(0, 7)}</span>
                  <span className="truncate">{c.message}</span>
                </li>
              ))}
            </ul>
          )}
          {event.payload.files.map((f) => (
            <FileDiff key={f.path} file={f} />
          ))}
          {event.payload.truncationNote && <p className="text-[12px] text-ink-3">{event.payload.truncationNote}</p>}
        </div>
      );
    case "proxy.digest":
    case "proxy.raw": {
      const p = event.payload;
      return (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-3 gap-3">
            <Field label="Model"><span className="font-mono text-[12px]">{p.model}</span></Field>
            <Field label="Tokens in"><span className="tabular-nums">{compact(p.inputTokens)}</span></Field>
            <Field label="Tokens out"><span className="tabular-nums">{compact(p.outputTokens)}</span></Field>
          </dl>
          <p className="rounded-lg bg-inset px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink">{p.reply}</p>
          {p.toolCalls.length > 0 && (
            <ToolChips
              animate={false}
              steps={toolSteps(p.toolCalls)}
              diffs={[]}
              labels={{ header: `${p.toolCalls.length} tool ${p.toolCalls.length === 1 ? "call" : "calls"}`, more: "" }}
            />
          )}
          {event.type === "proxy.raw" && (
            <Reasoning>
              <ReasoningTrigger className="text-[12.5px] font-medium">Model context (raw)</ReasoningTrigger>
              <ReasoningContent contentClassName="mt-2">
                <pre className="max-h-64 overflow-auto rounded-lg bg-inset p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
                  {event.payload.context}
                </pre>
              </ReasoningContent>
            </Reasoning>
          )}
          {p.maskedSecrets > 0 && (
            <p className="text-[12px] text-ink-3">
              {p.maskedSecrets} {p.maskedSecrets === 1 ? "secret" : "secrets"} masked
            </p>
          )}
        </div>
      );
    }
    case "tool.call":
      return (
        <Tool
          defaultOpen
          toolPart={{
            type: event.payload.tool,
            state: event.payload.ok ? "output-available" : "output-error",
            input: { arg: event.payload.arg },
            // A hook-captured call has neither; only the Tool Capture's do.
            output: {
              ...(event.payload.durationMs === undefined ? {} : { durationMs: event.payload.durationMs }),
              ...(event.payload.output ? { output: event.payload.output } : {}),
            },
          }}
        />
      );
    case "directive":
      return (
        <div className="flex flex-col gap-3 rounded-lg bg-inset p-3">
          <dl className="grid grid-cols-2 gap-3">
            <Field label="From">
              {event.actor.kind === "person" ? event.actor.person : "-"}
            </Field>
            <Field label="To"><AgentLink id={event.payload.to} showNickname={false} /></Field>
          </dl>
          <p className="text-[13.5px] leading-relaxed font-medium whitespace-pre-wrap text-accent-ink">{event.payload.text}</p>
        </div>
      );
    case "takeover":
      return (
        <div className="flex flex-col gap-3 rounded-lg bg-inset p-3">
          <dl className="grid grid-cols-2 gap-3">
            <Field label="From"><span className="font-mono text-[12px]">{holderName(event.payload.from)}</span></Field>
            <Field label="To"><span className="font-mono text-[12px]">{holderName(event.payload.to)}</span></Field>
          </dl>
          <Field label="Steps completed">
            {event.payload.stepsCompleted.length ? (
              <ul className="mt-0.5 list-inside list-disc text-ink-2">
                {event.payload.stepsCompleted.map((s) => <li key={s}>{s}</li>)}
              </ul>
            ) : (
              <span className="text-ink-3">None</span>
            )}
          </Field>
          <Field label="Last Update">
            <span className="text-ink-2">{event.payload.lastUpdate ?? "None"}</span>
          </Field>
        </div>
      );
    case "task.create":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-[13.5px] leading-relaxed text-ink">{event.payload.title}</p>
          <a href={event.payload.url} target="_blank" rel="noreferrer" className="self-start text-[12.5px] text-accent-ink hover:underline">
            Issue on GitHub
          </a>
        </div>
      );
    case "task.change":
      return (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {event.payload.fields.map((f) => (
              <span key={f} className="rounded-full bg-hover px-2 py-0.5 text-[12px] text-ink-2">
                {TASK_FIELD_LABEL[f]}
              </span>
            ))}
          </div>
        </div>
      );
    default:
      return <p className="text-[13.5px] leading-relaxed text-ink">{summarize(event)}</p>;
  }
}

export function EventDetail({
  event,
  verdicts,
  agentById,
  taskByNumber,
  threshold,
  verdictsLive = true,
  onClose,
}: {
  event: ChannelEvent;
  verdicts: Verdict[];
  agentById: Map<AgentId, Agent>;
  taskByNumber: Map<number, Task>;
  threshold: number;
  verdictsLive?: boolean;
  /** Shown as a close button in the header, where the Event opens beside the feed. */
  onClose?: () => void;
}) {
  const task = event.task !== undefined ? taskByNumber.get(event.task) : undefined;
  return (
    <article className="flex flex-col gap-5">
      <header className="flex items-start gap-3">
        <ActorAvatar actor={event.actor} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Actor event={event} agentById={agentById} />
            <span className="text-[12.5px] text-ink-3">{EVENT_TYPE_LABEL[event.type]}</span>
            <CaptureChip event={event} />
            {event.type === "proxy.raw" && <RawBadge />}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
            <time className="font-mono tabular-nums" dateTime={event.at}>
              {clock(event.at)} · {ago(event.at)}
            </time>
            {task && <TaskLink number={task.number} title={task.title} className="min-w-0 text-ink-2" />}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Event"
            className="-mt-1 -mr-2 grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </header>
      <EventBody event={event} />
      <section className="flex flex-col gap-2.5">
        <h3 className="flex items-center justify-between text-[13px] font-medium text-ink">
          Verdicts
          {event.type !== "directive" && verdictsLive && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="rounded-full bg-hover px-2 py-0.5 font-mono text-[11.5px] font-normal text-ink-3">
                  threshold {threshold.toFixed(2)}
                </span>
              </TooltipTrigger>
              <TooltipContent>An Interrupt needs at least this probability. Below it, the Event is Queued.</TooltipContent>
            </Tooltip>
          )}
        </h3>
        {event.type === "directive" ? (
          <p className="rounded-lg bg-inset px-3 py-2.5 text-[13px] text-ink-3">
            No Verdict: a Directive always reaches <span className="font-mono text-[12.5px] text-ink-2">{event.payload.to}</span>, labelled
            as from {event.actor.kind === "person" ? event.actor.person : "its sender"}.
          </p>
        ) : verdictsLive ? (
          <VerdictTable verdicts={verdicts} agentById={agentById} threshold={threshold} />
        ) : (
          <p className="rounded-lg bg-inset px-3 py-2.5 text-[13px] text-ink-3">
            Arrives with the Relay (<IssueLink capability="verdicts" />).
          </p>
        )}
      </section>
    </article>
  );
}
