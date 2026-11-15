import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelAuthorization } from "../src/organization";
import { managedAuthorityFixture } from "./managed-helpers";

describe("managed facade Update commit", () => {
  for (const change of ["none", "target", "generation", "revision"] as const) {
    it(`${change === "none" ? "commits" : "fences"} a real Update with ${change} receipt change`, async () => {
      const f = await managedAuthorityFixture();
      await runInDurableObject(env.CHANNEL.getByName(f.repo), async (channel, state) => {
        Object.assign(channel, {
          binding: { version: 1, generation: 1, workspace: f.workspaceId, operation: "binding", state: "linked" },
        });
        const before = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n;
        const original = (channel as unknown as { env: Env }).env;
        Object.assign(channel, {
          env: {
            ...original,
            ORGANIZATION: {
              getByName: () => ({
                issueMutationPermit: async (input: ChannelAuthorization) => {
                  // Create the forwarding stub in this DO callback, never capture a
                  // cross-context stub from the fixture.
                  const result = await env.ORGANIZATION.getByName(f.organizationId).issueMutationPermit(input);
                  if (!result.ok) return result;
                  if (change === "target") result.value.resource.targetId = "foreign-target";
                  if (change === "generation") result.value.generation++;
                  if (change === "revision") channel.invalidateManagedPolicy(f.workspaceId, result.policyRevision + 1);
                  return result;
                },
              }),
            },
          },
        });
        try {
          const response = await channel.managedRequest(
            new Request(`https://switchboard.test/r/${f.repo}/api/updates`, {
              method: "POST",
              headers: { Authorization: `Bearer ${f.token}` },
              body: JSON.stringify({ text: "facade-write-marker" }),
            }),
            f.repo,
          );
          expect(response.status).toBe(change === "none" ? 201 : 404);
          const after = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n;
          if (change === "none") {
            expect(after).toBeGreaterThan(before);
            const used = state.storage.sql.exec<{ body: string }>("SELECT body FROM managed_permits").toArray();
            expect(used.some((row) => JSON.parse(row.body).used)).toBe(true);
          } else {
            expect(after).toBe(before);
            expect(await response.text()).not.toContain("facade-write-marker");
          }
        } finally {
          Object.assign(channel, { env: original });
        }
      });
    });
  }
});
