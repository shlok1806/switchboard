import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelAuthorization } from "../src/organization";
import { bareChannel } from "./managed-helpers";
import { queryDenials, queryExecutionFixture } from "./managed-query-cases";

const surfaces = [
  "source=merged",
  "source=local",
  "tail=2",
  "before=9",
  "agent=alice/codex/session",
  "task=1",
  "source=stored&before=9",
  "source=merged&after=0",
];
function fixture() {
  const organizationId = crypto.randomUUID();
  const repo = "shlok1806/other";
  const binding = {
    version: 1,
    state: "linked",
    workspace: `${organizationId}:${crypto.randomUUID()}`,
    generation: 1,
    operation: "binding",
  };
  const channel = bareChannel(binding);
  let denial: string | undefined;
  let release = false;
  let privateRows = false;
  let reads = 0;
  const calls: ChannelAuthorization[] = [];
  const rows = [1, 2, 3].map((seq) => ({
    id: `visible-${seq}`,
    seq: seq * 2,
    at: `2026-11-15T00:00:0${seq}.000Z`,
    actor: JSON.stringify({ kind: "agent", agentId: "alice/codex/session" }),
    type: "update",
    payload: JSON.stringify({ text: `visible-${seq}` }),
    capture: null,
    turn: null,
    task: 1,
  }));
  Object.assign(channel, {
    ctx: {
      id: env.CHANNEL.idFromName(repo),
      storage: {
        sql: {
          exec: (sql: string, ...args: unknown[]) => {
            if (sql.includes("managed_")) return { toArray: () => [] };
            if (sql.includes("m1_agent_executions"))
              return { toArray: () => [{ organizationId, executionId: "execution", active: 1 }] };
            reads++;
            const input = privateRows
              ? [
                  ...rows,
                  {
                    ...rows[0],
                    id: "private",
                    seq: 3,
                    type: "directive",
                    payload: JSON.stringify({ text: "private-marker" }),
                  },
                ]
              : [...rows];
            const backward = sql.includes("seq <");
            const selected = input
              .filter((row) => (backward ? row.seq < Number(args[0]) : row.seq > Number(args[0])))
              .sort((a, b) => (backward ? b.seq - a.seq : a.seq - b.seq))
              .slice(0, Number(args[1]));
            return { toArray: () => selected };
          },
        },
      },
    },
    env: {
      CHANNEL: env.CHANNEL,
      ORGANIZATION: {
        getByName: () => ({
          authorizeChannelRead: async (input: ChannelAuthorization) => {
            calls.push(input);
            if (
              denial &&
              (!release ||
                calls.filter(
                  (call) =>
                    call.action === input.action &&
                    call.resource.operation === input.resource.operation &&
                    call.resource.targetId === input.resource.targetId,
                ).length > 1)
            )
              return { ok: false, status: 403, reason: denial, policyRevision: 1 };
            return { ok: true, value: { deadline: Date.now() + 60000 }, policyRevision: 1 };
          },
        }),
      },
    },
  });
  return {
    channel,
    binding,
    calls,
    reads: () => reads,
    hide: () => {
      privateRows = true;
    },
    deny: (reason: string, atRelease = false) => {
      denial = reason;
      release = atRelease;
    },
    request: (query: string) =>
      channel.managedRequest(
        new Request(`https://switchboard.test/r/${repo}/api/events?${query}`, {
          headers: { Authorization: "Bearer m1.fixture" },
        }),
        repo,
      ),
  };
}
beforeEach(reset);
describe("B1q3a history selector HTTP preparation", () => {
  for (const selector of surfaces) {
    it(`admits ${selector} through HR, UR and AV without opening a transport`, async () => {
      const f = fixture();
      const response = await f.request(selector);
      expect(response.status).toBe(200);
      const body = await response.json<{ events: { seq: number }[]; unavailable?: unknown }>();
      expect(body.events.length).toBe(selector.includes("local") ? 0 : selector.includes("tail=2") ? 2 : 3);
      expect(f.calls[0]).toMatchObject({
        action: "channel.history.read",
        resource: { operation: "history.read", targetId: "events" },
      });
      for (const action of ["channel.history.read", "channel.update.read", "agent.view"])
        expect(f.calls.filter((call) => call.action === action).length).toBeGreaterThanOrEqual(2);
      if (!selector.includes("source=stored"))
        expect(body.unavailable).toEqual([{ reason: "managed_local_history_unavailable" }]);
    });
    for (const denial of queryDenials) {
      it(`denies ${selector}: ${denial} before content access`, async () => {
        const f = fixture();
        f.deny(denial);
        const response = await f.request(selector);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
        expect(f.reads()).toBe(0);
      });
    }
    it(`withholds prepared content and availability when release denies: ${selector}`, async () => {
      const f = fixture();
      f.deny("revoked_execution", true);
      const response = await f.request(selector);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
    });
    it(`keeps visible bytes and cursors invariant under private insertion: ${selector}`, async () => {
      const f = fixture();
      const first = await (await f.request(selector)).text();
      f.hide();
      expect(await (await f.request(selector)).text()).toBe(first);
    });
  }
  it("uses admitted lookahead and continues an opaque boundary with no duplicates", async () => {
    const f = fixture();
    const query = "source=stored&tail=2";
    const first = await (await f.request(query)).json<{ events: { id: string }[]; cursor: string; more: boolean }>();
    expect(first.events.map((event) => event.id)).toEqual(["visible-2", "visible-3"]);
    expect(first.more).toBe(true);
    expect(first.cursor).not.toContain("visible");
    const second = await (await f.request(`${query}&cursor=${first.cursor}`)).json<{
      events: { id: string }[];
      more: boolean;
    }>();
    expect(second.events.map((event) => event.id)).toEqual(["visible-1"]);
    expect(second.more).toBe(false);
    for (const cursor of [`${first.cursor.slice(0, -3)}abc`, "malformed"]) {
      expect((await f.request(`${query}&cursor=${cursor}`)).status).toBe(404);
    }
    expect((await fixture().request(`${query}&cursor=${first.cursor}`)).status).toBe(404);
    expect((await f.request(`source=stored&tail=1&cursor=${first.cursor}`)).status).toBe(404);
    f.binding.generation++;
    expect((await f.request(`${query}&cursor=${first.cursor}`)).status).toBe(404);
  });
  it("withholds prepared content when release denies", async () => {
    const f = fixture();
    f.deny("revoked_execution", true);
    const response = await f.request("tail=2");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/visible|cursor|unavailable/);
  });
});

describe("B1q3a selectors with real Organization/decide", () => {
  for (const denial of ["none", ...queryDenials]) {
    it(`checks every selector against real authority: ${denial}`, async () => {
      const f = await queryExecutionFixture();
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
      await runInDurableObject(f.channel, async (object, state) => {
        state.storage.sql.exec(
          "INSERT INTO events (id,at,type,actor,task,payload) VALUES(?,?,?,?,?,?)",
          "selector-visible",
          new Date().toISOString(),
          "update",
          JSON.stringify({ kind: "agent", agentId: f.targetId }),
          1,
          JSON.stringify({ text: "selector-shared" }),
        );
        if (["foreign_organization", "foreign_workspace", "wrong_generation"].includes(denial))
          Object.assign(object, {
            binding: {
              ...object.bindingState(),
              generation: denial === "wrong_generation" ? 2 : 1,
              workspace:
                denial === "foreign_organization"
                  ? `${crypto.randomUUID()}:${crypto.randomUUID()}`
                  : denial === "foreign_workspace"
                    ? `${f.organizationId}:${crypto.randomUUID()}`
                    : f.workspaceId,
            },
          });
        for (const selector of surfaces) {
          const response = await object.managedRequest(
            new Request(`https://switchboard.test/r/${f.repo}/api/events?${selector}`, {
              headers: { Authorization: `Bearer ${f.credential}` },
            }),
            f.repo,
          );
          expect(response.status, selector).toBe(denial === "none" ? 200 : 404);
          const body = await response.text();
          if (denial !== "none") expect(JSON.parse(body)).toEqual({ ok: false, reason: "resource_denied" });
          else {
            const value = JSON.parse(body);
            expect(value).toHaveProperty("events");
            expect(value.events.some((event: { id: string }) => event.id === "selector-visible")).toBe(
              !selector.includes("local"),
            );
          }
        }
      });
    });
  }
});
