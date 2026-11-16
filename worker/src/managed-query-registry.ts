import type { QueryId, QueryPlan } from "./managed-query";

/** Trusted factories only. Request bodies never supply callbacks or policy scopes. */
export const MANAGED_QUERIES = {
  "connector.channel": {
    operation: "connector.channel",
    action: "workspace.read",
    constituents: ["events", "agents", "history", "tasks", "notes"],
  },
  "connector.github": { operation: "connector.github", action: "task.read", constituents: ["tasks"] },
  "connector.brief": { operation: "connector.brief", action: "channel.update.read", constituents: ["brief"] },
  "stream.event": {
    operation: "stream.event",
    action: "channel.history.read",
    constituents: ["events", "agents", "tasks", "persons"],
  },
  "stream.backlog": {
    operation: "stream.backlog",
    action: "channel.history.read",
    constituents: ["events", "agents", "tasks", "persons"],
  },
  "local.history": { operation: "local.history", action: "channel.history.read", constituents: ["events", "agents"] },
  librarian: {
    operation: "librarian.read",
    action: "channel.history.read",
    constituents: ["tasks", "brief", "events"],
  },
  summary: {
    operation: "agent.summary",
    action: "agent.view",
    constituents: ["history", "agents", "tasks", "events", "notes"],
  },
  history: { operation: "history.read", action: "channel.history.read", constituents: ["events", "agents"] },
  persons: { operation: "persons.read", action: "workspace.read", constituents: ["persons"] },
  agents: { operation: "agents.list", action: "agent.view", constituents: ["agents"] },
  github: { operation: "github.read", action: "task.read", constituents: ["tasks"] },
} as const;
const plans = new WeakSet<object>();
export function createManagedQuery<T>(plan: QueryPlan<T>): QueryPlan<T> {
  const definition = Object.hasOwn(MANAGED_QUERIES, plan.scope.id)
    ? MANAGED_QUERIES[plan.scope.id as QueryId]
    : undefined;
  if (
    !definition ||
    definition.action !== plan.scope.authorization.action ||
    definition.operation !== plan.scope.authorization.resource.operation ||
    new Set(plan.constituents.map((part) => part.id)).size !== plan.constituents.length ||
    plan.constituents.length !== definition.constituents.length ||
    plan.constituents.some(
      (part) =>
        !(definition.constituents as readonly string[]).includes(part.id) ||
        !Number.isSafeInteger(part.page.limit) ||
        part.page.limit < 1 ||
        part.page.limit > 10000,
    )
  )
    throw new Error("unknown_managed_query");
  const actions = {
    events: "channel.update.read",
    history: "channel.history.read",
    notes: "channel.update.read",
    brief: "channel.update.read",
    agents: "agent.view",
    persons: "workspace.read",
    tasks: "task.read",
  };
  if (plan.constituents.some((part) => part.authorization.action !== actions[part.id]))
    throw new Error("invalid_query_constituent");
  // Freeze all authority-bearing descriptors, preventing post-registration widening.
  for (const part of plan.constituents) {
    Object.freeze(part.authorization.resource);
    Object.freeze(part.authorization);
    Object.freeze(part.page);
    Object.freeze(part.projection);
    Object.freeze(part);
  }
  Object.freeze(plan.scope.authorization.resource);
  Object.freeze(plan.scope.authorization);
  Object.freeze(plan.scope.binding);
  Object.freeze(plan.scope);
  Object.freeze(plan.constituents);
  Object.freeze(plan);
  plans.add(plan);
  return plan;
}
export function registeredQueryPlan(plan: object): boolean {
  return plans.has(plan);
}

/** Resolve completed operation metadata, never a client-supplied query ID. */
export function managedQueryId(operation: string): QueryId | undefined {
  return (Object.keys(MANAGED_QUERIES) as QueryId[]).find((id) => MANAGED_QUERIES[id].operation === operation);
}

/** Actor-aware internal preparation only; this is not MCP/stream admission. */
export const MANAGED_PREPARATIONS = {
  "connector.channel": { path: "/api/events", targetId: "channel", base: "history" },
  "connector.github": { path: "/api/github", targetId: "github", base: "github" },
  "connector.brief": { path: "/api/brief", targetId: "brief", base: "brief" },
  "stream.event": { path: "/api/events", targetId: "events", base: "history" },
  "stream.backlog": { path: "/api/events", targetId: "events", base: "history" },
  "local.history": { path: "/api/events", targetId: "events", base: "history" },
} as const;
export type ManagedPreparationId = keyof typeof MANAGED_PREPARATIONS;
export interface ManagedPreparationRequest {
  id: ManagedPreparationId;
  actor: import("./organization").ChannelAuthorization["actor"];
  generation: number;
  /** Required for a native Person resolved from an expiring session by the caller. */
  credentialExpiresAt?: number;
  /** Parsed by the same bounded selectors as HTTP; never authority metadata. */
  selectors?: string;
}
