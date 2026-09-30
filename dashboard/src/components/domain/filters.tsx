import type { ChannelEvent, Verdict, VerdictOption } from "@shared/index";
import { actorPerson } from "@/lib/format";
import { PixelIcon } from "@/components/pixel-icon";
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
  // A Motif option menu: a raised button with the choice and a bar-and-arrow glyph.
  return (
    <label
      className={cn(
        "btn-motif relative h-[26px] shrink-0 justify-start gap-1 pr-6 pl-2 text-[12px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-[hsl(var(--ring))] coarse:h-9",
        on && "[border-color:hsl(var(--bevel-dark))_hsl(var(--bevel-light))_hsl(var(--bevel-light))_hsl(var(--bevel-dark))] bg-muted",
      )}
    >
      <span className="text-muted-foreground">{label}</span>
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
      <span className={cn("max-w-[10rem] truncate", on ? "font-bold text-accent-ink" : "font-semibold")}>
        {on ? options.find((o) => o.value === value)?.label ?? value : "All"}
      </span>
      <PixelIcon name="down" className="pointer-events-none absolute right-1" />
    </label>
  );
}
