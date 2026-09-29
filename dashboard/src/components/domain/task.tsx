import NumberFlow from "@number-flow/react";
import type { Agent, AgentId, Task } from "@shared/index";
import { ProgressRing } from "@/components/atoms/ProgressRing";
import { StatusPill } from "@/components/atoms/StatusPill";
import type { TaskRow } from "@/components/primitives/TaskRows";
import { holderName } from "@/lib/format";
import { href } from "@/lib/router";
import { StalePill } from "./pills";
import { TakeoverAction } from "./takeover";

export type Column = "stale" | "claimed" | "open" | "done";

export const COLUMN_LABEL: Record<Column, string> = {
  stale: "Stale Claim",
  claimed: "Claimed",
  open: "Open",
  done: "Done",
};

export function columnOf(t: Task): Column {
  if (t.status === "done") return "done";
  if (t.claim?.stale) return "stale";
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
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap font-mono text-[11.5px] tabular-nums text-ink-2">
      <span className="inline-flex items-baseline">
        <NumberFlow value={done} />
        <span>/{total}</span>
      </span>
      <span className="font-sans text-ink-3">{noun}</span>
    </span>
  );
}

function HolderPill({ task, agentById }: { task: Task; agentById: Map<AgentId, Agent> }) {
  if (!task.claim) return null;
  if (task.claim.stale) return <StalePill className="hidden sm:inline-flex" />;
  const h = task.claim.holder;
  const label = h.kind === "agent" ? agentById.get(h.agentId)?.nickname ?? h.agentId.split("/").slice(1).join("/") : h.person;
  return (
    <StatusPill tone={h.kind === "agent" ? "accent" : "neutral"} dot={false} className="hidden h-5 max-w-[9rem] px-2 font-mono text-[11px] sm:inline-flex">
      <span className="truncate">{label}</span>
    </StatusPill>
  );
}

/** A Task as a Beautiful UI TaskRows row: progress ring, holder, and Steps and Subtasks on expand. */
export function taskRow(task: Task, agentById: Map<AgentId, Agent>, taskByNumber: Map<number, Task>): TaskRow {
  const steps = stepProgress(task);
  const subs = subtaskProgress(task);
  const isParent = subs.total > 0;
  const prog = isParent ? subs : steps;
  const holderAgent = task.claim?.holder.kind === "agent" ? agentById.get(task.claim.holder.agentId) : undefined;
  const col = columnOf(task);
  const tone = col === "done" ? "green" : col === "stale" ? "red" : "accent";
  const blocked = task.blockedBy.filter((n) => taskByNumber.get(n)?.status !== "done");

  return {
    key: String(task.number),
    status: col === "done" ? "done" : holderAgent?.presence === "live" ? "running" : "idle",
    badge:
      col === "done" ? undefined : (
        <ProgressRing size={24} tone={tone} progress={prog.total ? prog.done / prog.total : 0}>
          <span className="text-[10px] text-ink">{prog.done}</span>
        </ProgressRing>
      ),
    label: (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-[11.5px] font-normal text-ink-3">#{task.number}</span>
          <span className="line-clamp-2">{task.title}</span>
        </span>
        {(blocked.length > 0 || col === "stale" || task.claim) && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[11.5px] font-normal text-ink-3">
            {task.claim && (
              <span className="truncate font-mono text-[11px]">{holderName(task.claim.holder)}</span>
            )}
            {blocked.length > 0 && <span className="text-orange">Blocked by {blocked.map((n) => `#${n}`).join(", ")}</span>}
          </span>
        )}
      </span>
    ),
    amount: prog.total ? <Progress done={prog.done} total={prog.total} noun={isParent ? "subtasks" : "steps"} /> : null,
    pill: <HolderPill task={task} agentById={agentById} />,
    details: [
      ...(isParent
        ? task.subtasks.map((n) => {
            const s = taskByNumber.get(n);
            return {
              key: `sub-${n}`,
              label: (
                <span className="text-ink-2">
                  <span className="font-mono text-ink-3">#{n}</span> {s?.title}
                </span>
              ),
              meta: s ? columnLabelShort(columnOf(s)) : "",
            };
          })
        : task.steps.map((s) => ({
            key: `step-${s.index}`,
            label: <span className={s.done ? "text-ink-3 line-through decoration-line-strong" : ""}>{s.text}</span>,
            meta: s.done ? "done" : "",
          }))),
    ],
    footer: (
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <a
          href={href({ view: "task", number: task.number })}
          className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-accent-ink shadow-btn hover:bg-hover"
        >
          Open Task
        </a>
        <TakeoverAction task={task} compact />
      </div>
    ),
  };
}

function columnLabelShort(c: Column) {
  return c === "stale" ? "stale" : c;
}
