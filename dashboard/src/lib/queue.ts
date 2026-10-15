// The Now view's queue (design.md): every line that waits on a Person, in the order a
// Person answers them. Your own Asks first, then Stale Claims (anyone may take one over),
// then pull requests in review, then the Asks that only another Person can answer. The
// count of lines that need you comes from this queue too, so the Now key, the page head
// and the queue never disagree.
import type { Agent, AgentId, ChannelEvent, PersonName, Task } from "@shared/index";
import { heldByMe } from "@/lib/state";

export type QueueItem =
  | { kind: "ask"; agent: Agent; mine: boolean; at: string }
  | { kind: "stale"; task: Task; at: string }
  /** `yours`: someone else finished it, so the review is yours to give. */
  | { kind: "review"; task: Task; yours: boolean; at: string };

const RANK = (i: QueueItem) => (i.kind === "ask" ? (i.mine ? 0 : 3) : i.kind === "stale" ? 1 : 2);

/** When each Task last went Stale and last went to review, from the Channel's own Events. */
function since(events: readonly ChannelEvent[]) {
  const stale = new Map<number, string>();
  const review = new Map<number, string>();
  for (const e of events) {
    if (e.task === undefined) continue;
    if (e.type === "claim.stale") stale.set(e.task, e.at);
    else if (e.type === "task.review") review.set(e.task, e.at);
  }
  return { stale, review };
}

/**
 * What waits on a Person, oldest first within a kind: the line that has waited longest is
 * answered first. A Gone Agent's prompt is left out, as `stateOf` leaves it out: nobody can
 * answer it any more. Ages come from the `claim.stale` and `task.review` Events when the
 * Channel still holds them, else from the Task's last change.
 */
export function needsQueue(agents: readonly Agent[], tasks: readonly Task[], me: PersonName, events: readonly ChannelEvent[] = []): QueueItem[] {
  const agentById = new Map<AgentId, Agent>(agents.map((a) => [a.id, a]));
  const at = since(events);
  const items: QueueItem[] = [];
  for (const a of agents)
    if (a.approval && a.presence !== "gone") items.push({ kind: "ask", agent: a, mine: a.person === me, at: a.approval.openedAt });
  for (const t of tasks) {
    if (t.claim?.stale && t.status !== "done") items.push({ kind: "stale", task: t, at: at.stale.get(t.number) ?? t.updatedAt });
    else if (t.status === "review")
      items.push({
        kind: "review",
        task: t,
        yours: !(t.claim && heldByMe(t.claim.holder, me, agentById)),
        at: at.review.get(t.number) ?? t.updatedAt,
      });
  }
  return items.sort((x, y) => RANK(x) - RANK(y) || x.at.localeCompare(y.at));
}

/** Whether an item is yours to act on: your Ask, any Stale Claim, a review someone else asks of you. */
export function isMine(item: QueueItem): boolean {
  return item.kind === "ask" ? item.mine : item.kind === "stale" ? true : item.yours;
}

/** How many lines need you: the one count the Now key, the page heads and the canvas show. */
export function needsYouCount(agents: readonly Agent[], tasks: readonly Task[], me: PersonName): number {
  return needsQueue(agents, tasks, me).filter(isMine).length;
}
