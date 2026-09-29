import { motion } from "motion/react";
import type { Agent, AgentId, ChannelEvent, Task, ToolCall, Verdict } from "@shared/index";
import ToolChips, { type ToolStep } from "@/components/primitives/ToolChips";
import { Tool } from "@/components/ui/tool";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ui/reasoning";
import { EVENT_TYPE_LABEL, TASK_FIELD_LABEL, ago, clock, compact, holderName, summarize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentLink, CaptureChip, RawBadge, TaskLink, VerdictTally } from "./pills";
import { FileDiff } from "./diff";
import { VerdictTable } from "./verdict";

const TONE: Partial<Record<ChannelEvent["type"], string>> = {
  update: "text-ink",
  directive: "text-accent-ink",
  takeover: "text-red",
  push: "text-green",
  merge: "text-green",
  "claim.refused": "text-orange",
  "task.create": "text-green",
  "task.reopen": "text-orange",
  "task.remove": "text-red",
  "mirror.failed": "text-orange",
  "person.join": "text-accent-ink",
};

function Actor({ event, agentById, compact }: { event: ChannelEvent; agentById: Map<AgentId, Agent>; compact?: boolean }) {
  const a = event.actor;
  if (a.kind === "agent")
    return <AgentLink id={a.agentId} agent={agentById.get(a.agentId)} nicknameClassName={compact ? "hidden sm:inline" : undefined} />;
  if (a.kind === "person")
    return <span className="text-[12.5px] font-medium text-ink">{a.person}</span>;
  return <span className="text-[12.5px] font-medium text-ink-2">GitHub</span>;
}

/** One line in the live feed. Dense on desktop, stacked on a phone. */
export function EventRow({
  event,
  verdicts,
  agentById,
  taskByNumber,
  selected,
  fresh,
  onSelect,
}: {
  event: ChannelEvent;
  verdicts: Verdict[];
  agentById: Map<AgentId, Agent>;
  taskByNumber: Map<number, Task>;
  selected: boolean;
  fresh: boolean;
  onSelect: () => void;
}) {
  const task = event.task !== undefined ? taskByNumber.get(event.task) : undefined;
  const isMessage = event.type === "update" || event.type === "directive";
  return (
    <motion.li
      layout="position"
      initial={fresh ? { opacity: 0, y: -6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="list-none"
    >
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
          "group relative grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-line-soft px-3 py-2 text-left transition-colors duration-100 hover:bg-inset sm:px-4",
          selected && "bg-accent-tint/60 hover:bg-accent-tint/80",
        )}
      >
        {selected && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="label-mono !text-[10px]">{EVENT_TYPE_LABEL[event.type]}</span>
          <Actor event={event} agentById={agentById} compact />
          <CaptureChip event={event} />
          {event.type === "proxy.raw" && <RawBadge />}
          {task && <TaskLink number={task.number} className="text-[12px] text-ink-3" />}
        </div>
        <div className="flex items-center gap-2 self-start pt-0.5">
          <VerdictTally verdicts={verdicts} />
          <time className="font-mono text-[11px] text-ink-3 tabular-nums" dateTime={event.at} title={clock(event.at)}>
            {ago(event.at)}
          </time>
        </div>
        <p
          className={cn(
            "col-span-2 line-clamp-2 min-w-0 text-[13px] leading-snug text-ink-2",
            TONE[event.type],
            isMessage && "font-medium",
            (event.type === "command" || event.type === "tool.call" || event.type === "file.edit") && "font-mono text-[12px]",
          )}
        >
          {event.type === "directive" && (
            <span className="mr-1 text-ink-3">
              to <span className="font-mono text-[12px]">{event.payload.to}</span>:
            </span>
          )}
          {summarize(event)}
        </p>
      </div>
    </motion.li>
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
      <dt className="label-mono">{label}</dt>
      <dd className="min-w-0 text-[12.5px] text-ink">{children}</dd>
    </div>
  );
}

/** The body of one Event, by type. */
export function EventBody({ event }: { event: ChannelEvent }) {
  switch (event.type) {
    case "push":
      return (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Branch"><span className="font-mono text-[12px]">{event.payload.branch}</span></Field>
            <Field label="Commit"><span className="font-mono text-[12px]">{event.payload.commit}</span></Field>
          </dl>
          {event.payload.files.map((f) => (
            <FileDiff key={f.path} file={f} />
          ))}
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
          <p className="rounded-card bg-inset px-3 py-2 text-[13px] leading-relaxed text-ink">{p.reply}</p>
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
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-card bg-inset p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
                  {event.payload.context}
                </pre>
              </ReasoningContent>
            </Reasoning>
          )}
          <p className="text-[11.5px] text-ink-3">
            {p.maskedSecrets > 0
              ? `${p.maskedSecrets} detected ${p.maskedSecrets === 1 ? "secret was" : "secrets were"} masked before leaving the laptop.`
              : "No secrets detected."}
          </p>
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
            output: {
              durationMs: event.payload.durationMs,
              ...(event.payload.output ? { output: event.payload.output } : {}),
            },
          }}
        />
      );
    case "takeover":
      return (
        <div className="flex flex-col gap-2 rounded-card bg-surface p-3 shadow-card">
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
            Open the Issue on GitHub
          </a>
        </div>
      );
    case "task.change":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-ink-2">GitHub owns these fields, so the Task now follows the Issue.</p>
          <div className="flex flex-wrap gap-1.5">
            {event.payload.fields.map((f) => (
              <span key={f} className="rounded-[4px] bg-inset px-1.5 py-0.5 font-mono text-[11.5px] text-ink shadow-hairline">
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
}: {
  event: ChannelEvent;
  verdicts: Verdict[];
  agentById: Map<AgentId, Agent>;
  taskByNumber: Map<number, Task>;
  threshold: number;
}) {
  const task = event.task !== undefined ? taskByNumber.get(event.task) : undefined;
  return (
    <article className="flex flex-col gap-4">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="label-mono">{EVENT_TYPE_LABEL[event.type]}</span>
          <CaptureChip event={event} />
          {event.type === "proxy.raw" && <RawBadge />}
          <time className="ml-auto font-mono text-[11px] text-ink-3 tabular-nums" dateTime={event.at}>
            {clock(event.at)} · {ago(event.at)}
          </time>
        </div>
        <Actor event={event} agentById={agentById} />
        {task && <TaskLink number={task.number} title={task.title} className="text-[12.5px] text-ink-2" />}
      </header>
      <EventBody event={event} />
      <section className="flex flex-col gap-2">
        <h3 className="flex items-baseline justify-between text-[12.5px] font-semibold text-ink">
          Verdicts
          <span className="font-mono text-[11px] font-normal text-ink-3">Interrupt threshold {threshold.toFixed(2)}</span>
        </h3>
        <VerdictTable verdicts={verdicts} agentById={agentById} threshold={threshold} />
      </section>
    </article>
  );
}
