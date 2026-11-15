import type { NativeResult } from "../../shared/src/m1";
import { type QueryAuthority, type QueryGuard, type QueryPlan, runManagedQuery } from "./managed-query";
import type { ChannelAuthorization } from "./organization";
import type { MutationPermit, PermitBinding } from "./policy-permits";
import { AuthorityUnavailable, authorityRequest, resourceKey } from "./policy-permits";

export interface ManagedReadRoute {
  action: string;
  targetId: string;
  operation: string;
}
/** Explicit read inventory. Every other managed operation remains closed until implemented. */
function matchReadRoute(method: string, path: string): ManagedReadRoute | null {
  if (method === "POST" && path === "/api/skill-files/read")
    return { action: "channel.update.read", targetId: "skill-files", operation: "skill-files.read" };
  if (method !== "GET") return null;
  if (path === "/api/persons") return { action: "workspace.read", targetId: "persons", operation: "persons.read" };
  if (path === "/api/events") return { action: "channel.history.read", targetId: "events", operation: "history.read" };
  if (path === "/api/github") return { action: "task.read", targetId: "github", operation: "github.read" };
  if (path === "/api/memory") return { action: "channel.history.read", targetId: "memory", operation: "memory.read" };
  if (["/api/skills", "/api/artifacts", "/api/brief"].includes(path))
    return { action: "channel.update.read", targetId: path.slice(5), operation: "content.list" };
  const content = /^\/api\/(skills|artifacts|brief)\/([^/]+)(\/page)?$/.exec(path);
  if (content?.[1] && content[2]) {
    try {
      const name = decodeURIComponent(content[2]);
      if (
        !name ||
        /[/\\]/.test(name) ||
        [...name].some((character) => character.charCodeAt(0) < 32) ||
        (content[3] && content[1] !== "artifacts")
      )
        return null;
      return {
        action: "channel.update.read",
        targetId: `${content[1]}/${name}`,
        operation: content[3] ? "content.page" : "content.read",
      };
    } catch {
      return null;
    }
  }
  if (path === "/api/agents") return { action: "agent.view", targetId: "agents", operation: "agents.list" };
  const summary = /^\/api\/agents\/([^/]+)\/summary$/.exec(path);
  if (summary?.[1]) {
    try {
      const id = decodeURIComponent(summary[1]);
      if (!/^[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(id)) return null;
      return { action: "agent.view", targetId: id, operation: "agent.summary" };
    } catch {
      return null;
    }
  }

  const privateRead = /^\/api\/agents\/([^/]+)\/(transcript|terminal|touched-files)$/.exec(path);
  if (privateRead?.[1] && privateRead[2]) {
    try {
      const id = decodeURIComponent(privateRead[1]);
      if (!/^[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(id)) return null;
      return {
        action: privateRead[2] === "terminal" ? "agent.private_screen.read" : "agent.private_transcript.read",
        targetId: id,
        operation: privateRead[2],
      };
    } catch {
      return null;
    }
  }

  const task = /^\/api\/tasks\/([1-9]\d{0,9})$/.exec(path);
  if (path === "/api/tasks" || task)
    return { action: "task.read", targetId: task?.[1] ?? "tasks", operation: "task.read" };
  if (path === "/api/relay") return { action: "workspace.read", targetId: "relay", operation: "relay.read" };
  return null;
}

export class ManagedReadFailure extends Error {
  constructor(readonly status: 404 | 502 | 503) {
    super("managed_read_unavailable");
  }
}

export function managedError(status: number, reason: string): Response {
  return Response.json({ ok: false, reason }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Recheck each constituent separately; never substitute the outer query's scope. */
export async function managedQueryAuthorization(
  input: ChannelAuthorization,
  constituents: readonly ChannelAuthorization[],
  authorize: (input: ChannelAuthorization) => Promise<NativeResult<unknown>>,
  current: () => boolean,
): Promise<NativeResult<unknown>> {
  const denied = { ok: false, status: 403, reason: "resource_denied", policyRevision: 0 } as const;
  let revision: number | undefined;
  for (const check of [...constituents, input]) {
    if (!current()) return denied;
    const result = await authorityRequest(() => authorize({ ...check, actor: input.actor }));
    if (!current()) return denied;
    if (!result.ok) return result;
    if (revision !== undefined && revision !== result.policyRevision) return denied;
    revision = result.policyRevision;
  }
  return { ok: true, value: {}, policyRevision: revision ?? 0 };
}

/** No cache: check before the read and again after every asynchronous read/preparation. */
export async function managedRead<T>(options: {
  input: ChannelAuthorization;
  current(): boolean;
  authorize(input: ChannelAuthorization): Promise<NativeResult<unknown>>;
  read(): Promise<T>;
}): Promise<Response> {
  try {
    const admitted = await authorityRequest(() => options.authorize(options.input));
    if (!admitted.ok || !options.current()) return managedError(404, "resource_denied");
    const value = await options.read();
    if (!options.current()) return managedError(404, "resource_denied");
    const released = await authorityRequest(() => options.authorize(options.input));
    if (!released.ok || !options.current()) return managedError(404, "resource_denied");
    return value instanceof Response ? value : Response.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ManagedReadFailure)
      return managedError(error.status, error.status === 404 ? "resource_denied" : "managed_read_unavailable");
    if (error instanceof AuthorityUnavailable) return managedError(503, "authority_unavailable");
    // Do not expose external error messages, paths or partially prepared content.
    return managedError(503, "managed_read_unavailable");
  }
}

/** Only implemented mutations are admitted; an unrecognized router path remains denied. */
function matchWriteRoute(method: string, path: string): ManagedReadRoute | null {
  if (method === "DELETE" || method === "PUT") {
    const read = managedReadRoute("GET", path);
    if (method === "PUT" && read?.operation === "content.read" && read.targetId.startsWith("brief/"))
      return { ...read, action: "channel.update.write", operation: "brief.write" };
    return read?.operation === "content.read" && read.targetId.startsWith("artifacts/")
      ? {
          ...read,
          action: "channel.update.write",
          operation: method === "PUT" ? "artifact.publish" : "artifact.delete",
        }
      : null;
  }
  if (method !== "POST") return null;
  if (path === "/api/memory") return { action: "channel.update.write", targetId: "memory", operation: "memory.write" };
  if (path === "/api/directives")
    return { action: "agent.directive.send", targetId: "directives", operation: "directive.send" };
  if (path === "/api/updates") return { action: "channel.update.write", targetId: "updates", operation: "update.post" };
  const task =
    /^\/api\/tasks\/([1-9]\d{0,9})\/(claim|release|branch|finish|takeover|steps\/(0|[1-9]\d{0,4})\/complete)$/.exec(
      path,
    );
  if (!task?.[1] || !task[2]) return null;
  return {
    action: task[2] === "claim" ? "task.claim" : "task.update",
    targetId: task[1],
    operation: `task.${task[2]}`,
  };
}

/** Admission metadata for implemented operations only. Unknown operations stay closed. */
export const MANAGED_OPERATIONS = {
  "skill-files.read": { action: "channel.update.read", mode: "read" },
  "persons.read": { action: "workspace.read", mode: "read" },
  "history.read": { action: "channel.history.read", mode: "read" },
  "github.read": { action: "task.read", mode: "read" },
  "memory.read": { action: "channel.history.read", mode: "read" },
  "content.list": { action: "channel.update.read", mode: "read" },
  "content.read": { action: "channel.update.read", mode: "read" },
  "content.page": { action: "channel.update.read", mode: "read" },
  "agents.list": { action: "agent.view", mode: "read" },
  "agent.summary": { action: "agent.view", mode: "read" },
  transcript: { action: "agent.private_transcript.read", mode: "read" },
  terminal: { action: "agent.private_screen.read", mode: "read" },
  "touched-files": { action: "agent.private_transcript.read", mode: "read" },
  "task.read": { action: "task.read", mode: "read" },
  "relay.read": { action: "workspace.read", mode: "read" },
  "brief.write": { action: "channel.update.write", mode: "write" },
  "artifact.publish": { action: "channel.update.write", mode: "write" },
  "artifact.delete": { action: "channel.update.write", mode: "write" },
  "memory.write": { action: "channel.update.write", mode: "write" },
  "directive.send": { action: "agent.directive.send", mode: "write" },
  "update.post": { action: "channel.update.write", mode: "write" },
  "task.claim": { action: "task.claim", mode: "write" },
  "task.release": { action: "task.update", mode: "write" },
  "task.branch": { action: "task.update", mode: "write" },
  "task.finish": { action: "task.update", mode: "write" },
  "task.takeover": { action: "task.update", mode: "write" },
  "task.step.complete": { action: "task.update", mode: "write" },
} as const;

export interface ManagedOperation extends ManagedReadRoute {
  id: keyof typeof MANAGED_OPERATIONS;
  mode: "read" | "write";
}

function descriptor(route: ManagedReadRoute | null): ManagedOperation | null {
  if (!route) return null;
  const id = (
    /^task\.steps\/\d+\/complete$/.test(route.operation) ? "task.step.complete" : route.operation
  ) as keyof typeof MANAGED_OPERATIONS;
  if (!Object.hasOwn(MANAGED_OPERATIONS, id)) return null;
  const definition = MANAGED_OPERATIONS[id];
  // Registry is authoritative; a matcher cannot silently broaden an action.
  if (definition.action !== route.action) return null;
  return { ...route, id, ...definition };
}

/** Compatibility matchers retain their original result shape for existing callers. */
export function managedReadRoute(method: string, path: string): ManagedReadRoute | null {
  const result = descriptor(matchReadRoute(method, path));
  return result ? { action: result.action, targetId: result.targetId, operation: result.operation } : null;
}
export function managedWriteRoute(method: string, path: string): ManagedReadRoute | null {
  const result = descriptor(matchWriteRoute(method, path));
  return result ? { action: result.action, targetId: result.targetId, operation: result.operation } : null;
}
export function managedOperationRoute(method: string, path: string): ManagedOperation | null {
  return descriptor(matchWriteRoute(method, path) ?? matchReadRoute(method, path));
}

/** Construct only after selecting the linked branch. No policy decisions or cache here. */
export function managedEnforcement<TAuthority>(options: {
  current(): boolean;
  authorize(input: ChannelAuthorization): Promise<NativeResult<TAuthority>>;
}) {
  return {
    query<T>(this: QueryAuthority, plan: QueryPlan<T>, guard: QueryGuard) {
      return runManagedQuery(plan, this, guard);
    },
    async check(input: ChannelAuthorization): Promise<NativeResult<TAuthority>> {
      if (!options.current()) return { ok: false, status: 403, reason: "resource_denied", policyRevision: 0 };
      const result = await authorityRequest(() => options.authorize(input));
      return options.current() ? result : { ok: false, status: 403, reason: "resource_denied", policyRevision: 0 };
    },
    read<T>(
      input: ChannelAuthorization,
      read: () => Promise<T>,
      project: (value: T) => unknown = (value) => value,
    ): Promise<Response> {
      return managedRead({ ...options, input, read: async () => project(await read()) });
    },
    async prepare<T>(
      expected: Omit<PermitBinding, "policyRevision">,
      issue: () => Promise<NativeResult<MutationPermit>>,
      local: (permit: MutationPermit) => T,
    ): Promise<T> {
      if (!options.current()) throw new ManagedReadFailure(404);
      const result = await authorityRequest(issue);
      if (!result.ok || !options.current()) throw new ManagedReadFailure(404);
      const permit = result.value;
      const now = Date.now();
      const sameActor =
        permit.actor.kind === "person" && expected.actor.kind === "person"
          ? permit.actor.personId === expected.actor.personId && permit.actor.githubId === expected.actor.githubId
          : permit.actor.kind === "execution" &&
            expected.actor.kind === "execution" &&
            permit.actor.executionId === expected.actor.executionId &&
            permit.actor.principalId === expected.actor.principalId &&
            permit.actor.workspaceId === expected.actor.workspaceId;
      if (
        !sameActor ||
        permit.action !== expected.action ||
        resourceKey(permit.resource) !== resourceKey(expected.resource) ||
        permit.requestId !== expected.requestId ||
        permit.generation !== expected.generation ||
        permit.policyRevision !== result.policyRevision ||
        !Number.isSafeInteger(permit.policyRevision) ||
        permit.policyRevision < 1 ||
        !Number.isFinite(permit.issuedAt) ||
        !Number.isFinite(permit.expiresAt) ||
        now < permit.issuedAt ||
        now >= permit.expiresAt ||
        permit.expiresAt <= permit.issuedAt ||
        permit.expiresAt > permit.issuedAt + 2000
      )
        throw new ManagedReadFailure(404);
      // No await between the generation fence and installation of a receipt.
      // The local closure must consume inside its synchronous write transaction.
      return local(permit);
    },
  };
}
