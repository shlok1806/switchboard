import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const f = await queryExecutionFixture();
  await runInDurableObject(f.channel, (_object, state) => {
    state.storage.sql.exec("INSERT OR REPLACE INTO task_sync VALUES('syncedAt',?)", new Date().toISOString());
  });
  const register = () =>
    env.CHANNEL.getByName(f.repo).registerManagedAgent(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.token}`, "Idempotency-Key": "execution-storage" },
      }),
      { cli: "codex", sessionId: "storage-session", resumed: false, cwd: "/repo" },
      { principalId: f.principalId, workspaceId: f.workspaceId },
    );
  return { ...f, register };
}

async function reservedExecution(f: Awaited<ReturnType<typeof fixture>>) {
  return runInDurableObject(f.org, (_object, state) => {
    const row = state.storage.sql
      .exec<{ body: string; constraints_body: string }>(
        `SELECT e.body,e.constraints_body FROM executions e JOIN registration_reservations r
         ON e.id=json_extract(r.payload,'$.executionId') WHERE r.request_id='execution-storage'`,
      )
      .one();
    return { execution: JSON.parse(row.body), constraints: JSON.parse(row.constraints_body) };
  });
}

describe("prepared registration execution row updates", () => {
  it("completes registration without replacing or dropping execution constraints", async () => {
    const f = await fixture();
    await runInDurableObject(f.org, async (object, state) => {
      const activate = object.activateRegistration.bind(object);
      const spy = vi.spyOn(object, "activateRegistration").mockImplementation(async (ack) => {
        const result = await activate(ack);
        expect(result.ok).toBe(true);
        state.storage.sql.exec(
          "UPDATE executions SET constraints_body=? WHERE id=?",
          JSON.stringify({ actions: ["workspace.read"] }),
          ack.executionId,
        );
        return result;
      });
      try {
        expect((await f.register()).status).toBe(200);
      } finally {
        spy.mockRestore();
      }
    });
    expect(await reservedExecution(f)).toMatchObject({
      execution: { status: "active", credentialGeneration: 1 },
      constraints: { actions: ["workspace.read"] },
    });
  });

  it("cancels an activated execution after a lost response while preserving constraints", async () => {
    const f = await fixture();
    await runInDurableObject(f.org, async (object, state) => {
      const activate = object.activateRegistration.bind(object);
      const spy = vi.spyOn(object, "activateRegistration").mockImplementation(async (ack) => {
        expect((await activate(ack)).ok).toBe(true);
        state.storage.sql.exec(
          "UPDATE executions SET constraints_body=? WHERE id=?",
          JSON.stringify({ actions: ["workspace.read"] }),
          ack.executionId,
        );
        throw new Error("lost activation response");
      });
      try {
        expect((await f.register()).status).toBe(503);
      } finally {
        spy.mockRestore();
      }
    });
    expect(await reservedExecution(f)).toMatchObject({
      execution: { status: "ended" },
      constraints: { actions: ["workspace.read"] },
    });
  });
});
