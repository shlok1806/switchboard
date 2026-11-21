import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelEvent, RegisterAgentRequest, StreamMessage } from "../../shared/src/index";
import { AgentRoster, type RosterHost } from "../src/agents";

beforeEach(reset);

const registration: RegisterAgentRequest = {
  cli: "claude-code",
  sessionId: "pcfix-local",
  resumed: false,
  cwd: "/repo",
};

/** Real Channel SQLite; notifications are collected by the transaction's caller. */
function roster(sql: SqlStorage) {
  const notifications: StreamMessage[] = [];
  const events: ChannelEvent[] = [];
  const watches: (number | null)[] = [];
  const host: RosterHost = {
    sql,
    goneAfterMs: 60_000,
    async schedulePresenceCheck(at) {
      watches.push(at);
    },
    append(event) {
      const recorded = { ...event, id: String(events.length), seq: events.length, at: new Date().toISOString() };
      events.push(recorded as ChannelEvent);
      return recorded as ChannelEvent;
    },
    broadcast(message) {
      notifications.push(message);
    },
  };
  return { agents: new AgentRoster(host), notifications, events, watches };
}

describe("synchronous registration algorithm extraction", () => {
  it("applies registration synchronously without scheduling the asynchronous presence watch", async () => {
    await runInDurableObject(env.CHANNEL.getByName("local-register/sync"), (_channel, state) => {
      const f = roster(state.storage.sql);
      const result = f.agents.registerLocal("alice", registration);
      expect(result).not.toBeInstanceOf(Promise);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("registration refused");
      expect(f.agents.find(result.agent.id)).toEqual(result.agent);
      expect(f.events.map((event) => event.type)).toEqual(["session.start", "presence"]);
      expect(f.notifications).toEqual([{ type: "agent", agent: result.agent }]);
      expect(f.watches).toEqual([]);
    });
  });

  it("keeps legacy registration watch scheduling after successful local application", async () => {
    await runInDurableObject(env.CHANNEL.getByName("local-register/legacy"), async (_channel, state) => {
      const f = roster(state.storage.sql);
      const result = await f.agents.register("alice", registration);
      expect(result.ok).toBe(true);
      expect(f.watches).toHaveLength(1);
      expect(f.watches[0]).toBeTypeOf("number");
    });
  });

  it("rolls back the Agent row when the caller aborts its synchronous transaction", async () => {
    await runInDurableObject(env.CHANNEL.getByName("local-register/rollback"), (_channel, state) => {
      const f = roster(state.storage.sql);
      const before = state.storage.sql.exec("SELECT * FROM agents ORDER BY id").toArray();
      expect(() =>
        state.storage.transactionSync(() => {
          expect(f.agents.registerLocal("alice", registration).ok).toBe(true);
          throw new Error("abort registration");
        }),
      ).toThrow("abort registration");
      expect(state.storage.sql.exec("SELECT * FROM agents ORDER BY id").toArray()).toEqual(before);
      // These buffers are intentionally not delivered: SQL rollback cannot undo callbacks.
      expect(f.notifications).toHaveLength(1);
      expect(f.watches).toEqual([]);
    });
  });

  it("refuses a second librarian without writes, notifications or asynchronous watches", async () => {
    await runInDurableObject(env.CHANNEL.getByName("local-register/refusal"), async (_channel, state) => {
      const f = roster(state.storage.sql);
      expect((await f.agents.register("alice", { ...registration, librarian: true })).ok).toBe(true);
      const before = state.storage.sql.exec("SELECT * FROM agents ORDER BY id").toArray();
      f.events.length = 0;
      f.notifications.length = 0;
      f.watches.length = 0;
      expect(f.agents.registerLocal("bob", { ...registration, librarian: true })).toMatchObject({
        ok: false,
        status: 409,
      });
      expect(state.storage.sql.exec("SELECT * FROM agents ORDER BY id").toArray()).toEqual(before);
      expect(f.events).toEqual([]);
      expect(f.notifications).toEqual([]);
      expect(f.watches).toEqual([]);
    });
  });
});
