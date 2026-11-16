import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelAuthorization } from "../src/organization";
import { b2Effects, b2Request } from "./managed-b2a-cases";
import { queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);
const surfaces = [
  { path: "/api/join", body: { timeZone: "UTC" }, human: true },
  { path: "/api/tool-calls", body: { tool: "list_tasks", ok: true, durationMs: 1 }, human: false },
] as const;
describe("B2a synchronous commit fences", () => {
  for (const surface of surfaces)
    for (const race of ["revocation", "generation", "revision", "expiry", "target", "outage", "replay"] as const)
      it(`${surface.path} has no effect after permit ${race}`, async () => {
        const f = await queryExecutionFixture();
        const before = await b2Effects(f);
        await runInDurableObject(f.channel, async (channel, state) => {
          const original = (channel as unknown as { env: Env }).env;
          const org = env.ORGANIZATION.getByName(f.organizationId);
          Object.assign(channel, {
            env: {
              ...original,
              ORGANIZATION: {
                getByName: () => ({
                  verifyExecution: (token: string) => org.verifyExecution(token),
                  authorizeChannelRead: (input: ChannelAuthorization) => org.authorizeChannelRead(input),
                  issueMutationPermit: async (input: ChannelAuthorization) => {
                    if (race === "outage") throw new Error("private authority marker");
                    const result = await org.issueMutationPermit(input);
                    if (!result.ok) return result;
                    if (race === "generation")
                      Object.assign(channel, { binding: { ...channel.bindingState(), generation: 2 } });
                    if (race === "revocation" || race === "revision")
                      channel.invalidateManagedPolicy(f.workspaceId, result.policyRevision + 1);
                    if (race === "expiry") result.value.expiresAt = Date.now();
                    if (race === "target") result.value.resource.targetId = "foreign-target";
                    if (race === "replay") {
                      state.storage.sql.exec(
                        "CREATE TABLE IF NOT EXISTS managed_permits(id TEXT PRIMARY KEY,body TEXT NOT NULL)",
                      );
                      state.storage.sql.exec(
                        "INSERT INTO managed_permits VALUES(?,?)",
                        result.value.id,
                        JSON.stringify({ permit: result.value, used: true }),
                      );
                    }
                    return result;
                  },
                }),
              },
            },
          });
          try {
            const response = await channel.managedRequest(
              b2Request(f, surface.path, surface.body, surface.human),
              f.repo,
            );
            expect(response.status).toBe(race === "outage" ? 503 : 404);
            expect(await response.text()).not.toContain("private authority marker");
          } finally {
            Object.assign(channel, { env: original });
          }
        });
        expect(await b2Effects(f)).toEqual(before);
      });
});
