/*
 * What the Relay decided for each Agent about one Event: the decision in words, Jev's three
 * probabilities as one meter with the threshold an Interrupt must clear, the overlap that
 * made it ask, and anything that changed the delivery on the way.
 */
import type { AgentId, Verdict, VerdictOption } from "@shared/index";
import { DOWNGRADE_LABEL, VERDICT_LABEL, prob } from "@/lib/format";
import { cn } from "@/lib/utils";
import { HolderLabel } from "./task";

const ORDER: VerdictOption[] = ["interrupt", "queue", "drop"];
const FILL: Record<VerdictOption, string> = {
  interrupt: "bg-ink",
  queue: "bg-ink-3",
  drop: "bg-rule-2",
};

/**
 * Jev's three probabilities as one meter, Interrupt first, with a tick at the threshold an
 * Interrupt must clear. The figures sit under it so they read without hovering.
 */
export function VerdictBar({ verdict, threshold, className }: { verdict: Verdict; threshold: number; className?: string }) {
  const p = verdict.probabilities;
  if (!p) {
    return <p className={cn("text-small text-ink-3", className)}>{verdict.source === "fallback" ? "Jev did not answer, so it was Queued." : "No overlap, so Jev was not asked."}</p>;
  }
  const top = ORDER.reduce((a, b) => (p[b] > p[a] ? b : a));
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="relative h-1 w-full bg-rule" role="img" aria-label={`${ORDER.map((o) => `${VERDICT_LABEL[o]} ${prob(p[o])}`).join(", ")}. An Interrupt needs ${prob(threshold)}.`}>
        <div className="flex h-full w-full gap-px">
          {ORDER.map((o) => (
            <span key={o} className={cn("h-full", FILL[o])} style={{ width: `${p[o] * 100}%` }} />
          ))}
        </div>
        <span aria-hidden className="absolute -top-1 -bottom-1 w-px bg-ink" style={{ left: `${threshold * 100}%` }} />
      </div>
      <p className="flex flex-wrap gap-x-3 text-small tabular-nums">
        {ORDER.map((o) => (
          <span key={o} className={o === top ? "text-ink" : "text-ink-3"}>
            {VERDICT_LABEL[o]} {prob(p[o])}
          </span>
        ))}
      </p>
    </div>
  );
}

/** Every Verdict for one Event: which Agent, what it decided, and why. */
export function VerdictTable({
  verdicts,
  threshold,
  woken = new Set(),
}: {
  verdicts: Verdict[];
  threshold: number;
  /** The Agents whose Queue Verdict on this Event a Wake delivered. */
  woken?: ReadonlySet<AgentId>;
}) {
  if (!verdicts.length) return <p className="text-small text-ink-3">No Agent was asked.</p>;
  const sorted = [...verdicts].sort((a, b) => ORDER.indexOf(a.option) - ORDER.indexOf(b.option) || (a.source === "jev" ? -1 : 1));
  return (
    <ul>
      {sorted.map((v) => (
        <li key={v.agent} className="flex flex-col gap-1.5 border-b border-rule py-2.5">
          <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-row">
            <HolderLabel holder={{ kind: "agent", agentId: v.agent }} />
            <span className="text-small tabular-nums">
              <span className={cn("font-semibold", v.option === "drop" ? "text-ink-2" : "text-ink")}>{VERDICT_LABEL[v.option]}</span>
              {v.latencyMs !== undefined && <span className="text-ink-3"> · {v.latencyMs} ms</span>}
            </span>
          </p>
          <VerdictBar verdict={v} threshold={threshold} />
          {(v.overlap.files.length > 0 || v.overlap.symbols.length > 0) && (
            <p className="text-small [overflow-wrap:anywhere] text-ink-3">
              Overlaps <code className="text-ink-2">{[...v.overlap.symbols, ...v.overlap.files].join(", ")}</code>
            </p>
          )}
          {v.downgraded && <p className="text-small text-ink">Queued instead: {DOWNGRADE_LABEL[v.downgraded.reason]}.</p>}
          {v.delivered === "queue" && woken.has(v.agent) && <p className="text-small text-ink">Delivered by a Wake: the Agent was idle.</p>}
        </li>
      ))}
    </ul>
  );
}
