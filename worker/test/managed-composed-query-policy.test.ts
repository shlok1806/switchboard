import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { composedQuerySurfaces, queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);
describe("B1q2 projected content through real Organization/decide", () => {
  it("admits enrolled historical authors, projects native content and omits pre-enrollment and private rows", async () => {
    const f = await queryExecutionFixture();
    const visibleThrough = await runInDurableObject(f.channel, (_object, state) => {
      const now = new Date().toISOString();
      const task = {
        number: 1,
        title: "Shared task",
        description: "Shared work",
        labels: [],
        blockedBy: [],
        subtasks: [],
        subtasksDone: 0,
        steps: [],
        stepsDone: 0,
        url: "https://example.test/issues/1",
        status: "claimed",
        updatedAt: now,
        claim: { task: 1, holder: { kind: "agent", agentId: f.targetId }, claimedAt: now, stale: false },
      };
      state.storage.sql.exec(
        "INSERT INTO tasks(number,data,holder_agent) VALUES(?,?,?)",
        1,
        JSON.stringify(task),
        f.targetId,
      );
      const append = (id: string, at: string, type: string, payload: unknown) =>
        state.storage.sql.exec(
          "INSERT INTO events(id,at,type,actor,task,payload,actor_kind,actor_id) VALUES(?,?,?,?,?,?,?,?)",
          id,
          at,
          type,
          JSON.stringify({ kind: "agent", agentId: f.targetId }),
          1,
          JSON.stringify(payload),
          "agent",
          f.targetId,
        );
      append("old-note", new Date(0).toISOString(), "memory.note", {
        text: "pre-enrollment-marker",
        tags: ["decision"],
      });
      append("shared-note", now, "memory.note", {
        text: "Shared note",
        tags: ["decision"],
        nickname: "private-marker",
      });
      append("shared-update", now, "update", { text: "Shared update" });
      append("directed-update", now, "update", { text: "private-marker", to: [f.targetId] });
      append("directive", now, "directive", { text: "private-marker", to: f.targetId });
      return state.storage.sql.exec<{ seq: number }>("SELECT seq FROM events WHERE id='shared-update'").one().seq;
    });
    await runInDurableObject(f.channel, async (object) => {
      for (const surface of composedQuerySurfaces) {
        const response = await object.managedRequest(
          new Request(`https://switchboard.test/r/${f.repo}${surface.path(f.targetId)}`, {
            headers: { Authorization: `Bearer ${f.credential}` },
          }),
          f.repo,
        );
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toMatch(/pre-enrollment-marker|private-marker|nickname|policyRevision|sessionId/);
        const body = JSON.parse(text);
        if (surface.id === "summary") {
          expect(body.agent).toMatchObject({
            id: f.targetId,
            ownerPersonId: f.actor.personId,
            executionId: f.executionId,
          });
          expect(body.tasks).toMatchObject([{ number: 1, claim: { holder: { kind: "agent", agentId: f.targetId } } }]);
          expect(body.notes).toMatchObject([{ author: { kind: "agent", agentId: f.targetId }, text: "Shared note" }]);
          expect(body.notes).toHaveLength(1);
          expect(body.updates).toMatchObject([{ text: "Shared update" }]);
        } else expect(body).toMatchObject({ cursor: null, through: visibleThrough, more: false, brief: { pages: 0 } });
      }
    });
  });
  for (const action of ["task.read", "channel.update.read", "channel.history.read", "agent.view"]) {
    it(`requires independent ${action} authority through both real handlers`, async () => {
      const f = await queryExecutionFixture();
      await runInDurableObject(f.channel, (_object, state) => {
        const task = {
          number: 1,
          title: "Visible",
          description: "",
          labels: [],
          blockedBy: [],
          subtasks: [],
          subtasksDone: 0,
          steps: [],
          stepsDone: 0,
          url: "https://example.test",
          status: "claimed",
          updatedAt: new Date().toISOString(),
          claim: {
            task: 1,
            holder: { kind: "agent", agentId: f.targetId },
            claimedAt: new Date().toISOString(),
            stale: false,
          },
        };
        state.storage.sql.exec(
          "INSERT INTO tasks(number,data,holder_agent) VALUES(?,?,?)",
          1,
          JSON.stringify(task),
          f.targetId,
        );
      });
      await runInDurableObject(f.org, (_object, state) => {
        const rows = state.storage.sql
          .exec<{ id: string; body: string }>(
            "SELECT id,body FROM grants WHERE json_extract(body,'$.principalId')=?",
            f.principalId,
          )
          .toArray();
        for (const row of rows) {
          const grant = JSON.parse(row.body);
          grant.actions = grant.actions.filter((value: string) => value !== action);
          state.storage.sql.exec("UPDATE grants SET body=? WHERE id=?", JSON.stringify(grant), row.id);
        }
      });
      await runInDurableObject(f.channel, async (object) => {
        for (const surface of composedQuerySurfaces) {
          const response = await object.managedRequest(
            new Request(`https://switchboard.test/r/${f.repo}${surface.path(f.targetId)}`, {
              headers: { Authorization: `Bearer ${f.credential}` },
            }),
            f.repo,
          );

          if (surface.id === "librarian" && action === "agent.view") {
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ quiet: [], quietStarted: [], quietEnded: [] });
          } else {
            expect(response.status).toBe(404);
            expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
          }
        }
      });
    });
  }
});
