import type { Agent } from "@shared/index";
import { duration, isStale } from "@/lib/usage";
import { cn } from "@/lib/utils";
import { useNow } from "./usage";

/**
 * How full the Agent's context window is (ADR 0012), as design.md's figure block: the
 * percent at the figure step, the tokens behind it, and an ink meter. A high reading is a
 * number, not a colour. `compact` is a table cell: the figure and a 56px meter.
 */
export function ContextWindow({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  const now = useNow();
  const c = agent.context;
  const percent = c?.tokens !== undefined && c.window ? (c.tokens / c.window) * 100 : undefined;
  const stale = c !== undefined && isStale(c.readAt, now);
  const meter = (className: string) =>
    percent !== undefined && (
      <span
        role="meter"
        aria-label="Context window fullness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, percent)}
        aria-valuetext={`${Math.round(percent)}%`}
        className={cn("block h-1 bg-rule", className)}
      >
        <span className="block h-full bg-ink-2" style={{ width: `${Math.min(100, percent)}%` }} />
      </span>
    );
  if (compact)
    return (
      <span className="inline-flex items-center gap-2 tabular-nums">
        {percent === undefined ? <span className="text-ink-3">-</span> : `${Math.round(percent)}%`}
        {meter("w-14 max-[900px]:hidden")}
      </span>
    );
  return (
    <section aria-label="Context window" className="flex min-w-0 flex-col gap-1">
      <span className={cn("tabular-nums", percent === undefined ? "text-row text-ink-3" : "text-figure font-semibold text-ink")}>
        {percent === undefined ? "Unavailable" : `${Math.round(percent)}%`}
      </span>
      <span className="text-small text-ink-3 tabular-nums">
        {[
          c?.tokens !== undefined && `${compactTokens(c.tokens)} of ${c.window ? compactTokens(c.window) : "unknown"} tokens`,
          c?.autoCompactions !== undefined && `${c.autoCompactions} auto-compaction${c.autoCompactions === 1 ? "" : "s"}`,
          percent !== undefined && percent > 80 && "Over 80%, compaction is near",
          stale && "Stale",
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      {meter("mt-2 w-full")}
    </section>
  );
}

/** 420000 as 420k, 1000000 as 1M. */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function AgentBrief({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  const now = useNow();
  const c = agent.context;
  const ran = `${agent.presence === "gone" ? "Ran" : "Running"} ${duration((agent.presence === "gone" ? Date.parse(agent.lastSeenAt) : now) - Date.parse(agent.startedAt))}`;
  return (
    <section aria-label="What this Agent is doing" className="flex min-w-0 flex-col gap-1.5 text-small text-ink-3">
      <p className={cn("break-words", c?.task ? (compact ? "text-body text-ink" : "text-lead font-medium text-ink") : "text-body text-ink-3")}>
        {c?.task ?? "Brief unavailable"}
      </p>
      {c?.brief && (
        <details onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <summary className="w-fit cursor-pointer text-ink underline-offset-4 hover:underline">Show brief</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-hover p-3 font-sans text-small whitespace-pre-wrap break-words text-ink-2">{c.brief}</pre>
        </details>
      )}
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        {c?.activity && <span className="break-words text-ink-2">{c.activity}</span>}
        <span className="tabular-nums">{ran}</span>
        {c?.model && c.model !== agent.model && <span>{c.model}</span>}
      </p>
      {(c?.cwd || c?.branch) && (
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          {c?.cwd && <code className="break-all font-mono" title={c.cwd}>{c.cwd}</code> /* taste-skill-ignore: a path */}
          {c?.branch && <code className="break-all font-mono">{c.branch}</code> /* taste-skill-ignore: a branch name */}
        </p>
      )}
    </section>
  );
}
