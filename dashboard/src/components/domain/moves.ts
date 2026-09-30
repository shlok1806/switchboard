import type { Agent, AgentId, Holder, PersonName, Task } from "@shared/index";
import { holderName } from "@/lib/format";
import { COLUMN_LABEL, type Column } from "./task";

/**
 * What dropping a card on another column asks the Channel to do. Only two moves
 * are real API actions today (the Claim API, #9): Open to Claimed claims the
 * Task for the Person, and Claimed to Open releases a Claim the Person holds.
 * Everything else is refused here, with the reason, instead of faking a move
 * the backend cannot make.
 */
export type Move = { kind: "claim" } | { kind: "release" } | { kind: "refuse"; reason: string };

/** True when this Person holds the Claim, directly or through one of their Agents. */
export function heldByMe(holder: Holder, me: PersonName, agentById: Map<AgentId, Agent>): boolean {
  if (holder.kind === "person") return holder.person === me;
  return agentById.get(holder.agentId)?.person === me || holder.agentId.split("/")[0] === me;
}

export function decideMove(
  task: Task,
  from: Column,
  to: Column,
  me: PersonName,
  agentById: Map<AgentId, Agent>,
  takeoverLive: boolean,
): Move {
  const n = `#${task.number}`;
  if (from === "open" && to === "claimed") return { kind: "claim" };
  if (from === "claimed" && to === "open") {
    const holder = task.claim?.holder;
    if (holder && heldByMe(holder, me, agentById)) return { kind: "release" };
    return {
      kind: "refuse",
      reason: holder ? `${n} is held by ${holderName(holder)}. Only its holder can release it.` : `${n} is not claimed.`,
    };
  }
  if (from === "done") return { kind: "refuse", reason: `${n} is done. Reopen the Issue on GitHub to bring it back.` };
  if (from === "stale") {
    return {
      kind: "refuse",
      reason: takeoverLive
        ? `A Stale Claim moves by Takeover. Use Take over on the card.`
        : `A Stale Claim moves by Takeover, which arrives with #11.`,
    };
  }
  if (to === "done") return { kind: "refuse", reason: `Done comes from GitHub: merge the PR or close the Issue.` };
  if (to === "review") return { kind: "refuse", reason: `In review comes from GitHub: ${n} lands there when its PR opens.` };
  if (to === "stale") return { kind: "refuse", reason: `A Claim goes stale on its own, when its Agent is Gone.` };
  if (from === "review") {
    return {
      kind: "refuse",
      reason: task.pr ? `${n} has PR #${task.pr} open. It moves on when the PR merges or closes.` : `${n} is in review. It moves on when its PR merges or closes.`,
    };
  }
  return { kind: "refuse", reason: `${COLUMN_LABEL[from]} to ${COLUMN_LABEL[to]} is not a move the Channel can make.` };
}
