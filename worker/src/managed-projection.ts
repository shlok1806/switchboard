import type { Agent } from "../../shared/src/domain";
import type { SafeAgent } from "../../shared/src/m1";

/** Call only after current enrollment and agent.view authorization. */
export function safeAgent(
  agent: Agent,
  identity: Pick<SafeAgent, "principalId" | "executionId" | "ownerPersonId">,
): SafeAgent {
  return {
    id: agent.id,
    principalId: identity.principalId,
    executionId: identity.executionId,
    ownerPersonId: identity.ownerPersonId,
    cli: agent.cli,
    presence: agent.presence,
    startedAt: agent.startedAt,
    lastSeenAt: agent.lastSeenAt,
  };
}
