import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { RegistrationPreparation } from "../src/registration-protocol";
import { queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);
async function fixture() {
  const f = await queryExecutionFixture();
  const input: RegistrationPreparation = {
    actor: f.actor,
    principalId: f.principalId,
    workspaceId: f.workspaceId,
    channelId: f.repo,
    generation: 1,
    agentId: "alice/codex/prepared-session",
    hostId: null,
    requestId: "prepared-registration-key",
    request: JSON.stringify({ cli: "codex", sessionId: "prepared-session", resumed: false, cwd: "/repo" }),
    credentialExpiresAt: Date.now() + 600_000,
  };
  return { ...f, input };
}
async function identitySnapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return runInDurableObject(f.org, (_object, state) =>
    Object.fromEntries(
      ["executions", "execution_credentials", "owner_consents", "admin_audit"].map((name) => {
        const exists = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name=?", name).toArray().length;
        return [name, exists ? state.storage.sql.exec(`SELECT * FROM ${name} ORDER BY rowid`).toArray() : []];
      }),
    ),
  );
}

describe("Organization prepared registration protocol handlers", () => {
  it("issues correlated dual receipts without creating an execution, credential, enrollment or registration audit", async () => {
    const f = await fixture();
    const before = await identitySnapshot(f);
    const result = await f.org.prepareRegistration(f.input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("preparation denied");
    const { reservation, permits } = result.value;
    const [start, handoff] = permits;
    if (!start || !handoff) throw new Error("dual receipts missing");
    expect(permits.map((permit) => permit.action)).toEqual(["agent.execution.start", "agent.handoff.cross_owner"]);
    expect(start.expiresAt).toBe(handoff.expiresAt);
    expect(start.expiresAt - start.issuedAt).toBeLessThanOrEqual(2000);
    expect(reservation.expiresAt - reservation.createdAt).toBeLessThanOrEqual(30_000);
    expect(start.resource.targetId).toBe(f.input.agentId);
    expect(handoff.resource.ownerPersonId).toBe(f.actor.personId);
    expect(start.resource.operation).toBe(`agent.register.prepare:${reservation.intentId}`);
    expect(await identitySnapshot(f)).toEqual(before);
    await runInDurableObject(f.org, (_object, state) => {
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='host_enrollments'").toArray()).toEqual(
        [],
      );
      expect(state.storage.sql.exec("SELECT id FROM registration_reservations").toArray()).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT id FROM mutation_permits").toArray()).toHaveLength(2);
    });
  });

  for (const mode of [
    "nonmember",
    "foreign-organization",
    "foreign-workspace",
    "wrong-generation",
    "wrong-role",
    "expired-session",
    "expired-grant",
    "revoked-principal",
  ] as const) {
    it(`denies ${mode} before any reservation or execution effect`, async () => {
      const f = await fixture();
      if (mode === "nonmember") f.input.actor = { ...f.actor, personId: crypto.randomUUID() };
      if (mode === "foreign-organization") f.input.workspaceId = `${crypto.randomUUID()}:${crypto.randomUUID()}`;
      if (mode === "foreign-workspace") f.input.workspaceId = `${f.organizationId}:${crypto.randomUUID()}`;
      if (mode === "wrong-generation") f.input.generation++;
      if (mode === "expired-session") f.input.credentialExpiresAt = Date.now() - 1;
      if (mode === "wrong-role" || mode === "expired-grant" || mode === "revoked-principal") {
        await runInDurableObject(f.org, (_object, state) => {
          if (mode === "wrong-role") {
            const aggregate = JSON.parse(
              state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
            );
            aggregate.workspaceMembers[f.workspaceId][f.actor.personId].role = "viewer";
            state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
          } else {
            const table = mode === "expired-grant" ? "grants" : "principals";
            const field = mode === "expired-grant" ? "expiresAt" : "status";
            const value = mode === "expired-grant" ? Date.now() - 1 : "revoked";
            state.storage.sql.exec(`UPDATE ${table} SET body=json_set(body,?,?)`, `$.${field}`, value);
          }
        });
      }
      const before = await identitySnapshot(f);
      const result = await f.org.prepareRegistration(f.input);
      expect(result.ok).toBe(false);
      expect(await identitySnapshot(f)).toEqual(before);
      await runInDurableObject(f.org, (_object, state) => {
        expect(state.storage.sql.exec("SELECT id FROM mutation_permits").toArray()).toEqual([]);
        expect(
          state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='registration_reservations'").toArray(),
        ).toEqual([]);
      });
    });
  }

  it("refuses activation without a durable dual-consumption Channel proof", async () => {
    const f = await fixture();
    const prepared = await f.org.prepareRegistration(f.input);
    if (!prepared.ok) throw new Error("preparation denied");
    const p = prepared.value.reservation;
    const before = await identitySnapshot(f);
    const result = await f.org.activateRegistration({
      reservationId: p.reservationId,
      intentId: p.intentId,
      startPermitId: p.startPermitId,
      handoffPermitId: p.handoffPermitId,
      executionId: p.executionId,
      workspaceId: p.workspaceId,
      channelId: p.channelId,
      generation: p.generation,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
    expect(await identitySnapshot(f)).toEqual(before);
    await runInDurableObject(f.org, (_object, state) => {
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM registration_reservations").one().state).toBe(
        "reserved",
      );
    });
  });

  it("rejects competing Agent and Host reservations and changed-body keys without replacing the first intent", async () => {
    const f = await fixture();
    f.input.hostId = "alice/prepared-host";
    const first = await f.org.prepareRegistration(f.input);
    expect(first.ok).toBe(true);
    for (const other of [
      { ...f.input, requestId: "same-agent-new-key", hostId: "alice/other" },
      {
        ...f.input,
        requestId: "same-host-new-key",
        agentId: "alice/codex/other",
        request: JSON.stringify({ cli: "codex", sessionId: "other", resumed: false, cwd: "/repo" }),
      },
      {
        ...f.input,
        request: JSON.stringify({ cli: "codex", sessionId: "prepared-session", resumed: false, cwd: "/changed" }),
      },
      f.input,
    ]) {
      const result = await f.org.prepareRegistration(other);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(409);
    }
    await runInDurableObject(f.org, (_object, state) => {
      expect(state.storage.sql.exec("SELECT id FROM registration_reservations").toArray()).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT id FROM mutation_permits").toArray()).toHaveLength(2);
    });
  });
});
