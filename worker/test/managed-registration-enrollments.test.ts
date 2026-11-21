import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MANAGED_RECORD_CAP } from "../src/managed-retention";
import { AuthorityUnavailable } from "../src/policy-permits";
import { RegistrationEnrollments } from "../src/registration-enrollments";
import { type RegistrationReservation, RegistrationReservations } from "../src/registration-reservations";

beforeEach(reset);
function fixture(now: number): RegistrationReservation {
  return {
    reservationId: "reservation",
    intentId: "intent",
    organizationId: "org",
    workspaceId: "workspace",
    channelId: "channel",
    generation: 1,
    actorPersonId: "owner",
    actorGithubId: "123",
    principalId: "principal",
    executionId: "execution",
    agentId: "agent",
    hostId: "host",
    ownerPersonId: "owner",
    requestId: "key",
    request: '{"cli":"claude","sessionId":"session"}',
    startPermitId: "start",
    handoffPermitId: "hand",
    policyRevision: 1,
    createdAt: now,
    expiresAt: now + 30_000,
  };
}
describe("Host enrollment storage (not handler admission or applied proof)", () => {
  it("rejects reservation and activation alone and idempotently records completion", async () => {
    await runInDurableObject(env.ORGANIZATION.getByName("enrollment-complete"), (_org, state) => {
      const reservations = new RegistrationReservations(state.storage.sql);
      const enrollments = new RegistrationEnrollments(state.storage.sql);
      const now = Date.now();
      const p = fixture(now);
      const reserved = reservations.reserve(p, now);
      expect(() => enrollments.complete(reserved, now)).toThrow(AuthorityUnavailable);
      const activated = reservations.activate(p, now);
      expect(() => enrollments.complete(activated, now)).toThrow(AuthorityUnavailable);
      expect(enrollments.get("org", "workspace", "host")).toBeUndefined();
      // Storage-only fixture: the future handler must verify the applied proof
      // before calling complete. This is not evidence of R4 handler provenance.
      const completed = reservations.complete(p, now);
      const row = state.storage.transactionSync(() => enrollments.complete(completed, now));
      expect(row).toEqual({
        organizationId: "org",
        workspaceId: "workspace",
        hostId: "host",
        ownerPersonId: "owner",
        intentId: "intent",
        executionId: "execution",
        createdAt: now,
        revokedAt: null,
      });
      expect(enrollments.complete(completed, now + 1)).toEqual(row);
      expect(enrollments.get("foreign", "workspace", "host")).toBeUndefined();
      expect(enrollments.get("org", "foreign", "host")).toBeUndefined();
      expect(enrollments.get("org", "workspace", "foreign")).toBeUndefined();
      expect(() => enrollments.complete({ ...completed, payload: { ...p, executionId: "foreign" } }, now)).toThrow(
        AuthorityUnavailable,
      );
    });
  });
  it("does not resurrect revoked enrollment and prunes only after bounded retention", async () => {
    await runInDurableObject(env.ORGANIZATION.getByName("enrollment-revoke"), (_org, state) => {
      const reservations = new RegistrationReservations(state.storage.sql);
      const enrollments = new RegistrationEnrollments(state.storage.sql);
      const now = Date.now();
      const p = fixture(now);
      reservations.reserve(p, now);
      reservations.activate(p, now);
      const completed = reservations.complete(p, now);
      enrollments.complete(completed, now);
      enrollments.revokeExecution("foreign", now + 1);
      expect(enrollments.get("org", "workspace", "host")?.revokedAt).toBeNull();
      enrollments.revokeWorkspace("foreign", "workspace", now + 1);
      expect(enrollments.get("org", "workspace", "host")?.revokedAt).toBeNull();
      enrollments.revokeExecution("execution", now + 2);
      enrollments.revokeExecution("execution", now + 3);
      expect(enrollments.get("org", "workspace", "host")?.revokedAt).toBe(now + 2);
      expect(() => enrollments.complete(completed, now + 3)).toThrow(AuthorityUnavailable);
      enrollments.prune(now + 86_400_001);
      expect(enrollments.get("org", "workspace", "host")).toBeDefined();
      enrollments.prune(now + 86_400_002);
      expect(enrollments.get("org", "workspace", "host")).toBeUndefined();
    });
  });
  it("rolls back enrollment with its caller completion transaction", async () => {
    await runInDurableObject(env.ORGANIZATION.getByName("enrollment-rollback"), (_org, state) => {
      const reservations = new RegistrationReservations(state.storage.sql);
      const enrollments = new RegistrationEnrollments(state.storage.sql);
      const now = Date.now();
      const p = fixture(now);
      reservations.reserve(p, now);
      reservations.activate(p, now);
      expect(() =>
        state.storage.transactionSync(() => {
          enrollments.complete(reservations.complete(p, now), now);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(reservations.get(p.reservationId)?.state).toBe("activated");
      expect(enrollments.get("org", "workspace", "host")).toBeUndefined();
    });
  });

  it("caps retained enrollment rows and frees only revoked rows past retention", async () => {
    await runInDurableObject(env.ORGANIZATION.getByName("enrollment-cap"), (_org, state) => {
      const enrollments = new RegistrationEnrollments(state.storage.sql);
      const now = Date.now();
      // Storage-only inputs: these rows never authorize a handler. Real-handler
      // fixtures elsewhere obtain enrollment exclusively through registration.
      for (let n = 0; n < MANAGED_RECORD_CAP; n++) {
        const payload = {
          ...fixture(now),
          hostId: `host-${n}`,
          intentId: `intent-${n}`,
          executionId: `execution-${n}`,
        };
        enrollments.complete({ payload, state: "completed", updatedAt: now }, now);
      }
      const next = { payload: { ...fixture(now), hostId: "overflow" }, state: "completed" as const, updatedAt: now };
      expect(() => enrollments.complete(next, now)).toThrow(AuthorityUnavailable);
      enrollments.revokeWorkspace("org", "workspace", now + 1);
      expect(() => enrollments.complete(next, now + 2)).toThrow(AuthorityUnavailable);
      expect(enrollments.complete(next, now + 86_400_001)?.hostId).toBe("overflow");
      expect(state.storage.sql.exec("SELECT * FROM host_enrollments").toArray()).toHaveLength(1);
    });
  });
});
