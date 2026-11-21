import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthorityUnavailable, LocalMutationPermits, type MutationPermit } from "../src/policy-permits";
import {
  IntentConflict,
  type IntentPayload,
  InvalidIntent,
  RegistrationIntents,
  registrationIntentRequest,
} from "../src/registration-intents";

beforeEach(reset);
function fixture(now: number) {
  const payload: IntentPayload = {
    intentId: "intent",
    organizationId: "org",
    workspaceId: "workspace",
    channelId: "channel",
    bindingGeneration: 1,
    actorPersonId: "owner",
    actorGithubId: "123",
    principalId: "principal",
    reservedExecutionId: "reserved",
    agentId: "owner/claude/session",
    hostId: "host",
    ownerPersonId: "owner",
    predecessorExecutionId: null,
    predecessorAgentId: null,
    requestId: "key",
    reservationId: "reservation",
    startPermitId: "start",
    handoffPermitId: "hand",
    policyRevision: 1,
    verifiedOwnerHandoff: true,
    createdAt: now,
    expiresAt: now + 30_000,
    request: registrationIntentRequest({ cli: "claude-code", sessionId: "session", resumed: false, cwd: "/work" }),
  };
  const entries = ["agent.execution.start", "agent.handoff.cross_owner"].map((action, index) => {
    const permit: MutationPermit = {
      id: index === 0 ? "start" : "hand",
      actor: { kind: "person", personId: "owner", githubId: "123" },
      action,
      resource: {
        kind: "workspace",
        organizationId: "org",
        id: "workspace",
        channel: "channel",
        targetId: "owner/claude/session",
        hostId: "host",
        ownerPersonId: "owner",
      },
      requestId: "key",
      generation: 1,
      policyRevision: 1,
      issuedAt: now,
      expiresAt: now + 2000,
    };
    return { permit, binding: structuredClone(permit) };
  });
  return { payload, entries };
}
describe("managed prepared intent storage (not handler admission)", () => {
  it("commits only the intent and correlated receipts, retaining proof past permit expiry", async () => {
    await runInDurableObject(env.CHANNEL.getByName("intents/prepare"), (_channel, state) => {
      const sql = state.storage.sql;
      const intents = new RegistrationIntents(sql);
      const permits = new LocalMutationPermits(sql);
      permits.observeRevision("workspace", 1);
      const now = Date.now();
      const { payload, entries } = fixture(now);
      sql.exec("CREATE TABLE shared_effects (value TEXT)");
      sql.exec("INSERT INTO shared_effects VALUES ('unchanged')");
      const before = sql.exec("SELECT * FROM shared_effects").toArray();
      const first = state.storage.transactionSync(() => intents.prepare(payload, entries, now));
      expect(first.state).toBe("prepared");
      expect(sql.exec("SELECT * FROM shared_effects").toArray()).toEqual(before);
      expect(permits.consumedByIntent(["start", "hand"], "intent", now + 2500)).toBe(true);
      expect(permits.consumedByIntent(["start", "hand"], "another", now + 2500)).toBe(false);
      expect(permits.consumedByIntent(["start", "hand"], "intent", now + 30_000)).toBe(false);
      expect(state.storage.transactionSync(() => intents.prepare(payload, entries, now + 1))).toEqual(first);
      expect(() => sql.exec("UPDATE registration_intents SET payload='{}'")).toThrow();
      expect(() =>
        state.storage.transactionSync(() => intents.prepare({ ...payload, principalId: "changed" }, entries, now)),
      ).toThrow(IntentConflict);
    });
  });
  it("rolls back receipt installation, consumption and intent together on a second receipt refusal", async () => {
    await runInDurableObject(env.CHANNEL.getByName("intents/rollback"), (_channel, state) => {
      const intents = new RegistrationIntents(state.storage.sql);
      const permits = new LocalMutationPermits(state.storage.sql);
      permits.observeRevision("workspace", 1);
      const now = Date.now();
      const { payload, entries } = fixture(now);
      const hand = entries[1];
      if (!hand) throw new Error("missing HAND fixture");
      hand.permit.resource.hostId = "foreign";
      expect(() => state.storage.transactionSync(() => intents.prepare(payload, entries, now))).toThrow(
        AuthorityUnavailable,
      );
      expect(intents.get("intent")).toBeUndefined();
      expect(state.storage.sql.exec("SELECT * FROM managed_permits").toArray()).toEqual([]);
    });
  });
  it("never activates or applies an expired or cancelled intent and never refunds its receipts", async () => {
    await runInDurableObject(env.CHANNEL.getByName("intents/cancel"), (_channel, state) => {
      const intents = new RegistrationIntents(state.storage.sql);
      const now = Date.now();
      const { payload, entries } = fixture(now);
      state.storage.transactionSync(() => intents.prepare(payload, entries, now));
      state.storage.transactionSync(() => intents.prune(now + 30_000));
      expect(intents.get("intent")?.state).toBe("cancelling");
      expect(() => intents.transition("intent", "prepared", "activated", now + 30_000)).toThrow(AuthorityUnavailable);
      state.storage.transactionSync(() => intents.transition("intent", "cancelling", "expired", now + 30_001));
      expect(intents.transition("intent", "cancelling", "expired", now + 30_002).state).toBe("expired");
      expect(state.storage.sql.exec("SELECT * FROM managed_permits").toArray()).toHaveLength(2);
      expect(intents.prepare(payload, entries, now + 40_000).state).toBe("expired");
    });
  });
  it("rejects competing live Agent and Host intents without replacing the first", async () => {
    await runInDurableObject(env.CHANNEL.getByName("intents/conflicts"), (_channel, state) => {
      const intents = new RegistrationIntents(state.storage.sql);
      const now = Date.now();
      const { payload, entries } = fixture(now);
      state.storage.transactionSync(() => intents.prepare(payload, entries, now));
      for (const other of [
        { ...payload, intentId: "other", requestId: "other", hostId: "other" },
        { ...payload, intentId: "other", requestId: "other", agentId: "other" },
      ])
        expect(() => state.storage.transactionSync(() => intents.prepare(other, entries, now))).toThrow(IntentConflict);
      expect(intents.get("intent")?.payload).toEqual(payload);
      expect(intents.get("other")).toBeUndefined();
    });
  });
  it("requires exactly START and HAND even when the single receipt is valid", async () => {
    await runInDurableObject(env.CHANNEL.getByName("intents/dual"), (_channel, state) => {
      const permits = new LocalMutationPermits(state.storage.sql);
      const now = Date.now();
      const { entries } = fixture(now);
      const start = entries[0];
      if (!start) throw new Error("missing START fixture");
      for (const subset of [[], entries.slice(0, 1), [start, { ...start, permit: { ...start.permit, id: "other" } }]])
        expect(() => state.storage.transactionSync(() => permits.consumeSet(subset, now))).toThrow(
          AuthorityUnavailable,
        );
      expect(state.storage.sql.exec("SELECT * FROM managed_permits").toArray()).toEqual([]);
    });
  });
  it("keeps correlation through receipt pruning and revision changes without authorizing reuse", async () => {
    await runInDurableObject(env.CHANNEL.getByName("intents/proof"), (_channel, state) => {
      const sql = state.storage.sql;
      const intents = new RegistrationIntents(sql);
      const permits = new LocalMutationPermits(sql);
      const now = Date.now();
      const { payload, entries } = fixture(now);
      state.storage.transactionSync(() => intents.prepare(payload, entries, now));
      permits.observeRevision("workspace", 2);
      const first = entries[0];
      if (!first) throw new Error("missing START fixture");
      // Installing another receipt must not delete intent-bound consumed evidence.
      permits.install({ ...first.permit, id: "another", policyRevision: 2 });
      expect(permits.consumedByIntent(["start", "hand"], "intent", now + 2500)).toBe(true);
      expect(permits.consume("start", first.binding, now)).toBe(false);
      permits.invalidate();
      expect(permits.consumedByIntent(["start", "hand"], "intent", now)).toBe(false);
    });
  });
  it("retains cancelling tombstones but prunes acknowledged terminal outcomes after 24 hours", async () => {
    await runInDurableObject(env.CHANNEL.getByName("intents/retention"), (_channel, state) => {
      const intents = new RegistrationIntents(state.storage.sql);
      const now = Date.now();
      const { payload, entries } = fixture(now);
      state.storage.transactionSync(() => intents.prepare(payload, entries, now));
      state.storage.transactionSync(() => intents.prune(now + 86_400_000));
      expect(intents.get("intent")?.state).toBe("cancelling");
      state.storage.transactionSync(() => intents.transition("intent", "cancelling", "cancelled", now + 86_400_001));
      state.storage.transactionSync(() => intents.prune(now + 2 * 86_400_000));
      expect(intents.get("intent")?.state).toBe("cancelled");
      state.storage.transactionSync(() => intents.prune(now + 2 * 86_400_000 + 1));
      expect(intents.get("intent")).toBeUndefined();
    });
  });
  it("allowlists request fields and rejects oversized identity and path inputs", () => {
    const request = {
      cli: "claude-code",
      sessionId: "session",
      cwd: "/work",
      credential: "must-not-persist",
      managed: { principalId: "not-input" },
    };
    const fixed = JSON.parse(registrationIntentRequest(request));
    expect(fixed.credential).toBeUndefined();
    expect(fixed.managed).toBeUndefined();
    expect(() => registrationIntentRequest({ ...request, cwd: "x".repeat(4097) })).toThrow(InvalidIntent);
    expect(() => registrationIntentRequest({ ...request, sessionId: "x".repeat(257) })).toThrow(InvalidIntent);
  });
});
