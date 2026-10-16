import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A filter, as a chip (design.md): 26px, 12.5/500; the current one has an ink border. Its count follows the word. */
export function Chip({ on, onClick, count, title, children }: { on: boolean; onClick: () => void; count?: number; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex h-[26px] shrink-0 items-center max-sm:min-h-11 gap-1.5 rounded-[var(--r)] border px-2 text-label font-medium whitespace-nowrap transition-colors duration-[var(--dur)] active:translate-y-px",
        on ? "border-ink text-ink" : "border-rule text-ink-2 hover:border-ink-3 hover:text-ink",
      )}
    >
      {children}
      {count !== undefined && <span className="text-ink-3 tabular-nums">{count}</span>}
    </button>
  );
}
