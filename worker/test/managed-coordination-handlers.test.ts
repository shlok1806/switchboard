import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { b2Effects, b2Request, denyB2 } from "./managed-b2a-cases";
import { queryDenials, queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);
const operations = [
  { suffix: "claim", action: "task.claim", body: {}, human: false },
  { suffix: "steps/0/complete", action: "task.update", body: {}, human: false },
  { suffix: "branch", action: "task.update", body: { branch: "task/1-work" }, human: false },
  { suffix: "finish", action: "task.update", body: {}, human: false },
  { suffix: "takeover", action: "task.update", body: { to: { kind: "person", person: "alice" } }, human: true },
] as const;
async function fixture(operation: (typeof operations)[number]) {
  const f = await queryExecutionFixture();
  await runInDurableObject(f.org, (_object, state) => {
    const actions = ["task.read", "task.update", "task.claim", "workspace.read"];
    for (const id of [f.organizationId, f.workspaceId])
      state.storage.sql.exec("UPDATE identity_policy SET body=? WHERE id=?", JSON.stringify(actions), id);
    state.storage.sql.exec("UPDATE grants SET body=json_set(body,'$.actions',json(?))", JSON.stringify(actions));
  });
  await runInDurableObject(f.channel, (object, state) => {
    const now = new Date().toISOString();
    state.storage.sql.exec("INSERT OR REPLACE INTO task_sync VALUES('syncedAt',?)", now);
    state.storage.sql.exec(
      "INSERT INTO tasks(number,data,holder_agent) VALUES(1,?,?)",
      JSON.stringify({
        number: 1,
        title: "Coordination task",
        description: "- [ ] Work",
        labels: [],
        blockedBy: [],
        subtasks: [],
        subtasksDone: 0,
        steps: [{ index: 0, text: "Work", done: false }],
        stepsDone: 0,
        url: "https://example.test/issues/1",
        updatedAt: now,
        status: operation.suffix === "claim" ? "open" : "claimed",
        ...(operation.suffix === "claim"
          ? {}
          : {
              claim: {
                task: 1,
                holder: operation.human ? { kind: "person", person: "other" } : { kind: "agent", agentId: f.targetId },
                claimedAt: now,
                stale: operation.human,
              },
            }),
        ...(operation.suffix === "finish" ? { branch: "task/1-work" } : {}),
      }),
      operation.human || operation.suffix === "claim" ? null : f.targetId,
    );
    // Suppress only upstream optional mirroring; local Tasks/Claims/Organization/decide/permits remain real.
    const claims = (object as unknown as { claims: { mirror: () => Promise<void> } }).claims;
    claims.mirror = async () => {};
    Object.assign(object, {
      gitHub: () => ({
        defaultBranch: async () => "main",
        createPullRequest: async () => ({ number: 2, url: "https://example.test/pull/2" }),
      }),
    });
  });
  return f;
}
describe("existing coordination through real managed handlers", () => {
  for (const operation of operations) {
    it(`commits ${operation.suffix} with the exact ${operation.action} permit`, async () => {
      const f = await fixture(operation);
      const response = await f.channel.managedRequest(
        b2Request(f, `/api/tasks/1/${operation.suffix}`, operation.body, operation.human),
        f.repo,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, task: { number: 1 } });
      await runInDurableObject(f.channel, (_object, state) => {
        expect(
          state.storage.sql
            .exec<{ body: string }>("SELECT body FROM managed_permits")
            .toArray()
            .map((r) => JSON.parse(r.body)),
        ).toContainEqual(
          expect.objectContaining({
            used: true,
            permit: expect.objectContaining({
              action: operation.action,
              resource: expect.objectContaining({ targetId: "1", operation: `task.${operation.suffix}` }),
            }),
          }),
        );
      });
    });
    for (const denial of queryDenials)
      it(`denies ${operation.suffix} before effects: ${denial}`, async () => {
        const f = await fixture(operation);
        const human = operation.human && !["revoked_execution", "expired_execution"].includes(denial);
        await denyB2(f, denial, human);
        const before = await b2Effects(f);
        const response = await f.channel.managedRequest(
          b2Request(f, `/api/tasks/1/${operation.suffix}`, operation.body, human),
          f.repo,
        );
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("Coordination task");
        expect(await b2Effects(f)).toEqual(before);
      });
  }
});
