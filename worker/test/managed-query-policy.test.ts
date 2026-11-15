import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GitHubApp, installGitHubApp } from "../src/github/index";
import { queryDenials, queryExecutionFixture, querySurfaces } from "./managed-query-cases";

beforeEach(reset);
afterEach(() => installGitHubApp(null));
describe("shared query real Organization/decide matrix", () => {
  for (const denial of ["none", ...queryDenials]) {
    it(`uses current execution authority for every migrated handler: ${denial}`, async () => {
      const f = await queryExecutionFixture();
      let upstream = 0;
      installGitHubApp({
        repo: () => ({
          call: async () => {
            upstream++;
            return Response.json({
              data: {
                repository: {
                  url: `https://github.com/${f.repo}`,
                  defaultBranchRef: { name: "main", target: null },
                  object: { __typename: "Blob", text: "visible", byteSize: 7, isBinary: false, isTruncated: false },
                },
              },
            });
          },
        }),
      } as unknown as GitHubApp);
      await runInDurableObject(f.org, (_object, state) => {
        if (denial === "non_member" || denial === "insufficient_role") {
          const aggregate = JSON.parse(
            state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
          );
          if (denial === "non_member") delete aggregate.workspaceMembers[f.workspaceId][f.actor.personId];
          else aggregate.workspaceMembers[f.workspaceId][f.actor.personId].role = "invalid-role";
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
        if (denial === "insufficient_scope")
          state.storage.sql.exec(
            "UPDATE grants SET body=json_set(body,'$.actions',json(?)) WHERE json_extract(body,'$.principalId')=?",
            JSON.stringify(["channel.update.write"]),
            f.principalId,
          );
      });
      await runInDurableObject(f.channel, async (object) => {
        if (["foreign_organization", "foreign_workspace", "wrong_generation"].includes(denial)) {
          const binding = object.bindingState();
          Object.assign(object, {
            binding: {
              ...binding,
              generation: denial === "wrong_generation" ? 2 : 1,
              workspace:
                denial === "foreign_organization"
                  ? `${crypto.randomUUID()}:${crypto.randomUUID()}`
                  : denial === "foreign_workspace"
                    ? `${f.organizationId}:${crypto.randomUUID()}`
                    : f.workspaceId,
            },
          });
        }
        for (const surface of querySurfaces) {
          const response = await object.managedRequest(
            new Request(`https://switchboard.test/r/${f.repo}${surface.path}`, {
              headers: { Authorization: `Bearer ${f.credential}` },
            }),
            f.repo,
          );
          expect(response.status, surface.id).toBe(denial === "none" ? 200 : 404);
          const text = await response.text();
          if (denial !== "none") expect(JSON.parse(text)).toEqual({ ok: false, reason: "resource_denied" });
          if (denial === "none" && surface.id === "agents")
            expect(JSON.parse(text)).toMatchObject({
              agents: [
                {
                  id: f.targetId,
                  executionId: f.executionId,
                  principalId: f.principalId,
                  ownerPersonId: f.actor.personId,
                },
              ],
            });
          expect(text).not.toMatch(/credential|sessionId|account|nickname|policyRevision/);
        }
      });
      expect(upstream).toBe(denial === "none" ? 1 : 0);
    });
  }
});
