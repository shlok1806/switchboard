import type { ChannelEvent, Verdict, VerdictOption } from "@shared/index";
import { actorPerson } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface FeedFilters {
  person: string;
  agent: string;
  task: string;
  capture: string;
  verdict: string;
}

export const EMPTY_FILTERS: FeedFilters = { person: "", agent: "", task: "", capture: "", verdict: "" };

export function matches(e: ChannelEvent, verdicts: Verdict[], f: FeedFilters): boolean {
  if (f.person && actorPerson(e.actor) !== f.person) return false;
  if (f.agent) {
    const isSender = e.actor.kind === "agent" && e.actor.agentId === f.agent;
    const isTarget = e.type === "directive" && e.payload.to === f.agent;
    if (!isSender && !isTarget) return false;
  }
  if (f.task && String(e.task ?? "") !== f.task) return false;
  if (f.capture) {
    if (f.capture === "none" ? e.capture !== null : e.capture !== f.capture) return false;
  }
  if (f.verdict && !verdicts.some((v) => v.option === (f.verdict as VerdictOption))) return false;
  return true;
}

export function activeCount(f: FeedFilters) {
  return Object.values(f).filter(Boolean).length;
}

/** One filter as a native select: fast, accessible and a real picker on a phone. */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
}) {
  const on = value !== "";
  return (
    <label
      className={cn(
        "relative inline-flex h-7 shrink-0 items-center gap-1 rounded-[6px] border pl-2 pr-6 text-[12px] transition-colors duration-100 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        on ? "border-accent/40 bg-accent-tint text-accent-ink" : "border-line bg-surface text-ink-2 hover:bg-hover",
      )}
    >
      <span className={on ? "text-accent-ink/80" : "text-ink-3"}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Filter by ${label}`}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className={cn("max-w-[10rem] truncate font-medium", on ? "text-accent-ink" : "text-ink")}>
        {on ? options.find((o) => o.value === value)?.label ?? value : "All"}
      </span>
      <svg aria-hidden className="pointer-events-none absolute right-1.5 size-3 text-ink-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </label>
  );
}
