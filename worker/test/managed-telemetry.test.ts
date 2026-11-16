import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { b2Effects, b2Request, denyB2 } from "./managed-b2a-cases";
import { queryDenials, queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);
const body = { tool: "list_tasks", arg: "secret-arg-marker", output: "secret-output-marker", ok: true, durationMs: 12 };
describe("managed telemetry handler", () => {
  it("appends own-execution metadata with an exact UW permit and omits arbitrary arguments/output", async () => {
    const f = await queryExecutionFixture();
    const response = await f.channel.managedRequest(b2Request(f, "/api/tool-calls", body), f.repo);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    await runInDurableObject(f.channel, (_object, state) => {
      const rows = state.storage.sql
        .exec<{ actor: string; payload: string }>("SELECT actor,payload FROM events WHERE type='tool.call'")
        .toArray();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("missing telemetry row");
      expect(JSON.parse(row.actor)).toEqual({ kind: "agent", agentId: f.targetId });
      expect(JSON.parse(row.payload)).toEqual({ tool: "list_tasks", arg: "", ok: true, durationMs: 12 });
      const receipts = state.storage.sql
        .exec<{ body: string }>("SELECT body FROM managed_permits")
        .toArray()
        .map((r) => JSON.parse(r.body));
      expect(receipts).toContainEqual(
        expect.objectContaining({
          used: true,
          permit: expect.objectContaining({
            action: "channel.update.write",
            resource: expect.objectContaining({ targetId: f.executionId, operation: "telemetry.append" }),
          }),
        }),
      );
    });
    expect(JSON.stringify(await b2Effects(f))).not.toContain("secret-");
  });
  for (const denial of queryDenials)
    it(`denies telemetry without effects: ${denial}`, async () => {
      const f = await queryExecutionFixture();
      await denyB2(f, denial);
      const before = await b2Effects(f);
      const response = await f.channel.managedRequest(b2Request(f, "/api/tool-calls", body), f.repo);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
      expect(await b2Effects(f)).toEqual(before);
    });
  for (const extra of [
    { agent: "foreign/codex/session" },
    { executionId: "foreign" },
    { task: 1 },
    { durationMs: -1 },
    { durationMs: 1e100 },
  ])
    it(`rejects unsafe telemetry metadata ${JSON.stringify(extra)}`, async () => {
      const f = await queryExecutionFixture();
      const before = await b2Effects(f);
      const response = await f.channel.managedRequest(b2Request(f, "/api/tool-calls", { ...body, ...extra }), f.repo);
      expect(response.status).toBe(400);
      expect(await b2Effects(f)).toEqual(before);
    });
  it("denies Person telemetry", async () => {
    const f = await queryExecutionFixture();
    const before = await b2Effects(f);
    expect((await f.channel.managedRequest(b2Request(f, "/api/tool-calls", body, true), f.repo)).status).toBe(404);
    expect(await b2Effects(f)).toEqual(before);
  });
});
