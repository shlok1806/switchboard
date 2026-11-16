import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { decide } from "../src/policy";
import type { IntegrationActor } from "../src/policy-permits";
import { FakeGitHub } from "./fake-github";
import { b2Request } from "./managed-b2a-cases";
import { bareChannel, legacyBinding } from "./managed-helpers";
import { queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);
async function fixture() {
  const f = await queryExecutionFixture();
  const github = new FakeGitHub();
  const issue = await github.createIssue({ title: "Mirrored issue", body: "body", labels: [] });
  await runInDurableObject(f.channel, (object) => {
    Object.assign(object, { gitHub: () => github });
  });
  return { ...f, github, issue };
}
describe("typed GitHub mirror scope", () => {
  it("admits a real webhook mirror with an exact integration permit without borrowing a Person's membership", async () => {
    const f = await fixture();
    await runInDurableObject(f.org, (_object, state) => {
      const aggregate = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
      );
      delete aggregate.members[f.actor.personId];
      delete aggregate.workspaceMembers[f.workspaceId][f.actor.personId];
      state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
      state.storage.sql.exec("UPDATE executions SET body=json_set(body,'$.status','revoked')");
    });
    const response = await f.channel.gitHubWebhook(f.repo, { issues: [f.issue.number] });
    expect(response.ok).toBe(true);
    await runInDurableObject(f.channel, (_object, state) => {
      expect(state.storage.sql.exec("SELECT * FROM tasks WHERE number=?", f.issue.number).toArray()).toHaveLength(1);
      const receipts = state.storage.sql
        .exec<{ body: string }>("SELECT body FROM managed_permits")
        .toArray()
        .map((r) => JSON.parse(r.body));
      expect(receipts).toContainEqual(
        expect.objectContaining({
          used: true,
          permit: expect.objectContaining({
            actor: expect.objectContaining({ kind: "integration", repository: f.repo, workspaceId: f.workspaceId }),
            action: "task.update",
            resource: expect.objectContaining({ operation: "github.mirror", targetId: String(f.issue.number) }),
          }),
        }),
      );
    });
  });
  for (const change of [
    "foreign_repo",
    "foreign_workspace",
    "generation",
    "pending",
    "unknown",
    "inactive_workspace",
    "outage",
    "revoke_during_prepare",
  ] as const)
    it(`refuses mirror effects after ${change}`, async () => {
      const f = await fixture();
      await runInDurableObject(f.channel, (object) => {
        if (["foreign_workspace", "generation", "pending", "unknown"].includes(change))
          Object.assign(object, {
            binding: {
              ...object.bindingState(),
              workspace: change === "foreign_workspace" ? `${f.organizationId}:${crypto.randomUUID()}` : f.workspaceId,
              generation: change === "generation" ? 2 : 1,
              state: change === "pending" ? "pending" : "linked",
              version: change === "unknown" ? 2 : 1,
            },
          });
      });
      if (change === "inactive_workspace")
        await runInDurableObject(f.org, (_object, state) => {
          const aggregate = JSON.parse(
            state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
          );
          aggregate.workspaces[f.workspaceId].status = "archived";
          state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
        });
      await runInDurableObject(f.channel, async (channel, state) => {
        const original = (channel as unknown as { env: Env }).env;
        if (change === "outage" || change === "revoke_during_prepare")
          Object.assign(channel, {
            env: {
              ...original,
              ORGANIZATION: {
                getByName: () => ({
                  issueIntegrationPermit: async (
                    input: Parameters<import("../src/organization").Organization["issueIntegrationPermit"]>[0],
                  ) => {
                    if (change === "outage") throw new Error("private integration marker");
                    const result = await env.ORGANIZATION.getByName(f.organizationId).issueIntegrationPermit(input);
                    if (result.ok) channel.invalidateManagedPolicy(f.workspaceId, result.policyRevision + 1);
                    return result;
                  },
                }),
              },
            },
          });
        try {
          const response = await channel.gitHubWebhook(change === "foreign_repo" ? "foreign/repo" : f.repo, {
            issues: [f.issue.number],
          });
          expect(response.ok).toBe(false);
          expect(JSON.stringify(response)).not.toContain("private integration marker");
          expect(state.storage.sql.exec("SELECT * FROM tasks").toArray()).toEqual([]);
          expect(state.storage.sql.exec("SELECT * FROM events WHERE type LIKE 'task.%'").toArray()).toEqual([]);
        } finally {
          Object.assign(channel, { env: original });
        }
      });
    });
  it("runs reconciliation through the real Channel alarm with scoped final mirror receipts", async () => {
    const f = await fixture();
    // Establish the repository through the trusted webhook boundary first.
    expect((await f.channel.gitHubWebhook(f.repo, { issues: [f.issue.number] })).ok).toBe(true);
    const second = await f.github.createIssue({ title: "Reconciled issue", body: "", labels: [] });
    await runInDurableObject(f.channel, async (channel, state) => {
      state.storage.sql.exec("DELETE FROM alarm_deadlines");
      state.storage.sql.exec("INSERT INTO alarm_deadlines VALUES('tasks',?)", Date.now() - 1);
      await channel.alarm();
      expect(state.storage.sql.exec("SELECT * FROM tasks WHERE number=?", second.number).toArray()).toHaveLength(1);
      expect(
        state.storage.sql
          .exec<{ body: string }>("SELECT body FROM managed_permits")
          .toArray()
          .map((r) => JSON.parse(r.body)),
      ).toContainEqual(
        expect.objectContaining({
          used: true,
          permit: expect.objectContaining({
            resource: expect.objectContaining({ targetId: String(second.number), operation: "github.mirror" }),
          }),
        }),
      );
    });
  });
  it("fences the real code webhook and returns no raw diff Event", async () => {
    const f = await fixture();
    const delivery = f.github.push("task/1-work", { commits: ["Shared change"], repo: f.repo });
    const result = await f.channel.gitHubCodeWebhook(f.repo, "delivery", {
      kind: "push",
      branch: "task/1-work",
      task: 1,
      base: "main",
      head: delivery.after,
    });
    expect(result).toEqual({ ok: true, event: null });
    await runInDurableObject(f.channel, (_object, state) => {
      expect(state.storage.sql.exec("SELECT * FROM events WHERE id='github:delivery'").toArray()).toHaveLength(1);
    });
    await runInDurableObject(f.channel, (channel) =>
      Object.assign(channel, { binding: { ...channel.bindingState(), generation: 2 } }),
    );
    expect(
      (
        await f.channel.gitHubCodeWebhook(f.repo, "denied-delivery", {
          kind: "push",
          branch: "task/1-work",
          task: 1,
          base: "main",
          head: delivery.after,
        })
      ).ok,
    ).toBe(false);
    await runInDurableObject(f.channel, (_object, state) =>
      expect(state.storage.sql.exec("SELECT * FROM events WHERE id='github:denied-delivery'").toArray()).toEqual([]),
    );
  });
  it("keeps coordination labels behind a fresh mirror receipt through the real claim handler", async () => {
    const f = await fixture();
    expect((await f.channel.gitHubWebhook(f.repo, { issues: [1] })).ok).toBe(true);
    await runInDurableObject(f.org, (_object, state) => {
      const actions = ["workspace.read", "task.read", "task.claim", "task.update"];
      for (const id of [f.organizationId, f.workspaceId])
        state.storage.sql.exec("UPDATE identity_policy SET body=? WHERE id=?", JSON.stringify(actions), id);
      state.storage.sql.exec("UPDATE grants SET body=json_set(body,'$.actions',json(?))", JSON.stringify(actions));
    });
    await runInDurableObject(f.channel, (_object, state) =>
      state.storage.sql
        .exec("INSERT OR REPLACE INTO task_sync VALUES('syncedAt',?)", new Date().toISOString())
        .toArray(),
    );
    const response = await f.channel.managedRequest(b2Request(f, "/api/tasks/1/claim", {}), f.repo);
    expect(response.status).toBe(200);
    await runInDurableObject(f.channel, (_object, state) => {
      const task = JSON.parse(
        state.storage.sql.exec<{ data: string }>("SELECT data FROM tasks WHERE number=1").one().data,
      );
      expect(task.claim.holder.agentId).toBe(f.targetId);
      expect(task.labels).toContain("status:claimed");
      expect(
        state.storage.sql
          .exec<{ body: string }>("SELECT body FROM managed_permits")
          .toArray()
          .map((r) => JSON.parse(r.body)),
      ).toContainEqual(
        expect.objectContaining({
          used: true,
          permit: expect.objectContaining({
            actor: expect.objectContaining({ kind: "integration" }),
            resource: expect.objectContaining({ targetId: "1", operation: "github.coordination" }),
          }),
        }),
      );
    });
  });
  it("exports typed integration outcomes with auditable repository and generation after receipt expiry", async () => {
    const f = await fixture();
    expect((await f.channel.gitHubWebhook(f.repo, { issues: [1] })).ok).toBe(true);
    await runInDurableObject(f.org, (_object, state) =>
      state.storage.sql.exec("DELETE FROM mutation_permits").toArray(),
    );
    await runInDurableObject(f.channel, async (channel, state) => {
      state.storage.sql.exec("DELETE FROM alarm_deadlines");
      state.storage.sql.exec("INSERT INTO alarm_deadlines VALUES('managed-outcomes',?)", Date.now() - 1);
      await channel.alarm();
      expect(state.storage.sql.exec("SELECT * FROM managed_outcome_outbox").toArray()).toEqual([]);
    });
    await runInDurableObject(f.org, (_object, state) => {
      const records = state.storage.sql
        .exec<{ body: string }>(
          "SELECT body FROM audit WHERE json_extract(body,'$.reason')='channel_outcome:committed'",
        )
        .toArray()
        .map((row) => JSON.parse(row.body));
      expect(records).toContainEqual(
        expect.objectContaining({
          actor: {
            kind: "integration",
            provider: "github",
            repository: f.repo,
            workspaceId: f.workspaceId,
            generation: 1,
          },
        }),
      );
    });
  });
  it("keeps unlinked webhook dispatch synchronous with no managed environment access", () => {
    const channel = bareChannel(legacyBinding);
    const result = Promise.resolve({ ok: true as const, value: null });
    Object.assign(channel, { access: { setRepo: () => {} }, tasks: { webhook: () => result } });
    Object.defineProperty(channel, "env", {
      get: () => {
        throw new Error("unlinked managed access");
      },
    });
    expect(channel.gitHubWebhook("legacy/repo", { issues: [1] })).toBe(result);
  });
  it("has no content, control or user-impersonation authority", async () => {
    const f = await fixture();
    const actor: IntegrationActor = {
      kind: "integration",
      provider: "github",
      repository: f.repo,
      workspaceId: f.workspaceId,
      generation: 1,
    };
    const resource = {
      kind: "workspace" as const,
      organizationId: f.organizationId,
      id: f.workspaceId,
      channel: f.repo,
      targetId: "1",
      operation: "github.mirror",
    };
    for (const action of [
      "workspace.read",
      "channel.history.read",
      "agent.private_screen.read",
      "agent.directive.send",
      "agent.execution.start",
    ])
      expect(
        decide(actor, action, resource, {
          available: true,
          organizationId: f.organizationId,
          policyRevision: 1,
          workspaceActive: true,
          integration: actor,
        }).decision,
      ).toBe("deny");
    expect(
      decide(actor, "task.update", resource, {
        available: true,
        organizationId: f.organizationId,
        policyRevision: 1,
        workspaceActive: true,
      }).decision,
    ).toBe("deny");
  });
});
