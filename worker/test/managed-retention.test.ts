import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { appendManagedOutcome, MANAGED_OUTCOME_TTL_MS, MANAGED_RECORD_CAP } from "../src/managed-retention";
import { LocalMutationPermits, type MutationPermit } from "../src/policy-permits";
import { nativeFetch } from "./m1-helpers";
import { managedAuthorityFixture } from "./managed-helpers";

describe("managed record retention", () => {
  it("refuses a managed Update before append when outcome capacity is exhausted", async () => {
    const f = await managedAuthorityFixture();
    const channel = env.CHANNEL.getByName(f.repo);
    const before = await runInDurableObject(channel, (object, state) => {
      Object.assign(object, {
        binding: { version: 1, generation: 1, workspace: f.workspaceId, operation: "binding", state: "linked" },
      });
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE managed_outcome_outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
      for (let i = 0; i < MANAGED_RECORD_CAP; i++)
        sql.exec("INSERT INTO managed_outcome_outbox VALUES(?,?)", String(i), JSON.stringify({ at: Date.now() }));
      return sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n;
    });
    const response = await nativeFetch(`/r/${f.repo}/api/updates`, f.token, {
      method: "POST",
      body: JSON.stringify({ text: "must never append at capacity" }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("must never append");
    expect(
      await runInDurableObject(
        channel,
        (_object, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n,
      ),
    ).toBe(before);
  });
  it("prunes expired outcomes and refuses capacity without losing pending evidence", async () => {
    await runInDurableObject(env.CHANNEL.getByName(`retention/${crypto.randomUUID()}`), (_object, state) => {
      const sql = state.storage.sql;
      for (const table of ["managed_outcome_outbox", "managed_external_outcomes"] as const) {
        const now = Date.now();
        appendManagedOutcome(sql, table, "expired", { outcome: "intent" }, now - MANAGED_OUTCOME_TTL_MS);
        for (let i = 0; i < MANAGED_RECORD_CAP; i++)
          appendManagedOutcome(sql, table, String(i), { outcome: "committed" }, now);
        expect(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n).toBe(MANAGED_RECORD_CAP);
        expect(sql.exec(`SELECT id FROM ${table} WHERE id='expired'`).toArray()).toHaveLength(0);
        expect(() => appendManagedOutcome(sql, table, "overflow", {}, now)).toThrow("managed_outcome_capacity");
        expect(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n).toBe(MANAGED_RECORD_CAP);
        appendManagedOutcome(sql, table, "fresh", {}, now + MANAGED_OUTCOME_TTL_MS);
        expect(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n).toBe(1);
      }
    });
  });
  it("bounds permits retains consumed replay fences and prunes expired receipts", async () => {
    await runInDurableObject(env.CHANNEL.getByName(`retention/${crypto.randomUUID()}`), (_object, state) => {
      const sql = state.storage.sql;
      const permits = new LocalMutationPermits(sql);
      const now = Date.now();
      const permit: MutationPermit = {
        id: "consumed",
        actor: { kind: "person", personId: "person", githubId: "123" },
        action: "task.claim",
        resource: { kind: "workspace", organizationId: "org", id: "ws" },
        requestId: "request",
        generation: 1,
        policyRevision: 1,
        issuedAt: now,
        expiresAt: now + 2000,
      };
      permits.install(permit);
      expect(permits.consume(permit.id, permit, now)).toBe(true);
      permits.install(permit);
      expect(permits.consume(permit.id, permit, now)).toBe(false);
      // Seed capacity directly to avoid depending on how long 1024 permit installations take.
      for (let i = 1; i < MANAGED_RECORD_CAP; i++)
        sql.exec("INSERT INTO managed_permits VALUES(?,?)", String(i), JSON.stringify({ permit, used: false }));
      expect(() => permits.install({ ...permit, id: "overflow" })).toThrow("authority_unavailable");
      sql.exec(
        "UPDATE managed_permits SET body=?",
        JSON.stringify({ permit: { ...permit, expiresAt: now - 1 }, used: true }),
      );
      permits.install({ ...permit, id: "fresh" });
      expect(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM managed_permits").one().n).toBe(1);
    });
  });
});
