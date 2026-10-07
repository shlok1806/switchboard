// Usage (ADR 0011): an account's limits as Claude Code's `/usage` reports them, the
// Agents running on each account and what each used.

import { useEffect, useState } from "react";
import { ChevronDown, Gauge } from "lucide-react";
import type { Agent, LimitsReading, SessionUsage, UsageLimit } from "@shared/index";
import { modelLabel } from "@shared/index";
import { useChannel } from "@/data/store";
import { ago, compact } from "@/lib/format";
import { href } from "@/lib/router";
import {
  type AccountCard,
  accountCards,
  dollars,
  duration,
  isStale,
  limitsFor,
  type MeterTone,
  meterTone,
  resetText,
  sessionHistory,
} from "@/lib/usage";
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

const BAR: Record<MeterTone, string> = { green: "bg-green", amber: "bg-orange", red: "bg-red" };
const TEXT: Record<MeterTone, string> = { green: "text-green", amber: "text-orange", red: "text-red" };

/** One limit as a labelled bar: green under 70%, amber to 90%, red over. */
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
        <span className={cn("truncate text-ink-2", small ? "text-[11.5px]" : "text-[12.5px]")}>{label}</span>
        <span className={cn("shrink-0 font-medium tabular-nums", TEXT[tone], small ? "text-[11.5px]" : "text-[13px]")}>
          {Math.round(limit.percent)}%
        </span>
      </div>
      <div
        className={cn("overflow-hidden rounded-full bg-inset", small ? "h-1" : "h-1.5")}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={limit.percent}
      >
        <div className={cn("h-full rounded-full", BAR[tone])} style={{ width: `${width}%` }} />
      </div>
      {reset && !small && <span className="truncate text-[11.5px] text-ink-3">{reset}</span>}
    </div>
  );
}

/** The session percent over the window, as a small line. */
export function Sparkline({ points, className }: { points: { at: number; percent: number }[]; className?: string }) {
  if (points.length < 2) return null;
  const w = 120;
  const h = 28;
  const first = points[0].at;
  const span = Math.max(1, points[points.length - 1].at - first);
  // The y axis spans the points' own range, at least 10 points wide, so a slow climb still shows.
  const values = points.map((p) => Math.min(100, p.percent));
  const low = Math.max(0, Math.min(...values) - 5);
  const high = Math.min(100, Math.max(low + 10, Math.max(...values) + 5));
  const xy = points.map((p, i) => `${((p.at - first) / span) * w},${h - 1 - ((values[i] - low) / (high - low)) * (h - 2)}`);
  const tone = meterTone(points[points.length - 1].percent);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn("h-7 w-[120px]", TEXT[tone], className)} role="img" aria-label="Session percent over this window">
      <polyline points={xy.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

function StaleLabel({ readAt, now }: { readAt: string; now: number }) {
  return (
    <span className="inline-flex h-5 items-center rounded-full bg-inset px-2 text-[11px] font-medium text-ink-3">
      Stale · read {ago(readAt, now)}
    </span>
  );
}

/** Every limit `/usage` reported: the session, the week and each model's week. */
function Limits({ limits, now, stale }: { limits: LimitsReading; now: number; stale: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {limits.session && <Meter label="Session" limit={limits.session} now={now} stale={stale} />}
      {limits.week && <Meter label="Week (all models)" limit={limits.week} now={now} stale={stale} />}
      {limits.models.map((m) => (
        <Meter key={m.model} label={`Week (${m.model})`} limit={m} now={now} stale={stale} />
      ))}
    </div>
  );
}

function tokens(s: SessionUsage): string {
  return `${compact(s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens)} in · ${compact(s.outputTokens)} out`;
}

function Used({ session }: { session?: SessionUsage }) {
  if (!session) return <span className="text-ink-4">No usage yet</span>;
  return (
    <span className="tabular-nums" title={`${session.inputTokens} input, ${session.cacheReadTokens} cache read, ${session.cacheWriteTokens} cache write, ${session.outputTokens} output tokens`}>
      {session.requests} {session.requests === 1 ? "request" : "requests"} · {tokens(session)}
      {session.costUsd !== undefined && ` · ${dollars(session.costUsd)}`}
    </span>
  );
}

const SHARE_COLOURS = ["bg-accent", "bg-green", "bg-orange", "bg-ink-3", "bg-red"];

export function AccountCardView({ card, now }: { card: AccountCard; now: number }) {
  const stale = card.limits !== undefined && isStale(card.limits.readAt, now);
  const history = sessionHistory(card, now);
  const shared = card.agents.filter((a) => a.share > 0);
  return (
    <article className="flex min-w-[300px] flex-1 flex-col gap-3 rounded-xl border border-line bg-surface p-4" aria-label={`Account ${card.email}`}>
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-[13px] break-all text-ink">{card.email}</span>
          <span className="text-[12px] text-ink-3">
            {card.plan ? `${card.plan[0].toUpperCase()}${card.plan.slice(1)} plan` : "Plan unknown"}
            {card.limits && ` · read ${ago(card.limits.readAt, now)}`}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {stale && card.limits && <StaleLabel readAt={card.limits.readAt} now={now} />}
          <Sparkline points={history} />
        </div>
      </header>

      {card.limits ? (
        <Limits limits={card.limits} now={now} stale={stale} />
      ) : (
        <p className="text-[12.5px] text-ink-3">No limits: /usage reported none for this login.</p>
      )}

      <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[12.5px]">
          <span className="font-medium whitespace-nowrap text-ink">
            {card.agents.length === 0 ? "No Agents running" : `${card.agents.length} ${card.agents.length === 1 ? "Agent" : "Agents"} running`}
          </span>
          {card.agents.length > 0 && (
            <span className="text-ink-3">
              <Used session={card.total} />
            </span>
          )}
        </div>
        {shared.length > 1 && (
          <div className="flex h-1.5 overflow-hidden rounded-full bg-inset" role="img" aria-label="Share of usage by Agent">
            {shared.map((a, i) => (
              <div key={a.agent.id} className={SHARE_COLOURS[i % SHARE_COLOURS.length]} style={{ width: `${a.share * 100}%` }} />
            ))}
          </div>
        )}
        <ul className="flex flex-col gap-1.5">
          {card.agents.map((a, i) => (
            <li key={a.agent.id} className="flex min-w-0 flex-col text-[12.5px]">
              <span className="flex min-w-0 items-center gap-1.5">
                {shared.length > 1 && a.share > 0 && (
                  <span className={cn("size-2 shrink-0 rounded-full", SHARE_COLOURS[shared.indexOf(a) % SHARE_COLOURS.length])} aria-hidden />
                )}
                <a href={href({ view: "agent", id: a.agent.id })} className="truncate text-ink hover:text-accent-ink" title={a.agent.id}>
                  {a.agent.nickname ?? a.agent.id}
                </a>
                <span className="shrink-0 text-ink-3">
                  {a.agent.model ? `${modelLabel(a.agent.model)} · ` : ""}
                  {duration(now - Date.parse(a.agent.startedAt))}
                  {card.agents.length > 1 && ` · ${Math.round(a.share * 100)}%`}
                </span>
              </span>
              <span className={cn("truncate text-ink-3", i === 0 && "")}>
                <Used session={a.session} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

const COLLAPSED_KEY = "switchboard.accounts.collapsed";

/** The Accounts panel: one card per account, at the top of the Channel's views. */
export function AccountsPanel() {
  const { accounts, agents } = useChannel();
  const now = useNow();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  const cards = accountCards(accounts, agents);
  if (cards.length === 0) return null;
  const toggle = () => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "0" : "1");
    setCollapsed(!collapsed);
  };
  return (
    <section className="shrink-0 border-b border-line bg-page" aria-label="Accounts">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex h-9 w-full items-center gap-2 px-4 text-left text-[13px] sm:px-6"
      >
        <Gauge className="size-3.5 text-ink-3" aria-hidden />
        <span className="font-medium text-ink">Accounts</span>
        {collapsed && (
          <span className="flex min-w-0 items-center gap-3 truncate text-ink-3">
            {cards.map((c) => (
              <span key={c.email} className="truncate">
                {c.email}
                {c.limits?.session && (
                  <span className={TEXT[meterTone(c.limits.session.percent)]}> {Math.round(c.limits.session.percent)}%</span>
                )}
              </span>
            ))}
          </span>
        )}
        <ChevronDown className={cn("ml-auto size-4 text-ink-3 transition-transform", collapsed && "-rotate-90")} aria-hidden />
      </button>
      {!collapsed && (
        <div className="flex max-h-[45vh] flex-wrap gap-3 overflow-y-auto px-4 pb-3 sm:px-6">
          {cards.map((c) => (
            <AccountCardView key={c.email} card={c} now={now} />
          ))}
        </div>
      )}
    </section>
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
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[12px] text-ink-3">
        {usage.email && <span className="truncate font-mono text-ink-2">{usage.email}</span>}
        <Used session={usage.session} />
        {stale && limits && <StaleLabel readAt={limits.readAt} now={now} />}
      </span>
      {limits && (limits.session || limits.week) && (
        <div className={cn("grid gap-3", small ? "max-w-[320px] grid-cols-2" : "sm:grid-cols-2")}>
          {limits.session && <Meter label="Session" limit={limits.session} now={now} stale={stale} compact={small} />}
          {limits.week && <Meter label="Week" limit={limits.week} now={now} stale={stale} compact={small} />}
        </div>
      )}
    </div>
  );
}
