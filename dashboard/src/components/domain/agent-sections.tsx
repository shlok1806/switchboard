/*
 * Sections an Agent shows on its page and in the canvas inspector: the Steps of a Task it
 * holds, and a facts list (design.md).
 */
import type { ReactNode } from "react";
import type { Task } from "@shared/index";
import { Section } from "@/components/shell/section";
import { Glyph, State } from "@/components/domain/state";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";

/** A Task the Agent holds, with its Steps: done, the one it is on, and the rest. */
export function Steps({ task }: { task: Task }) {
  const blockedBy = task.claim?.blockedBy ?? [];
  // A Stale or blocked Claim is not working on any Step, so none is shown in progress.
  const halted = task.claim?.stale === true || blockedBy.length > 0;
  const next = halted ? -1 : task.steps.findIndex((s) => !s.done);
  return (
    <Section
      title={
        <a href={href({ view: "task", number: task.number })} className="hover:underline">
          #{task.number} {task.title}
        </a>
      }
      meta={
        <>
          {task.steps.length > 0 && `${task.stepsDone} of ${task.steps.length} Steps`}
          {task.claim?.stale && <State state="stale" word="Stale Claim" className="ml-3 text-small" />}
          {blockedBy.length > 0 && <span className="ml-3">blocked by {blockedBy.map((n) => `#${n}`).join(", ")}</span>}
        </>
      }
      action={
        <a href={href({ view: "task", number: task.number })} className="text-ink-2 hover:text-ink">
          Open the Task
        </a>
      }
      bodyClassName="pt-0"
    >
      {task.steps.length > 0 ? (
        <ol>
          {task.steps.map((s, i) => (
            <li key={s.index} className={cn("flex items-baseline gap-2.5 border-b border-rule py-2 text-row", s.done || i === next ? "text-ink" : "text-ink-3")}>
              <Glyph state={s.done ? "done" : i === next ? "running" : "idle"} className="relative top-px" />
              <span className="sr-only">{s.done ? "Done:" : i === next ? "In progress:" : "To do:"}</span>
              <span className="min-w-0 max-w-[72ch] [overflow-wrap:anywhere]">{s.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="pt-3 text-small text-ink-3">No Steps on this Task.</p>
      )}
    </Section>
  );
}

export type Row = [label: string, value: ReactNode, note?: ReactNode] | false | undefined | "";

/** Label and value pairs, a small note under a value (design.md's facts list). */
export function Facts({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2 text-row">
      {rows.filter((r): r is Exclude<Row, false | undefined | ""> => Boolean(r)).map(([label, value, note]) => (
        <div key={label} className="contents">
          <dt className="text-ink-3">{label}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere] text-ink">
            {value}
            {note && <span className="block text-small text-ink-3">{note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
