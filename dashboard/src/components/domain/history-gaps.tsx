import type { HistoryGap } from "@shared/index";
import { cn } from "@/lib/utils";

/**
 * The history a list could not show: the Local Events of a machine that is away
 * (ADR 0037), such as "offline: history unavailable until shlok/studio is back".
 * Its Updates, Claims and Directives are still in the list.
 */
export function HistoryGaps({ gaps, className }: { gaps: readonly HistoryGap[] | undefined; className?: string }) {
  if (gaps === undefined || gaps.length === 0) return null;
  return (
    <ul aria-label="History not shown" className={cn("flex flex-col gap-0.5 py-2 text-small text-ink-3", className)}>
      {gaps.map((gap) => (
        <li key={`${gap.host ?? ""}:${gap.agents.join(",")}`}>{gap.reason}</li>
      ))}
    </ul>
  );
}
