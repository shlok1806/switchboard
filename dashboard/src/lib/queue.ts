// The Now view's queue (design.md): every line that waits on a Person, in the order a
// Person answers them. Your own Asks first, then Stale Claims (anyone may take one over),
// then pull requests in review, then the Asks that only another Person can answer.
import type { Agent, AgentId, PersonName, Task } from "@shared/index";
import { heldByMe } from "@/components/domain/moves";

export type QueueItem =
  | { kind: "ask"; agent: Agent; mine: boolean; at: string }
  | { kind: "stale"; task: Task; at: string }
  /** `yours`: someone else finished it, so the review is yours to give. */
  | { kind: "review"; task: Task; yours: boolean; at: string };

const RANK = (i: QueueItem) => (i.kind === "ask" ? (i.mine ? 0 : 3) : i.kind === "stale" ? 1 : 2);

/** Oldest first within a kind: the line that has waited longest is answered first. */
export function needsQueue(agents: readonly Agent[], tasks: readonly Task[], me: PersonName): QueueItem[] {
  const agentById = new Map<AgentId, Agent>(agents.map((a) => [a.id, a]));
  const items: QueueItem[] = [];
  for (const a of agents)
    if (a.approval && a.presence !== "gone") items.push({ kind: "ask", agent: a, mine: a.person === me, at: a.approval.openedAt });
  for (const t of tasks) {
    if (t.claim?.stale && t.status !== "done") items.push({ kind: "stale", task: t, at: t.updatedAt });
    else if (t.status === "review")
      items.push({ kind: "review", task: t, yours: !(t.claim && heldByMe(t.claim.holder, me, agentById)), at: t.updatedAt });
  }
  return items.sort((x, y) => RANK(x) - RANK(y) || x.at.localeCompare(y.at));
}

/** Whether an item is yours to act on: your Ask, any Stale Claim, a review someone else asks of you. */
export function isMine(item: QueueItem): boolean {
  return item.kind === "ask" ? item.mine : item.kind === "stale" ? true : item.yours;
}
