import type { Agent } from "@shared/index";
import { duration, isStale } from "@/lib/usage";
import { cn } from "@/lib/utils";
import { useNow } from "./usage";

/**
 * How full the Agent's context window is (ADR 0012): the percent as a figure, the
 * tokens behind it and a bar, green under 50%, amber to 80%, red over. `compact`
 * is the Agents list's version: the same figure and bar, fewer words.
 */
export function ContextWindow({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  const now = useNow();
  const c = agent.context;
  const percent = c?.tokens !== undefined && c.window ? c.tokens / c.window * 100 : undefined;
  const tone = percent === undefined ? "text-ink-3" : percent > 80 ? "text-red" : percent >= 50 ? "text-orange" : "text-green";
  const bar = percent !== undefined && percent > 80 ? "bg-red" : percent !== undefined && percent >= 50 ? "bg-orange" : "bg-green";
  const stale = c !== undefined && isStale(c.readAt, now);
  return (
    <section aria-label="Context window" className={cn("flex min-w-0 flex-col", compact ? "gap-1.5" : "gap-2")}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-small">
        <span className={cn("text-ink-3", compact && "lg:sr-only")}>Context window</span>
        {percent !== undefined && percent > 80 && <span className="rounded-sm bg-red-tint px-2 py-0.5 font-medium text-red">Over 80%</span>}
      </div>
      <span className={cn("font-medium tabular-nums", compact ? "text-lead" : "text-title", percent === undefined ? "text-body font-normal text-ink-3" : tone)}>
        {percent === undefined ? "Unavailable" : `${percent.toFixed(1)}%`}
      </span>
      {percent !== undefined && (
        <div
          role="meter"
          aria-label="Context window fullness"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, percent)}
          aria-valuetext={`${percent.toFixed(1)}%`}
          className="h-1.5 overflow-hidden rounded-full bg-track"
        >
          <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
      )}
      <span className="text-small text-ink-3 tabular-nums">
        {c?.tokens === undefined ? "No context reading yet" : `${c.tokens.toLocaleString()} / ${c.window?.toLocaleString() ?? "unknown"} tokens`}
      </span>
      <span className="text-small text-ink-3 tabular-nums">
        {c?.autoCompactions === undefined ? "Auto-compactions unavailable" : `${c.autoCompactions} auto-compaction${c.autoCompactions === 1 ? "" : "s"}`}
        {stale ? " · Stale" : ""}
      </span>
    </section>
  );
}

/** What the Agent is working on, from its session: the task, its brief, its latest activity and where it runs. */
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
          <summary className="w-fit cursor-pointer text-accent-ink underline-offset-4 hover:underline">Show brief</summary>
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
