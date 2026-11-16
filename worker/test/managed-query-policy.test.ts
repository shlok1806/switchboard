import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GitHubApp, installGitHubApp } from "../src/github/index";
import {
  b1AdditionalSurfaces,
  b1ContentDetails,
  composedQuerySurfaces,
  preparationSurfaces,
  queryDenials,
  queryExecutionFixture,
  querySurfaces,
  seedB1Content,
} from "./managed-query-cases";

beforeEach(reset);
afterEach(() => installGitHubApp(null));
describe("shared query real Organization/decide matrix", () => {
  for (const denial of ["none", ...queryDenials]) {
    it(`uses current execution authority for every migrated handler: ${denial}`, async () => {
      const f = await queryExecutionFixture();
      await seedB1Content(f);
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
      let taskReads = 0;
      await runInDurableObject(f.channel, async (object) => {
        // Task integration is independently tested; this matrix observes source access.
        Object.assign(object, {
          tasks: {
            list: async () => {
              taskReads++;
              return { ok: true, value: [] };
            },
            get: async () => {
              taskReads++;
              return { ok: true, value: { number: 1, title: "Shared task" } };
            },
          },
        });
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
        const surfaces = [
          ...querySurfaces,
          ...b1AdditionalSurfaces,
          ...b1ContentDetails,
          { id: "agent-selector", path: `/api/events?agent=${encodeURIComponent(f.targetId)}` },
          { id: "memory-search", path: "/api/memory?q=shared" },
          { id: "detail", path: `/api/agents/${encodeURIComponent(f.targetId)}` },
          ...preparationSurfaces.map((surface) => ({ ...surface, path: "", preparation: surface.id })),
          ...composedQuerySurfaces.map((surface) => ({
            ...surface,
            path: surface.path(f.targetId),
          })),
        ];
        if (denial === "none") {
          const native = await object.prepareManagedQuery(f.repo, {
            id: "connector.brief",
            actor: f.actor,
            generation: 1,
            credentialExpiresAt: Date.now() + 10000,
          });
          expect(native.status).toBe(200);
          expect(await native.json()).toEqual({
            pages: [{ page: "guide", title: "Guide", text: "Shared guide", version: 1 }],
          });
          const lookup = async (about: string) =>
            object.prepareManagedQuery(f.repo, {
              id: "connector.channel",
              actor: { token: f.credential },
              generation: 1,
              selectors: new URLSearchParams({ about, since: "7d" }).toString(),
            });
          const visible = await lookup("B1 shared");
          expect(visible.status).toBe(200);
          expect(await visible.json()).toMatchObject({
            events: [expect.objectContaining({ payload: { text: "B1 shared content" } })],
          });
          const absent = await lookup("missing-marker");
          const inaccessible = await lookup("private-marker");
          expect(absent.status).toBe(200);
          expect(inaccessible.status).toBe(200);
          expect(await absent.json()).toEqual({ tasks: [], events: [], agents: [], notes: [] });
          expect(await inaccessible.json()).toEqual({ tasks: [], events: [], agents: [], notes: [] });
          const page = await object.prepareManagedQuery(f.repo, {
            id: "connector.brief",
            actor: { token: f.credential },
            generation: 1,
            selectors: "area=guide",
          });
          expect(page.status).toBe(200);
          expect(await page.json()).toEqual({
            pages: [{ page: "guide", title: "Guide", text: "Shared guide", version: 1 }],
          });
        }
        // Internal preparation must not open any actual managed transport.
        const upgrade = await object.fetch(
          new Request("https://channel/stream?person=alice&generation=1", {
            headers: { Upgrade: "websocket" },
          }),
        );
        expect(upgrade.status).toBe(403);
        expect(() => object.askChannel({ since: new Date().toISOString() })).toThrow();
        let closed = 0;
        const socket = {
          close: () => {
            closed++;
          },
        } as unknown as WebSocket;
        for (const type of ["history.page", "terminal.input", "hook", "wake"])
          object.webSocketMessage(socket, JSON.stringify({ type, text: "private-marker" }));
        expect(closed).toBe(4);
        for (const surface of surfaces) {
          const preparedSurface = preparationSurfaces.find((candidate) => candidate.id === surface.id);
          const response = preparedSurface
            ? await object.prepareManagedQuery(f.repo, {
                id: preparedSurface.id,
                actor: { token: f.credential },
                generation: 1,
                selectors: preparedSurface.selectors,
              })
            : await object.managedRequest(
                new Request(`https://switchboard.test/r/${f.repo}${surface.path}`, {
                  headers: { Authorization: `Bearer ${f.credential}`, "Content-Type": "application/json" },
                  method: "method" in surface ? (surface.method as string) : "GET",
                  ...("body" in surface ? { body: JSON.stringify(surface.body) } : {}),
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
          if (denial === "none" && ["connector.channel", "stream.event", "stream.backlog"].includes(surface.id)) {
            expect(JSON.parse(text)).toMatchObject({
              events: expect.arrayContaining([expect.objectContaining({ payload: { text: "B1 shared content" } })]),
            });
          }
          if (denial === "none" && ["stream.event", "stream.backlog"].includes(surface.id))
            expect(JSON.parse(text)).toMatchObject({
              agents: [expect.objectContaining({ id: f.targetId, executionId: f.executionId })],
              tasks: [expect.objectContaining({ number: 1 })],
              persons: expect.arrayContaining([{ personId: f.actor.personId }]),
            });
          if (denial === "none" && surface.id === "connector.channel")
            expect(JSON.parse(text)).toMatchObject({
              notes: [
                expect.objectContaining({ text: "B1 shared note", author: { kind: "agent", agentId: f.targetId } }),
              ],
            });
          if (denial === "none" && surface.id === "connector.brief")
            expect(JSON.parse(text)).toEqual({
              pages: [{ page: "guide", title: "Guide", text: "Shared guide", version: 1 }],
            });
          expect(text).not.toMatch(/private-marker|credential|sessionId|account|nickname|policyRevision/);
        }
      });
      expect(taskReads).toBe(denial === "none" ? 2 : 0);
      expect(upstream).toBe(denial === "none" ? 2 : 0);
    });
  }
});
