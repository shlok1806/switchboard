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
  const moment = moments.find((m) => m.turn === turn) ?? moments[0];

  if (!can.captures && moments.length === 0) {
    return (
      <Pending title="Nothing to compare yet" className="h-full">
        Proxy, Hook and Tool Captures of the same model turn show side by side here once Hook Capture (
        <IssueLink capability="captures" />) and Proxy Capture (<IssueLink capability="proxyMode" />) land.
      </Pending>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <nav
        aria-label="Moments"
        className="no-scrollbar flex shrink-0 gap-[2px] overflow-x-auto border-b border-border bg-secondary p-1.5 lg:w-72 lg:flex-col lg:gap-0 lg:overflow-y-auto lg:border-r lg:border-b-0 lg:bg-card lg:p-0"
      >
        <p className="hidden border-b border-border bg-secondary px-3 py-2 text-[12px] text-muted-foreground lg:block">
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
                "flex shrink-0 flex-col gap-1 px-2.5 py-1.5 text-left lg:shrink lg:border-b lg:border-line-soft",
                // Chosen the way the site's file manager chooses: the row inverts. On a phone each moment is a push button.
                on
                  ? "bevel-in bg-muted lg:border-x-0 lg:border-t-0 lg:bg-primary lg:text-primary-foreground lg:[&_*]:!text-primary-foreground"
                  : "bevel-out bg-secondary hover:bg-hover lg:border-x-0 lg:border-t-0 lg:bg-transparent",
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
                      className={cn("h-1.5 w-3 border border-current", caps.has(c) ? "bg-current" : "bg-transparent opacity-40")}
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
            <p className="font-mono text-[13px] text-ink-2">
              Waiting for the first model turn<span aria-hidden className="caret-blink ml-0.5 inline-block h-[1em] w-[0.55em] translate-y-[2px] bg-accent-ink" />
            </p>
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
    // Three document windows side by side, each with its own title bar.
    <section className="bevel-out flex min-w-0 flex-col bg-secondary">
      <header className="flex flex-col gap-0.5">
        <h2 className="titlebar-active flex h-[22px] items-center gap-2 px-2 text-[12px] font-bold">
          {CAPTURE_LABEL[capture]}
          <span className="font-mono text-[11px] font-normal">{events.length} {events.length === 1 ? "Event" : "Events"}</span>
          {events.some((e) => e.type === "proxy.raw") && <RawBadge />}
        </h2>
        <p className="px-2 pb-1 text-[11.5px] text-muted-foreground">{WHAT[capture]}</p>
      </header>
      <div className="bevel-in m-[3px] mt-0 flex flex-1 flex-col gap-3 bg-card p-3 text-card-foreground">
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
                  className="bevel-out flex w-full flex-col gap-0.5 bg-secondary px-2.5 py-1.5 text-left text-secondary-foreground active:bevel-in"
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
      <p className="font-mono text-[12px] leading-relaxed text-ink">{p.reply}</p>
      {p.toolCalls.length > 0 && (
        <ToolChips
          animate={false}
          steps={toolSteps(p.toolCalls)}
          diffs={[]}
          labels={{ header: `${p.toolCalls.length} tool ${p.toolCalls.length === 1 ? "call" : "calls"} in the reply`, more: "" }}
        />
      )}
      {event.type === "proxy.raw" && (
        <pre className="bevel-in max-h-40 overflow-auto bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
          {event.payload.context}
        </pre>
      )}
      {p.maskedSecrets > 0 && <p className="text-[11px] text-ink-3">{p.maskedSecrets} secret masked</p>}
    </div>
  );
}
