import { parseRegister } from "./agents-api";
import { MANAGED_OUTCOME_TTL_MS, MANAGED_RECORD_CAP } from "./managed-retention";
import { AuthorityUnavailable, LocalMutationPermits, type MutationPermit, type PermitBinding } from "./policy-permits";

export type IntentState =
  | "prepared"
  | "activated"
  | "cancelling"
  | "cancelled"
  | "expired"
  | "failed"
  | "applied"
  | "completed"
  | "applied-failed";
export interface IntentPayload {
  intentId: string;
  organizationId: string;
  workspaceId: string;
  channelId: string;
  bindingGeneration: number;
  actorPersonId: string;
  actorGithubId: string;
  principalId: string;
  reservedExecutionId: string;
  agentId: string;
  hostId: string | null;
  ownerPersonId: string;
  predecessorExecutionId: string | null;
  predecessorAgentId: string | null;
  requestId: string;
  reservationId: string;
  startPermitId: string;
  handoffPermitId: string;
  policyRevision: number;
  verifiedOwnerHandoff: true;
  createdAt: number;
  expiresAt: number;
  /** Canonical allowlisted registration inputs; validation belongs to managed preparation. */
  request: string;
}
export interface StoredIntent {
  payload: IntentPayload;
  state: IntentState;
  failureCode: string | null;
  appliedAt: number | null;
  completedAt: number | null;
  cancelRequestedAt: number | null;
}
export class IntentConflict extends Error {
  readonly status = 409;
  constructor() {
    super("registration_intent_conflict");
  }
}
export class InvalidIntent extends Error {
  readonly status = 400;
  constructor() {
    super("invalid_registration_intent");
  }
}
/** Canonical bounded request allowlist, never raw authentication/registration JSON. */
export function registrationIntentRequest(input: Record<string, unknown>): string {
  const allowed: Record<string, unknown> = {};
  for (const key of [
    "cli",
    "sessionId",
    "resumed",
    "cwd",
    "nickname",
    "librarian",
    "continues",
    "host",
    "historyHost",
    "spawn",
    "usage",
  ])
    if (input[key] !== undefined) allowed[key] = input[key];
  for (const [key, limit] of [
    ["sessionId", 256],
    ["cwd", 4096],
    ["nickname", 128],
    ["continues", 256],
    ["host", 256],
    ["historyHost", 256],
    ["spawn", 256],
  ] as const) {
    const value = allowed[key];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" || new TextEncoder().encode(value).length > limit)
    )
      throw new InvalidIntent();
  }
  const parsed = parseRegister(allowed);
  if (!parsed.ok) throw new InvalidIntent();
  const validate = (value: unknown, depth: number): void => {
    if (depth > 5) throw new InvalidIntent();
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER))
      throw new InvalidIntent();
    if (typeof value === "string" && new TextEncoder().encode(value).length > 256) throw new InvalidIntent();
    if (value && typeof value === "object") for (const entry of Object.values(value)) validate(entry, depth + 1);
  };
  validate(allowed.usage, 0);
  validate(parsed.value.usage, 0);
  return JSON.stringify(parsed.value);
}
const transitions: Record<IntentState, readonly IntentState[]> = {
  prepared: ["activated", "cancelling"],
  activated: ["applied", "cancelling"],
  cancelling: ["cancelled", "expired", "failed"],
  applied: ["completed", "applied-failed"],
  completed: [],
  cancelled: [],
  expired: [],
  failed: [],
  "applied-failed": [],
};
/** Lazy managed-only storage primitive, NOT registration authorization or a protocol entry point.
 * Caller owns transactionSync, request validation, external authority and independent binding reconstruction.
 */
export class RegistrationIntents {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS registration_intents (
      intentId TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, bindingGeneration INTEGER NOT NULL,
      actorPersonId TEXT NOT NULL, requestId TEXT NOT NULL, agentId TEXT NOT NULL, hostId TEXT,
      payload TEXT NOT NULL, state TEXT NOT NULL, failureCode TEXT, appliedAt INTEGER,
      completedAt INTEGER, cancelRequestedAt INTEGER, updatedAt INTEGER NOT NULL,
      UNIQUE(workspaceId,bindingGeneration,actorPersonId,requestId));
      CREATE UNIQUE INDEX IF NOT EXISTS registration_live_agent ON registration_intents(workspaceId,agentId)
        WHERE state IN ('prepared','activated','cancelling','applied');
      CREATE UNIQUE INDEX IF NOT EXISTS registration_live_host ON registration_intents(workspaceId,hostId)
        WHERE hostId IS NOT NULL AND state IN ('prepared','activated','cancelling','applied');
      CREATE TRIGGER IF NOT EXISTS registration_payload_immutable BEFORE UPDATE OF
        intentId,workspaceId,bindingGeneration,actorPersonId,requestId,agentId,hostId,payload ON registration_intents
        BEGIN SELECT RAISE(ABORT, 'immutable_registration_intent'); END;`);
  }
  get(id: string): StoredIntent | undefined {
    const row = this.sql
      .exec<Omit<StoredIntent, "payload"> & { payload: string }>(
        "SELECT payload,state,failureCode,appliedAt,completedAt,cancelRequestedAt FROM registration_intents WHERE intentId=?",
        id,
      )
      .toArray()[0];
    return row ? { ...row, payload: JSON.parse(row.payload) as IntentPayload } : undefined;
  }
  find(workspace: string, generation: number, actor: string, request: string): StoredIntent | undefined {
    const row = this.sql
      .exec<{ intentId: string }>(
        "SELECT intentId FROM registration_intents WHERE workspaceId=? AND bindingGeneration=? AND actorPersonId=? AND requestId=?",
        workspace,
        generation,
        actor,
        request,
      )
      .toArray()[0];
    return row ? this.get(row.intentId) : undefined;
  }
  prepare(
    payload: IntentPayload,
    entries: readonly { permit: MutationPermit; binding: PermitBinding }[],
    now = Date.now(),
  ): StoredIntent {
    const keys: (keyof IntentPayload)[] = [
      "intentId",
      "organizationId",
      "workspaceId",
      "channelId",
      "bindingGeneration",
      "actorPersonId",
      "actorGithubId",
      "principalId",
      "reservedExecutionId",
      "agentId",
      "hostId",
      "ownerPersonId",
      "predecessorExecutionId",
      "predecessorAgentId",
      "requestId",
      "reservationId",
      "startPermitId",
      "handoffPermitId",
      "policyRevision",
      "verifiedOwnerHandoff",
      "createdAt",
      "expiresAt",
      "request",
    ];
    const fixed = Object.fromEntries(keys.map((key) => [key, payload[key]])) as unknown as IntentPayload;
    for (const key of keys) {
      const value = fixed[key];
      if (
        value === undefined ||
        (value === null && !["hostId", "predecessorAgentId", "predecessorExecutionId"].includes(key)) ||
        (typeof value === "string" && key !== "request" && (!value || new TextEncoder().encode(value).length > 256))
      )
        throw new AuthorityUnavailable();
    }
    if (
      !Number.isSafeInteger(fixed.bindingGeneration) ||
      fixed.bindingGeneration < 1 ||
      !Number.isSafeInteger(fixed.policyRevision) ||
      fixed.policyRevision < 1 ||
      fixed.verifiedOwnerHandoff !== true ||
      fixed.ownerPersonId !== fixed.actorPersonId ||
      !Number.isFinite(now) ||
      !Number.isFinite(fixed.createdAt) ||
      !Number.isFinite(fixed.expiresAt) ||
      fixed.createdAt > now ||
      fixed.expiresAt > fixed.createdAt + 30_000
    )
      throw new AuthorityUnavailable();
    if (typeof fixed.request !== "string" || new TextEncoder().encode(fixed.request).length > 16 * 1024)
      throw new InvalidIntent();
    let rawRequest: unknown;
    try {
      rawRequest = JSON.parse(fixed.request);
    } catch {
      throw new InvalidIntent();
    }
    if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) throw new AuthorityUnavailable();
    fixed.request = registrationIntentRequest(rawRequest as Record<string, unknown>);
    const body = JSON.stringify(fixed);
    if (new TextEncoder().encode(body).length > 16 * 1024) throw new AuthorityUnavailable();
    const prior = this.find(fixed.workspaceId, fixed.bindingGeneration, fixed.actorPersonId, fixed.requestId);
    if (prior) {
      if (JSON.stringify(prior.payload) !== body) throw new IntentConflict();
      return prior;
    }
    if (now >= fixed.expiresAt) throw new AuthorityUnavailable();
    this.prune(now);
    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM registration_intents").one().n >= MANAGED_RECORD_CAP)
      throw new AuthorityUnavailable();
    if (
      this.sql
        .exec(
          `SELECT intentId FROM registration_intents WHERE workspaceId=?
      AND state IN ('prepared','activated','cancelling','applied') AND (agentId=? OR (hostId IS NOT NULL AND hostId=?))`,
          fixed.workspaceId,
          fixed.agentId,
          fixed.hostId,
        )
        .toArray().length
    )
      throw new IntentConflict();
    if (
      entries.length !== 2 ||
      !entries.some(({ permit }) => permit.id === fixed.startPermitId && permit.action === "agent.execution.start") ||
      !entries.some(
        ({ permit }) => permit.id === fixed.handoffPermitId && permit.action === "agent.handoff.cross_owner",
      ) ||
      entries.some(
        ({ binding }) =>
          binding.actor.kind !== "person" ||
          binding.actor.personId !== fixed.actorPersonId ||
          binding.actor.githubId !== fixed.actorGithubId ||
          binding.generation !== fixed.bindingGeneration ||
          binding.policyRevision !== fixed.policyRevision ||
          binding.requestId !== fixed.requestId ||
          binding.resource.id !== fixed.workspaceId ||
          binding.resource.organizationId !== fixed.organizationId ||
          binding.resource.channel !== fixed.channelId ||
          binding.resource.targetId !== fixed.agentId ||
          (binding.resource.hostId ?? null) !== fixed.hostId ||
          binding.resource.ownerPersonId !== fixed.ownerPersonId,
      )
    )
      throw new AuthorityUnavailable();
    new LocalMutationPermits(this.sql).consumeSet(entries, now, { id: fixed.intentId, expiresAt: fixed.expiresAt });
    this.sql.exec(
      "INSERT INTO registration_intents VALUES(?,?,?,?,?,?,?,?, 'prepared',NULL,NULL,NULL,NULL,?)",
      fixed.intentId,
      fixed.workspaceId,
      fixed.bindingGeneration,
      fixed.actorPersonId,
      fixed.requestId,
      fixed.agentId,
      fixed.hostId,
      body,
      now,
    );
    return this.get(fixed.intentId) as StoredIntent;
  }
  transition(id: string, expected: IntentState, next: IntentState, now = Date.now()): StoredIntent {
    const intent = this.get(id);
    if (!intent || !Number.isFinite(now)) throw new AuthorityUnavailable();
    if (intent.state === next) return intent;
    if (
      intent.state !== expected ||
      !transitions[expected].includes(next) ||
      ((next === "activated" || next === "applied") && now >= intent.payload.expiresAt)
    )
      throw new AuthorityUnavailable();
    this.sql.exec(
      `UPDATE registration_intents SET state=?,updatedAt=?,
      appliedAt=CASE WHEN ?='applied' THEN ? ELSE appliedAt END,
      completedAt=CASE WHEN ?='completed' THEN ? ELSE completedAt END,
      cancelRequestedAt=CASE WHEN ?='cancelling' THEN ? ELSE cancelRequestedAt END WHERE intentId=?`,
      next,
      now,
      next,
      now,
      next,
      now,
      next,
      now,
      id,
    );
    return this.get(id) as StoredIntent;
  }
  prune(now = Date.now()): void {
    // Cancellation tombstones cannot be discarded while authority is unavailable.
    this.sql.exec(
      `UPDATE registration_intents SET state='cancelling',cancelRequestedAt=?,updatedAt=?
      WHERE state IN ('prepared','activated') AND json_extract(payload,'$.expiresAt') <= ?`,
      now,
      now,
      now,
    );
    for (const state of ["cancelled", "expired", "failed", "completed", "applied-failed"])
      this.sql.exec(
        "DELETE FROM registration_intents WHERE state=? AND updatedAt <= ?",
        state,
        now - MANAGED_OUTCOME_TTL_MS,
      );
  }
}
