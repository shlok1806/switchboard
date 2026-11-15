import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Alarms } from "../src/alarms";
import { managedOutcome, OUTCOME_BATCH_SIZE, outcomeAuditId } from "../src/managed-outcomes";
import { appendManagedOutcome, MANAGED_OUTCOME_TTL_MS } from "../src/managed-retention";
import { bareChannel, managedAuthorityFixture } from "./managed-helpers";

beforeEach(async () => {
  await reset();
});

async function fixture() {
  const f = await managedAuthorityFixture();
  const requestId = crypto.randomUUID();
  const result = await f.org.issueMutationPermit({
    actor: f.actor,
    action: "channel.update.write",
    resource: {
      kind: "workspace",
      organizationId: f.organizationId,
      id: f.workspaceId,
      channel: f.repo,
      targetId: "artifacts/guide",
      operation: "artifact.publish",
    },
    generation: 1,
    requestId,
  });
  if (!result.ok) throw new Error("fixture permit denied");
  const permit = result.value;
  const binding = { version: 1, state: "linked", workspace: f.workspaceId, operation: "binding", generation: 1 };
  const body = {
    requestId,
    actor: permit.actor,
    action: permit.action,
    resource: permit.resource,
    policyRevision: permit.policyRevision,
    outcome: "committed",
    at: Date.now(),
    text: "PRIVATE_CONTENT_MARKER",
    token: "PRIVATE_CREDENTIAL_MARKER",
  };
  const channel = env.CHANNEL.getByName(f.repo);
  await runInDurableObject(channel, (object, state) => {
    Object.assign(object, { binding });
    appendManagedOutcome(state.storage.sql, "managed_outcome_outbox", permit.id, body, body.at);
  });
  const outcome = managedOutcome("managed_outcome_outbox", permit.id, body);
  if (!outcome) throw new Error("fixture outcome denied");
  return { ...f, channel, permit, binding, body, outcome };
}

describe("managed durable audit outcomes", () => {
  it("exports an allowlisted outcome and deletes only acknowledged rows", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (object, state) => {
      state.storage.sql.exec("DELETE FROM alarm_deadlines");
      await new Alarms(state.storage).set("managed-outcomes", Date.now());
      await object.alarm();
      expect(state.storage.sql.exec("SELECT id FROM managed_outcome_outbox").toArray()).toHaveLength(0);
      expect(new Alarms(state.storage).deadline("managed-outcomes")).toBeNull();
    });
    const records = await f.org.auditRecords(f.actor);
    const record = records?.find((record) => record.id === outcomeAuditId(f.outcome));
    expect(record).toMatchObject({
      actor: { kind: "person", personId: f.actor.personId },
      requestId: f.permit.requestId,
      policyRevision: f.permit.policyRevision,
      outcome: "committed",
      reason: "channel_outcome:committed",
    });
    expect(JSON.stringify(record)).not.toContain("PRIVATE_");
    expect(JSON.stringify(record)).not.toContain("githubId");
  });

  it("replays a lost acknowledgment once and rejects conflicting or unauthorised evidence", async () => {
    const f = await fixture();
    const id = outcomeAuditId(f.outcome);
    expect(await f.org.recordChannelOutcomes([f.outcome])).toEqual([id]);
    expect(await f.org.recordChannelOutcomes([f.outcome])).toEqual([id]);
    expect(await f.org.recordChannelOutcomes([{ ...f.outcome, at: f.outcome.at + 1 }])).toEqual([]);
    for (const changed of [
      { ...f.outcome, requestId: "unissued", id: "unissued" },
      { ...f.outcome, action: "unknown" },
      { ...f.outcome, policyRevision: f.outcome.policyRevision + 1 },
      { ...f.outcome, resource: { ...f.outcome.resource, channel: "foreign/repo" } },
      { ...f.outcome, resource: { ...f.outcome.resource, organizationId: crypto.randomUUID() } },
      { ...f.outcome, resource: { ...f.outcome.resource, id: `${crypto.randomUUID()}:foreign` } },
      { ...f.outcome, actor: { kind: "person" as const, personId: crypto.randomUUID() } },
    ])
      expect(await f.org.recordChannelOutcomes([changed])).toEqual([]);
    await runInDurableObject(f.channel, async (object, state) => {
      state.storage.sql.exec("DELETE FROM alarm_deadlines");
      await new Alarms(state.storage).set("managed-outcomes", Date.now());
      await object.alarm();
    });
    const records = await f.org.auditRecords(f.actor);
    expect(records?.filter((record) => record.id === id)).toHaveLength(1);
  });

  it("keeps retries durable on failure and preserves rows changed during acknowledgment or generation changes", async () => {
    const f = await fixture();
    for (const mode of ["failure", "changed-row", "generation"] as const) {
      await runInDurableObject(f.channel, async (channel, state) => {
        const originalEnv = (channel as unknown as { env: Env }).env;
        Object.assign(channel, { binding: f.binding });
        const alarms = new Alarms(state.storage);
        const original = JSON.stringify(f.body);
        state.storage.sql.exec("INSERT OR REPLACE INTO managed_outcome_outbox VALUES(?,?)", f.permit.id, original);
        Object.assign(channel, {
          alarms,
          env: {
            ORGANIZATION: {
              getByName: () => ({
                recordChannelOutcomes: async () => {
                  if (mode === "failure") throw new Error("private transport error");
                  if (mode === "changed-row")
                    state.storage.sql.exec(
                      "UPDATE managed_outcome_outbox SET body=?",
                      JSON.stringify({ ...f.body, at: f.body.at + 1 }),
                    );
                  if (mode === "generation") Object.assign(channel, { binding: { ...f.binding, generation: 2 } });
                  return [outcomeAuditId(f.outcome)];
                },
              }),
            },
          },
        });
        state.storage.sql.exec("DELETE FROM alarm_deadlines");
        await alarms.set("managed-outcomes", Date.now());
        try {
          await channel.alarm();
        } finally {
          Object.assign(channel, { env: originalEnv, binding: f.binding });
        }
        expect(state.storage.sql.exec("SELECT id FROM managed_outcome_outbox").toArray()).toHaveLength(1);
        expect(alarms.deadline("managed-outcomes")).not.toBeNull();
      });
    }
  });

  it("exports final external outcomes without deleting the pending capacity reservation", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (object, state) => {
      const sql = state.storage.sql;
      appendManagedOutcome(
        sql,
        "managed_external_outcomes",
        "pending",
        { ...f.body, outcome: "external_pending" },
        f.body.at,
      );
      appendManagedOutcome(
        sql,
        "managed_external_outcomes",
        f.permit.requestId,
        { ...f.body, outcome: "pr_created" },
        f.body.at,
      );
      state.storage.sql.exec("DELETE FROM alarm_deadlines");
      await new Alarms(state.storage).set("managed-outcomes", Date.now());
      await object.alarm();
      expect(sql.exec("SELECT id FROM managed_external_outcomes").toArray()).toEqual([{ id: "pending" }]);
      expect(new Alarms(state.storage).deadline("managed-outcomes")).not.toBeNull();
    });
    const records = await f.org.auditRecords(f.actor);
    expect(records?.find((record) => record.reason === "channel_outcome:pr_created")?.outcome).toBe("pr_created");
  });

  it("bounds batches and fields and expires records at the D4 deadline", async () => {
    const f = await fixture();
    expect(await f.org.recordChannelOutcomes(Array.from({ length: OUTCOME_BATCH_SIZE + 1 }, () => f.outcome))).toEqual(
      [],
    );
    expect(managedOutcome("managed_outcome_outbox", f.permit.id, { ...f.body, action: "a".repeat(81) })).toBeNull();
    expect(
      managedOutcome("managed_outcome_outbox", f.permit.id, f.body, f.body.at + MANAGED_OUTCOME_TTL_MS),
    ).toBeNull();
    await runInDurableObject(f.channel, async (object, state) => {
      appendManagedOutcome(
        state.storage.sql,
        "managed_outcome_outbox",
        "expired",
        f.body,
        Date.now() - MANAGED_OUTCOME_TTL_MS,
      );
      state.storage.sql.exec("DELETE FROM alarm_deadlines");
      await new Alarms(state.storage).set("managed-outcomes", Date.now());
      await object.alarm();
      expect(state.storage.sql.exec("SELECT id FROM managed_outcome_outbox").toArray()).toHaveLength(0);
    });
  });

  it("advances durable batches past retained unverifiable historical rows", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (object, state) => {
      for (let index = 0; index < OUTCOME_BATCH_SIZE; index++)
        appendManagedOutcome(state.storage.sql, "managed_outcome_outbox", `!historical-${index}`, {
          outcome: "committed",
        });
      const alarms = new Alarms(state.storage);
      state.storage.sql.exec("DELETE FROM alarm_deadlines");
      await alarms.set("managed-outcomes", Date.now());
      await object.alarm();
      expect(state.storage.sql.exec("SELECT id FROM managed_outcome_outbox").toArray()).toHaveLength(
        OUTCOME_BATCH_SIZE + 1,
      );
      // The next alarm reads its cursor from durable SQL, not an in-memory offset.
      await alarms.set("managed-outcomes", Date.now());
      await object.alarm();
      expect(state.storage.sql.exec("SELECT id FROM managed_outcome_outbox WHERE id=?", f.permit.id).toArray()).toEqual(
        [],
      );
      expect(state.storage.sql.exec("SELECT id FROM managed_outcome_outbox").toArray()).toHaveLength(
        OUTCOME_BATCH_SIZE,
      );
      expect(alarms.deadline("managed-outcomes")).not.toBeNull();
    });
    expect(
      (await f.org.auditRecords(f.actor))?.find((record) => record.id === outcomeAuditId(f.outcome)),
    ).toBeDefined();
  });

  it("acknowledges valid evidence beside an uncorrelated row and rejects conflicting batch replays", async () => {
    const f = await fixture();
    const uncorrelated = { ...f.outcome, id: "unissued", requestId: "unissued" };
    const conflicting = { ...f.outcome, requestId: "conflicting" };
    expect(await f.org.recordChannelOutcomes([f.outcome, conflicting])).toEqual([]);
    expect(
      (await f.org.auditRecords(f.actor))?.find((record) => record.id === outcomeAuditId(f.outcome)),
    ).toBeUndefined();
    expect(await f.org.recordChannelOutcomes([uncorrelated, f.outcome])).toEqual([outcomeAuditId(f.outcome)]);
    expect(await f.org.recordChannelOutcomes([f.outcome, uncorrelated])).toEqual([outcomeAuditId(f.outcome)]);
    expect(
      (await f.org.auditRecords(f.actor))?.filter((record) => record.id === outcomeAuditId(f.outcome)),
    ).toHaveLength(1);
  });

  it("skips unlinked export synchronously without accessing storage or authority", async () => {
    const channel = bareChannel({ version: 1, state: "unlinked", workspace: null, operation: null, generation: 0 });
    Object.assign(channel, {
      alarms: { takeDue: () => new Set(["managed-outcomes"]), arm: async () => {} },
    });
    await expect(channel.alarm()).resolves.toBeUndefined();
  });
});
