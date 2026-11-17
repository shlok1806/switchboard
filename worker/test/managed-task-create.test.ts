import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelAuthorization } from "../src/organization";
import { FakeGitHub } from "./fake-github";
import { b2Effects, b2Request, denyB2 } from "./managed-b2a-cases";
import { queryDenials, queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);
const body = { title: "Created task", description: "Shared description", labels: [] };
async function fixture() {
  const f = await queryExecutionFixture();
  const github = new FakeGitHub();
  await runInDurableObject(f.channel, (object) => {
    Object.assign(object, { gitHub: () => github });
  });
  return { ...f, github };
}
describe("managed human Task creation", () => {
  it("records exact request intent before Issue creation and consumes a fresh resulting-Task permit after mirror preparation", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, async (channel, state) => {
      const create = f.github.createIssue.bind(f.github);
      f.github.createIssue = async (input) => {
        const rows = state.storage.sql.exec<{ body: string }>("SELECT body FROM managed_external_outcomes").toArray();
        expect(rows.map((r) => JSON.parse(r.body))).toContainEqual(
          expect.objectContaining({
            outcome: "external_pending",
            resource: expect.objectContaining({
              operation: "task.create.intent",
              targetId: expect.stringMatching(/^create:/),
            }),
          }),
        );
        return create(input);
      };
      const response = await channel.managedRequest(b2Request(f, "/api/tasks", body, true), f.repo);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ ok: true, task: { number: 1, title: body.title } });
      const receipts = state.storage.sql
        .exec<{ body: string }>("SELECT body FROM managed_permits")
        .toArray()
        .map((r) => JSON.parse(r.body));
      expect(receipts).toHaveLength(2);
      expect(receipts).toContainEqual(
        expect.objectContaining({
          used: true,
          permit: expect.objectContaining({
            action: "task.update",
            resource: expect.objectContaining({ targetId: "1", operation: "task.create" }),
          }),
        }),
      );
      expect(
        state.storage.sql
          .exec<{ body: string }>("SELECT body FROM managed_external_outcomes")
          .toArray()
          .map((r) => JSON.parse(r.body)),
      ).toContainEqual(expect.objectContaining({ outcome: "issue_created", issue: 1 }));
    });
  });
  it("prepares every Issue relationship before acquiring the exact Task permit", async () => {
    const f = await fixture();
    const order: string[] = [];
    const create = f.github.createIssue.bind(f.github);
    f.github.createIssue = async (input) => ({ ...(await create(input)), subIssueCount: 1 });
    f.github.listSubIssues = async () => {
      order.push("relationships");
      return [];
    };
    await runInDurableObject(f.channel, async (channel) => {
      const original = (channel as unknown as { env: Env }).env;
      const org = original.ORGANIZATION.getByName(f.organizationId);
      Object.assign(channel, {
        env: {
          ...original,
          ORGANIZATION: {
            getByName: () => ({
              authorizeChannelRead: (input: ChannelAuthorization) => org.authorizeChannelRead(input),
              issueMutationPermit: async (input: ChannelAuthorization) => {
                order.push(input.resource.operation ?? "unknown");
                return org.issueMutationPermit(input);
              },
            }),
          },
        },
      });
      try {
        expect((await channel.managedRequest(b2Request(f, "/api/tasks", body, true), f.repo)).status).toBe(201);
      } finally {
        Object.assign(channel, { env: original });
      }
    });
    expect(order).toEqual(["task.create.intent", "relationships", "task.create"]);
  });
  it("exports and acknowledges the bounded external Issue outcome without losing the Issue number", async () => {
    const f = await fixture();
    expect((await f.channel.managedRequest(b2Request(f, "/api/tasks", body, true), f.repo)).status).toBe(201);
    await runInDurableObject(f.channel, async (channel, state) => {
      state.storage.sql.exec("DELETE FROM alarm_deadlines");
      state.storage.sql.exec("INSERT INTO alarm_deadlines VALUES('managed-outcomes',?)", Date.now() - 1);
      await channel.alarm();
      expect(state.storage.sql.exec("SELECT * FROM managed_external_outcomes").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT * FROM managed_outcome_outbox").toArray()).toEqual([]);
    });
    await runInDurableObject(f.org, (_object, state) => {
      expect(
        state.storage.sql
          .exec<{ body: string }>(
            "SELECT body FROM audit WHERE json_extract(body,'$.reason')='channel_outcome:issue_created:1'",
          )
          .toArray(),
      ).toHaveLength(1);
    });
  });
  it("records a failed external creation without a local Task or upstream error details", async () => {
    const f = await fixture();
    f.github.createIssue = async () => {
      throw new Error("private external marker");
    };
    const response = await f.channel.managedRequest(b2Request(f, "/api/tasks", body, true), f.repo);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private external marker");
    await runInDurableObject(f.channel, (_object, state) => {
      expect(state.storage.sql.exec("SELECT * FROM tasks").toArray()).toEqual([]);
      expect(
        state.storage.sql
          .exec<{ body: string }>("SELECT body FROM managed_external_outcomes")
          .toArray()
          .map((row) => JSON.parse(row.body)),
      ).toContainEqual(expect.objectContaining({ outcome: "issue_failed" }));
    });
  });
  for (const denial of queryDenials)
    it(`denies creation before external or local effects: ${denial}`, async () => {
      const f = await fixture();
      const human = !["revoked_execution", "expired_execution"].includes(denial);
      await denyB2(f, denial, human);
      const before = await b2Effects(f);
      const response = await f.channel.managedRequest(b2Request(f, "/api/tasks", body, human), f.repo);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
      expect(await f.github.listOpenIssues()).toEqual([]);
      expect(await b2Effects(f)).toEqual(before);
    });
  it("rejects an otherwise authorized live Agent", async () => {
    const f = await fixture();
    expect((await f.channel.managedRequest(b2Request(f, "/api/tasks", body), f.repo)).status).toBe(404);
    expect(await f.github.listOpenIssues()).toEqual([]);
  });
  for (const phase of [
    "external",
    "final_permit",
    "release",
    "final_generation",
    "final_expiry",
    "final_target",
    "final_outage",
  ] as const)
    it(`fences creation at ${phase} and retains external outcome`, async () => {
      const f = await fixture();
      await runInDurableObject(f.channel, async (channel, state) => {
        const original = (channel as unknown as { env: Env }).env;
        const org = original.ORGANIZATION.getByName(f.organizationId);
        const revoke = async () => {
          const meta = await org.metadata(f.actor);
          const res = await org.mutate({
            actor: f.actor,
            command: {
              kind: "workspace.member",
              workspaceId: f.workspaceId,
              personId: f.actor.personId,
              role: "manager",
              status: "revoked",
              reason: "membership revoked",
            },
            key: `revoke-${phase}-${Date.now()}-${Math.random()}`,
            requestId: `revoke-req-${phase}-${Date.now()}-${Math.random()}`,
            expectedRevision: meta?.policyRevision,
          });
          if (!res.ok) throw new Error(`revoke failed: ${res.reason}`);
        };
        let reads = 0;
        Object.assign(channel, {
          env: {
            ...original,
            ORGANIZATION: {
              getByName: () => ({
                issueMutationPermit: async (input: ChannelAuthorization) => {
                  if (phase === "final_permit" && input.resource.operation === "task.create") await revoke();
                  if (phase === "final_outage" && input.resource.operation === "task.create")
                    throw new Error("private authority marker");
                  const result = await org.issueMutationPermit(input);
                  if (result.ok && input.resource.operation === "task.create") {
                    if (phase === "final_generation")
                      Object.assign(channel, { binding: { ...channel.bindingState(), generation: 2 } });
                    if (phase === "final_expiry") result.value.expiresAt = Date.now();
                    if (phase === "final_target") result.value.resource.targetId = "foreign-task";
                  }
                  return result;
                },
                authorizeChannelRead: async (input: ChannelAuthorization) => {
                  if (phase === "release" && ++reads === 2) await revoke();
                  return org.authorizeChannelRead(input);
                },
              }),
            },
          },
        });
        if (phase === "external") {
          const create = f.github.createIssue.bind(f.github);
          f.github.createIssue = async (input) => {
            const issue = await create(input);
            await revoke();
            return issue;
          };
        }
        try {
          const response = await channel.managedRequest(b2Request(f, "/api/tasks", body, true), f.repo);
          expect(response.status).toBe(phase === "final_outage" ? 503 : 404);
          const text = await response.text();
          expect(text).not.toContain(body.title);
          expect(text).not.toContain("private authority marker");
          expect(state.storage.sql.exec("SELECT * FROM tasks").toArray()).toHaveLength(phase === "release" ? 1 : 0);
          expect(
            state.storage.sql
              .exec<{ body: string }>("SELECT body FROM managed_external_outcomes")
              .toArray()
              .map((r) => JSON.parse(r.body)),
          ).toContainEqual(expect.objectContaining({ outcome: "issue_created", issue: 1 }));
        } finally {
          Object.assign(channel, { env: original });
        }
      });
    });
});
