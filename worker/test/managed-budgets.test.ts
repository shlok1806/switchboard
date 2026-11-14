import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ManagedUpdateBudgets, refillBucket } from "../src/managed-budgets";
import { nativeFetch } from "./m1-helpers";
import { managedAuthorityFixture } from "./managed-helpers";

describe("managed Update budgets", () => {
  it("persists execution burst ten and refills thirty per minute", async () => {
    const channel = env.CHANNEL.getByName(`budget/${crypto.randomUUID()}`);
    const result = await runInDurableObject(channel, (_object, state) => {
      const sql = state.storage.sql;
      const b = new ManagedUpdateBudgets(sql);
      const first = Array.from({ length: 10 }, () => b.consume("execution", 1000));
      const denied = new ManagedUpdateBudgets(sql).consume("execution", 1000);
      const refill = b.consume("execution", 3000);
      return { first, denied, refill };
    });
    expect(result).toEqual({ first: Array(10).fill(0), denied: 2, refill: 0 });
  });
  it("shares Channel burst fifty across executions and never partially debits on denial", async () => {
    const result = await runInDurableObject(
      env.CHANNEL.getByName(`budget/${crypto.randomUUID()}`),
      (_object, state) => {
        const b = new ManagedUpdateBudgets(state.storage.sql);
        for (let i = 0; i < 50; i++) b.consume(`execution-${i}`, 1000);
        const denied = b.consume("fresh", 1000);
        const row = state.storage.sql
          .exec("SELECT body FROM managed_update_buckets WHERE id=?", "execution:fresh")
          .toArray();
        return { denied, row, refilled: b.consume("fresh", 1200) };
      },
    );
    expect(result.denied).toBe(1);
    expect(result.row).toHaveLength(0);
    expect(result.refilled).toBe(0);
  });
  it("does not mint tokens when the clock moves backwards", () => {
    expect(refillBucket({ tokens: 9, at: 1000 }, 500, 10, 30)).toEqual({ tokens: 0, at: 1000 });
  });
  it("returns 429 and Retry-After before appending an Update", async () => {
    const f = await managedAuthorityFixture();
    const channel = env.CHANNEL.getByName(f.repo);
    const before = await runInDurableObject(channel, (object, state) => {
      Object.assign(object, {
        binding: { version: 1, generation: 1, workspace: f.workspaceId, operation: "binding", state: "linked" },
      });
      const b = new ManagedUpdateBudgets(state.storage.sql);
      const now = Date.now() + 60000;
      for (let i = 0; i < 50; i++) b.consume(undefined, now);
      return state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n;
    });
    const response = await nativeFetch(`/r/${f.repo}/api/updates`, f.token, {
      method: "POST",
      body: JSON.stringify({ text: "must never append" }),
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(
      await runInDurableObject(
        channel,
        (_object, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n,
      ),
    ).toBe(before);
  });
});
