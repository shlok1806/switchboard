import { useMemo } from "react";
import type { Capture, ChannelEvent } from "@shared/index";
import { useChannel, useIndex } from "@/data/store";
import ToolChips, { type ToolStep } from "@/components/primitives/ToolChips";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { AgentLink, RawBadge, TaskLink } from "@/components/domain/pills";
import { toolSteps } from "@/components/domain/event";
import { CAPTURE_LABEL, EVENT_TYPE_LABEL, ago, clock, compact, summarize } from "@/lib/format";
import { go, href } from "@/lib/router";
import { cn } from "@/lib/utils";

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
  const moment = moments.find((m) => m.turn === turn) ?? moments[0];

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <nav
        aria-label="Moments"
        className="no-scrollbar flex shrink-0 gap-1.5 overflow-x-auto border-b border-line p-2 lg:w-72 lg:flex-col lg:overflow-y-auto lg:border-r lg:border-b-0"
      >
        <p className="hidden px-1.5 pt-1 pb-2 text-[12px] text-ink-3 lg:block">
          A moment is one model turn by one Agent. Pick one to see what each Capture recorded.
        </p>
        {moments.map((m) => {
          const on = m.turn === moment?.turn;
          const caps = new Set(m.events.map((e) => e.capture));
          return (
            <a
              key={m.turn}
              href={href({ view: "compare", turn: m.turn })}
              aria-current={on ? "true" : undefined}
              className={cn(
                "flex shrink-0 flex-col gap-1 rounded-control px-2.5 py-2 text-left transition-colors duration-100 lg:shrink",
                on ? "bg-surface shadow-card" : "hover:bg-hover",
              )}
            >
              <span className="truncate font-mono text-[12px] text-ink">{m.agent}</span>
              <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
                <span className="tabular-nums">{clock(m.at)}</span>
                {m.task && <span className="font-mono">#{m.task}</span>}
                <span className="flex gap-0.5">
                  {CAPTURES.map((c) => (
                    <span
                      key={c}
                      title={CAPTURE_LABEL[c]}
                      className={cn("h-1.5 w-3 rounded-full", caps.has(c) ? "bg-accent" : "bg-line")}
                    />
                  ))}
                </span>
              </span>
            </a>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!moment ? (
          <div className="flex h-full items-center justify-center p-6">
            <TextShimmer className="text-[13px]">Waiting for the first model turn</TextShimmer>
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-3 sm:p-5">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <AgentLink id={moment.agent} agent={agentById.get(moment.agent as never)} />
              {moment.task && <TaskLink number={moment.task} className="text-[12.5px]" />}
              <span className="font-mono text-[11.5px] text-ink-3">
                {clock(moment.at)} · {ago(moment.at)}
              </span>
            </header>
            <div className="grid gap-3 md:grid-cols-3">
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
    <section className="flex min-w-0 flex-col overflow-hidden rounded-card bg-surface shadow-card">
      <header className="flex flex-col gap-0.5 border-b border-line px-3 py-2.5">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
          {CAPTURE_LABEL[capture]}
          <span className="font-mono text-[11px] font-normal text-ink-3">{events.length} {events.length === 1 ? "Event" : "Events"}</span>
          {events.some((e) => e.type === "proxy.raw") && <RawBadge />}
        </h2>
        <p className="text-[11.5px] text-ink-3">{WHAT[capture]}</p>
      </header>
      <div className="flex flex-col gap-3 p-3">
        {events.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">Nothing from this Capture for this moment.</p>
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
            labels={{ header: `${events.length} Hook Events`, more: "" }}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {events.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => go({ view: "feed", event: e.id })}
                  className="flex w-full flex-col gap-0.5 rounded-control bg-inset px-2.5 py-2 text-left hover:bg-hover"
                >
                  <span className="label-mono !text-[10px]">{EVENT_TYPE_LABEL[e.type]}</span>
                  <span className="text-[12.5px] leading-snug text-ink">{summarize(e)}</span>
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
      detail: [{ text: `${e.payload.ok ? "ok" : "failed"} in ${e.payload.durationMs} ms` }, ...(e.payload.output ? [{ text: e.payload.output }] : [])],
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
    return { icon: "run", label: "Command", chip: e.payload.command, mono: true, detailMono: true, detail: [{ text: `exit ${e.payload.exitCode}` }] };
  return { icon: "think", label: EVENT_TYPE_LABEL[e.type], chip: summarize(e), mono: false, detailMono: false, detail: [{ text: summarize(e) }] };
}

function ProxyCard({ event }: { event: ChannelEvent }) {
  if (event.type !== "proxy.digest" && event.type !== "proxy.raw") return null;
  const p = event.payload;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-ink-3">
        <span>{p.model}</span>
        <span className="tabular-nums">
          {compact(p.inputTokens)} in · {compact(p.outputTokens)} out
        </span>
      </div>
      <p className="text-[12.5px] leading-relaxed text-ink">{p.reply}</p>
      {p.toolCalls.length > 0 && (
        <ToolChips
          animate={false}
          steps={toolSteps(p.toolCalls)}
          diffs={[]}
          labels={{ header: `${p.toolCalls.length} tool ${p.toolCalls.length === 1 ? "call" : "calls"} in the reply`, more: "" }}
        />
      )}
      {event.type === "proxy.raw" && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-control bg-inset p-2 font-mono text-[11px] leading-relaxed text-ink-2">
          {event.payload.context}
        </pre>
      )}
      {p.maskedSecrets > 0 && <p className="text-[11px] text-ink-3">{p.maskedSecrets} secret masked</p>}
    </div>
  );
}
