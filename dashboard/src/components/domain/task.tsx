import type { Agent, AgentId, Holder, Task } from "@shared/index";
import { Glyph, useAgentStates } from "@/components/domain/state";
import { ownedName } from "@/components/domain/fleet";
import { useIndex } from "@/data/store";
import { href } from "@/lib/router";
import { stateWord, type GlyphState } from "@/lib/state";

export type Column = "stale" | "open" | "claimed" | "review" | "done";

export const COLUMN_LABEL: Record<Column, string> = {
  stale: "Stale Claim",
  open: "Open",
  claimed: "Claimed",
  review: "In review",
  done: "Done",
};

/** A column's glyph in the one state vocabulary: a Stale Claim is a triangle, In review a diamond. */
export const COLUMN_GLYPH: Record<Column, GlyphState> = { stale: "stale", open: "idle", claimed: "running", review: "review", done: "done" };

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

/** Open Issues a Task still waits on. */
export function openBlockers(t: Task, taskByNumber: Map<number, Task>): number[] {
  return t.blockedBy.filter((n) => taskByNumber.get(n)?.status !== "done");
}

/** The Person holding a Task's Claim, directly or through one of their Agents. */
export function holderPerson(t: Task, agentById: Map<AgentId, Agent>): string | null {
  const h = t.claim?.holder;
  if (!h) return null;
  return h.kind === "person" ? h.person : (agentById.get(h.agentId)?.person ?? h.agentId.split("/")[0]!);
}

/** `status:*` labels mirror the column the Task already sits in (ADR 0001), so views leave them out. */
/**
 * The index of the Step its holder is on: the first open one, while someone holds the Task
 * and nothing halts it (a Stale Claim, or a blocker that arrived after the Claim). -1 when none.
 */
export function currentStep(t: Task): number {
  if (!t.claim || t.claim.stale || (t.claim.blockedBy?.length ?? 0) > 0) return -1;
  return t.steps.findIndex((s) => !s.done);
}

export const shownLabels = (t: Task) => t.labels.filter((l) => !l.startsWith("status:"));

/**
 * Who holds a Claim: an Agent by its Person and short name with its state, a Person by name.
 * A link to the Agent unless `link` is false, as inside a draggable card.
 */
export function HolderLabel({ holder, link = true, className }: { holder: Holder; link?: boolean; className?: string }) {
  const { agentById } = useIndex();
  const states = useAgentStates();
  if (holder.kind === "person") return <span className={className}>{holder.person}</span>;
  const agent = agentById.get(holder.agentId);
  const name = agent ? ownedName(agent) : holder.agentId;
  const state = states.get(holder.agentId) ?? "gone";
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className ?? ""}`}>
      <Glyph state={state} />
      <span className="sr-only">{stateWord(state, agent?.person)}:</span>
      {link ? (
        <a href={href({ view: "agent", id: holder.agentId })} className="min-w-0 [overflow-wrap:anywhere] text-ink hover:underline">
          {name}
        </a>
      ) : (
        <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
      )}
    </span>
  );
}
