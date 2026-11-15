import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { managedEnforcement, managedQueryAuthorization } from "../src/managed-channel";
import type { ChannelAuthorization } from "../src/organization";
import { LocalMutationPermits, type MutationPermit } from "../src/policy-permits";
import { bareChannel, legacyBinding } from "./managed-helpers";

const actor = { kind: "person" as const, personId: "person", githubId: "123" };
const input: ChannelAuthorization = {
  actor,
  action: "task.claim",
  generation: 1,
  requestId: "request",
  resource: {
    kind: "workspace",
    organizationId: "org",
    id: "org:workspace",
    channel: "owner/repo",
    targetId: "1",
    operation: "task.claim",
  },
};
function receipt(): MutationPermit {
  const now = Date.now();
  return { ...input, actor, id: "permit", policyRevision: 2, issuedAt: now, expiresAt: now + 2000 };
}
const allowed = { ok: true as const, value: {}, policyRevision: 2 };

describe("managed facade request binding", () => {
  it("passes an exact authority receipt to synchronous local preparation", async () => {
    const permit = receipt();
    const local = vi.fn().mockReturnValue("prepared");
    const facade = managedEnforcement({ current: () => true, authorize: async () => allowed });
    expect(await facade.prepare({ ...input, actor }, async () => ({ ...allowed, value: permit }), local)).toBe(
      "prepared",
    );
    expect(local).toHaveBeenCalledExactlyOnceWith(permit);
  });
  for (const field of [
    "actor",
    "action",
    "resource",
    "requestId",
    "generation",
    "policyRevision",
    "expiry",
    "future",
    "duration",
  ]) {
    it(`rejects mismatched ${field} before installing or committing a receipt`, async () => {
      const permit = receipt();
      if (field === "actor") permit.actor = { ...actor, personId: "foreign" };
      if (field === "action") permit.action = "task.update";
      if (field === "resource") permit.resource = { ...permit.resource, targetId: "2" };
      if (field === "requestId") permit.requestId = "other";
      if (field === "generation") permit.generation++;
      if (field === "policyRevision") permit.policyRevision++;
      if (field === "expiry") permit.expiresAt = permit.issuedAt;
      if (field === "future") permit.issuedAt += 1000;
      if (field === "duration") permit.expiresAt = permit.issuedAt + 2001;
      const local = vi.fn();
      const facade = managedEnforcement({ current: () => true, authorize: async () => allowed });
      await expect(
        facade.prepare({ ...input, actor }, async () => ({ ...allowed, value: permit }), local),
      ).rejects.toMatchObject({ status: 404 });
      expect(local).not.toHaveBeenCalled();
    });
  }
  it("drops late issuance after a timeout without installing a receipt", async () => {
    vi.useFakeTimers();
    try {
      const permit = receipt();
      const local = vi.fn();
      let release: ((value: { ok: true; value: MutationPermit; policyRevision: number }) => void) | undefined;
      const facade = managedEnforcement({ current: () => true, authorize: async () => allowed });
      const pending = facade.prepare(
        { ...input, actor },
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        local,
      );
      const rejected = expect(pending).rejects.toMatchObject({ status: 503 });
      await vi.advanceTimersByTimeAsync(2000);
      await rejected;
      if (!release) throw new Error("issuance was not started");
      release({ ...allowed, value: permit });
      await Promise.resolve();
      expect(local).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("drops issuance if binding changes during the authority await", async () => {
    let current = true;
    const local = vi.fn();
    const facade = managedEnforcement({ current: () => current, authorize: async () => allowed });
    await expect(
      facade.prepare(
        { ...input, actor },
        async () => {
          current = false;
          return { ...allowed, value: receipt() };
        },
        local,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(local).not.toHaveBeenCalled();
  });
});

describe("managed query decomposition", () => {
  it("checks constituent scope and outer scope independently with the current actor", async () => {
    const constituent = { ...input, action: "agent.view", actor: { token: "unused-stale-context" } };
    const authorize = vi.fn().mockResolvedValue(allowed);
    expect((await managedQueryAuthorization(input, [constituent], authorize, () => true)).ok).toBe(true);
    expect(authorize.mock.calls.map(([check]) => check.action)).toEqual(["agent.view", "task.claim"]);
    expect(authorize.mock.calls.every(([check]) => check.actor === actor)).toBe(true);
  });
  it("rejects mixed revisions without releasing merged results", async () => {
    const authorize = vi
      .fn()
      .mockResolvedValueOnce(allowed)
      .mockResolvedValueOnce({ ...allowed, policyRevision: 3 });
    expect((await managedQueryAuthorization(input, [input], authorize, () => true)).ok).toBe(false);
  });
  it("does not query further constituents after a denial or enrollment change", async () => {
    const authorize = vi.fn().mockResolvedValue({ ok: false, reason: "revoked", status: 403, policyRevision: 3 });
    expect((await managedQueryAuthorization(input, [input, input], authorize, () => true)).ok).toBe(false);
    expect(authorize).toHaveBeenCalledTimes(1);
    authorize.mockClear();
    expect((await managedQueryAuthorization(input, [input], authorize, () => false)).ok).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe("managed durable revision floor", () => {
  it("applies internal invalidations only to the currently linked Workspace", async () => {
    await runInDurableObject(env.CHANNEL.getByName(`invalidate/${crypto.randomUUID()}`), (channel, state) => {
      Object.assign(channel, {
        binding: { version: 1, state: "linked", generation: 1, workspace: input.resource.id, operation: "binding" },
      });
      const permits = new LocalMutationPermits(state.storage.sql);
      const permit = receipt();
      permits.install(permit);
      channel.invalidateManagedPolicy("foreign:workspace", 100);
      expect(permits.consume(permit.id, permit)).toBe(true);
      const pending = { ...permit, id: "pending" };
      permits.install(pending);
      channel.invalidateManagedPolicy(input.resource.id, 3);
      expect(permits.consume(pending.id, pending)).toBe(false);
      permits.install({ ...pending, id: "late" });
      expect(permits.consume("late", pending)).toBe(false);
    });
  });
  it("rejects installed and late old receipts after invalidation even after recreating the store", async () => {
    await runInDurableObject(env.CHANNEL.getByName(`floor/${crypto.randomUUID()}`), (_object, state) => {
      const permit = receipt();
      const store = new LocalMutationPermits(state.storage.sql);
      store.install(permit);
      store.observeRevision(permit.resource.id, 3);
      const restored = new LocalMutationPermits(state.storage.sql);
      restored.observeRevision(permit.resource.id, 2);
      restored.install(permit);
      expect(restored.consume(permit.id, permit)).toBe(false);
      const fresh = { ...permit, id: "fresh", policyRevision: 3 };
      restored.install(fresh);
      expect(restored.consume(fresh.id, fresh)).toBe(true);
      expect(restored.consume(fresh.id, fresh)).toBe(false);
      expect(state.storage.sql.exec("SELECT * FROM managed_policy_floor").toArray()).toHaveLength(1);
    });
  });
  it("skips invalidation on unlinked Channels before any storage access", () => {
    expect(() => bareChannel(legacyBinding).invalidateManagedPolicy("org:workspace", 4)).not.toThrow();
  });
});
