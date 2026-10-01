import { useMemo } from "react";
import type { Capture, ChannelEvent } from "@shared/index";
import { useCapabilities, useChannel, useIndex } from "@/data/store";
import { IssueLink, Pending } from "@/components/domain/pending";
import ToolChips, { type ToolStep } from "@/components/primitives/ToolChips";
import { AgentLink, RawBadge, TaskLink } from "@/components/domain/pills";
import { toolSteps } from "@/components/domain/event";
import { CAPTURE_LABEL, EVENT_TYPE_LABEL, ago, clock, compact, summarize } from "@/lib/format";
import { go, href } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const CAPTURES: Capture[] = ["proxy", "hook", "tool"];

const WHAT: Record<Capture, string> = {
  proxy: "The model's API traffic: what it read and said.",
  hook: "The CLI's lifecycle: every tool call, edit and command.",
  tool: "What the Agent reported on purpose through Switchboard's tools.",
};

interface Moment {
  turn: string;
  agent: string;
  at: string;
  task?: number;
  events: ChannelEvent[];
}

/** Group Events that share a model turn, so one moment can be read from each Capture. */
function useMoments(): Moment[] {
  const { events } = useChannel();
  return useMemo(() => {
    const m = new Map<string, Moment>();
    for (const e of events) {
      if (!e.turn || e.actor.kind !== "agent") continue;
      const cur = m.get(e.turn) ?? { turn: e.turn, agent: e.actor.agentId, at: e.at, events: [] };
      cur.events.push(e);
      cur.task ??= e.task;
      cur.at = e.at;
      m.set(e.turn, cur);
    }
    return [...m.values()].reverse();
  }, [events]);
}

export function CompareView({ turn }: { turn?: string }) {
  const moments = useMoments();
  const { agentById } = useIndex();
  const can = useCapabilities();
  // A turn the URL names that is not on the Channel is not found, never quietly another turn.
  const moment = turn === undefined ? moments[0] : moments.find((m) => m.turn === turn);

  if (!can.captures && moments.length === 0) {
    return (
      <Pending title="Nothing to compare yet" className="h-full">
        Arrives with <IssueLink capability="captures" /> and <IssueLink capability="proxyMode" />.
      </Pending>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <nav
        aria-label="Model turns"
        className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line px-3 py-2.5 lg:w-72 lg:flex-col lg:gap-0.5 lg:overflow-y-auto lg:border-r lg:border-b-0 lg:p-2"
      >
        <h2 className="hidden items-center gap-1.5 px-2.5 pt-1 pb-2 text-[12.5px] text-ink-3 lg:flex">
          Model turns
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="About model turns" className="grid size-5 place-items-center rounded text-ink-4 hover:text-ink-2">
                <Info className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent>One model turn by one Agent, as each Capture recorded it.</TooltipContent>
          </Tooltip>
        </h2>
        {moments.map((m) => {
          const on = m.turn === moment?.turn;
          const caps = new Set(m.events.map((e) => e.capture));
          return (
            <a
              key={m.turn}
              href={href({ view: "compare", turn: m.turn })}
              aria-current={on ? "true" : undefined}
              className={cn(
                "flex shrink-0 flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors lg:shrink",
                on ? "bg-accent-tint" : "border border-line hover:bg-hover lg:border-transparent",
              )}
            >
              <span className={cn("truncate font-mono text-[12.5px]", on ? "text-accent-ink" : "text-ink")}>{m.agent}</span>
              <span className="flex items-center gap-2 text-[12px] text-ink-3">
                <span className="font-mono tabular-nums">{clock(m.at)}</span>
                {m.task && <span className="font-mono">#{m.task}</span>}
                <span className="ml-auto flex gap-1" aria-label={`Captures: ${CAPTURES.filter((c) => caps.has(c)).map((c) => CAPTURE_LABEL[c]).join(", ")}`}>
                  {CAPTURES.map((c) => (
                    <span key={c} title={CAPTURE_LABEL[c]} className={cn("size-1.5 rounded-full", caps.has(c) ? "bg-accent" : "bg-hover-2")} />
                  ))}
                </span>
              </span>
            </a>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!moment && turn !== undefined ? (
          <Pending title="No such model turn" className="h-full">
            <span className="font-mono text-[12px] break-all text-ink-2">{turn}</span> is not on this Channel.{" "}
            {moments.length > 0 && (
              <a href={href({ view: "compare" })} className="text-accent-ink hover:underline">
                Show the latest turn
              </a>
            )}
          </Pending>
        ) : !moment ? (
          <div className="flex h-full items-center justify-center p-6">
            <p className="text-[14px] text-ink-3">Waiting for the first model turn</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-4 py-5 sm:px-6">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <AgentLink id={moment.agent} agent={agentById.get(moment.agent as never)} />
              {moment.task && <TaskLink number={moment.task} className="text-[13px]" />}
              <span className="font-mono text-[12px] text-ink-3">
                {clock(moment.at)} · {ago(moment.at)}
              </span>
            </header>
            <div className="grid gap-4 md:grid-cols-3">
              {CAPTURES.map((c) => (
                <CaptureColumn key={c} capture={c} events={moment.events.filter((e) => e.capture === c)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CaptureColumn({ capture, events }: { capture: Capture; events: ChannelEvent[] }) {
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line-soft px-4 py-2.5">
        <h2 className="text-[13.5px] font-medium text-ink">{CAPTURE_LABEL[capture]}</h2>
        <span className="rounded-full bg-hover px-1.5 font-mono text-[11.5px] text-ink-3 tabular-nums">{events.length}</span>
        {events.some((e) => e.type === "proxy.raw") && <RawBadge />}
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label={`About ${CAPTURE_LABEL[capture]} Capture`} className="ml-auto grid size-6 place-items-center rounded text-ink-4 hover:text-ink-2">
              <Info className="size-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent>{WHAT[capture]}</TooltipContent>
        </Tooltip>
      </header>
      <div className="flex flex-1 flex-col gap-3 p-4">
        {events.length === 0 ? (
          <p className="text-[13px] text-ink-3">Nothing</p>
        ) : capture === "proxy" ? (
          events.map((e) => <ProxyCard key={e.id} event={e} />)
        ) : capture === "hook" ? (
          <ToolChips
            animate={false}
            steps={events.map(hookStep)}
            diffs={events.flatMap((e) =>
              e.type === "file.edit" ? [{ file: e.payload.path.split("/").pop()!, add: e.payload.additions, del: e.payload.deletions }] : [],
            )}
            diffLines={{}}
            labels={{ header: `${events.length} Hook ${events.length === 1 ? "Event" : "Events"}`, more: "" }}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {events.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => go({ view: "feed", event: e.id })}
                  className="flex w-full flex-col gap-0.5 rounded-lg bg-inset px-3 py-2 text-left transition-colors hover:bg-hover"
                >
                  <span className="text-[12px] text-ink-3">{EVENT_TYPE_LABEL[e.type]}</span>
                  <span className="text-[13px] leading-snug text-ink">{summarize(e)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function hookStep(e: ChannelEvent): ToolStep {
  if (e.type === "tool.call")
    return {
      icon: e.payload.tool === "Bash" ? "run" : e.payload.tool === "Read" || e.payload.tool === "Grep" ? "read" : "write",
      label: e.payload.tool,
      chip: e.payload.arg,
      mono: true,
      detailMono: true,
      // A hook-captured call has no duration or output; only the Tool Capture's do.
      detail: [
        { text: `${e.payload.ok ? "ok" : "failed"}${e.payload.durationMs === undefined ? "" : ` in ${e.payload.durationMs} ms`}` },
        ...(e.payload.output ? [{ text: e.payload.output }] : []),
      ],
    };
  if (e.type === "file.edit")
    return {
      icon: "write",
      label: "File edit",
      chip: e.payload.path,
      mono: true,
      detailMono: true,
      detail: [{ text: `+${e.payload.additions} -${e.payload.deletions}`, tone: "add" }],
    };
  if (e.type === "command")
    // Claude Code does not report a shell command's exit code; Codex does.
    return {
      icon: "run",
      label: "Command",
      chip: e.payload.command,
      mono: true,
      detailMono: true,
      detail: e.payload.exitCode === undefined ? [] : [{ text: `exit ${e.payload.exitCode}` }],
    };
  // The chip already says it all: the row does not open (a cut chip shows its full text itself).
  return { icon: "think", label: EVENT_TYPE_LABEL[e.type], chip: summarize(e), mono: false, detailMono: false, detail: [] };
}

function ProxyCard({ event }: { event: ChannelEvent }) {
  if (event.type !== "proxy.digest" && event.type !== "proxy.raw") return null;
  const p = event.payload;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11.5px] text-ink-3">
        <span>{p.model}</span>
        <span className="tabular-nums">
          {compact(p.inputTokens)} in · {compact(p.outputTokens)} out
        </span>
      </div>
      <p className="text-[13px] leading-relaxed text-ink">{p.reply}</p>
      {p.toolCalls.length > 0 && (
        <ToolChips
          animate={false}
          steps={toolSteps(p.toolCalls)}
          diffs={[]}
          labels={{ header: `${p.toolCalls.length} tool ${p.toolCalls.length === 1 ? "call" : "calls"} in the reply`, more: "" }}
        />
      )}
      {event.type === "proxy.raw" && (
        <pre className="max-h-40 overflow-auto rounded-lg bg-inset p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
          {event.payload.context}
        </pre>
      )}
      {p.maskedSecrets > 0 && <p className="text-[12px] text-ink-3">{p.maskedSecrets} secret masked</p>}
    </div>
  );
}
