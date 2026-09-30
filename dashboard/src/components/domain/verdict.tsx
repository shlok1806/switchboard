import type { Agent, AgentId, Verdict, VerdictOption } from "@shared/index";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VERDICT_LABEL, prob } from "@/lib/format";
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
        <div className="h-2 border border-dashed border-line-strong" />
        <span className="text-[11px] text-ink-3">
          {verdict.source === "fallback"
            ? "Jev gave no answer, so it was Queued."
            : "No overlap. Dropped without asking Jev."}
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
            className="relative flex h-2 w-full overflow-visible bg-inset"
            role="img"
            aria-label={ORDER.map((o) => `${VERDICT_LABEL[o]} ${prob(p[o])}`).join(", ")}
          >
            <div className="flex h-full w-full overflow-hidden">
              {ORDER.map((o) => (
                <span
                  key={o}
                  className={cn("h-full transition-[width] duration-300", FILL[o])}
                  style={{ width: `${p[o] * 100}%`, boxShadow: "inset -1px 0 0 var(--surface)" }}
                />
              ))}
            </div>
            <span
              aria-hidden
              className="absolute -top-1 -bottom-1 w-px bg-ink"
              style={{ left: `${threshold * 100}%` }}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          Interrupt needs at least {prob(threshold)}. Below that it becomes Queue.
        </TooltipContent>
      </Tooltip>
      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[11px] tabular-nums">
        {ORDER.map((o) => (
          <span key={o} className={cn("inline-flex items-center gap-1", o === top ? "text-ink" : "text-ink-3")}>
            <span aria-hidden className={cn("size-1.5", FILL[o])} />
            {VERDICT_LABEL[o]} <b className={o === top ? "font-semibold" : "font-normal"}>{prob(p[o])}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export function DowngradeNote({ verdict }: { verdict: Verdict }) {
  if (!verdict.downgraded) return null;
  const why =
    verdict.downgraded.reason === "below-threshold"
      ? "Interrupt was below the threshold"
      : "this CLI cannot receive Interrupts";
  return (
    <span className="inline-flex items-center gap-1 bg-orange-tint px-1.5 py-0.5 text-[11px] text-orange">
      Downgraded from Interrupt: {why}
    </span>
  );
}

/** Every Verdict for one Event: which Agent, what it decided, and why. */
export function VerdictTable({
  verdicts,
  agentById,
  threshold,
}: {
  verdicts: Verdict[];
  agentById: Map<AgentId, Agent>;
  threshold: number;
}) {
  if (!verdicts.length) {
    return <p className="text-[12.5px] text-ink-3">No connected Agent was asked about this Event.</p>;
  }
  const sorted = [...verdicts].sort(
    (a, b) => ORDER.indexOf(a.option) - ORDER.indexOf(b.option) || (a.source === "jev" ? -1 : 1),
  );
  return (
    <ul className="@container bevel-in flex flex-col divide-y divide-line overflow-hidden bg-card">
      {sorted.map((v) => (
        <li key={v.agent} className="grid gap-2 px-3 py-2.5 @xl:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] @xl:gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <AgentLink id={v.agent} agent={agentById.get(v.agent as AgentId)} />
            <div className="flex flex-wrap items-center gap-1.5">
              <VerdictPill option={v.option} />
              {v.latencyMs !== undefined && (
                <span className="font-mono text-[11px] text-ink-3 tabular-nums">{v.latencyMs} ms</span>
              )}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <VerdictBar verdict={v} threshold={threshold} />
            {(v.overlap.files.length > 0 || v.overlap.symbols.length > 0) && (
              <div className="flex flex-wrap items-center gap-1 text-[11px] text-ink-3">
                <span>Overlap</span>
                {v.overlap.symbols.map((s) => (
                  <code key={s} className="bg-orange-tint px-1 font-mono text-orange">{s}</code>
                ))}
                {v.overlap.files.map((f) => (
                  <code key={f} className="bg-inset px-1 font-mono text-ink-2">{f}</code>
                ))}
              </div>
            )}
            <DowngradeNote verdict={v} />
          </div>
        </li>
      ))}
    </ul>
  );
}
