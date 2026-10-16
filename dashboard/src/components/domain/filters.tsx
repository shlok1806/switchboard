import type { ChannelEvent, Verdict, VerdictOption } from "@shared/index";
import { actorPerson } from "@/lib/format";
import { ChevronDown } from "lucide-react";
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
  /** `short` names the picked option on the chip when the menu's label is long. */
  options: { value: string; label: string; short?: string }[];
  allLabel: string;
}) {
  const on = value !== "";
  const picked = options.find((o) => o.value === value);
  return (
    <label
      className={cn(
        "relative inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[var(--r)] border pr-6 pl-2 text-label font-medium transition-colors duration-[var(--dur)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
        on ? "border-ink text-ink" : "border-rule text-ink-2 hover:border-ink-3 hover:text-ink",
      )}
    >
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
      {/* The picked value in full: a chip wraps nothing and cuts nothing. */}
      <span className="whitespace-nowrap">{on ? (picked?.short ?? picked?.label ?? value) : label}</span>
      <ChevronDown className="pointer-events-none absolute right-1.5 size-3.5 text-ink-3" aria-hidden />
    </label>
  );
}
