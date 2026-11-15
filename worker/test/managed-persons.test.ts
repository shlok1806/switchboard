import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelAuthorization } from "../src/organization";
import { bareChannel, managedAuthorityFixture } from "./managed-helpers";
import { queryMetadataSql } from "./managed-query-cases";

const denials = [
  "non_member",
  "foreign_organization",
  "foreign_workspace",
  "revoked_execution",
  "expired_execution",
  "wrong_generation",
  "insufficient_role",
  "insufficient_scope",
];
function fixture(deny?: string, release = false, changeGeneration = false, changedMembers = false) {
  const repo = "shlok1806/other";
  const organizationId = crypto.randomUUID();
  const binding = {
    version: 1,
    generation: 1,
    workspace: `${organizationId}:${crypto.randomUUID()}`,
    operation: "binding",
    state: "linked",
  };
  const channel = bareChannel(binding);
  const calls: ChannelAuthorization[] = [];
  let reads = 0;
  Object.assign(channel, {
    ctx: { id: env.CHANNEL.idFromName(repo), storage: { sql: queryMetadataSql } },
    env: {
      CHANNEL: env.CHANNEL,
      ORGANIZATION: {
        getByName: () => ({
          authorizeChannelRead: async (input: ChannelAuthorization) => {
            calls.push(input);
            if (deny && (!release || reads > 0)) return { ok: false, reason: deny, status: 403, policyRevision: 1 };
            return { ok: true, value: { deadline: Date.now() + 60000 }, policyRevision: 1 };
          },
          readChannelPersons: async (input: ChannelAuthorization) => {
            calls.push(input);
            reads++;
            if (deny === "outage") throw new Error("private-authority-marker");
            if (deny && release && reads > 1) return { ok: false, reason: deny, status: 403, policyRevision: 1 };
            if (changeGeneration) binding.generation++;
            return {
              ok: true,
              value: { persons: changedMembers && reads > 1 ? [] : [{ personId: "native-person" }] },
              policyRevision: 1,
            };
          },
        }),
      },
    },
  });
  return {
    calls,
    reads: () => reads,
    request: () =>
      channel.managedRequest(
        new Request(`https://switchboard.test/r/${repo}/api/persons`, {
          headers: { Authorization: "Bearer m1.synthetic" },
        }),
        repo,
      ),
  };
}

describe("managed Persons HTTP handler", () => {
  it("admits the native allowlist through WR and rechecks membership before release", async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ persons: [{ personId: "native-person" }] });
    expect(f.reads()).toBe(2);
    expect(
      f.calls.every(
        (input) =>
          input.action === "workspace.read" &&
          input.resource.targetId === "persons" &&
          input.resource.operation === "persons.read" &&
          input.generation === 1,
      ),
    ).toBe(true);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  for (const denial of denials)
    for (const release of [false, true]) {
      it(`withholds roster and counts for ${denial} at ${release ? "release" : "admission"}`, async () => {
        const f = fixture(denial, release);
        const response = await f.request();
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("native-person");
        if (!release) expect(f.reads()).toBe(0);
      });
    }
  it("discards a page if the binding changes during preparation", async () => {
    const response = await fixture(undefined, false, true).request();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("native-person");
  });
  it("discards a page if a projected membership disappears at release", async () => {
    const response = await fixture(undefined, false, false, true).request();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("native-person");
  });
  it("redacts projection authority outages", async () => {
    const response = await fixture("outage", true).request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-authority-marker");
  });
});

describe("native Persons authority", () => {
  for (const revoked of ["none", "organization", "workspace"]) {
    it(`projects only current dual memberships with ${revoked} revocation`, async () => {
      const f = await managedAuthorityFixture();
      await runInDurableObject(f.org, (_object, state) => {
        const row = JSON.parse(
          state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
        );
        if (revoked === "organization") row.members[f.recipient.personId].status = "revoked";
        if (revoked === "workspace") row.workspaceMembers[f.workspaceId][f.recipient.personId].status = "revoked";
        row.members["org-only"] = { personId: "org-only", status: "active", private: "private-marker" };
        row.workspaceMembers[f.workspaceId]["workspace-only"] = {
          personId: "workspace-only",
          workspaceId: f.workspaceId,
          status: "active",
        };
        state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(row));
      });
      const input: ChannelAuthorization = {
        actor: f.actor,
        action: "workspace.read",
        generation: 1,
        requestId: "persons-test",
        resource: {
          kind: "workspace",
          organizationId: f.organizationId,
          id: f.workspaceId,
          channel: f.repo,
          targetId: "persons",
          operation: "persons.read",
        },
      };
      const result = await f.org.readChannelPersons(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("admission denied");
      expect(result.value.persons).toEqual(
        [f.actor.personId, ...(revoked === "none" ? [f.recipient.personId] : [])]
          .sort((a, b) => a.localeCompare(b))
          .map((personId) => ({ personId })),
      );
      for (const denied of [
        { ...input, generation: 2 },
        { ...input, action: "workspace.manage" },
        { ...input, resource: { ...input.resource, id: `${f.organizationId}:foreign` } },
      ])
        expect((await f.org.readChannelPersons(denied)).ok).toBe(false);
    });
  }
});
