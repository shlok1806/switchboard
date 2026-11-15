import type { Actor, Agent, ChannelEvent, Person } from "../../shared/src/domain";
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

/** Membership and workspace.read must be checked by the caller before projection. */
export function safePerson(person: Person): Person {
  return { name: person.name, timeZone: person.timeZone, joinedAt: person.joinedAt };
}

function safeActor(actor: Actor): Actor | null {
  switch (actor.kind) {
    case "agent":
      return { kind: "agent", agentId: actor.agentId };
    case "person":
      return { kind: "person", person: actor.person };
    case "github":
      return { kind: "github" };
    case "relay":
      return { kind: "relay" };
    default:
      return null;
  }
}

/**
 * Shared query preparation only; never grants admission. The caller must check
 * history + constituent/author authority and revalidate before release. Unknown,
 * private and directed payloads default to omission. No capture/session metadata.
 */
export function safeSharedEvent(event: ChannelEvent) {
  const actor = safeActor(event.actor);
  if (!actor) return null;
  const base = { id: event.id, seq: event.seq, at: event.at, actor };
  switch (event.type) {
    case "update":
      if (event.payload.to?.length) return null;
      return { ...base, type: "update" as const, payload: { text: event.payload.text } };
    case "presence":
      return { ...base, type: "presence" as const, payload: { presence: event.payload.presence } };
    default:
      return null;
  }
}
