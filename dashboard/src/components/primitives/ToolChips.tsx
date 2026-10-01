"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/* Switchboard: from Beautiful UI ToolChips (MIT, Shane Levine). Local edits:
 * `animate` prop, row keys by index, optional "+N more", no fixed min-height,
 * rows without detail do not open, a cut-short chip shows its full text.
 * ─────────────────────────────────────────────────────────
 * TOOL CHIPS
 * An agent run as compact rows: tool calls with inline
 * chips, then file-diff chips summarizing the edits.
 * Hover a row to reveal its chevron; every row expands
 * to show what the tool actually did.
 * ───────────────────────────────────────────────────────── */

const STEP_MS = 700;

const Icons: Record<string, React.ReactNode> = {
  think: <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,
  write: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></g>,
  run: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 17l6-5-6-5M12 19h8" /></g>,
  read: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></g>,
};

export type ToolDetailLine = { text: string; tone?: "add" };

export type ToolStep = {
  icon: string;
  label: string;
  chip: string;
  mono: boolean;
  detailMono: boolean;
  detail: ToolDetailLine[];
};

export type ToolDiff = { file: string; add: number; del: number };

export type ToolDiffLine = { text: string; tone: "add" | "del" | "ctx" };

export type ToolChipsLabels = {
  header: string;
  /** Switchboard: empty hides the "+N more" link. */
  more: string;
};

const DEFAULT_LABELS: ToolChipsLabels = {
  header: "4 tool calls, 2 messages",
  more: "+2 more",
};

const ROWS: ToolStep[] = [
  {
    icon: "think", label: "Thinking", chip: "Planning the churn schedule…", mono: false, detailMono: false,
    detail: [
      { text: "Weekend demand carries pistachio, so it churns first." },
      { text: "Batch capacity leaves two evening freezer windows." },
    ],
  },
  {
    icon: "write", label: "Write 204 lines", chip: "ChurnSchedule.tsx", mono: true, detailMono: true,
    detail: [
      { text: "+ const windows = slots.filter((s) => s.temp <= -12)", tone: "add" },
      { text: "+ return schedule(windows, { hero: \"pistachio\" })", tone: "add" },
    ],
  },
  {
    icon: "run", label: "Rebuild and verify", chip: "npm run freeze", mono: true, detailMono: true,
    detail: [
      { text: "✓ built in 1.2s" },
      { text: "✓ 34 checks passed" },
    ],
  },
  {
    icon: "read", label: "Read image", chip: "flavor-chart.png", mono: true, detailMono: false,
    detail: [
      { text: "1280 × 720 · line chart, three summers." },
      { text: "Mint chip trends up 12% through July." },
    ],
  },
];

const DIFFS: ToolDiff[] = [
  { file: "flavors.css", add: 13, del: 0 },
  { file: "ChurnSchedule.tsx", add: 74, del: 41 },
  { file: "menu.ts", add: 8, del: 2 },
];

/* hovering a file chip opens its diff - green added, red removed */
const DIFF_LINES: Record<string, ToolDiffLine[]> = {
  "flavors.css": [
    { text: ".scoop-card {", tone: "ctx" },
    { text: "  gap: 14px;", tone: "del" },
    { text: "  gap: 12px;", tone: "add" },
    { text: "  container-type: inline-size;", tone: "add" },
    { text: "}", tone: "ctx" },
  ],
  "ChurnSchedule.tsx": [
    { text: "const slots = coldSlots(week);", tone: "ctx" },
    { text: "const windows = slots;", tone: "del" },
    { text: "const windows = slots.filter(", tone: "add" },
    { text: "  (s) => s.temp <= -12,", tone: "add" },
    { text: ");", tone: "add" },
  ],
  "menu.ts": [
    { text: "export const hero = \"mint-chip\";", tone: "del" },
    { text: "export const hero = \"pistachio\";", tone: "add" },
  ],
};

/**
 * `text` with a line-break opportunity after each path separator, so a long path wraps
 * between its parts (`web/src/components/` then `Pager.tsx`), not mid-name. A part too
 * long for the line still breaks where it must (`overflow-wrap: anywhere`).
 */
function breakable(text: string): React.ReactNode {
  const parts = text.split(/(?<=[/\\])(?=[^/\\])/);
  if (parts.length === 1) return text;
  return parts.map((part, i) => (
    <span key={i}>
      {part}
      {i < parts.length - 1 && <wbr />}
    </span>
  ));
}

/**
 * A row's chip, cut short with an ellipsis when it does not fit. `onCut` says whether
 * it is. On a row that opens, the row's detail then shows the full text. On a row that
 * does not, the chip takes keyboard focus and shows the full text in a tooltip, on
 * hover and on focus. The full text is the chip's content either way (only its
 * display is cut), so a screen reader reads it once; the tooltip is not added as a
 * description that would read it again.
 */
function Chip({
  text,
  mono,
  inButton,
  onCut,
}: {
  text: string;
  mono: boolean;
  inButton: boolean;
  onCut?: (cut: boolean) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const isCut = el.scrollWidth > el.clientWidth;
      setCut(isCut);
      // A chip that fits has no tooltip, and must not keep one to show when it is cut again.
      if (!isCut) setOpen(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  useEffect(() => onCut?.(cut), [cut, onCut]);

  // The text in its own span: an ellipsis does not apply to text directly inside a flex box.
  const body = (
    <span
      tabIndex={cut && !inButton ? 0 : undefined}
      aria-describedby={undefined}
      onBlur={() => setOpen(false)}
      className={`inline-flex h-5.5 min-w-0 flex-1 items-center rounded-chip bg-field px-1.5
        text-[11.5px] text-ink-2 shadow-hairline
        ${inButton ? "cursor-pointer transition-colors duration-100 hover:bg-hover-2" : ""}
        ${mono ? "font-mono" : ""}`}
    >
      <span ref={ref} className="min-w-0 truncate">
        {text}
      </span>
    </span>
  );
  if (inButton) return body;
  // Always in the tooltip, which opens only while the text is cut short: a tree that
  // changed with `cut` would remount the measured span and lose its observer.
  return (
    <Tooltip open={cut && open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent aria-hidden className={`max-w-[min(32rem,90vw)] [overflow-wrap:anywhere] whitespace-pre-wrap ${mono ? "font-mono" : ""}`}>
        {breakable(text)}
      </TooltipContent>
    </Tooltip>
  );
}

export default function ToolChips({
  steps = ROWS,
  diffs = DIFFS,
  diffLines = DIFF_LINES,
  labels,
  className,
  onOpenChange,
  onToggleRow,
  animate = true,
}: {
  /** Accepted for gallery/registry parity; ToolChips has no visual variants. */
  variant?: string;
  steps?: ToolStep[];
  diffs?: ToolDiff[];
  diffLines?: Record<string, ToolDiffLine[]>;
  labels?: Partial<ToolChipsLabels>;
  className?: string;
  onOpenChange?: (open: boolean) => void;
  onToggleRow?: (label: string, open: boolean) => void;
  /** Switchboard: false shows every row at once (history), true plays them in (live). */
  animate?: boolean;
} = {}) {
  const copy = { ...DEFAULT_LABELS, ...labels };
  const [step, setStep] = useState(animate ? 0 : steps.length + 1);
  const [open, setOpen] = useState(true);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  // Rows whose chip is cut short: their detail starts with the chip's full text.
  const [cutRows, setCutRows] = useState<ReadonlySet<string>>(new Set());
  const markCut = useCallback(
    (key: string, cut: boolean) =>
      setCutRows((current) => {
        if (current.has(key) === cut) return current;
        const next = new Set(current);
        if (cut) next.add(key);
        else next.delete(key);
        return next;
      }),
    [],
  );
  /* Rendered in a body portal so animated/translated reply wrappers cannot
   * redefine the fixed-position coordinate system. */
  const [preview, setPreview] = useState<{
    file: string;
    x: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const openPreview = (file: string) => (event: React.SyntheticEvent) => {
    const rect = (event.currentTarget as Element).closest("[data-diffchip]")!.getBoundingClientRect();
    const previewHeight = 38 + (diffLines[file]?.length ?? 0) * 19;
    const fitsBelow = rect.bottom + 6 + previewHeight <= window.innerHeight - 12;
    setPreview({
      file,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 300)),
      ...(fitsBelow
        ? { top: rect.bottom + 6 }
        : { bottom: window.innerHeight - rect.top + 6 }),
    });
  };
  const closePreview = (file: string) => () =>
    setPreview((current) => (current?.file === file ? null : current));
  const total = steps.length + 1; // rows, then diff chips
  const keyOf = (row: ToolStep, i: number) => `${i}:${row.label}`;
  // One stable callback per row, so a Chip's effect does not run on every render.
  const cutCallbacks = useRef(new Map<string, (cut: boolean) => void>());
  const cutOf = (key: string) => {
    let callback = cutCallbacks.current.get(key);
    if (!callback) {
      callback = (cut: boolean) => markCut(key, cut);
      cutCallbacks.current.set(key, callback);
    }
    return callback;
  };

  useEffect(() => {
    if (step >= total) return;
    const t = setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [step, total]);

  const toggleRow = (label: string) =>
    setOpenRows((current) => {
      const next = new Set(current);
      next.has(label) ? next.delete(label) : next.add(label);
      onToggleRow?.(label, next.has(label));
      return next;
    });

  return (
    <div className={`w-full pb-1${className ? ` ${className}` : ""}`}>
      {/* collapsed run header */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() =>
          setOpen((current) => {
            onOpenChange?.(!current);
            return !current;
          })
        }
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="tabular-nums">{copy.header}</span>
      </button>

      {/* tool call rows */}
      <div className="grid transition-[grid-template-rows,opacity] duration-300" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}>
        {/* -mx-1 + px-1.5 keeps content at the same x while giving the
            row hover pills room inside this overflow-hidden clip box */}
        <div className="-mx-1 overflow-hidden px-1.5 pb-1">
        <div className="mt-1.5 flex flex-col gap-1">
          {steps.slice(0, step).map((row, i) => {
            const key = keyOf(row, i);
            const rowOpen = openRows.has(key);
            const detail = cutRows.has(key) ? [{ text: row.chip, full: true }, ...row.detail] : row.detail;
            // A step with nothing more to show (a Claude Code command has no exit code) does not open.
            const expandable = row.detail.length > 0;
            const icon = (
              <svg
                width="13" height="13" viewBox="0 0 24 24" fill={row.icon === "think" ? "currentColor" : "none"} stroke="currentColor"
                className={expandable ? `transition-opacity duration-100 group-hover/row:opacity-0 group-focus-visible/row:opacity-0 ${rowOpen ? "opacity-0" : ""}` : ""}
              >
                {Icons[row.icon]}
              </svg>
            );
            const label = <span className="shrink-0 text-[12.5px] font-medium text-ink">{row.label}</span>;
            const chip = <Chip text={row.chip} mono={row.mono} inButton={expandable} onCut={expandable ? cutOf(key) : undefined} />;
            return (
            <div key={keyOf(row, i)} style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
              {expandable ? (
                <button
                  type="button"
                  aria-expanded={rowOpen}
                  onClick={() => toggleRow(keyOf(row, i))}
                  className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-[3px] text-left transition-colors duration-100 hover:bg-hover-2"
                >
                  <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
                    {icon}
                    <svg
                      width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                      className={`absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 ${rowOpen ? "opacity-100" : "opacity-0"}`}
                      style={{ transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </span>
                  {label}
                  {chip}
                </button>
              ) : (
                <div className="-mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 px-[3px]">
                  <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">{icon}</span>
                  {label}
                  {chip}
                </div>
              )}

              {/* expanded detail, when there is any (a Claude Code command has no exit code to show) */}
              {row.detail.length > 0 && (
                <div
                  // Closed, the detail is out of reach, for screen readers and Tab alike.
                  inert={!rowOpen}
                  className="grid transition-[grid-template-rows,opacity] duration-300"
                  style={{ gridTemplateRows: rowOpen ? "1fr" : "0fr", opacity: rowOpen ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l border-line py-0.5 pl-3.5">
                      {detail.map((line) => (
                        <span
                          key={line.text}
                          className={`text-[11.5px] leading-[1.6] [overflow-wrap:anywhere] whitespace-pre-wrap ${
                            "full" in line ? (row.mono ? "font-mono" : "") : row.detailMono ? "font-mono" : ""
                          } ${"tone" in line && line.tone === "add" ? "text-green" : "text-ink-2"}`}
                        >
                          {breakable(line.text)}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            );
          })}
        </div>

      {/* file-diff chips */}
      {step >= total && diffs.length > 0 && (
        <div className="mt-2.5 flex max-w-full flex-wrap gap-1.5 border-t border-line pt-2.5">
          {diffs.map((d, i) => (
            <span
              key={d.file}
              data-diffchip
              className="relative"
              onMouseEnter={openPreview(d.file)}
              onMouseLeave={closePreview(d.file)}
            >
              <button
                type="button"
                aria-expanded={preview?.file === d.file}
                aria-label={`Show diff for ${d.file}`}
                onFocus={openPreview(d.file)}
                onBlur={closePreview(d.file)}
                className="inline-flex h-7 max-w-full items-center gap-2 rounded-chip
                  bg-surface px-2 font-mono text-[11.5px] text-ink shadow-btn
                  transition-colors duration-100 hover:bg-hover"
                style={{ animation: `pop-in 250ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both` }}
              >
                <span className="min-w-0 truncate">{d.file}</span>
                <span className="shrink-0 text-green tabular-nums">+{d.add}</span>
                {d.del > 0 && <span className="shrink-0 text-red tabular-nums">−{d.del}</span>}
              </button>

            </span>
          ))}
          {copy.more && <button
            type="button"
            className="inline-flex h-7 items-center rounded-chip px-1.5 font-mono text-[11.5px] text-ink-3
              underline decoration-transparent underline-offset-2 transition-colors duration-100
              hover:text-ink-2 hover:decoration-current"
            style={{ animation: `fade-in 300ms ease-out ${diffs.length * 80}ms both` }}
          >
            {copy.more}
          </button>}
        </div>
      )}
        </div>
      </div>
      {preview && typeof document !== "undefined" && createPortal(
        <div
          className="fixed z-50 w-72 overflow-hidden rounded-[10px] bg-surface shadow-overlay"
          style={{
            left: preview.x,
            top: preview.top,
            bottom: preview.bottom,
            animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
            transformOrigin: preview.top === undefined ? "bottom left" : "top left",
          }}
        >
          <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5 font-mono text-[11px]">
            <span className="min-w-0 truncate text-ink-2">{preview.file}</span>
            <span className="shrink-0 tabular-nums">
              <span className="text-green">+{diffs.find((diff) => diff.file === preview.file)?.add}</span>
              {(diffs.find((diff) => diff.file === preview.file)?.del ?? 0) > 0 && (
                <span className="text-red"> −{diffs.find((diff) => diff.file === preview.file)?.del}</span>
              )}
            </span>
          </div>
          <div className="py-1 font-mono text-[11px] leading-[1.8]">
            {(diffLines[preview.file] ?? []).map((line, index) => (
              <div
                key={index}
                className={`flex gap-2 px-2.5 whitespace-pre ${
                  line.tone === "add"
                    ? "bg-green-tint text-green"
                    : line.tone === "del"
                      ? "bg-red-tint text-red"
                      : "text-ink-2"
                }`}
              >
                <span className="w-3 shrink-0 select-none">{line.tone === "add" ? "+" : line.tone === "del" ? "−" : " "}</span>
                <span className="min-w-0 truncate">{line.text}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
