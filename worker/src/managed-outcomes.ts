import type { AdminAuditRecord, PolicyResource } from "../../shared/src/m1";
import { MANAGED_OUTCOME_TTL_MS, type ManagedOutcomeTable } from "./managed-retention";

export const OUTCOME_BATCH_SIZE = 25;
export const OUTCOME_TABLES: readonly ManagedOutcomeTable[] = ["managed_outcome_outbox", "managed_external_outcomes"];
const OUTCOMES = new Set([
  "committed",
  "local_restriction_denied",
  "update_budget_exhausted",
  "external_pending",
  "external_intent",
  "pr_created",
  "pr_failed",
]);

/** Internal audit delivery protocol, never a content or authorization facade. */
export interface ManagedOutcome {
  table: ManagedOutcomeTable;
  id: string;
  requestId: string;
  actor: AdminAuditRecord["actor"];
  action: string;
  resource: PolicyResource;
  policyRevision: number;
  outcome: string;
  at: number;
}
function identifier(value: unknown, max = 500): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32)
  );
}

/** Construct by allowlist on both sides of the RPC. Never forward stored bodies. */
export function managedOutcome(
  table: ManagedOutcomeTable,
  id: string,
  value: unknown,
  now = Date.now(),
): ManagedOutcome | null {
  if (!OUTCOME_TABLES.includes(table) || !identifier(id, 200) || !value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const resource = body.resource as Partial<PolicyResource> | undefined;
  const actor = body.actor as Partial<AdminAuditRecord["actor"]> | undefined;
  if (
    !identifier(body.action, 80) ||
    typeof body.outcome !== "string" ||
    !OUTCOMES.has(body.outcome) ||
    typeof body.at !== "number" ||
    !Number.isSafeInteger(body.at) ||
    body.at > now ||
    body.at <= now - MANAGED_OUTCOME_TTL_MS ||
    !Number.isSafeInteger(body.policyRevision) ||
    (body.policyRevision as number) < 1 ||
    resource?.kind !== "workspace" ||
    !identifier(resource.organizationId, 100) ||
    !identifier(resource.id, 100) ||
    !identifier(resource.channel) ||
    !identifier(resource.targetId) ||
    !identifier(resource.operation) ||
    !actor
  )
    return null;
  let safeActor: AdminAuditRecord["actor"];
  if (actor.kind === "person" && identifier(actor.personId, 100))
    safeActor = { kind: "person", personId: actor.personId };
  else if (
    actor.kind === "execution" &&
    identifier(actor.executionId, 100) &&
    identifier(actor.principalId, 100) &&
    identifier(actor.workspaceId, 100)
  )
    safeActor = {
      kind: "execution",
      executionId: actor.executionId,
      principalId: actor.principalId,
      workspaceId: actor.workspaceId,
    };
  else return null;
  return {
    table,
    id,
    requestId: identifier(body.requestId, 200) ? body.requestId : id,
    actor: safeActor,
    action: body.action,
    resource: {
      kind: "workspace",
      organizationId: resource.organizationId,
      id: resource.id,
      channel: resource.channel,
      targetId: resource.targetId,
      operation: resource.operation,
    },
    policyRevision: body.policyRevision as number,
    outcome: body.outcome,
    at: body.at,
  };
}

/** External phases share an id; each phase is an immutable, independently replayable audit fact. */
export function outcomeAuditId(outcome: ManagedOutcome): string {
  return JSON.stringify(["channel-outcome", outcome.resource.channel, outcome.table, outcome.id, outcome.outcome]);
}
