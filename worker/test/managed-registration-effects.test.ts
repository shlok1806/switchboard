import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelEvent, RegisterAgentRequest } from "../../shared/src/index";
import type { Channel } from "../src/channel";
import { queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const registration: RegisterAgentRequest = {
  cli: "codex",
  sessionId: "pcfix-effects-9001",
  resumed: false,
  cwd: "/repo",
};

// These tests exercise the real managed registration handler and its local
// transaction. They do NOT claim intent/activation protocol coverage.
type Internals = {
  lastSeq: number | null;
  recentLocal: Map<string, ChannelEvent>;
  relay: { consider(event: ChannelEvent): void };
  registrationEffects?: unknown;
};
function internals(object: Channel): Internals {
  return object as unknown as Internals;
}
function sharedSnapshot(sql: SqlStorage) {
  const tables = sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .toArray()
    .map(({ name }) => name)
    .filter(
      (name) => !/^(sqlite_|_cf_|managed_permits$|managed_policy_floor$|registration_|alarm_deadlines$)/.test(name),
    );
  return Object.fromEntries(
    tables.map((name) => [
      name,
      sql
        .exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
        .toArray()
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ]),
  );
}
function request(f: Awaited<ReturnType<typeof queryExecutionFixture>>) {
  return new Request(`https://switchboard.test/r/${f.repo}/api/agents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.token}`, "Idempotency-Key": "registration-effects" },
  });
}

describe("managed registration local effect isolation through the real handler", () => {
  it("rolls back shared SQL and event caches and discards Relay notifications on a late SQL failure", async () => {
    const f = await queryExecutionFixture();
    await runInDurableObject(f.channel, async (object, state) => {
      state.storage.sql.exec("INSERT OR REPLACE INTO task_sync VALUES('syncedAt',?)", new Date().toISOString());
      const local = internals(object);
      const before = sharedSnapshot(state.storage.sql);
      const lastSeq = local.lastSeq;
      const recent = [...local.recentLocal];
      const relay = vi.spyOn(local.relay, "consider");
      state.storage.sql.exec(`CREATE TRIGGER abort_registration_presence BEFORE INSERT ON events
        WHEN NEW.type='presence' BEGIN SELECT RAISE(ABORT, 'registration rollback probe'); END`);
      try {
        const response = await object.registerManagedAgent(request(f), registration, {
          principalId: f.principalId,
          workspaceId: f.workspaceId,
        });
        expect(response.status).toBe(503);
        expect(sharedSnapshot(state.storage.sql)).toEqual(before);
        expect(local.lastSeq).toBe(lastSeq);
        expect([...local.recentLocal]).toEqual(recent);
        expect(relay).not.toHaveBeenCalled();
        expect(local.registrationEffects).toBeUndefined();
      } finally {
        state.storage.sql.exec("DROP TRIGGER abort_registration_presence");
        relay.mockRestore();
      }
    });
  });

  it("delivers Relay notifications only after successful SQL commit and clears the request-local collector", async () => {
    const f = await queryExecutionFixture();
    await runInDurableObject(f.channel, async (object, state) => {
      state.storage.sql.exec("INSERT OR REPLACE INTO task_sync VALUES('syncedAt',?)", new Date().toISOString());
      const local = internals(object);
      const observed: string[] = [];
      // At every external notification the new Agent and event must already be
      // visible and the collector must no longer be installed.
      const relay = vi.spyOn(local.relay, "consider").mockImplementation((event) => {
        expect(local.registrationEffects).toBeUndefined();
        expect(
          state.storage.sql.exec("SELECT id FROM agents WHERE session_id=?", registration.sessionId).toArray(),
        ).toHaveLength(1);
        expect(state.storage.sql.exec("SELECT id FROM events WHERE id=?", event.id).toArray()).toHaveLength(1);
        observed.push(event.type);
      });
      try {
        const response = await object.registerManagedAgent(request(f), registration, {
          principalId: f.principalId,
          workspaceId: f.workspaceId,
        });
        expect(response.status).toBe(200);
        expect(observed).toContain("session.start");
        expect(observed).toContain("presence");
        expect(local.registrationEffects).toBeUndefined();
      } finally {
        relay.mockRestore();
      }
    });
  });
});
