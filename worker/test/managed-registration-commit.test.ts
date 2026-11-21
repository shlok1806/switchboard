import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelEvent } from "../../shared/src/index";
import { AgentRoster } from "../src/agents";
import { AuthorityUnavailable, LocalMutationPermits, type MutationPermit } from "../src/policy-permits";
import { commitRegistration, RegistrationEffects, RegistrationRefused } from "../src/registration-commit";
import { type IntentPayload, RegistrationIntents, registrationIntentRequest } from "../src/registration-intents";

beforeEach(reset);
function prepare(storage: DurableObjectStorage) {
  const now = Date.now();
  const payload: IntentPayload = {
    intentId: "intent",
    organizationId: "org",
    workspaceId: "workspace",
    channelId: "channel",
    bindingGeneration: 1,
    actorPersonId: "owner",
    actorGithubId: "123",
    principalId: "principal",
    reservedExecutionId: "execution",
    agentId: "alice/claude-code/session",
    hostId: "alice/studio",
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
    request: registrationIntentRequest({ cli: "claude-code", sessionId: "session", cwd: "/repo" }),
  };
  const base: MutationPermit = {
    id: "apply",
    actor: { kind: "person", personId: "owner", githubId: "123" },
    action: "agent.execution.start",
    resource: {
      kind: "workspace",
      organizationId: "org",
      id: "workspace",
      channel: "channel",
      targetId: payload.agentId,
      ownerPersonId: "owner",
      hostId: payload.hostId ?? undefined,
      operation: "agent.register.apply:intent",
    },
    requestId: "key",
    generation: 1,
    policyRevision: 1,
    issuedAt: now,
    expiresAt: now + 2000,
  };
  const entries = [
    { ...base, id: "start", resource: { ...base.resource, operation: "agent.register" } },
    {
      ...base,
      id: "hand",
      action: "agent.handoff.cross_owner",
      resource: { ...base.resource, operation: "agent.register" },
    },
  ].map((permit) => ({ permit, binding: structuredClone(permit) }));
  const intents = new RegistrationIntents(storage.sql);
  storage.transactionSync(() => {
    intents.prepare(payload, entries, now);
    intents.transition("intent", "prepared", "activated", now);
  });
  return { intents, permit: base, payload };
}

describe("registration TXN-2 local boundary (not handler admission)", () => {
  it("refuses a dual receipt set bound to another Agent before installing receipts or intent", async () => {
    await runInDurableObject(env.CHANNEL.getByName("commit/prepare-target"), (_channel, state) => {
      const f = prepare(state.storage);
      const payload = {
        ...f.payload,
        intentId: "other",
        agentId: "alice/claude-code/other",
        requestId: "other",
        hostId: null,
        startPermitId: "other-start",
        handoffPermitId: "other-hand",
      };
      const entries = ["agent.execution.start", "agent.handoff.cross_owner"].map((action, index) => {
        const permit = {
          ...f.permit,
          id: index === 0 ? "other-start" : "other-hand",
          action,
          requestId: "other",
          resource: { ...f.permit.resource, hostId: undefined },
        };
        return { permit, binding: structuredClone(permit) };
      });
      expect(() => state.storage.transactionSync(() => f.intents.prepare(payload, entries))).toThrow(
        AuthorityUnavailable,
      );
      expect(f.intents.get("other")).toBeUndefined();
      expect(state.storage.sql.exec("SELECT id FROM managed_permits WHERE id LIKE 'other-%'").toArray()).toEqual([]);
    });
  });
  it("reads live state and commits roster plus applied proof before releasing ordered effects", async () => {
    await runInDurableObject(env.CHANNEL.getByName("commit/live"), (_channel, state) => {
      const f = prepare(state.storage);
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE commit_queue (id TEXT PRIMARY KEY)");
      sql.exec("INSERT INTO commit_queue VALUES ('new-after-activation')");
      const sent: string[] = [];
      let sequence = 0;
      const result = commitRegistration({
        storage: state.storage,
        intentId: "intent",
        permit: f.permit,
        binding: structuredClone(f.permit),
        current: () => true,
        checkpoint: () => sequence,
        restore: (value) => {
          sequence = value;
        },
        register: (intent, effects) => {
          const roster = new AgentRoster({
            sql,
            goneAfterMs: 60_000,
            schedulePresenceCheck: async () => {
              throw new Error("watch inside commit");
            },
            append: (event) => {
              sequence++;
              effects.defer(() => {
                sent.push(event.type);
              });
              return { ...event, id: String(sequence), seq: sequence, at: new Date().toISOString() } as ChannelEvent;
            },
            broadcast: () =>
              effects.defer(() => {
                sent.push("roster");
              }),
          });
          const registered = roster.registerLocal("alice", JSON.parse(intent.request));
          if (!registered.ok) throw new Error(registered.reason);
          const queued = sql.exec<{ id: string }>("DELETE FROM commit_queue RETURNING id").toArray();
          expect(sent).toEqual([]);
          return { registered, queued };
        },
      });
      expect(result.value.registered.ok).toBe(true);
      expect(result.value.queued).toEqual([{ id: "new-after-activation" }]);
      expect(result.intent.state).toBe("applied");
      expect(sql.exec("SELECT * FROM commit_queue").toArray()).toEqual([]);
      expect(sent).toEqual([]);
      expect(result.effects.release(() => true)).toEqual([]);
      expect(sent).toEqual(["session.start", "presence", "roster"]);
      result.effects.release(() => true);
      expect(sent).toHaveLength(3);
      expect(() =>
        commitRegistration({
          storage: state.storage,
          intentId: "intent",
          permit: f.permit,
          binding: f.permit,
          current: () => true,
          checkpoint: () => sequence,
          restore: (value) => {
            sequence = value;
          },
          register: () => {
            throw new Error("must not apply twice");
          },
        }),
      ).toThrow(AuthorityUnavailable);
    });
  });
  it("rolls back SQL, fresh permit, outcome, counters and nested callbacks on a business exception", async () => {
    await runInDurableObject(env.CHANNEL.getByName("commit/rollback"), (_channel, state) => {
      const f = prepare(state.storage);
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE commit_queue (id TEXT PRIMARY KEY)");
      sql.exec("INSERT INTO commit_queue VALUES ('live')");
      let sequence = 7;
      let captured: RegistrationEffects | undefined;
      const sent: string[] = [];
      expect(() =>
        commitRegistration({
          storage: state.storage,
          intentId: "intent",
          permit: f.permit,
          binding: f.permit,
          current: () => true,
          checkpoint: () => sequence,
          restore: (value) => {
            sequence = value;
          },
          register: (_intent, effects) => {
            captured = effects;
            sequence++;
            sql.exec("DELETE FROM commit_queue");
            effects.defer(() => {
              sent.push("spawn waiter");
            });
            throw new Error("registration predicate changed");
          },
        }),
      ).toThrow("registration predicate changed");
      expect(sequence).toBe(7);
      expect(sql.exec("SELECT * FROM commit_queue").toArray()).toEqual([{ id: "live" }]);
      expect(f.intents.get("intent")?.state).toBe("activated");
      expect(sql.exec("SELECT id FROM managed_permits WHERE id='apply'").toArray()).toEqual([]);
      expect(captured?.release(() => true)).toEqual([]);
      expect(sent).toEqual([]);
    });
  });
  it("preserves a business refusal while rolling back earlier resume and queue consumption", async () => {
    await runInDurableObject(env.CHANNEL.getByName("commit/refusal"), (_channel, state) => {
      const f = prepare(state.storage);
      state.storage.sql.exec("CREATE TABLE commit_resume (agent TEXT PRIMARY KEY)");
      state.storage.sql.exec("INSERT INTO commit_resume VALUES ('agent')");
      const refusal = { ok: false as const, status: 409, reason: "Another librarian is live." };
      let error: unknown;
      try {
        commitRegistration({
          storage: state.storage,
          intentId: "intent",
          permit: f.permit,
          binding: f.permit,
          current: () => true,
          checkpoint: () => null,
          restore: () => {},
          register: () => {
            state.storage.sql.exec("DELETE FROM commit_resume");
            return refusal;
          },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RegistrationRefused);
      expect((error as RegistrationRefused).result).toEqual(refusal);
      expect(state.storage.sql.exec("SELECT * FROM commit_resume").toArray()).toEqual([{ agent: "agent" }]);
      expect(f.intents.get("intent")?.state).toBe("activated");
      expect(state.storage.sql.exec("SELECT id FROM managed_permits WHERE id='apply'").toArray()).toEqual([]);
    });
  });
  it("rejects stale generation, wrong Host, expired apply, missing consumption and cancelled intent before effects", async () => {
    await runInDurableObject(env.CHANNEL.getByName("commit/denials"), (_channel, state) => {
      const f = prepare(state.storage);
      let effects = 0;
      const attempt = (permit: MutationPermit, current = true) =>
        commitRegistration({
          storage: state.storage,
          intentId: "intent",
          permit,
          binding: f.permit,
          current: () => current,
          checkpoint: () => 0,
          restore: () => {},
          register: () => {
            effects++;
          },
        });
      expect(() => attempt({ ...f.permit, generation: 2 })).toThrow(AuthorityUnavailable);
      expect(() => attempt({ ...f.permit, resource: { ...f.permit.resource, hostId: "foreign" } })).toThrow(
        AuthorityUnavailable,
      );
      expect(() => attempt({ ...f.permit, issuedAt: Date.now() - 3000, expiresAt: Date.now() - 1000 })).toThrow(
        AuthorityUnavailable,
      );
      expect(() => attempt(f.permit, false)).toThrow(AuthorityUnavailable);
      state.storage.sql.exec(
        "UPDATE managed_permits SET body=json_set(body,'$.consumedByIntentId','other') WHERE id='hand'",
      );
      expect(() => attempt(f.permit)).toThrow(AuthorityUnavailable);
      f.intents.transition("intent", "activated", "cancelling");
      expect(() => attempt(f.permit)).toThrow(AuthorityUnavailable);
      expect(effects).toBe(0);
      expect(f.intents.get("intent")?.state).toBe("cancelling");
      expect(new LocalMutationPermits(state.storage.sql).consumedByIntent(["start", "hand"], "intent")).toBe(false);
    });
  });
  it("drops remaining effects on invalidation and reports delivery errors separately from SQL commit", () => {
    const effects = new RegistrationEffects();
    const sent: number[] = [];
    let current = true;
    effects.defer(() => {
      sent.push(1);
      throw new Error("delivery failed");
    });
    effects.defer(() => {
      sent.push(2);
      current = false;
    });
    effects.defer(() => {
      sent.push(3);
    });
    const errors = effects.release(() => current);
    expect(errors).toHaveLength(1);
    expect(sent).toEqual([1, 2]);
    expect(effects.release(() => true)).toEqual([]);
    expect(() => effects.defer(() => {})).toThrow("registration_effects_closed");
  });
});
