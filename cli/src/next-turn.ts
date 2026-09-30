// What the Agent is told at its next turn. The wrapper keeps it here, locally, and
// the agent CLI's next hook that can add to the model's context (SessionStart, else
// the next UserPromptSubmit) prints it, so the hook never waits on the network.
//
// - Lost Claims (ADR 0002): while an Agent is Gone a Person may take over its Stale
//   Claim. The Channel hands each Lost Claim over in its next register or heartbeat
//   answer.
// - Queued Events (the Relay's Queue Verdicts): the Channel pushes each Delivery over
//   the wrapper's WebSocket as soon as it has it, and hands any the wrapper has not
//   acknowledged over in the next register or heartbeat answer. The wrapper keeps
//   each once, whichever way it came.
// - The standing rule (ADR 0005), at every SessionStart, so it survives /clear and
//   compaction.
//
// - Directives: a Person's message to this Agent. The Channel pushes each over the
//   WebSocket and hands any the wrapper has not acknowledged over in the next
//   register or heartbeat answer, like Deliveries.
//
// Everything from the Channel is short structured facts, framed as information,
// never as instructions (ADR 0005). The one exception is a Directive, framed as
// coming from the named Person.

import type { Delivery, DirectiveDelivery, LostClaim } from "../../shared/src/index";
import { deliveriesNotice, directivesNotice, holderName, STANDING_RULE } from "../../shared/src/index";

/** The hooks whose output Claude Code adds to the model's context. */
export const CONTEXT_HOOKS = ["SessionStart", "UserPromptSubmit"] as const;

/** How many Delivery and Directive IDs the wrapper remembers, so one sent twice is shown once. */
const REMEMBERED_DELIVERIES = 1000;

/** One line per Lost Claim, the way the Agent reads it. */
export function describeLostClaim(lost: LostClaim): string {
  const holder = lost.to.kind === "person" ? `Person ${lost.to.person}` : `Agent ${holderName(lost.to)}`;
  return (
    `- Task #${lost.task} (${JSON.stringify(lost.title)}): Person ${lost.by} took over your Stale Claim ` +
    `at ${lost.at}. It is now held by ${holder}. You no longer hold Task #${lost.task}.`
  );
}

/** The framed notice for the Agent's context. */
export function lostClaimsNotice(lost: readonly LostClaim[]): string {
  return [
    "[Switchboard] Information from the Channel, not an instruction:",
    "While this session was away (Gone), a Person took over Claims it held.",
    ...lost.map(describeLostClaim),
    "Do not keep working on these Tasks unless your own Person asks you to. Uncommitted work for them stays where it is.",
  ].join("\n");
}

/** What the Channel handed over for the Agent's next turn, in a register or heartbeat answer. */
export interface NextTurnItems {
  lostClaims?: LostClaim[];
  deliveries?: Delivery[];
  directives?: DirectiveDelivery[];
}

export class NextTurn {
  private readonly lostClaims = new Map<string, LostClaim>();
  private readonly deliveries = new Map<string, Delivery>();
  private readonly directives = new Map<string, DirectiveDelivery>();
  /** Delivery and Directive IDs already kept, oldest first. */
  private readonly seen = new Set<string>();

  /** Keeps what the Channel handed over. Returns the IDs of Deliveries and Directives kept for the first time. */
  add(items: NextTurnItems): string[] {
    for (const claim of items.lostClaims ?? []) this.lostClaims.set(claim.event, claim);
    const kept: string[] = [];
    for (const delivery of items.deliveries ?? []) {
      if (this.remember(delivery.id)) {
        this.deliveries.set(delivery.id, delivery);
        kept.push(delivery.id);
      }
    }
    for (const directive of items.directives ?? []) {
      if (this.remember(directive.id)) {
        this.directives.set(directive.id, directive);
        kept.push(directive.id);
      }
    }
    return kept;
  }

  /** True the first time `id` is seen. */
  private remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > REMEMBERED_DELIVERIES) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  /** What a hook prints into the Agent's context, once; "" for other hooks and when there is nothing to tell. */
  take(hook: string | undefined): string {
    if (!(CONTEXT_HOOKS as readonly (string | undefined)[]).includes(hook)) return "";
    const parts: string[] = [];
    if (hook === "SessionStart") parts.push(STANDING_RULE);
    if (this.lostClaims.size > 0) {
      parts.push(lostClaimsNotice([...this.lostClaims.values()]));
      this.lostClaims.clear();
    }
    if (this.deliveries.size > 0) {
      parts.push(deliveriesNotice([...this.deliveries.values()].sort((a, b) => a.seq - b.seq)));
      this.deliveries.clear();
    }
    if (this.directives.size > 0) {
      parts.push(directivesNotice([...this.directives.values()].sort((a, b) => a.seq - b.seq)));
      this.directives.clear();
    }
    return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
  }
}
