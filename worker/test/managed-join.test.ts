import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelAuthorization } from "../src/organization";
import { b2Effects, b2Request, denyB2 } from "./managed-b2a-cases";
import { queryDenials, queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);
describe("managed native presence handler", () => {
  it("joins the authenticated native identity with a WR permit and exposes no private Person fields", async () => {
    const f = await queryExecutionFixture();
    const response = await f.channel.managedRequest(
      b2Request(f, "/api/join", { person: "foreign", timeZone: "UTC" }, true),
      f.repo,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, person: { personId: f.actor.personId } });
    await runInDurableObject(f.channel, (_object, state) => {
      expect(state.storage.sql.exec("SELECT * FROM persons WHERE name=?", f.actor.personId).toArray()).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT * FROM persons WHERE name='foreign'").toArray()).toEqual([]);
      expect(
        state.storage.sql
          .exec<{ body: string }>("SELECT body FROM managed_permits")
          .toArray()
          .map((r) => JSON.parse(r.body)),
      ).toContainEqual(
        expect.objectContaining({
          used: true,
          permit: expect.objectContaining({
            action: "workspace.read",
            resource: expect.objectContaining({ operation: "presence.join", targetId: f.actor.personId }),
          }),
        }),
      );
    });
  });
  for (const denial of queryDenials)
    it(`denies presence without effects: ${denial}`, async () => {
      const f = await queryExecutionFixture();
      // WR permits viewer presence. An execution has no native Person presence scope.
      const human = !["revoked_execution", "expired_execution", "insufficient_scope"].includes(denial);
      await denyB2(f, denial, human);
      const before = await b2Effects(f);
      const response = await f.channel.managedRequest(b2Request(f, "/api/join", {}, human), f.repo);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
      expect(await b2Effects(f)).toEqual(before);
    });
  it("withholds native presence after membership is revoked before response release", async () => {
    const f = await queryExecutionFixture();
    await runInDurableObject(f.channel, async (channel, state) => {
      const original = (channel as unknown as { env: Env }).env;
      const org = original.ORGANIZATION.getByName(f.organizationId);
      Object.assign(channel, {
        env: {
          ...original,
          ORGANIZATION: {
            getByName: () => ({
              issueMutationPermit: (input: ChannelAuthorization) => org.issueMutationPermit(input),
              authorizeChannelRead: async (input: ChannelAuthorization) => {
                await runInDurableObject(f.org, (_object, orgState) => {
                  const aggregate = JSON.parse(
                    orgState.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
                  );
                  delete aggregate.workspaceMembers[f.workspaceId][f.actor.personId];
                  orgState.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
                });
                return org.authorizeChannelRead(input);
              },
            }),
          },
        },
      });
      try {
        const response = await channel.managedRequest(b2Request(f, "/api/join", {}, true), f.repo);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
        expect(
          state.storage.sql.exec("SELECT name FROM persons WHERE name=?", f.actor.personId).toArray(),
        ).toHaveLength(1);
      } finally {
        Object.assign(channel, { env: original });
      }
    });
  });
  it("rejects invalid time zones without changing presence", async () => {
    const f = await queryExecutionFixture();
    const before = await b2Effects(f);
    expect(
      (await f.channel.managedRequest(b2Request(f, "/api/join", { timeZone: "invalid-marker" }, true), f.repo)).status,
    ).toBe(400);
    expect(await b2Effects(f)).toEqual(before);
  });
});
