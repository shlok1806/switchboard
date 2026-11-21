import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthorityUnavailable } from "../src/policy-permits";
import { IntentConflict } from "../src/registration-intents";
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
describe("Organization registration reservation storage (not handler admission)", () => {
  it("keeps reservations non-authorizing and binds activation to the exact dual receipt acknowledgement", async () => {
    await runInDurableObject(env.ORGANIZATION.getByName("reservation-correlation"), (_org, state) => {
      const reservations = new RegistrationReservations(state.storage.sql);
      const now = Date.now();
      const payload = fixture(now);
      const prepared = state.storage.transactionSync(() => reservations.reserve(payload, now));
      expect(prepared.state).toBe("reserved");
      expect(state.storage.sql.exec("SELECT * FROM executions").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT * FROM execution_credentials").toArray()).toEqual([]);
      for (const field of [
        "intentId",
        "startPermitId",
        "handoffPermitId",
        "executionId",
        "workspaceId",
        "channelId",
      ] as const)
        expect(() => reservations.activate({ ...payload, [field]: "foreign" }, now)).toThrow(AuthorityUnavailable);
      expect(() => reservations.activate({ ...payload, generation: 2 }, now)).toThrow(AuthorityUnavailable);
      expect(reservations.get(payload.reservationId)).toEqual(prepared);
      expect(state.storage.transactionSync(() => reservations.activate(payload, now + 1)).state).toBe("activated");
      expect(reservations.activate(payload, now + 2).updatedAt).toBe(now + 1);
      // Activation storage itself creates no usable execution or credential.
      expect(state.storage.sql.exec("SELECT * FROM executions").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT * FROM execution_credentials").toArray()).toEqual([]);
    });
  });
  it("never revives a cancelled reservation through delayed activation or same-key replay", async () => {
    await runInDurableObject(env.ORGANIZATION.getByName("reservation-cancel"), (_org, state) => {
      const reservations = new RegistrationReservations(state.storage.sql);
      const now = Date.now();
      const payload = fixture(now);
      state.storage.transactionSync(() => reservations.reserve(payload, now));
      const cancelled = state.storage.transactionSync(() => reservations.cancel(payload, false, now + 1));
      expect(cancelled.state).toBe("cancelled");
      expect(reservations.cancel(payload, false, now + 2)).toEqual(cancelled);
      expect(() => reservations.activate(payload, now + 2)).toThrow(AuthorityUnavailable);
      expect(() => reservations.complete(payload, now + 2)).toThrow(AuthorityUnavailable);
      expect(reservations.reserve(payload, now + 2)).toEqual(cancelled);
      expect(() =>
        reservations.reserve({ ...payload, request: '{"cli":"claude","sessionId":"changed"}' }, now + 2),
      ).toThrow(IntentConflict);
    });
  });
  it("rejects simultaneous agent and Host reservations and permits only idempotent completion recovery", async () => {
    await runInDurableObject(env.ORGANIZATION.getByName("reservation-complete"), (_org, state) => {
      const reservations = new RegistrationReservations(state.storage.sql);
      const now = Date.now();
      const payload = fixture(now);
      state.storage.transactionSync(() => reservations.reserve(payload, now));
      for (const other of [
        { ...payload, reservationId: "other", requestId: "other", hostId: "other" },
        { ...payload, reservationId: "other", requestId: "other", agentId: "other" },
      ])
        expect(() => state.storage.transactionSync(() => reservations.reserve(other, now))).toThrow(IntentConflict);
      expect(() => reservations.complete(payload, now)).toThrow(AuthorityUnavailable);
      state.storage.transactionSync(() => reservations.activate(payload, now + 1));
      expect(() => reservations.activate(payload, now + 30_000)).toThrow(AuthorityUnavailable);
      // Only an authenticated applied-proof handler may call complete: TTL must
      // not turn already committed shared work into a fictional zero-effect abort.
      const completed = state.storage.transactionSync(() => reservations.complete(payload, now + 30_001));
      expect(completed.state).toBe("completed");
      expect(reservations.complete(payload, now + 30_002)).toEqual(completed);
      expect(() => reservations.cancel(payload, false, now + 30_002)).toThrow(AuthorityUnavailable);
      expect(reservations.cancel(payload, true, now + 30_002).state).toBe("applied-failed");
    });
  });
  it("expires unactivated records, retains unresolved activation and prunes terminal outcomes", async () => {
    await runInDurableObject(env.ORGANIZATION.getByName("reservation-prune"), (_org, state) => {
      const reservations = new RegistrationReservations(state.storage.sql);
      const now = Date.now();
      const payload = fixture(now);
      state.storage.transactionSync(() => reservations.reserve(payload, now));
      state.storage.transactionSync(() => reservations.prune(now + 30_000));
      expect(reservations.get(payload.reservationId)?.state).toBe("expired");
      expect(() => reservations.activate(payload, now + 30_000)).toThrow(AuthorityUnavailable);
      state.storage.transactionSync(() => reservations.prune(now + 30_000 + 86_400_000));
      expect(reservations.get(payload.reservationId)).toBeUndefined();
      const active = { ...fixture(now), reservationId: "active", intentId: "active", requestId: "active" };
      state.storage.transactionSync(() => reservations.reserve(active, now));
      state.storage.transactionSync(() => reservations.activate(active, now));
      state.storage.transactionSync(() => reservations.prune(now + 2 * 86_400_000));
      expect(reservations.get("active")?.state).toBe("activated");
      expect(() => reservations.activate(active, now + 2 * 86_400_000)).toThrow(AuthorityUnavailable);
    });
  });
  it("rolls back lifecycle changes with caller transactions and keeps the immutable payload fixed", async () => {
    await runInDurableObject(env.ORGANIZATION.getByName("reservation-rollback"), (_org, state) => {
      const reservations = new RegistrationReservations(state.storage.sql);
      const now = Date.now();
      const payload = fixture(now);
      const before = state.storage.transactionSync(() => reservations.reserve(payload, now));
      expect(() =>
        state.storage.transactionSync(() => {
          reservations.activate(payload, now);
          throw new Error("business failure");
        }),
      ).toThrow("business failure");
      expect(reservations.get(payload.reservationId)).toEqual(before);
      expect(() => state.storage.sql.exec("UPDATE registration_reservations SET payload='{}'")).toThrow();
    });
  });
});
