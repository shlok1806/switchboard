import { MANAGED_OUTCOME_TTL_MS, MANAGED_RECORD_CAP } from "./managed-retention";
import { AuthorityUnavailable } from "./policy-permits";
import type { StoredReservation } from "./registration-reservations";

export type HostEnrollment = {
  organizationId: string;
  workspaceId: string;
  hostId: string;
  ownerPersonId: string;
  intentId: string;
  executionId: string;
  createdAt: number;
  revokedAt: number | null;
};

/** Organization-local storage only, not an enrollment RPC or an authorization
 * boundary. Construct lazily on managed completion. The completion handler must
 * authenticate the bound Channel, verify its durable applied proof and current
 * execution/binding/decide result before entering the synchronous transaction.
 */
export class RegistrationEnrollments {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS host_enrollments (
      organizationId TEXT NOT NULL, workspaceId TEXT NOT NULL, hostId TEXT NOT NULL,
      ownerPersonId TEXT NOT NULL, intentId TEXT NOT NULL, executionId TEXT NOT NULL,
      createdAt INTEGER NOT NULL, revokedAt INTEGER,
      PRIMARY KEY(organizationId,workspaceId,hostId))`);
  }

  get(organizationId: string, workspaceId: string, hostId: string): HostEnrollment | undefined {
    return this.sql
      .exec<HostEnrollment>(
        "SELECT * FROM host_enrollments WHERE organizationId=? AND workspaceId=? AND hostId=?",
        organizationId,
        workspaceId,
        hostId,
      )
      .toArray()[0];
  }

  /** ONLY the verified-handoff registration completion transaction may call this.
   * Activation alone cannot write an enrollment. No replacement or resurrection
   * of an existing Host's ownership is allowed through a supplied Host ID.
   */
  complete(reservation: StoredReservation, now = Date.now()): HostEnrollment | undefined {
    if (reservation.state !== "completed" || !Number.isSafeInteger(now)) throw new AuthorityUnavailable();
    const p = reservation.payload;
    if (!p.hostId) return undefined;
    if (p.ownerPersonId !== p.actorPersonId || p.startPermitId === p.handoffPermitId) throw new AuthorityUnavailable();
    const previous = this.get(p.organizationId, p.workspaceId, p.hostId);
    if (previous) {
      if (
        previous.revokedAt !== null ||
        previous.ownerPersonId !== p.ownerPersonId ||
        previous.intentId !== p.intentId ||
        previous.executionId !== p.executionId
      )
        throw new AuthorityUnavailable();
      return previous;
    }
    this.prune(now);
    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM host_enrollments").one().n >= MANAGED_RECORD_CAP)
      throw new AuthorityUnavailable();
    this.sql.exec(
      "INSERT INTO host_enrollments VALUES(?,?,?,?,?,?,?,NULL)",
      p.organizationId,
      p.workspaceId,
      p.hostId,
      p.ownerPersonId,
      p.intentId,
      p.executionId,
      now,
    );
    return this.get(p.organizationId, p.workspaceId, p.hostId);
  }

  /** Additional lifecycle fence; callers still check the current enrolling
   * execution and binding on every use. This record alone never grants access.
   */
  revokeExecution(executionId: string, now = Date.now()): void {
    this.sql.exec(
      "UPDATE host_enrollments SET revokedAt=? WHERE executionId=? AND revokedAt IS NULL",
      now,
      executionId,
    );
  }

  revokeWorkspace(organizationId: string, workspaceId: string, now = Date.now()): void {
    this.sql.exec(
      "UPDATE host_enrollments SET revokedAt=? WHERE organizationId=? AND workspaceId=? AND revokedAt IS NULL",
      now,
      organizationId,
      workspaceId,
    );
  }

  prune(now = Date.now()): void {
    this.sql.exec(
      "DELETE FROM host_enrollments WHERE revokedAt IS NOT NULL AND revokedAt<=?",
      now - MANAGED_OUTCOME_TTL_MS,
    );
  }
}
