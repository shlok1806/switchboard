import type { Agent, AgentId, Verdict, VerdictOption } from "@shared/index";
import { AlarmClock, ArrowDown } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DOWNGRADE_LABEL, VERDICT_LABEL, prob } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentLink, VerdictPill } from "./pills";

const ORDER: VerdictOption[] = ["interrupt", "queue", "drop"];
const FILL: Record<VerdictOption, string> = {
  interrupt: "bg-verdict-interrupt",
  queue: "bg-verdict-queue",
  drop: "bg-verdict-drop",
};

/**
 * Jev's three probabilities as one bar, Interrupt first, with the threshold an
 * Interrupt must clear. The numbers sit under the bar so they read without hovering.
 */
export function VerdictBar({ verdict, threshold, className }: { verdict: Verdict; threshold: number; className?: string }) {
  const p = verdict.probabilities;
  if (!p) {
    return (
      <div className={cn("flex flex-col gap-1", className)}>
        <span className="text-[12px] text-ink-3">
          {verdict.source === "fallback" ? "Jev did not answer: Queued" : "No overlap: not asked"}
        </span>
      </div>
    );
  }
  const top = ORDER.reduce((a, b) => (p[b] > p[a] ? b : a));
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="relative flex h-2 w-full overflow-visible rounded-full bg-hover-2"
            role="img"
            aria-label={ORDER.map((o) => `${VERDICT_LABEL[o]} ${prob(p[o])}`).join(", ")}
          >
            <div className="flex h-full w-full gap-px overflow-hidden rounded-full">
              {ORDER.map((o) => (
                <span
                  key={o}
                  className={cn("h-full", FILL[o])}
                  style={{ width: `${p[o] * 100}%` }}
                />
              ))}
            </div>
            <span
              aria-hidden
              className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-ink-2"
              style={{ left: `${threshold * 100}%` }}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {ORDER.map((o) => `${VERDICT_LABEL[o]} ${prob(p[o])}`).join(" · ")}. Interrupt needs {prob(threshold)}.
        </TooltipContent>
      </Tooltip>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11.5px] tabular-nums">
        {ORDER.map((o) => (
          <span key={o} className={cn("inline-flex items-center gap-1", o === top ? "text-ink" : "text-ink-3")}>
            <span aria-hidden className={cn("size-1.5 rounded-full", FILL[o])} />
            <span className="sr-only">{VERDICT_LABEL[o]}</span>
            {prob(p[o])}
          </span>
        ))}
      </div>
    </div>
  );
}

export function DowngradeNote({ verdict }: { verdict: Verdict }) {
  if (!verdict.downgraded) return null;
  const why = DOWNGRADE_LABEL[verdict.downgraded.reason];
  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-orange-tint px-2 py-0.5 text-[12px] text-orange">
      <ArrowDown className="size-3" aria-hidden />
      Downgraded: {why}
    </span>
  );
}

/** A Queue that did not wait for the next turn: the Agent was idle, and its wrapper woke it with it. */
function WokeNote() {
  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-accent-tint px-2 py-0.5 text-[12px] text-accent-ink">
      <AlarmClock className="size-3" aria-hidden />
      Delivered by a Wake: the Agent was idle
    </span>
  );
}

/** Every Verdict for one Event: which Agent, what it decided, and why. */
export function VerdictTable({
  verdicts,
  agentById,
  threshold,
  woken = new Set(),
}: {
  verdicts: Verdict[];
  agentById: Map<AgentId, Agent>;
  threshold: number;
  /** The Agents whose Queue Verdict on this Event a Wake delivered. */
  woken?: ReadonlySet<AgentId>;
}) {
  if (!verdicts.length) {
    return <p className="text-[13px] text-ink-3">No Agent was asked.</p>;
  }
  const sorted = [...verdicts].sort(
    (a, b) => ORDER.indexOf(a.option) - ORDER.indexOf(b.option) || (a.source === "jev" ? -1 : 1),
  );
  return (
    <ul className="@container flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {sorted.map((v) => (
        <li key={v.agent} className="grid gap-2 px-3 py-2.5 @xl:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] @xl:gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <AgentLink id={v.agent} agent={agentById.get(v.agent as AgentId)} />
            <div className="flex flex-wrap items-center gap-1.5">
              <VerdictPill option={v.option} />
              {v.latencyMs !== undefined && (
                <span className="font-mono text-[11.5px] text-ink-3 tabular-nums">{v.latencyMs} ms</span>
              )}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <VerdictBar verdict={v} threshold={threshold} />
            {(v.overlap.files.length > 0 || v.overlap.symbols.length > 0) && (
              <div className="flex flex-wrap items-center gap-1 text-[11.5px]" aria-label="Overlap">
                {v.overlap.symbols.map((s) => (
                  <code key={s} className="rounded bg-orange-tint px-1.5 py-px font-mono text-orange">{s}</code>
                ))}
                {v.overlap.files.map((f) => (
                  <code key={f} className="rounded bg-hover px-1.5 py-px font-mono text-ink-2">{f}</code>
                ))}
              </div>
            )}
            <DowngradeNote verdict={v} />
            {v.delivered === "queue" && woken.has(v.agent) && <WokeNote />}
          </div>
        </li>
      ))}
    </ul>
  );
}
