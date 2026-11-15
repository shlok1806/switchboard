import type { Agent, AgentId, Task } from "../../shared/src/domain";
import { safeAgent, safeTask } from "./managed-projection";
import type { ProjectionContext } from "./managed-query";
import type { ChannelAuthorization } from "./organization";

export interface ManagedAttributionHost {
  input: ChannelAuthorization;
  agent(id: AgentId): Agent | null;
  association(id: AgentId): { active: number; executionId: string } | null | undefined;
  pin(input: ChannelAuthorization): void;
}
/** Fresh exact-target authority, never a login-derived identity or positive cache. */
export async function managedAgentAttribution(
  host: ManagedAttributionHost,
  id: AgentId,
  context: ProjectionContext,
  eventAt?: number,
) {
  const association = host.association(id);
  if (association?.active !== 1) return null;
  const check: ChannelAuthorization = {
    ...host.input,
    action: "agent.view",
    targetExecutionId: association.executionId,
    ...(eventAt === undefined ? {} : { eventAt }),
    resource: {
      ...host.input.resource,
      targetId: id,
      operation: eventAt === undefined ? "query.target" : "history.author",
    },
  };
  const allowed = await context.check(check);
  context.boundary();
  const latest = host.association(id);
  const candidate = host.agent(id);
  if (
    !allowed?.target ||
    !candidate ||
    candidate.presence === "gone" ||
    latest?.active !== 1 ||
    latest.executionId !== association.executionId
  )
    return null;
  context.onRetain(() => host.pin(check));
  return safeAgent(candidate, allowed.target);
}

/** Shared Task projection used by summary and feed; denied relationships omit the row. */
export async function managedTaskProjection(host: ManagedAttributionHost, task: Task, context: ProjectionContext) {
  // Legacy Person names are not proof of enrollment or native identity.
  if (task.claim && task.claim.holder.kind !== "agent") return null;
  for (const number of new Set([
    task.number,
    ...task.blockedBy,
    ...task.subtasks,
    ...(task.parent === undefined ? [] : [task.parent]),
    ...(task.claim?.blockedBy ?? []),
  ])) {
    const check: ChannelAuthorization = {
      ...host.input,
      action: "task.read",
      targetExecutionId: undefined,
      resource: { ...host.input.resource, targetId: String(number), operation: "query.task" },
    };
    if (!(await context.check(check))) return null;
  }
  if (!task.claim) return safeTask(task);
  if (task.claim.holder.kind !== "agent" || !(await managedAgentAttribution(host, task.claim.holder.agentId, context)))
    return null;
  return safeTask(task, { kind: "agent", agentId: task.claim.holder.agentId });
}
