import type { NativeResult } from "../../shared/src/m1";
import { registeredQueryPlan } from "./managed-query-registry";
import type { ChannelAuthorization, Organization } from "./organization";
import { AuthorityUnavailable, authorityRequest } from "./policy-permits";

export type AuthorityValue = Extract<Awaited<ReturnType<Organization["authorizeChannelRead"]>>, { ok: true }>["value"];
export type QueryId = "history" | "persons" | "agents" | "github" | "summary" | "librarian";
export type ConstituentId = "events" | "agents" | "persons" | "tasks" | "history" | "notes" | "brief";
export interface QueryBinding {
  organizationId: string;
  workspaceId: string;
  channel: string;
  generation: number;
  operation: string;
}
export interface QueryScope {
  id: QueryId;
  binding: QueryBinding;
  authorization: ChannelAuthorization;
}
export interface QueryGuard {
  /** Adapter captures this before credential resolution. */
  preparationDeadline?: number;
  bindingCurrent(): boolean;
  revisionFloor(): number;
  now(): number;
}
export interface QueryAuthority {
  check(input: ChannelAuthorization): Promise<NativeResult<AuthorityValue>>;
}
export interface QueryRow {
  key: string;
  value: unknown;
}
export interface ProjectionContext {
  /** Synchronous local fences are installed only if this projection survives. */
  onRetain(effect: () => void): void;
  check(input: ChannelAuthorization): Promise<AuthorityValue | null>;
  boundary(): void;
}
export interface ProjectionSpec<T> {
  id: string;
  project(row: QueryRow, context: ProjectionContext): Promise<T | null>;
}
export interface PageRequest {
  source: "stored" | "merged" | "local";
  selector:
    | { kind: "forward"; after: number }
    | { kind: "before"; before: number }
    | { kind: "tail" }
    | { kind: "ids"; ids: readonly string[] };
  agentId?: string;
  taskNumber?: number;
  wakesOnly: boolean;
  limit: number;
  cursor?: string;
}
export interface CandidateWindow {
  rows: readonly QueryRow[];
  nextInternal: string | null;
  exhausted: boolean;
}
export interface ConstituentDescriptor<T> {
  id: ConstituentId;
  authorization: ChannelAuthorization;
  page: PageRequest;
  projection: ProjectionSpec<T>;
  readWindow(position: string | null, limit: number): Promise<CandidateWindow>;
}
export interface QueryPlan<T> {
  scope: QueryScope;
  constituents: readonly ConstituentDescriptor<unknown>[];
  assemble(parts: ReadonlyMap<ConstituentId, readonly unknown[]>): T;
}
export interface QueryEnvelope<T> {
  value: T;
  policyRevision: number;
  deadline: number;
}
export type QueryFailureReason =
  | "resource_denied"
  | "query_unavailable"
  | "authority_unavailable"
  | "managed_read_unavailable";
export type QueryResult<T> =
  | { ok: true; envelope: QueryEnvelope<T> }
  | { ok: false; error: { status: 404 | 502 | 503; reason: QueryFailureReason } };
class QueryFailure extends Error {
  constructor(
    readonly status: 404 | 502 | 503,
    readonly reason: QueryFailureReason,
  ) {
    super(reason);
  }
}
const deny = (): never => {
  throw new QueryFailure(404, "resource_denied");
};
const unavailable = (): never => {
  throw new QueryFailure(503, "managed_read_unavailable");
};
export const QUERY_WINDOW_CAP = 1000;
export const QUERY_CANDIDATE_CAP = 10000;

/** Preparation only: all authority is freshly obtained from Organization/decide. */
export async function runManagedQuery<T>(
  plan: QueryPlan<T>,
  authority: QueryAuthority,
  guard: QueryGuard,
): Promise<QueryResult<T>> {
  const preparationDeadline = Math.min(guard.now() + 10000, guard.preparationDeadline ?? Infinity);
  let revision: number | undefined;
  const deadlines: number[] = [];
  const release: ChannelAuthorization[] = [];
  const rowRelease: ChannelAuthorization[] = [];
  const binding = plan.scope.binding;
  const boundary = () => {
    const now = guard.now();
    if (now >= preparationDeadline) throw new QueryFailure(503, "query_unavailable");
    if (
      !guard.bindingCurrent() ||
      deadlines.some((deadline) => now >= deadline) ||
      (revision !== undefined && guard.revisionFloor() > revision)
    )
      deny();
  };
  const exactBinding = (input: ChannelAuthorization) =>
    input.generation === binding.generation &&
    input.resource.kind === "workspace" &&
    input.resource.organizationId === binding.organizationId &&
    input.resource.id === binding.workspaceId &&
    input.resource.channel === binding.channel &&
    input.actor === plan.scope.authorization.actor;
  const wait = async <V>(operation: () => Promise<V>): Promise<V> => {
    boundary();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new QueryFailure(503, "query_unavailable")),
            Math.max(0, preparationDeadline - guard.now()),
          );
        }),
      ]);
      boundary();
      return value;
    } finally {
      clearTimeout(timer);
    }
  };
  const check = async (input: ChannelAuthorization): Promise<AuthorityValue | null> => {
    if (!exactBinding(input)) deny();
    const result = await wait(() => authorityRequest(() => authority.check(input), preparationDeadline - guard.now()));
    if (!result.ok) return null;
    if (
      !Number.isSafeInteger(result.policyRevision) ||
      result.policyRevision < 1 ||
      !Number.isFinite(result.value.deadline)
    )
      deny();
    if (revision !== undefined && revision !== result.policyRevision) deny();
    revision = result.policyRevision;
    deadlines.push(result.value.deadline);
    boundary();
    return result.value;
  };
  try {
    if (!registeredQueryPlan(plan) || !binding.operation || !exactBinding(plan.scope.authorization)) deny();
    boundary();
    if (!(await check(plan.scope.authorization))) deny();

    const parts = new Map<ConstituentId, readonly unknown[]>();
    let candidates = 0;
    let retained = 0;
    let windows = 0;
    for (const constituent of plan.constituents) {
      // A source protected by the exact outer scope is the same scope, not a new grant.
      if (constituent.authorization !== plan.scope.authorization) {
        if (!(await check(constituent.authorization))) deny();
        release.push(constituent.authorization);
      }
      const output: unknown[] = [];
      const keys = new Set<string>();
      const positions = new Set<string>();
      let position: string | null = null;
      while (output.length < constituent.page.limit) {
        if (candidates >= QUERY_CANDIDATE_CAP || ++windows > QUERY_CANDIDATE_CAP) unavailable();
        const limit = Math.min(QUERY_WINDOW_CAP, QUERY_CANDIDATE_CAP - candidates);
        const window = await wait(() => constituent.readWindow(position, limit));
        if (window.rows.length > limit) unavailable();
        candidates += window.rows.length;
        for (const row of window.rows) {
          boundary();
          if (keys.has(row.key)) continue;
          const dependencies: ChannelAuthorization[] = [];
          const retainedEffects: (() => void)[] = [];
          const deadlineStart = deadlines.length;
          const projected = await wait(() =>
            constituent.projection.project(row, {
              boundary,
              onRetain: (effect) => retainedEffects.push(effect),
              check: async (input) => {
                const result = await check(input);
                if (result) dependencies.push(input);
                return result;
              },
            }),
          );
          // QL-3: dependencies from discarded candidates never survive to release.
          if (projected === null) {
            deadlines.splice(deadlineStart);
            continue;
          }
          for (const effect of retainedEffects) effect();
          boundary();
          keys.add(row.key);
          output.push(projected);
          rowRelease.push(...dependencies);
          if (++retained > QUERY_CANDIDATE_CAP) unavailable();
          if (output.length === constituent.page.limit) break;
        }
        if (output.length === constituent.page.limit || window.exhausted) break;
        const next = window.nextInternal;
        if (next === null || next === position || positions.has(next))
          throw new QueryFailure(503, "managed_read_unavailable");
        positions.add(next);
        position = next;
      }
      parts.set(constituent.id, output);
    }
    for (const input of [...rowRelease, ...release, plan.scope.authorization]) if (!(await check(input))) deny();
    boundary();
    const value = plan.assemble(parts);
    boundary();
    return {
      ok: true,
      envelope: { value, policyRevision: revision ?? 0, deadline: Math.min(preparationDeadline, ...deadlines) },
    };
  } catch (error) {
    if (error instanceof QueryFailure) return { ok: false, error: { status: error.status, reason: error.reason } };
    if (error instanceof AuthorityUnavailable)
      return { ok: false, error: { status: 503, reason: "authority_unavailable" } };
    // Preserve redacted external reader failures without importing route modules.
    const status =
      error instanceof Error && "status" in error && (error.status === 502 || error.status === 404)
        ? error.status
        : 503;
    return { ok: false, error: { status, reason: status === 404 ? "resource_denied" : "managed_read_unavailable" } };
  }
}

/** Serialize only the route schema; policy revisions remain internal (QL-1/QL-2). */
export function managedQueryResponse<T>(result: QueryResult<T>, guard: QueryGuard): Response {
  if (
    result.ok &&
    (!guard.bindingCurrent() ||
      guard.revisionFloor() > result.envelope.policyRevision ||
      guard.now() >= result.envelope.deadline)
  )
    return Response.json(
      { ok: false, reason: "resource_denied" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  return result.ok
    ? result.envelope.value instanceof Response
      ? result.envelope.value
      : Response.json(result.envelope.value, { headers: { "Cache-Control": "no-store" } })
    : Response.json(
        { ok: false, reason: result.error.reason },
        { status: result.error.status, headers: { "Cache-Control": "no-store" } },
      );
}
