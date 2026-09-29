import { useMemo } from "react";
import NumberFlow from "@number-flow/react";
import { useCapabilities, useChannel, useIndex } from "@/data/store";
import { NewTaskButton } from "@/components/domain/new-task";
import { IssueLink, Pending } from "@/components/domain/pending";
import TaskRows from "@/components/primitives/TaskRows";
import { COLUMN_LABEL, columnOf, taskRow, type Column } from "@/components/domain/task";
import { cn } from "@/lib/utils";

const COLUMNS: Column[] = ["stale", "claimed", "open", "done"];

const HINT: Record<Column, string> = {
  stale: "Holder is Gone. Held until a Person takes it over.",
  claimed: "Held by a Live or Idle Agent, or a Person.",
  open: "No Claim yet.",
  done: "Closed on GitHub.",
};

export function TasksView() {
  const { tasks } = useChannel();
  const { agentById, taskByNumber } = useIndex();
  const can = useCapabilities();

  const byColumn = useMemo(() => {
    const m = new Map<Column, typeof tasks>(COLUMNS.map((c) => [c, []]));
    for (const t of tasks) m.get(columnOf(t))!.push(t);
    for (const list of m.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return m;
  }, [tasks]);

  if (tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Pending title="No Tasks yet">
          Every open GitHub Issue in the repo shows up here as a Task. If there should be some, the Channel may not reach
          GitHub right now.
        </Pending>
        <NewTaskButton />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3 sm:px-4 sm:pt-4">
        <p className="text-[12.5px] text-ink-3">
          {tasks.length} {tasks.length === 1 ? "Task" : "Tasks"}, mirrored from GitHub Issues.
          {!can.claims && (
            <>
              {" "}Claims arrive with <IssueLink capability="claims" />.
            </>
          )}
        </p>
        <NewTaskButton />
      </div>
      <div className="grid gap-5 p-3 sm:p-4 lg:grid-cols-2 lg:gap-4 2xl:grid-cols-4">
        {COLUMNS.filter((c) => can.claims || (c !== "stale" && c !== "claimed")).map((c) => {
          const list = byColumn.get(c)!;
          return (
            <section key={c} aria-labelledby={`col-${c}`} className="flex min-w-0 flex-col gap-2">
              <header className="flex items-baseline justify-between gap-2 px-0.5">
                <h2 id={`col-${c}`} className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[13px] font-semibold text-ink">
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 rounded-full",
                      c === "stale" ? "bg-red" : c === "claimed" ? "bg-accent" : c === "done" ? "bg-green" : "bg-ink-3",
                    )}
                  />
                  {COLUMN_LABEL[c]}
                  <span className="font-mono text-[12px] font-normal text-ink-3 tabular-nums">
                    <NumberFlow value={list.length} />
                  </span>
                </h2>
                <span className="hidden truncate text-[11.5px] text-ink-3 sm:inline">{HINT[c]}</span>
              </header>
              {list.length ? (
                <TaskRows
                  variant="List"
                  rows={list.map((t) => taskRow(t, agentById, taskByNumber))}
                  defaultOpen={c === "stale" ? String(list[0].number) : undefined}
                />
              ) : (
                <p className="rounded-card border border-dashed border-line-strong px-3 py-4 text-center text-[12.5px] text-ink-3">
                  {c === "stale" ? "No Stale Claims. Every holder is still around." : "Nothing here."}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
