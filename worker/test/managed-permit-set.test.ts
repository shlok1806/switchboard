import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthorityUnavailable, LocalMutationPermits, type MutationPermit } from "../src/policy-permits";

beforeEach(reset);

describe("managed correlated permit commit primitive", () => {
  for (const failure of ["expiry", "revision", "generation", "host", "used", "duplicate", "write"] as const)
    it(`rolls back both receipts and local writes on ${failure}`, async () => {
      const channel = env.CHANNEL.getByName(`permit-set/${failure}`);
      await runInDurableObject(channel, (_channel, state) => {
        const sql = state.storage.sql;
        const permits = new LocalMutationPermits(sql);
        permits.observeRevision("workspace", 1);
        sql.exec("CREATE TABLE permit_set_effects (id TEXT PRIMARY KEY)");
        const now = Date.now();
        const start: MutationPermit = {
          id: "start",
          actor: { kind: "person", personId: "owner", githubId: "123" },
          action: "agent.execution.start",
          resource: { kind: "workspace", organizationId: "org", id: "workspace", targetId: "successor" },
          requestId: "registration",
          generation: 1,
          policyRevision: 1,
          issuedAt: now,
          expiresAt: now + 2000,
        };
        const hand = {
          ...start,
          id: "hand",
          action: "agent.handoff.cross_owner",
          resource: { ...start.resource, targetId: "predecessor", hostId: "owner-host" },
        };
        const expectedHand = structuredClone(hand);
        if (failure === "expiry") hand.expiresAt = now;
        if (failure === "revision") hand.policyRevision = 2;
        if (failure === "generation") hand.generation = 2;
        if (failure === "host") hand.resource.hostId = "foreign-host";
        if (failure === "duplicate") hand.id = start.id;
        if (failure === "used") {
          permits.install(hand);
          expect(permits.consume(hand.id, expectedHand, now)).toBe(true);
        }
        const before = sql.exec("SELECT * FROM managed_permits ORDER BY id").toArray();
        expect(() =>
          state.storage.transactionSync(() => {
            permits.consumeSet(
              [
                { permit: start, binding: start },
                { permit: hand, binding: expectedHand },
              ],
              now,
            );
            sql.exec("INSERT INTO permit_set_effects VALUES ('registration')");
            if (failure === "write") throw new AuthorityUnavailable();
          }),
        ).toThrow(AuthorityUnavailable);
        expect(sql.exec("SELECT * FROM managed_permits ORDER BY id").toArray()).toEqual(before);
        expect(sql.exec("SELECT * FROM permit_set_effects").toArray()).toEqual([]);
      });
    });

  it("consumes both receipts with the local write once and rejects replay", async () => {
    await runInDurableObject(env.CHANNEL.getByName("permit-set/success"), (_channel, state) => {
      const permits = new LocalMutationPermits(state.storage.sql);
      permits.observeRevision("workspace", 1);
      state.storage.sql.exec("CREATE TABLE permit_set_effects (id TEXT PRIMARY KEY)");
      const now = Date.now();
      const entries = ["agent.execution.start", "agent.handoff.cross_owner"].map((action) => {
        const permit: MutationPermit = {
          id: action,
          actor: { kind: "person", personId: "owner", githubId: "123" },
          action,
          resource: { kind: "workspace", organizationId: "org", id: "workspace", targetId: action },
          requestId: "registration",
          generation: 1,
          policyRevision: 1,
          issuedAt: now,
          expiresAt: now + 2000,
        };
        return { permit, binding: structuredClone(permit) };
      });
      state.storage.transactionSync(() => {
        permits.consumeSet(entries, now);
        state.storage.sql.exec("INSERT INTO permit_set_effects VALUES ('registration')");
      });
      expect(() => state.storage.transactionSync(() => permits.consumeSet(entries, now))).toThrow(AuthorityUnavailable);
      expect(state.storage.sql.exec("SELECT * FROM managed_permits").toArray()).toHaveLength(2);
      expect(state.storage.sql.exec("SELECT * FROM permit_set_effects").toArray()).toEqual([{ id: "registration" }]);
    });
  });
});
