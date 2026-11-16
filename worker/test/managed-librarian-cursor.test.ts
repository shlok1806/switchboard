import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { managedOperationRoute } from "../src/managed-channel";
import { queryDenials, queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);
async function fixture() {
  const f = await queryExecutionFixture();
  await runInDurableObject(f.channel, (_object, state) => {
    state.storage.sql.exec("UPDATE agents SET librarian='1' WHERE id=?", f.targetId);
  });
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function request(f: Fixture, body: unknown = { through: 0, quiet: [1, 1, 2] }) {
  return new Request(`https://board.test/r/${f.repo}/api/librarian`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${f.credential}` },
    body: JSON.stringify(body),
  });
}
async function cursor(f: Fixture) {
  return runInDurableObject(f.channel, (_object, state) =>
    state.storage.sql.exec("SELECT * FROM librarian_cursor").toArray(),
  );
}

describe("managed librarian cursor", () => {
  it("moves only its own cursor through the real handler with an exact UW permit", async () => {
    const f = await fixture();
    expect(managedOperationRoute("PUT", "/api/librarian")).toMatchObject({
      action: "channel.update.write",
      targetId: "librarian",
      operation: "librarian.cursor",
      mode: "write",
    });
    const response = await f.channel.managedRequest(request(f), f.repo);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, cursor: 0 });
    expect(await cursor(f)).toEqual([expect.objectContaining({ seq: 0, quiet: "[1,2]", agent: f.targetId })]);
    await runInDurableObject(f.channel, (_object, state) => {
      const receipts = state.storage.sql.exec<{ body: string }>("SELECT body FROM managed_permits").toArray();
      expect(receipts.map((row) => JSON.parse(row.body))).toContainEqual(
        expect.objectContaining({
          used: true,
          permit: expect.objectContaining({
            action: "channel.update.write",
            resource: expect.objectContaining({ targetId: "librarian", operation: "librarian.cursor" }),
          }),
        }),
      );
    });
  });
  for (const denial of [...queryDenials, "not_librarian", "inactive_enrollment"] as const) {
    it(`denies cursor mutation without rows or cursor bytes: ${denial}`, async () => {
      const f = await fixture();
      if (denial === "insufficient_scope")
        await runInDurableObject(f.org, (_object, state) => {
          state.storage.sql.exec(
            "UPDATE grants SET body=json_set(body,'$.actions',json(?)) WHERE json_extract(body,'$.principalId')=?",
            JSON.stringify(["workspace.read"]),
            f.principalId,
          );
        });
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
      await runInDurableObject(f.channel, (object) => {
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
      });
      await runInDurableObject(f.channel, (_object, state) => {
        if (denial === "not_librarian")
          state.storage.sql.exec("UPDATE agents SET librarian=NULL WHERE id=?", f.targetId);
        if (denial === "inactive_enrollment") state.storage.sql.exec("UPDATE m1_agent_executions SET active=0");
      });
      const response = await f.channel.managedRequest(request(f), f.repo);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
      expect(await cursor(f)).toEqual([]);
    });
  }
  for (const change of ["librarian", "enrollment", "generation", "revision", "target", "expiry", "outage"] as const) {
    it(`fences cursor at permit completion after ${change} changes`, async () => {
      const f = await fixture();
      await runInDurableObject(f.channel, async (channel, state) => {
        const original = (channel as unknown as { env: Env }).env;
        Object.assign(channel, {
          env: {
            ...original,
            ORGANIZATION: {
              getByName: () => ({
                verifyExecution: (token: string) => env.ORGANIZATION.getByName(f.organizationId).verifyExecution(token),
                issueMutationPermit: async (input: import("../src/organization").ChannelAuthorization) => {
                  if (change === "outage") throw new Error("private upstream marker");
                  const result = await env.ORGANIZATION.getByName(f.organizationId).issueMutationPermit(input);
                  if (!result.ok) return result;
                  if (change === "librarian")
                    state.storage.sql.exec("UPDATE agents SET librarian=NULL WHERE id=?", f.targetId);
                  if (change === "enrollment") state.storage.sql.exec("UPDATE m1_agent_executions SET active=0");
                  if (change === "generation")
                    Object.assign(channel, { binding: { ...channel.bindingState(), generation: 2 } });
                  if (change === "revision") channel.invalidateManagedPolicy(f.workspaceId, result.policyRevision + 1);
                  if (change === "target") result.value.resource.targetId = "foreign-cursor";
                  if (change === "expiry") result.value.expiresAt = Date.now();
                  return result;
                },
              }),
            },
          },
        });
        try {
          const response = await channel.managedRequest(request(f), f.repo);
          expect(response.status).toBe(change === "outage" ? 503 : 404);
          expect(await response.text()).not.toContain("private upstream marker");
          expect(state.storage.sql.exec("SELECT * FROM librarian_cursor").toArray()).toEqual([]);
        } finally {
          Object.assign(channel, { env: original });
        }
      });
    });
  }
  for (const body of [
    { through: -1, quiet: [] },
    { through: 0, quiet: [0] },
    { through: 0.5, quiet: [] },
    { through: 0, quiet: Array(101).fill(1) },
    { through: Number.MAX_SAFE_INTEGER, quiet: [] },
  ]) {
    it(`rejects invalid cursor ${JSON.stringify(body)} without mutation`, async () => {
      const f = await fixture();
      const response = await f.channel.managedRequest(request(f, body), f.repo);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, reason: "invalid_cursor" });
      expect(await cursor(f)).toEqual([]);
    });
  }
});
