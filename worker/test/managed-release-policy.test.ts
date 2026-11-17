import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { managedOperationRoute } from "../src/managed-channel";
import { queryDenials, queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);

async function fixture() {
  const f = await queryExecutionFixture();
  await runInDurableObject(f.org, (_object, state) => {
    const actions = ["task.read", "task.claim", "task.update"];
    for (const id of [f.organizationId, f.workspaceId])
      state.storage.sql.exec("UPDATE identity_policy SET body=? WHERE id=?", JSON.stringify(actions), id);
    state.storage.sql.exec(
      "UPDATE grants SET body=json_set(body,'$.actions',json(?)) WHERE json_extract(body,'$.principalId')=?",
      JSON.stringify(actions),
      f.principalId,
    );
  });
  await runInDurableObject(f.channel, (object, state) => {
    // Keep real Tasks/Claims/permit storage; suppress only optional upstream mirroring.
    Object.assign(object, { gitHub: () => null });
    state.storage.sql.exec("INSERT OR REPLACE INTO task_sync VALUES('syncedAt',?)", new Date().toISOString());
    state.storage.sql.exec(
      "INSERT INTO tasks(number,data,holder_agent) VALUES(1,?,?)",
      JSON.stringify({
        number: 1,
        title: "Held task",
        status: "claimed",
        blockedBy: [],
        labels: [],
        steps: [],
        claim: {
          task: 1,
          holder: { kind: "agent", agentId: f.targetId },
          claimedAt: new Date().toISOString(),
          stale: false,
        },
      }),
      f.targetId,
    );
  });
  return f;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function request(f: Fixture) {
  return new Request(`https://board.test/r/${f.repo}/api/tasks/1/release`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.credential}` },
    body: "{}",
  });
}
async function release(f: Fixture) {
  return f.channel.managedRequest(request(f), f.repo);
}
async function task(f: Fixture) {
  return runInDurableObject(
    f.channel,
    (_object, state) => state.storage.sql.exec<{ data: string }>("SELECT data FROM tasks WHERE number=1").one().data,
  );
}
async function narrowGrant(
  f: Fixture,
  actions: string[],
  orgStub?: DurableObjectStub<import("../src/organization").Organization>,
) {
  const org = orgStub ?? f.org;
  const meta = await org.metadata(f.actor);
  const result = await org.mutateIdentity({
    actor: f.actor,
    command: {
      kind: "grant.put",
      principalId: f.principalId,
      workspaceId: f.workspaceId,
      actions,
      constraints: {},
      expiresAt: Date.now() + 600000,
    },
    key: `narrow-${Date.now()}-${Math.random()}`,
    requestId: `narrow-${Date.now()}-${Math.random()}`,
    expectedRevision: meta?.policyRevision,
  });
  if (!result.ok) throw new Error(`narrowGrant failed: ${result.reason}`);
}

describe("managed release uses claim authority", () => {
  it("releases through the real handler with task.claim and no task.update", async () => {
    const f = await fixture();
    await narrowGrant(f, ["task.read", "task.claim"]);
    expect(managedOperationRoute("POST", "/api/tasks/1/release")).toMatchObject({
      action: "task.claim",
      targetId: "1",
      operation: "task.release",
      mode: "write",
    });
    const response = await release(f);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, task: { number: 1, status: "open" } });
    expect(JSON.parse(await task(f)).claim).toBeUndefined();
    await runInDurableObject(f.channel, (_object, state) => {
      const rows = state.storage.sql.exec<{ body: string }>("SELECT body FROM managed_outcome_outbox").toArray();
      expect(rows.map((row) => JSON.parse(row.body))).toContainEqual(
        expect.objectContaining({
          action: "task.claim",
          resource: expect.objectContaining({ targetId: "1", operation: "task.release" }),
          outcome: "committed",
        }),
      );
      const permits = state.storage.sql.exec<{ body: string }>("SELECT body FROM managed_permits").toArray();
      expect(permits.map((row) => JSON.parse(row.body))).toContainEqual(
        expect.objectContaining({
          used: true,
          permit: expect.objectContaining({
            action: "task.claim",
            resource: expect.objectContaining({ targetId: "1", operation: "task.release" }),
          }),
        }),
      );
    });
  });

  for (const change of ["revoked", "generation", "holder", "scope"] as const) {
    it(`rechecks release after Task synchronization changes ${change}`, async () => {
      const f = await fixture();
      await runInDurableObject(f.channel, async (object, state) => {
        const org = (object as unknown as { env: Env }).env.ORGANIZATION.getByName(f.organizationId);
        const tasks = (object as unknown as { tasks: { ensureSynced(): Promise<unknown> } }).tasks;
        const sync = tasks.ensureSynced.bind(tasks);
        tasks.ensureSynced = async () => {
          const result = await sync();
          if (change === "generation") Object.assign(object, { binding: { ...object.bindingState(), generation: 2 } });
          if (change === "holder")
            state.storage.sql.exec(
              "UPDATE tasks SET data=json_set(data,'$.claim.holder',json(?)) WHERE number=1",
              JSON.stringify({ kind: "person", person: "bob" }),
            );
          if (change === "scope") await narrowGrant(f, ["task.read", "task.update"], org);
          if (change === "revoked") {
            const meta = await org.metadata(f.actor);
            const res = await org.mutateIdentity({
              actor: f.actor,
              command: {
                kind: "execution.revoke",
                executionId: f.executionId,
              },
              key: `revoke-sync-${Date.now()}-${Math.random()}`,
              requestId: `revoke-sync-req-${Date.now()}-${Math.random()}`,
              expectedRevision: meta?.policyRevision,
            });
            if (!res.ok) throw new Error(`revoke failed: ${res.reason}`);
          }
          return result;
        };
        const response = await object.managedRequest(request(f), f.repo);
        expect(response.status).toBe(change === "holder" ? 403 : 404);
        expect(await response.text()).not.toContain("Held task");
        const stored = JSON.parse(
          state.storage.sql.exec<{ data: string }>("SELECT data FROM tasks WHERE number=1").one().data,
        );
        expect(stored.status).toBe("claimed");
        expect(stored.claim.holder).toEqual(
          change === "holder" ? { kind: "person", person: "bob" } : { kind: "agent", agentId: f.targetId },
        );
        expect(
          state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type='claim.release'").one().n,
        ).toBe(0);
      });
    });
  }

  it("withholds the Task result if authority is revoked during post-commit mirroring", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (object, state) => {
      const org = (object as unknown as { env: Env }).env.ORGANIZATION.getByName(f.organizationId);
      const claims = (object as unknown as { claims: { mirror(): Promise<void> } }).claims;
      claims.mirror = async () => {
        const meta = await org.metadata(f.actor);
        const res = await org.mutateIdentity({
          actor: f.actor,
          command: {
            kind: "execution.revoke",
            executionId: f.executionId,
          },
          key: `revoke-mirror-${Date.now()}-${Math.random()}`,
          requestId: `revoke-mirror-req-${Date.now()}-${Math.random()}`,
          expectedRevision: meta?.policyRevision,
        });
        if (!res.ok) throw new Error(`revoke failed: ${res.reason}`);
      };
      const response = await object.managedRequest(request(f), f.repo);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
      // The already authorized local effect remains committed; its private response does not escape.
      const stored = JSON.parse(
        state.storage.sql.exec<{ data: string }>("SELECT data FROM tasks WHERE number=1").one().data,
      );
      expect(stored.status).toBe("open");
      expect(stored.claim).toBeUndefined();
      expect(
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type='claim.release'").one().n,
      ).toBe(1);
    });
  });

  for (const denial of [...queryDenials, "update_only", "foreign_holder"] as const) {
    it(`denies release without task changes or release Events: ${denial}`, async () => {
      const f = await fixture();
      if (denial === "update_only" || denial === "insufficient_scope")
        await narrowGrant(f, ["task.read", "task.update"]);
      await runInDurableObject(f.org, (_object, state) => {
        if (denial === "non_member" || denial === "insufficient_role") {
          const aggregate = JSON.parse(
            state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
          );
          if (denial === "non_member") delete aggregate.workspaceMembers[f.workspaceId][f.actor.personId];
          else aggregate.workspaceMembers[f.workspaceId][f.actor.personId].role = "viewer";
          state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
        }
        if (denial === "revoked_execution")
          state.storage.sql.exec(
            "UPDATE executions SET body=json_set(body,'$.status','revoked') WHERE id=?",
            f.executionId,
          );
        if (denial === "expired_execution")
          state.storage.sql.exec(
            "UPDATE execution_credentials SET body=json_set(body,'$.expiresAt',0) WHERE json_extract(body,'$.executionId')=?",
            f.executionId,
          );
      });
      await runInDurableObject(f.channel, (object, state) => {
        if (["foreign_organization", "foreign_workspace", "wrong_generation"].includes(denial))
          Object.assign(object, {
            binding: {
              ...object.bindingState(),
              generation: denial === "wrong_generation" ? 2 : 1,
              workspace:
                denial === "foreign_organization"
                  ? `${crypto.randomUUID()}:${crypto.randomUUID()}`
                  : denial === "foreign_workspace"
                    ? `${f.organizationId}:${crypto.randomUUID()}`
                    : f.workspaceId,
            },
          });
        if (denial === "foreign_holder")
          state.storage.sql.exec(
            "UPDATE tasks SET data=json_set(data,'$.claim.holder',json(?)) WHERE number=1",
            JSON.stringify({ kind: "person", person: "bob" }),
          );
      });
      const before = await task(f);
      const response = await release(f);
      expect(response.status).toBe(denial === "foreign_holder" ? 403 : 404);
      expect(await response.text()).not.toContain("Held task");
      expect(await task(f)).toBe(before);
      await runInDurableObject(f.channel, (_object, state) => {
        expect(
          state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type='claim.release'").one().n,
        ).toBe(0);
      });
    });
  }
});
