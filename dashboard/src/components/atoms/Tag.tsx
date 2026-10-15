/*
 * A word in a quiet box (design.md's chip shape): radius 3, a 1px rule, 12.5/500 in ink-2.
 * It never carries a colour; a state is drawn with the State component instead.
 */
import { cn } from "@/lib/utils";

export function Tag({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-[var(--r)] border border-rule px-2 text-label font-medium leading-none whitespace-nowrap text-ink-2",
        className,
      )}
    >
      {children}
    </span>
  );
}
