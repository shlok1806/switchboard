import type { Agent } from "@shared/index";
import { duration, isStale } from "@/lib/usage";
import { useNow } from "./usage";

export function ContextWindow({ agent }: { agent: Agent }) {
  const now = useNow();
  const c = agent.context;
  const percent = c?.tokens !== undefined && c.window ? c.tokens / c.window * 100 : undefined;
  const tone = percent === undefined ? "text-ink-3" : percent > 80 ? "text-red" : percent >= 50 ? "text-orange" : "text-green";
  const bar = percent !== undefined && percent > 80 ? "bg-red" : percent !== undefined && percent >= 50 ? "bg-orange" : "bg-green";
  return <section aria-label="Context window" className="flex min-w-0 flex-col gap-1.5">
    <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
      <span className="font-medium text-ink-2">Context window</span>
      {percent !== undefined && percent > 80 && <span className="rounded bg-red/10 px-2 py-0.5 font-medium text-red">Over 80%</span>}
    </div>
    <span className={`font-mono text-[15px] font-medium tabular-nums ${tone}`}>
      {percent === undefined ? "Unavailable" : `${percent.toFixed(1)}%`}
    </span>
    <span className="text-[11.5px] tabular-nums text-ink-3">{c?.tokens === undefined ? "No context reading yet" : `${c.tokens.toLocaleString()} / ${c.window?.toLocaleString() ?? "unknown"} tokens`}</span>
    {percent !== undefined && <div role="meter" aria-label="Context window fullness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, percent)} aria-valuetext={`${percent.toFixed(1)}%`} className="h-1.5 overflow-hidden rounded-full bg-inset"><div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.min(100, percent)}%` }} /></div>}
    <span className="text-[11.5px] text-ink-3">{c?.autoCompactions === undefined ? "Auto-compactions unavailable" : `${c.autoCompactions} auto-compactions`}{c && isStale(c.readAt, now) ? " · Stale" : ""}</span>
  </section>;
}

export function AgentBrief({ agent }: { agent: Agent }) {
  const now = useNow();
  const c = agent.context;
  return <section aria-label="What this Agent is doing" className="flex min-w-0 flex-col gap-1.5 text-[12px] text-ink-3">
    <p className="break-words text-[13px] font-medium text-ink">{c?.task ?? "Brief unavailable"}</p>
    {c?.brief && <details onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}><summary className="cursor-pointer text-accent-ink">Show brief</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-3 font-sans text-[12px] text-ink-2">{c.brief}</pre></details>}
    {c?.activity && <p className="break-words text-ink-2">{c.activity}</p>}
    <span>{agent.presence === "gone" ? "Ran" : "Running"} {duration((agent.presence === "gone" ? Date.parse(agent.lastSeenAt) : now) - Date.parse(agent.startedAt))}</span>
    {c?.cwd && <span className="break-all font-mono" title={c.cwd}>{c.cwd}</span>}
    {c?.branch && <span className="break-all font-mono">{c.branch}</span>}
    {c?.model && c.model !== agent.model && <span>{c.model}</span>}
  </section>;
}
