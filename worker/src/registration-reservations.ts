import { MANAGED_OUTCOME_TTL_MS, MANAGED_RECORD_CAP } from "./managed-retention";
import { AuthorityUnavailable } from "./policy-permits";
import { IntentConflict, InvalidIntent, registrationIntentRequest } from "./registration-intents";

/** Organization-owned, non-authorizing correlation. Never contains a credential.
 * This storage primitive is NOT an RPC or policy boundary. Its caller must check
 * decide(), the bound Channel and current authority in the same transaction.
 */
export interface RegistrationReservation {
  reservationId: string;
  intentId: string;
  organizationId: string;
  workspaceId: string;
  channelId: string;
  generation: number;
  actorPersonId: string;
  actorGithubId: string;
  principalId: string;
  executionId: string;
  agentId: string;
  hostId: string | null;
  ownerPersonId: string;
  requestId: string;
  request: string;
  startPermitId: string;
  handoffPermitId: string;
  policyRevision: number;
  createdAt: number;
  expiresAt: number;
}
export interface RegistrationAcknowledgement {
  reservationId: string;
  intentId: string;
  startPermitId: string;
  handoffPermitId: string;
  executionId: string;
  workspaceId: string;
  channelId: string;
  generation: number;
}
type ReservationState = "reserved" | "activated" | "completed" | "cancelled" | "expired" | "applied-failed";
export interface StoredReservation {
  payload: RegistrationReservation;
  state: ReservationState;
  updatedAt: number;
}
const keys: readonly (keyof RegistrationReservation)[] = [
  "reservationId",
  "intentId",
  "organizationId",
  "workspaceId",
  "channelId",
  "generation",
  "actorPersonId",
  "actorGithubId",
  "principalId",
  "executionId",
  "agentId",
  "hostId",
  "ownerPersonId",
  "requestId",
  "request",
  "startPermitId",
  "handoffPermitId",
  "policyRevision",
  "createdAt",
  "expiresAt",
];

export class RegistrationReservations {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS registration_reservations (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, generation INTEGER NOT NULL,
      actor TEXT NOT NULL, request_id TEXT NOT NULL, agent TEXT NOT NULL, host TEXT,
      payload TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(workspace,generation,actor,request_id));
      CREATE UNIQUE INDEX IF NOT EXISTS reserved_registration_agent
        ON registration_reservations(workspace,agent) WHERE state IN ('reserved','activated');
      CREATE UNIQUE INDEX IF NOT EXISTS reserved_registration_host
        ON registration_reservations(workspace,host) WHERE host IS NOT NULL AND state IN ('reserved','activated');
      CREATE TRIGGER IF NOT EXISTS reservation_payload_immutable BEFORE UPDATE OF
        id,workspace,generation,actor,request_id,agent,host,payload ON registration_reservations
        BEGIN SELECT RAISE(ABORT, 'immutable_registration_reservation'); END;`);
  }

  get(id: string): StoredReservation | undefined {
    const row = this.sql
      .exec<{ payload: string; state: ReservationState; updatedAt: number }>(
        "SELECT payload,state,updated_at AS updatedAt FROM registration_reservations WHERE id=?",
        id,
      )
      .toArray()[0];
    return row ? { ...row, payload: JSON.parse(row.payload) as RegistrationReservation } : undefined;
  }

  /** Caller owns transactionSync. IDs are correlation only, never bearer proof. */
  reserve(input: RegistrationReservation, now = Date.now()): StoredReservation {
    const fixed = Object.fromEntries(keys.map((key) => [key, input[key]])) as unknown as RegistrationReservation;
    for (const key of keys) {
      const value = fixed[key];
      if (key === "hostId" && value === null) continue;
      if (["generation", "policyRevision", "createdAt", "expiresAt"].includes(key)) {
        if (!Number.isSafeInteger(value)) throw new AuthorityUnavailable();
      } else if (
        typeof value !== "string" ||
        !value ||
        new TextEncoder().encode(value).length > (key === "request" ? 16 * 1024 : 256)
      )
        throw new AuthorityUnavailable();
    }
    if (
      !Number.isFinite(now) ||
      fixed.generation < 1 ||
      fixed.policyRevision < 1 ||
      fixed.ownerPersonId !== fixed.actorPersonId ||
      fixed.startPermitId === fixed.handoffPermitId ||
      fixed.createdAt > now ||
      fixed.expiresAt <= fixed.createdAt ||
      fixed.expiresAt > fixed.createdAt + 30_000
    )
      throw new AuthorityUnavailable();
    let request: unknown;
    try {
      request = JSON.parse(fixed.request);
    } catch {
      throw new InvalidIntent();
    }
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new InvalidIntent();
    fixed.request = registrationIntentRequest(request as Record<string, unknown>);
    const body = JSON.stringify(fixed);
    if (new TextEncoder().encode(body).length > 16 * 1024) throw new AuthorityUnavailable();
    const previous = this.sql
      .exec<{ id: string }>(
        "SELECT id FROM registration_reservations WHERE workspace=? AND generation=? AND actor=? AND request_id=?",
        fixed.workspaceId,
        fixed.generation,
        fixed.actorPersonId,
        fixed.requestId,
      )
      .toArray()[0];
    if (previous) {
      const stored = this.get(previous.id);
      if (!stored || JSON.stringify(stored.payload) !== body) throw new IntentConflict();
      // A retry only observes; it never revives or re-activates a reservation.
      return stored;
    }
    if (now >= fixed.expiresAt) throw new AuthorityUnavailable();
    this.prune(now);
    if (
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM registration_reservations").one().n >= MANAGED_RECORD_CAP
    )
      throw new AuthorityUnavailable();
    if (
      this.sql
        .exec(
          `SELECT id FROM registration_reservations WHERE workspace=? AND state IN ('reserved','activated')
       AND (agent=? OR (host IS NOT NULL AND host=?))`,
          fixed.workspaceId,
          fixed.agentId,
          fixed.hostId,
        )
        .toArray().length
    )
      throw new IntentConflict();
    this.sql.exec(
      "INSERT INTO registration_reservations VALUES(?,?,?,?,?,?,?,?,'reserved',?)",
      fixed.reservationId,
      fixed.workspaceId,
      fixed.generation,
      fixed.actorPersonId,
      fixed.requestId,
      fixed.agentId,
      fixed.hostId,
      body,
      now,
    );
    return this.get(fixed.reservationId) as StoredReservation;
  }

  private correlated(ack: RegistrationAcknowledgement): StoredReservation {
    const record = this.get(ack.reservationId);
    if (
      !record ||
      ![
        "reservationId",
        "intentId",
        "startPermitId",
        "handoffPermitId",
        "executionId",
        "workspaceId",
        "channelId",
        "generation",
      ].every(
        (key) => record.payload[key as keyof RegistrationReservation] === ack[key as keyof RegistrationAcknowledgement],
      )
    )
      throw new AuthorityUnavailable();
    return record;
  }

  /** Called ONLY after authenticated Channel dual-consumption acknowledgement. */
  activate(ack: RegistrationAcknowledgement, now = Date.now()): StoredReservation {
    const record = this.correlated(ack);
    if (
      !Number.isFinite(now) ||
      now >= record.payload.expiresAt ||
      (record.state !== "reserved" && record.state !== "activated")
    )
      throw new AuthorityUnavailable();
    if (record.state === "activated") return record;
    this.sql.exec(
      "UPDATE registration_reservations SET state='activated',updated_at=? WHERE id=?",
      now,
      ack.reservationId,
    );
    return this.get(ack.reservationId) as StoredReservation;
  }

  /** Caller must verify the durable local applied proof and current authority first.
   * Completion may recover after intent TTL: registration already committed.
   */
  complete(ack: RegistrationAcknowledgement, now = Date.now()): StoredReservation {
    const record = this.correlated(ack);
    if (!Number.isFinite(now) || (record.state !== "activated" && record.state !== "completed"))
      throw new AuthorityUnavailable();
    if (record.state === "completed") return record;
    this.sql.exec(
      "UPDATE registration_reservations SET state='completed',updated_at=? WHERE id=?",
      now,
      ack.reservationId,
    );
    return this.get(ack.reservationId) as StoredReservation;
  }

  /** Serialized with activation/completion. Caller also ends any activated execution.
   * A committed apply is reported separately; cancellation never claims to undo it.
   */
  cancel(ack: RegistrationAcknowledgement, applied: boolean, now = Date.now()): StoredReservation {
    const record = this.correlated(ack);
    if (!Number.isFinite(now)) throw new AuthorityUnavailable();
    if (["cancelled", "expired", "applied-failed"].includes(record.state)) return record;
    if (record.state === "completed" && !applied) throw new AuthorityUnavailable();
    const state = applied ? "applied-failed" : now >= record.payload.expiresAt ? "expired" : "cancelled";
    this.sql.exec(
      "UPDATE registration_reservations SET state=?,updated_at=? WHERE id=?",
      state,
      now,
      ack.reservationId,
    );
    return this.get(ack.reservationId) as StoredReservation;
  }

  prune(now = Date.now()): void {
    // Unactivated reservations have no execution to terminate. Activated ones
    // remain fenced by their deadline and retained until explicit reconciliation.
    this.sql.exec(
      `UPDATE registration_reservations SET state='expired',updated_at=?
      WHERE state='reserved' AND json_extract(payload,'$.expiresAt')<=?`,
      now,
      now,
    );
    this.sql.exec(
      `DELETE FROM registration_reservations
      WHERE state IN ('cancelled','expired','completed','applied-failed') AND updated_at<=?`,
      now - MANAGED_OUTCOME_TTL_MS,
    );
  }
}
