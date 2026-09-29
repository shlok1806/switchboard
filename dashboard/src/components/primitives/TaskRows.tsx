"use client";

import { useState, type ReactNode } from "react";

/* Switchboard: adapted from Beautiful UI TaskRows (MIT, Shane Levine).
 * The scripted demo sequence is replaced by data-driven rows; the visuals are unchanged.
 * ─────────────────────────────────────────────────────────
 * TASK ROWS
 *
 *     0ms   rows enter staggered (80ms apart)
 *   600ms   row 1 ring sweeps 0 → 66%
 *  1500ms   row 1 expands - detail steps drop down
 *  3900ms   row 1 collapses; row 2 flips to Failed + retry
 *  5300ms   row 2 resolves to Completed
 * The status run completes once; task details stay clickable.
 * ───────────────────────────────────────────────────────── */


function SpinnerRing({ active, children }: { active?: boolean; children?: React.ReactNode }) {
  const size = 24, stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg
        width={size} height={size} className="absolute inset-0"
        style={active ? { animation: "spin 1.1s linear infinite" } : undefined}
      >
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        {active && (
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke="var(--ink-3)" strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${c * 0.28} ${c * 0.72}`}
          />
        )}
      </svg>
      <span className="relative text-[10.5px] font-semibold tabular-nums text-ink">{children}</span>
    </span>
  );
}

function Badge({ tone, children }: { tone: "red" | "green"; children: React.ReactNode }) {
  return (
    <span
      className={`flex size-5.5 shrink-0 items-center justify-center rounded-full text-surface
        ${tone === "red" ? "bg-red" : "bg-green"}`}
      style={{ animation: "pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      {children}
    </span>
  );
}

const XIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
);
const CheckIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
);

/* One detail line shown when a task row is expanded. */
export type TaskDetail = { label: ReactNode; meta: ReactNode; key?: string };

/* A single task row.
 *  - "done"     → green check badge
 *  - "running"  → active spinner showing `step`
 *  - "idle"     → still ring showing `step`
 *  - "failed"   → red cross badge
 */
export type TaskRow = {
  key: string;
  label: ReactNode;
  amount: ReactNode;
  status: "done" | "running" | "idle" | "failed";
  step?: ReactNode;
  /** Replaces the status badge, such as a progress ring for Steps. */
  badge?: ReactNode;
  /** Right-side pill, such as the holder or a Stale Claim marker. */
  pill?: ReactNode;
  details: TaskDetail[];
  /** Extra content at the bottom of the expanded area, such as an Open link. */
  footer?: ReactNode;
};

export default function TaskRows({
  variant = "List",
  rows,
  className,
  onToggleRow,
  defaultOpen,
}: {
  variant?: "List" | "Capsules";
  rows: TaskRow[];
  className?: string;
  onToggleRow?: (key: string, open: boolean) => void;
  defaultOpen?: string;
}) {
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});

  const badgeFor = (row: TaskRow) => {
    if (row.status === "done") return <Badge tone="green">{CheckIcon}</Badge>;
    if (row.status === "failed") return <Badge tone="red">{XIcon}</Badge>;
    return <SpinnerRing active={row.status === "running"}>{row.step}</SpinnerRing>;
  };

  const list = variant === "List";
  return (
    <div
      className={`flex w-full flex-col ${
        list ? "gap-0 self-start overflow-hidden rounded-card bg-surface shadow-card" : "gap-2"
      }${className ? ` ${className}` : ""}`}
    >
      {rows.map((row, i) => {
        const open = manualOpen[row.key] ?? row.key === defaultOpen;
        return (
          <div
            key={row.key}
            className={`self-stretch overflow-hidden transition-[border-radius,background-color] duration-300 hover:bg-inset ${
              list ? "border-b border-line last:border-0" : "bg-surface shadow-card"
            }`}
            style={{
              borderRadius: list ? 0 : open ? 14 : 22,
              animation: `fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${Math.min(i, 8) * 40}ms both`,
            }}
          >
            <button
              type="button"
              aria-expanded={open}
              onClick={() => {
                setManualOpen((current) => ({ ...current, [row.key]: !open }));
                onToggleRow?.(row.key, !open);
              }}
              className="flex min-h-11 w-full items-center gap-2.5 px-2.5 py-1.5 text-left"
            >
              <span className="flex size-6 shrink-0 items-center justify-center">
                {row.badge ?? badgeFor(row)}
              </span>
              <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-ink">
                {row.label}
              </span>
              <span className="shrink-0 text-[12px] text-ink-2 tabular-nums">{row.amount}</span>
              {row.pill}
              <span
                aria-hidden="true"
                className="-ml-1 flex size-6 shrink-0 items-center justify-center rounded-full text-ink-3"
              >
                <svg
                  width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                  className="transition-transform duration-300"
                  style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </button>

            {/* dropdown detail - same expandable grammar as Chain of Thought */}
            <div
              className="grid transition-[grid-template-rows,opacity] duration-300"
                style={{
                  gridTemplateRows: open ? "1fr" : "0fr",
                  opacity: open ? 1 : 0,
                  transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                }}
              >
                <div className="overflow-hidden">
                  <div className="mb-2.5 grid grid-cols-[24px_minmax(0,1fr)] gap-2.5 px-2.5">
                    <span aria-hidden className="mx-auto h-full w-px bg-line" />
                    <div className="flex min-w-0 flex-col gap-1.5">
                      {row.details.map((d, j) => (
                        <div
                          key={d.key ?? j}
                          className="flex items-center justify-between gap-3"
                          style={
                            open
                              ? { animation: `fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${120 + j * 60}ms both` }
                              : undefined
                          }
                        >
                          <span className="min-w-0 text-[12px] text-ink-2">{d.label}</span>
                          <span className="shrink-0 font-mono text-[11.5px] text-ink-3 tabular-nums">
                            {d.meta}
                          </span>
                        </div>
                      ))}
                      {row.footer}
                    </div>
                  </div>
                </div>
              </div>
          </div>
        );
      })}
    </div>
  );
}
