import type { Task } from "@shared/index";

export type Column = "stale" | "open" | "claimed" | "review" | "done";

export const COLUMN_LABEL: Record<Column, string> = {
  stale: "Stale Claim",
  open: "Open",
  claimed: "Claimed",
  review: "In review",
  done: "Done",
};

/** Where a Task sits on the board. A finished Task with its PR open is In review (#10). */
export function columnOf(t: Task): Column {
  if (t.status === "done") return "done";
  if (t.claim?.stale) return "stale";
  if (t.status === "review") return "review";
  if (t.claim) return "claimed";
  return "open";
}

/** Steps progress, as counted by GitHub sync. */
export function stepProgress(t: Task) {
  return { done: t.stepsDone, total: t.steps.length };
}

/** Subtasks progress, as counted by GitHub sync (a Subtask may not be loaded yet). */
export function subtaskProgress(t: Task) {
  return { done: t.subtasksDone, total: t.subtasks.length };
}

/** "3/5 steps" with a rolling numerator. */
export function Progress({ done, total, noun }: { done: number; total: number; noun: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 font-mono text-[11.5px] font-normal whitespace-nowrap tabular-nums text-ink-2">
      <span className="inline-flex items-baseline">
        <span className="tabular-nums">{done}</span>
        <span>/{total}</span>
      </span>
      <span className="font-sans text-ink-3">{noun}</span>
    </span>
  );
}
