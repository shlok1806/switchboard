// Channel state as lines a model reads: the Agents' stdio MCP server (cli/src/mcp-server.ts)
// and the read-only connector (worker/src/mcp/, ADR 0040) describe Tasks the same way.

import { holderName } from "./claims";
import type { AgentId, Task } from "./domain";
import { cleanNoteText } from "./memory";

/** Channel text on one line, cut to `max`. */
export function oneLine(text: string, max: number): string {
  const flat = cleanNoteText(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Task numbers as `#3, #7`. */
export function taskRefs(numbers: readonly number[]): string {
  return numbers.map((n) => `#${n}`).join(", ");
}

/**
 * One line per Task, readable by a model. `me` marks the Tasks the calling Agent
 * holds, so a resumed Agent can see which Claims it still has.
 */
export function describeTask(task: Task, me?: AgentId): string {
  const parts = [`#${task.number} ${task.title}`, `[${task.status}]`];
  if (task.steps.length > 0) parts.push(`${task.stepsDone}/${task.steps.length} Steps`);
  const claim = task.claim;
  if (claim) {
    const mine = claim.holder.kind === "agent" && claim.holder.agentId === me ? " (you)" : "";
    const stale = claim.stale ? " (Stale: its holder is Gone, only a Person can take it over)" : "";
    parts.push(`held by ${holderName(claim.holder)}${mine}${stale}`);
  }
  if (claim?.blockedBy && claim.blockedBy.length > 0) {
    parts.push(`claimed but now blocked by ${taskRefs(claim.blockedBy)}`);
  } else if (task.blockedBy.length > 0) {
    parts.push(`blocked by ${taskRefs(task.blockedBy)}`);
  }
  return parts.join(" ");
}
