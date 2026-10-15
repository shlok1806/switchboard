import { useEffect, useState } from "react";

/*
 * Long-running work (design.md's loading state): a 12px half ring turning, the label, and
 * the time it has taken in tabular figures. Reduced motion leaves the ring still; the
 * timer still ticks.
 */

function useElapsed() {
  const [ds, setDs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setDs((d) => d + 1), 100);
    return () => clearInterval(t);
  }, []);
  const total = ds / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

export default function LoadingState({ label = "Loading" }: { label?: string }) {
  const elapsed = useElapsed();
  return (
    <div role="status" className="flex w-fit items-center gap-3">
      <svg viewBox="0 0 12 12" aria-hidden className="size-3 shrink-0 animate-spin text-ink">
        <circle cx="6" cy="6" r="4.75" fill="none" stroke="var(--rule-2)" strokeWidth="1.5" />
        <path d="M6 1.25 A4.75 4.75 0 0 1 10.75 6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <span className="text-row font-medium text-ink">{label}</span>
      <span className="text-row text-ink-3 tabular-nums">{elapsed}</span>
    </div>
  );
}
