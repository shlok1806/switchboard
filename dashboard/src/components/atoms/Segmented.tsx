import { ChevronDown } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** A count, set after the word in ink-3. */
  n?: number;
}

/**
 * One choice out of a few (design.md "Segmented control"): the options joined in one bordered
 * control, the picked one on paper-3 inside a 1px ink ring. On a phone more than three options
 * do not fit one row, so they become a native select that names the pick and its count.
 */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  className?: string;
}) {
  const mobile = useIsMobile();
  const text = (o: SegmentOption<T>) => (o.n === undefined ? o.label : `${o.label} ${o.n}`);

  if (mobile && options.length > 3) {
    const picked = options.find((o) => o.value === value) ?? options[0];
    return (
      <label
        className={cn(
          "relative inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-[var(--r)] border border-rule-2 pr-8 pl-3 text-small font-medium text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
          className,
        )}
      >
        <select value={value} onChange={(e) => onChange(e.target.value as T)} aria-label={label} className="absolute inset-0 cursor-pointer opacity-0">
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {text(o)}
            </option>
          ))}
        </select>
        <span className="text-ink-3">{label}</span>
        <span className="whitespace-nowrap">{picked?.label}</span>
        {picked?.n !== undefined && <span className="text-ink-3 tabular-nums">{picked.n}</span>}
        <ChevronDown className="pointer-events-none absolute right-2.5 size-3.5 text-ink-3" aria-hidden />
      </label>
    );
  }

  // On a phone each option is 42px inside the 1px border: the control is 44, a thumb's target, and no taller.
  return (
    <div role="group" aria-label={label} className={cn("inline-flex max-w-full shrink-0 rounded-[var(--r)] border border-rule-2", className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-[26px] items-center gap-1.5 px-2.5 text-label font-medium whitespace-nowrap transition-colors duration-[var(--dur)] max-sm:min-h-[42px] focus-visible:-outline-offset-2",
              i > 0 && "border-l border-rule",
              i === 0 && "rounded-l-[calc(var(--r)-1px)]",
              i === options.length - 1 && "rounded-r-[calc(var(--r)-1px)]",
              on ? "bg-paper-3 text-ink shadow-[inset_0_0_0_1px_var(--ink)]" : "text-ink-2 hover:bg-paper-2 hover:text-ink active:bg-paper-3",
            )}
          >
            {o.label}
            {o.n !== undefined && <span className="text-ink-3 tabular-nums">{o.n}</span>}
          </button>
        );
      })}
    </div>
  );
}
