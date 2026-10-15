import type { Agent, AgentId, ChannelEvent, Task, ToolCall, Verdict } from "@shared/index";
import ToolChips, { type ToolStep } from "@/components/primitives/ToolChips";
import { Tool } from "@/components/ui/tool";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ui/reasoning";
import { EVENT_TYPE_LABEL, TASK_FIELD_LABEL, ago, clock, compact, holderName, summarize, unrelayedReason } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ActorAvatar, AgentLink, CaptureChip, CaptureIcon, RawBadge, TaskLink, VerdictTally } from "./pills";
import { ArrowRight, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FileDiff } from "./diff";
import { VerdictTable } from "./verdict";
import { IssueLink } from "./pending";
import { useMemo } from "react";
import { useEventsById } from "@/data/history";
import { href } from "@/lib/router";

const TONE: Partial<Record<ChannelEvent["type"], string>> = {
  update: "text-ink",
  directive: "text-ink",
  "directive.delivery": "text-ink-2",
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
    return <span className="truncate text-body font-medium text-ink">{a.person}</span>;
  return <span className="text-body font-medium text-ink-2">GitHub</span>;
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
  const isMessage = event.type === "update" || event.type === "directive" || event.type === "memory.note";
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
          "group relative grid cursor-pointer grid-cols-[2rem_minmax(0,1fr)] gap-x-3 rounded-md px-3 text-left outline-none transition-colors duration-150 hover:bg-inset focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
          continued ? "py-1.5" : "pt-3.5 pb-1.5",
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
                    <ArrowRight className="size-3.5 shrink-0 text-ink-3" aria-label="to" />
                    <AgentLink id={event.payload.to} agent={agentById.get(event.payload.to)} showNickname={false} />
                  </>
                )}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-small text-ink-3">{EVENT_TYPE_LABEL[event.type]}</span>
                {event.type === "proxy.raw" && <RawBadge />}
                {task && <TaskLink number={task.number} className="shrink-0 text-small text-ink-3" />}
              </span>
            </div>
            <span className="flex h-5 shrink-0 items-center gap-2">
              <VerdictTally verdicts={verdicts} />
              <CaptureIcon event={event} />
              <time className="text-small whitespace-nowrap text-ink-3 tabular-nums" dateTime={event.at} title={clock(event.at)}>
                {ago(event.at)}
              </time>
            </span>
          </div>
          <p
            className={cn(
              "line-clamp-2 max-w-[68ch] min-w-0 text-body leading-normal text-ink-2",
              TONE[event.type],
              isMessage && "text-ink",
              event.type === "directive" && "font-medium",
            )}
          >
            {event.type === "command" || event.type === "tool.call" || event.type === "file.edit" ? (
              <code className="font-mono text-small">{summarize(event)}</code> // taste-skill-ignore: a command, tool argument or path is literal code
            ) : (
              summarize(event)
            )}
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
    // Nothing more than the row says: the row does not open, and a chip cut short shows its full text itself.
    detail: [],
  }));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-small text-ink-3">{label}</dt>
      <dd className="min-w-0 text-body text-ink">{children}</dd>
    </div>
  );
}

/** A Wake: why the Agent started a turn, and the Events and Directives it was woken with, each a link. */
function WakeBody({ event }: { event: Extract<ChannelEvent, { type: "wake" }> }) {
  const delivered = useMemo(
    () => [...event.payload.events, ...event.payload.directives],
    [event.payload.events, event.payload.directives],
  );
  // They can be older than the Events the Dashboard has loaded.
  const byId = useEventsById(delivered);
  return (
    <div className="flex flex-col gap-2.5">
      <p className="max-w-[68ch] text-body leading-relaxed text-ink">
        The Agent was idle, so its wrapper typed what was waiting for its next turn as one prompt, which started a
        turn. Its Person did not write that prompt.
      </p>
      {delivered.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {delivered.map((id) => {
            const woken = byId.get(id);
            return (
              <li key={id}>
                <a
                  href={href({ view: "feed", event: id })}
                  className="flex min-w-0 flex-col gap-0.5 rounded-md bg-hover px-3 py-2.5 transition-colors hover:bg-hover-2"
                >
                  <span className="text-small text-ink-3">{woken ? EVENT_TYPE_LABEL[woken.type] : "Event"}</span>
                  <span className="truncate text-body text-ink">{woken ? summarize(woken) : id}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
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
            <Field label="Branch"><code className="font-mono text-small">{event.payload.branch}</code></Field>{/* taste-skill-ignore: a branch name is code */}
            <Field label="Commit"><code className="font-mono text-small">{event.payload.commit.slice(0, 7)}</code></Field>{/* taste-skill-ignore: a commit hash is code */}
          </dl>
          {event.type === "push" && event.payload.commits.length > 1 && (
            <ul className="flex flex-col gap-1">
              {event.payload.commits.map((c) => (
                <li key={c.sha} className="flex min-w-0 gap-2 text-small text-ink-2">
                  <code className="shrink-0 font-mono text-small text-ink-3">{c.sha.slice(0, 7)}</code>{/* taste-skill-ignore: a commit hash is code */}
                  <span className="truncate">{c.message}</span>
                </li>
              ))}
            </ul>
          )}
          {event.payload.files.map((f) => (
            <FileDiff key={f.path} file={f} />
          ))}
          {event.payload.truncationNote && <p className="text-small text-ink-3">{event.payload.truncationNote}</p>}
        </div>
      );
    case "proxy.digest":
    case "proxy.raw": {
      const p = event.payload;
      return (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-3 gap-3">
            <Field label="Model"><span className="text-body">{p.model}</span></Field>
            <Field label="Tokens in"><span className="tabular-nums">{compact(p.inputTokens)}</span></Field>
            <Field label="Tokens out"><span className="tabular-nums">{compact(p.outputTokens)}</span></Field>
          </dl>
          <p className="rounded-md bg-hover px-3.5 py-3 text-body leading-relaxed text-ink">{p.reply}</p>
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
              <ReasoningTrigger className="text-small font-medium">Model context (raw)</ReasoningTrigger>
              <ReasoningContent contentClassName="mt-2">
                <pre /* taste-skill-ignore: raw model context */ className="max-h-64 overflow-auto rounded-md bg-hover p-3 font-mono text-small leading-relaxed whitespace-pre-wrap text-ink-2">
                  {event.payload.context}
                </pre>
              </ReasoningContent>
            </Reasoning>
          )}
          {p.maskedSecrets > 0 && (
            <p className="text-small text-ink-3">
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
    case "command": {
      const { command, exitCode } = event.payload;
      return (
        <div className="flex flex-col gap-3">
          <pre /* taste-skill-ignore: a shell command */ className="overflow-x-auto rounded-md bg-hover px-3 py-2.5 font-mono text-small leading-relaxed whitespace-pre-wrap text-ink">
            $ {command}
          </pre>
          {exitCode !== undefined && (
            <dl className="grid grid-cols-2 gap-3">
              <Field label="Exit code">
                <span className={cn("text-body font-medium tabular-nums", exitCode === 0 ? "text-green" : "text-red")}>{exitCode}</span>
              </Field>
            </dl>
          )}
        </div>
      );
    }
    case "wake":
      return <WakeBody event={event} />;
    case "directive":
      return (
        <div className="flex flex-col gap-3 rounded-md bg-hover p-4">
          <dl className="grid grid-cols-2 gap-3">
            <Field label="From">
              {event.actor.kind === "person" ? event.actor.person : "-"}
            </Field>
            <Field label="To"><AgentLink id={event.payload.to} showNickname={false} /></Field>
          </dl>
          <p className="max-w-[60ch] text-lead leading-relaxed font-medium whitespace-pre-wrap text-ink">{event.payload.text}</p>
        </div>
      );
    case "takeover":
      return (
        <div className="flex flex-col gap-3 rounded-md bg-hover p-4">
          <dl className="grid grid-cols-2 gap-3">
            <Field label="From"><span className="tabular-nums">{holderName(event.payload.from)}</span></Field>
            <Field label="To"><span className="tabular-nums">{holderName(event.payload.to)}</span></Field>
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
          <p className="max-w-[68ch] text-body leading-relaxed text-ink">{event.payload.title}</p>
          <a href={event.payload.url} target="_blank" rel="noreferrer" className="self-start text-small text-accent-ink underline-offset-4 hover:underline">
            Issue on GitHub
          </a>
        </div>
      );
    case "task.change":
      return (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {event.payload.fields.map((f) => (
              <span key={f} className="rounded-sm bg-hover px-2 py-0.5 text-small text-ink-2">
                {TASK_FIELD_LABEL[f]}
              </span>
            ))}
          </div>
        </div>
      );
    default:
      return <p className="max-w-[68ch] text-body leading-relaxed text-ink">{summarize(event)}</p>;
  }
}

export function EventDetail({
  event,
  verdicts,
  agentById,
  taskByNumber,
  threshold,
  verdictsLive = true,
  verdictsLoaded = true,
  woken,
  onClose,
}: {
  event: ChannelEvent;
  verdicts: Verdict[];
  agentById: Map<AgentId, Agent>;
  taskByNumber: Map<number, Task>;
  threshold: number;
  verdictsLive?: boolean;
  /** False for an Event older than those loaded: its Verdicts are not loaded with it. */
  verdictsLoaded?: boolean;
  /** The Agents whose Queue Verdict on this Event a Wake delivered. */
  woken?: ReadonlySet<AgentId>;
  /** Shown as a close button in the header, where the Event opens beside the feed. */
  onClose?: () => void;
}) {
  const task = event.task !== undefined ? taskByNumber.get(event.task) : undefined;
  const unrelayed = event.type !== "directive" ? unrelayedReason(event.type) : null;
  return (
    <article className="flex flex-col gap-6">
      <header className="flex items-start gap-3">
        <ActorAvatar actor={event.actor} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Actor event={event} agentById={agentById} />
            <span className="text-small text-ink-3">{EVENT_TYPE_LABEL[event.type]}</span>
            <CaptureChip event={event} />
            {event.type === "proxy.raw" && <RawBadge />}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-3">
            <time className="tabular-nums" dateTime={event.at}>
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
            className="-mt-1 -mr-2 grid size-9 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </header>
      <EventBody event={event} />
      <section className="flex flex-col gap-2.5">
        <h3 className="flex items-center justify-between text-body font-medium text-ink">
          Verdicts
          {event.type !== "directive" && unrelayed === null && verdictsLive && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="rounded-sm bg-hover px-2 py-0.5 text-small font-normal text-ink-3 tabular-nums">
                  threshold {threshold.toFixed(2)}
                </span>
              </TooltipTrigger>
              <TooltipContent>An Interrupt needs at least this probability. Below it, the Event is Queued.</TooltipContent>
            </Tooltip>
          )}
        </h3>
        {event.type === "directive" ? (
          <p className="rounded-md bg-hover px-3.5 py-3 text-small text-ink-3">
            No Verdict: a Directive always reaches <span className="font-medium text-ink-2">{event.payload.to}</span>, labelled
            as from {event.actor.kind === "person" ? event.actor.person : "its sender"}.
          </p>
        ) : unrelayed !== null ? (
          <p className="rounded-md bg-hover px-3.5 py-3 text-small text-ink-3">{unrelayed}</p>
        ) : verdictsLive && !verdictsLoaded ? (
          <p className="rounded-md bg-hover px-3.5 py-3 text-small text-ink-3">
            This Event is older than the ones loaded, so its Verdicts are not shown.
          </p>
        ) : verdictsLive ? (
          <VerdictTable verdicts={verdicts} agentById={agentById} threshold={threshold} woken={woken} />
        ) : (
          <p className="rounded-md bg-hover px-3.5 py-3 text-small text-ink-3">
            Arrives with the Relay (<IssueLink capability="verdicts" />).
          </p>
        )}
      </section>
    </article>
  );
}
