// Usage (ADR 0011): an Agent's account, what it used, and the account's limits as
// Claude Code's `/usage` reports them.

import { useEffect, useState } from "react";
import type { Agent, SessionUsage, UsageLimit } from "@shared/index";
import { useChannel } from "@/data/store";
import { ago, compact } from "@/lib/format";
import { dollars, isStale, limitsFor, meterTone, resetText } from "@/lib/usage";
import { cn } from "@/lib/utils";

/** The time now, again every `everyMs`, for countdowns and staleness. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** One limit as a labelled bar, its tone (green under 70%, amber to 90%, red over) kept as data. */
export function Meter({
  label,
  limit,
  now,
  stale = false,
  compact: small = false,
  timeZone,
}: {
  label: string;
  limit: UsageLimit;
  now: number;
  stale?: boolean;
  compact?: boolean;
  timeZone?: string;
}) {
  const tone = meterTone(limit.percent);
  const reset = resetText(limit, now, timeZone);
  const width = Math.min(100, Math.max(0, limit.percent));
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", stale && "opacity-55")} data-tone={tone} data-stale={stale || undefined}>
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 [overflow-wrap:anywhere] text-small text-ink-2">{label}</span>
        <span className="shrink-0 text-small font-medium text-ink tabular-nums">
          {Math.round(limit.percent)}%
        </span>
      </div>
      <div
        className="h-1 overflow-hidden bg-rule"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={limit.percent}
      >
        {/* A high reading is a number, not a colour (design.md): every tone fills in ink-2. */}
        <div className="h-full bg-ink-2" style={{ width: `${width}%` }} />
      </div>
      {reset && !small && <span className="text-small text-pretty text-ink-3 tabular-nums">{reset}</span>}
    </div>
  );
}

function StaleLabel({ readAt, now }: { readAt: string; now: number }) {
  return (
    <span className="text-small whitespace-nowrap text-ink-3">
      Stale · read {ago(readAt, now)}
    </span>
  );
}

function tokens(s: SessionUsage): string {
  return `${compact(s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens)} in · ${compact(s.outputTokens)} out`;
}

function Used({ session }: { session?: SessionUsage }) {
  if (!session) return <span className="text-ink-3">No usage yet</span>;
  return (
    <span className="tabular-nums" title={`${session.inputTokens} input, ${session.cacheReadTokens} cache read, ${session.cacheWriteTokens} cache write, ${session.outputTokens} output tokens`}>
      {session.requests} {session.requests === 1 ? "request" : "requests"} · {tokens(session)}
      {session.costUsd !== undefined && ` · ${dollars(session.costUsd)}`}
    </span>
  );
}

/** One Agent's usage: its account, its own session and the account's meters. */
export function AgentUsage({ agent, compact: small = false }: { agent: Agent; compact?: boolean }) {
  const { accounts } = useChannel();
  const now = useNow();
  const usage = agent.usage;
  if (!usage) return null;
  const limits = limitsFor(agent, accounts);
  const stale = limits !== undefined && isStale(limits.readAt, now);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-small text-ink-3">
        {(usage.email ?? usage.accountId) && <span className="min-w-0 [overflow-wrap:anywhere] text-ink-2">{usage.email ?? usage.accountId}</span>}
        <Used session={usage.session} />
        {stale && limits && <StaleLabel readAt={limits.readAt} now={now} />}
      </span>
      {limits && (limits.session || limits.week) && (
        <div className={cn("grid gap-x-5 gap-y-3", small ? "max-w-[320px] grid-cols-2" : "sm:grid-cols-2")}>
          {limits.session && <Meter label="5-hour" limit={limits.session} now={now} stale={stale} compact={small} />}
          {limits.week && <Meter label="Week" limit={limits.week} now={now} stale={stale} compact={small} />}
        </div>
      )}
    </div>
  );
}
