import {
  type ChannelEvent,
  cleanAbsolutePath,
  isPermissionMode,
  type PermissionMode,
  permissionModeWithin,
  underRoots,
} from "../../shared/src/index";
import { managedStoredEvent } from "./managed-history";
import type { ProjectionContext, QueryBinding } from "./managed-query";
import type { ChannelAuthorization } from "./organization";

/** Preparation transport only. Never use the legacy history.request send path. */
export interface ManagedHistorySelector {
  kind: "forward" | "before" | "tail" | "ids";
  boundary?: number;
  ids?: readonly string[];
  taskNumber?: number;
  limit: number;
}
export interface ManagedHistoryHolder {
  /** Connection object identity, not a client-supplied socket name. */
  connection: object;
  hostId: string;
  executionId: string;
  principalId: string;
  ownerPersonId: string;
  agentId: string;
}
export interface ManagedHistoryLease {
  generation: number;
  policyRevision: number;
  expiresAt: number;
}
export interface ManagedHistoryRequest {
  type: "managed.history.request";
  id: string;
  queryId: string;
  binding: QueryBinding;
  requester: { kind: "person"; personId: string } | { kind: "execution"; executionId: string };
  hostId: string;
  executionId: string;
  selector: ManagedHistorySelector;
  projection: "shared.events";
  deadline: number;
  policyRevision: number;
}
export type ManagedHistoryResult =
  | { available: true; events: readonly NonNullable<ReturnType<typeof managedStoredEvent>>[] }
  | { available: false };
export class ManagedHistoryFailure extends Error {
  constructor(readonly status: 404 | 503) {
    super(status === 404 ? "resource_denied" : "managed_read_unavailable");
  }
}
export interface HolderProgress {
  exhausted: boolean;
  next: number | null;
}
interface Pending {
  request: ManagedHistoryRequest;
  holder: ManagedHistoryHolder;
  fence(): void;
  consumeCandidates(count: number): void;
  finish(value: readonly ChannelEvent[] | null, progress?: HolderProgress): void;
  abort(error: unknown): void;
}
/** Native enrollment plus machine-attested limits, never the advisory Host row.
 * Resolved paths must be supplied by the machine (including symlink resolution).
 */
export interface ManagedHistoryCeiling {
  workspaceId: string;
  generation: number;
  hostId: string;
  executionId: string;
  ownerPersonId: string;
  resolvedCwd: string;
  roots: readonly string[];
  mode: PermissionMode;
  maxMode: PermissionMode;
  activeExecutions: number;
  maxExecutions: number;
  allowedPersonIds: readonly string[];
  expiresAt: number;
}
export interface ManagedHistoryOptions {
  queryId: string;
  binding: QueryBinding;
  authorization: ChannelAuthorization;
  selector: ManagedHistorySelector;
  holder: ManagedHistoryHolder;
  context: ProjectionContext;
  policyRevision: number;
  preparationDeadline: number;
  configuredHistoryWaitMs: number;
  now(): number;
  /** Trusted enrollment/capability/local-ceiling resolver; never a login comparison. */
  holderCurrent(): boolean;
  /** Missing proof denies. Supplied only by trusted Channel enrollment resolution. */
  localCeiling(): ManagedHistoryCeiling | null;
  /** Internal acquisition evidence only; never expose raw progress as a public cursor. */
  holderProgress?(evidence: HolderProgress): void;
  /** B4 must supply its synchronous recipient lease check immediately before send. */
  recipientLease(): ManagedHistoryLease | null;
  send(connection: object, request: ManagedHistoryRequest): void;
}
const MAX_REPLY_BYTES = 1024 * 1024;
const MAX_REPLY_ROWS = 1000;
const unavailable = (): ManagedHistoryResult => ({ available: false });
const fail = (status: 404 | 503): never => {
  throw new ManagedHistoryFailure(status);
};
function selectorSnapshot(value: ManagedHistorySelector): ManagedHistorySelector {
  if (
    Object.keys(value).some((key) => !["kind", "boundary", "ids", "taskNumber", "limit"].includes(key)) ||
    !["forward", "before", "tail", "ids"].includes(value.kind) ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_REPLY_ROWS ||
    (value.taskNumber !== undefined && (!Number.isSafeInteger(value.taskNumber) || value.taskNumber < 1)) ||
    ((value.kind === "forward" || value.kind === "before") &&
      (!Number.isSafeInteger(value.boundary) || (value.boundary as number) < 0)) ||
    ((value.kind === "tail" || value.kind === "ids") && value.boundary !== undefined) ||
    (value.kind !== "ids" && value.ids !== undefined) ||
    (value.kind === "ids" &&
      (!value.ids?.length ||
        value.ids.length > MAX_REPLY_ROWS ||
        value.ids.some((id) => typeof id !== "string" || !id || id.length > 200)))
  )
    fail(404);
  return Object.freeze({
    kind: value.kind,
    limit: value.limit,
    ...(value.boundary === undefined ? {} : { boundary: value.boundary }),
    ...(value.taskNumber === undefined ? {} : { taskNumber: value.taskNumber }),
    ...(value.ids === undefined ? {} : { ids: Object.freeze([...value.ids]) }),
  });
}

/** One instance per managed Channel, allocated lazily; no storage or credentials. */
export class ManagedLocalHistory {
  private readonly pending = new Map<string, Pending>();
  private readonly queries = new Map<string, number>();

  get size(): number {
    return this.pending.size;
  }

  async request(options: ManagedHistoryOptions): Promise<ManagedHistoryResult> {
    const { context, authorization, holder } = options;
    const selector = selectorSnapshot(options.selector);
    const binding = Object.freeze({ ...options.binding });
    if (
      !options.queryId ||
      options.queryId.length > 200 ||
      !binding.operation ||
      authorization.action !== "channel.history.read" ||
      authorization.generation !== binding.generation ||
      authorization.resource.kind !== "workspace" ||
      authorization.resource.id !== binding.workspaceId ||
      authorization.resource.organizationId !== binding.organizationId ||
      authorization.resource.channel !== binding.channel ||
      !Number.isSafeInteger(options.policyRevision) ||
      options.policyRevision < 1 ||
      !Number.isFinite(options.preparationDeadline) ||
      !Number.isFinite(options.configuredHistoryWaitMs) ||
      options.configuredHistoryWaitMs < 0
    )
      fail(404);
    // Capture all identity fields; callers cannot widen pending requests by mutation.
    const target = Object.freeze({ ...holder });
    if (
      [target.hostId, target.executionId, target.principalId, target.ownerPersonId, target.agentId].some(
        (id) => typeof id !== "string" || !id || id.length > 200,
      )
    )
      fail(404);
    const scopes: ChannelAuthorization[] = [
      authorization,
      { ...authorization, action: "channel.update.read" },
      {
        ...authorization,
        action: "agent.view",
        targetExecutionId: target.executionId,
        resource: { ...authorization.resource, targetId: target.agentId, operation: "local.history.holder" },
      },
    ];
    let deadline = options.preparationDeadline;
    let requesterPersonId: string | undefined;
    const localFence = () => {
      const ceiling = options.localCeiling();
      if (
        !ceiling ||
        ceiling.workspaceId !== binding.workspaceId ||
        ceiling.generation !== binding.generation ||
        ceiling.hostId !== target.hostId ||
        ceiling.executionId !== target.executionId ||
        ceiling.ownerPersonId !== target.ownerPersonId ||
        !Number.isFinite(ceiling.expiresAt) ||
        options.now() >= ceiling.expiresAt ||
        !cleanAbsolutePath(ceiling.resolvedCwd) ||
        !ceiling.roots.length ||
        ceiling.roots.some((root) => !cleanAbsolutePath(root)) ||
        !underRoots(ceiling.resolvedCwd, ceiling.roots) ||
        !isPermissionMode(ceiling.mode) ||
        !isPermissionMode(ceiling.maxMode) ||
        !permissionModeWithin(ceiling.mode, ceiling.maxMode) ||
        !Number.isSafeInteger(ceiling.activeExecutions) ||
        !Number.isSafeInteger(ceiling.maxExecutions) ||
        ceiling.maxExecutions < 1 ||
        ceiling.activeExecutions < 0 ||
        ceiling.activeExecutions > ceiling.maxExecutions ||
        (requesterPersonId !== undefined &&
          requesterPersonId !== ceiling.ownerPersonId &&
          !ceiling.allowedPersonIds.includes(requesterPersonId))
      )
        fail(404);
    };
    const fence = () => {
      context.boundary();
      if (!options.holderCurrent() || options.now() >= deadline) fail(404);
      localFence();
    };
    const check = async () => {
      let requester: ManagedHistoryRequest["requester"] | undefined;
      for (const scope of scopes) {
        fence();
        const allowed = await context.check(scope);
        fence();
        if (!allowed) throw new ManagedHistoryFailure(404);
        deadline = Math.min(deadline, allowed.deadline);
        if (
          scope.action === "agent.view" &&
          (allowed.target?.executionId !== target.executionId ||
            allowed.target.principalId !== target.principalId ||
            allowed.target.ownerPersonId !== target.ownerPersonId)
        )
          fail(404);
        const actor = allowed.actor;
        requester =
          actor.kind === "person"
            ? { kind: "person", personId: actor.personId }
            : { kind: "execution", executionId: actor.executionId };
        fence();
      }
      return requester as ManagedHistoryRequest["requester"];
    };
    const requester = await check();
    // Existing OwnerConsent binds private actions to an Agent target, not a Host
    // read scope. It cannot prove Host consent for this shared-history protocol.
    // Cross-owner and delegated agent reads therefore stay closed until B3 can
    // supply that exact authority through decide(); never reinterpret screen or
    // terminal_control consent as a read-history grant.
    if (requester.kind !== "person" || requester.personId !== target.ownerPersonId) fail(404);
    requesterPersonId = requester.kind === "person" ? requester.personId : undefined;
    fence();
    const count = this.queries.get(options.queryId) ?? 0;
    if (count >= 32 || this.pending.size >= 128) fail(503);
    // QL-5: no holder can use the full legacy wait or overrun preparation/authority.
    const wait = Math.min(options.configuredHistoryWaitMs, deadline - options.now(), 2000);
    if (wait <= 0) return unavailable();
    const request: ManagedHistoryRequest = Object.freeze({
      type: "managed.history.request",
      id: crypto.randomUUID(),
      queryId: options.queryId,
      binding,
      requester: Object.freeze(requester),
      hostId: target.hostId,
      executionId: target.executionId,
      selector,
      projection: "shared.events",
      deadline: options.now() + wait,
      policyRevision: options.policyRevision,
    });
    let progress: HolderProgress | undefined;
    const rows = await new Promise<readonly ChannelEvent[] | null>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(request.id);
        const active = (this.queries.get(options.queryId) ?? 1) - 1;
        if (active) this.queries.set(options.queryId, active);
        else this.queries.delete(options.queryId);
      };
      const finish = (value: readonly ChannelEvent[] | null, evidence?: HolderProgress) => {
        progress = evidence;
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const abort = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      this.queries.set(options.queryId, count + 1);
      this.pending.set(request.id, {
        request,
        holder: target,
        fence: () => {
          fence();
          if (options.now() >= request.deadline) fail(404);
        },
        finish,
        abort,
        consumeCandidates: (count) => context.consumeCandidates(count),
      });
      timer = setTimeout(() => finish(null), wait);
      try {
        fence();
        const lease = options.recipientLease();
        if (
          !lease ||
          lease.generation !== binding.generation ||
          lease.policyRevision !== options.policyRevision ||
          !Number.isFinite(lease.expiresAt) ||
          options.now() >= lease.expiresAt
        )
          fail(404);
        // No await between the local fences/recipient lease and the transport effect.
        options.send(target.connection, request);
      } catch (error) {
        abort(error);
      }
    });
    fence();
    await check();
    fence();
    if (rows === null) return unavailable();
    // Projection precedes deduplication, sorting and visible limits.
    const visible = new Map<string, NonNullable<ReturnType<typeof managedStoredEvent>>>();
    for (const row of rows) {
      const projected = managedStoredEvent(row);
      if (!projected || row.actor.kind !== "agent" || row.actor.agentId !== target.agentId) continue;
      const admitted = await context.check({
        ...authorization,
        action: "agent.view",
        targetExecutionId: target.executionId,
        eventAt: Date.parse(row.at),
        resource: { ...authorization.resource, targetId: target.agentId, operation: "history.author" },
      });
      fence();
      if (!admitted) continue;
      if (
        admitted.target?.executionId !== target.executionId ||
        admitted.target.principalId !== target.principalId ||
        admitted.target.ownerPersonId !== target.ownerPersonId
      )
        fail(404);
      deadline = Math.min(deadline, admitted.deadline);
      const previous = visible.get(projected.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(projected)) fail(404);
      visible.set(projected.id, projected);
    }
    fence();
    // A later constituent may await after this holder has replied. Retain the
    // trusted holder/binding/deadline fence through the executor's final release.
    // onRetain commits it only when this projection is actually included.
    context.onRetain(() => {
      fence();
      context.onRelease?.(fence);
    });
    if (!progress) fail(503);
    if (progress) options.holderProgress?.(progress);
    return {
      available: true,
      events: [...visible.values()]
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id) || a.seq - b.seq)
        .slice(0, selector.limit),
    };
  }

  /** Caller passes the actual receiving connection, never frame-supplied identity. */
  reply(connection: object, raw: string): boolean {
    if (
      typeof raw !== "string" ||
      raw.length > MAX_REPLY_BYTES ||
      new TextEncoder().encode(raw).length > MAX_REPLY_BYTES
    )
      return false;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!body || typeof body !== "object" || typeof body.id !== "string") return false;
    const pending = this.pending.get(body.id);
    if (!pending || pending.holder.connection !== connection) return false;
    const { request } = pending;
    if (
      Object.keys(body).some(
        (key) =>
          ![
            "type",
            "id",
            "hostId",
            "executionId",
            "generation",
            "policyRevision",
            "selector",
            "events",
            "exhausted",
            "next",
          ].includes(key),
      ) ||
      body.type !== "managed.history.page" ||
      body.hostId !== request.hostId ||
      body.executionId !== request.executionId ||
      body.generation !== request.binding.generation ||
      body.policyRevision !== request.policyRevision ||
      JSON.stringify(body.selector) !== JSON.stringify(request.selector)
    )
      return false;
    try {
      pending.fence();
    } catch (error) {
      pending.abort(error);
      return false;
    }
    if (
      !Array.isArray(body.events) ||
      body.events.length > MAX_REPLY_ROWS ||
      body.events.length > request.selector.limit
    )
      return false;
    for (const row of body.events) {
      if (!validRow(row, request, pending.holder.agentId)) return false;
    }
    if (
      typeof body.exhausted !== "boolean" ||
      (body.exhausted
        ? body.next !== null
        : !Number.isSafeInteger(body.next) ||
          (body.next as number) < 0 ||
          (request.selector.kind === "forward" && (body.next as number) <= (request.selector.boundary ?? 0)) ||
          (request.selector.kind === "before" &&
            (body.next as number) >= (request.selector.boundary ?? Number.MAX_SAFE_INTEGER)) ||
          (request.selector.kind === "tail" && (body.next as number) >= Number.MAX_SAFE_INTEGER) ||
          request.selector.kind === "ids")
    )
      return false;
    try {
      // Raw rows count, including private and duplicate candidates, across every holder.
      pending.consumeCandidates(body.events.length);
    } catch (error) {
      pending.abort(error);
      return false;
    }
    pending.finish(body.events, { exhausted: body.exhausted, next: body.next as number | null });
    return true;
  }

  disconnect(connection: object): void {
    for (const pending of this.pending.values()) if (pending.holder.connection === connection) pending.finish(null);
  }
  invalidate(): void {
    for (const pending of this.pending.values()) pending.abort(new ManagedHistoryFailure(404));
  }
}

function validRow(raw: unknown, request: ManagedHistoryRequest, agentId: string): raw is ChannelEvent {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as ChannelEvent;
  const selector = request.selector;
  if (
    typeof row.id !== "string" ||
    !row.id ||
    row.id.length > 200 ||
    !Number.isSafeInteger(row.seq) ||
    row.seq < 0 ||
    typeof row.at !== "string" ||
    !Number.isFinite(Date.parse(row.at)) ||
    !row.actor ||
    row.actor.kind !== "agent" ||
    row.actor.agentId !== agentId ||
    !row.payload ||
    typeof row.payload !== "object"
  )
    return false;
  if (selector.kind === "before" && row.seq >= (selector.boundary as number)) return false;
  if (selector.kind === "forward" && row.seq <= (selector.boundary as number)) return false;
  if (selector.ids && !selector.ids.includes(row.id)) return false;
  if (selector.taskNumber !== undefined && row.task !== selector.taskNumber) return false;
  // Unknown/private types are omitted, never interpreted as a shared payload.
  if (row.type === "update")
    return (
      typeof row.payload.text === "string" &&
      (row.payload.to === undefined ||
        (Array.isArray(row.payload.to) && row.payload.to.every((id) => typeof id === "string")))
    );
  if (row.type === "presence") return ["live", "idle", "paused", "gone"].includes(row.payload.presence);
  return typeof row.type === "string";
}
