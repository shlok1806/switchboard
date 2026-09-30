// Telling a resumed Agent it lost a Claim (ADR 0002). While an Agent is Gone a
// Person may take over its Stale Claim. The Channel keeps each such Lost Claim
// until the Agent's wrapper next registers or heartbeats, and hands it over in
// that answer. The wrapper keeps them here until the agent CLI's next hook that
// can add to the model's context (SessionStart on resume, else the next
// UserPromptSubmit) asks for them, and each is told once.
//
// The notice holds short structured facts only (which Task, who took it over,
// who holds it now), framed as information from the Channel (ADR 0005).

import type { LostClaim } from "../../shared/src/index";
import { holderName } from "../../shared/src/index";

/** The hooks whose output Claude Code adds to the model's context. */
export const CONTEXT_HOOKS = ["SessionStart", "UserPromptSubmit"] as const;

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

export class LostClaimNotices {
  private readonly waiting = new Map<string, LostClaim>();

  /** Lost Claims the Channel handed over. */
  add(lost: readonly LostClaim[]): void {
    for (const claim of lost) this.waiting.set(claim.event, claim);
  }

  /** The notice for a hook that adds to the model's context, once; "" when there is nothing to tell. */
  take(hook: string | undefined): string {
    if (!(CONTEXT_HOOKS as readonly (string | undefined)[]).includes(hook) || this.waiting.size === 0) return "";
    const lost = [...this.waiting.values()];
    this.waiting.clear();
    return `${lostClaimsNotice(lost)}\n`;
  }
}
