import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisterAgentRequest } from "../../shared/src/index";
import { LocalMutationPermits } from "../src/policy-permits";
import { RegistrationIntents } from "../src/registration-intents";
import { queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const f = await queryExecutionFixture();
  await runInDurableObject(f.channel, (_object, state) => {
    state.storage.sql.exec("INSERT OR REPLACE INTO task_sync VALUES('syncedAt',?)", new Date().toISOString());
  });
  const register = (key = "failure-registration", extra: Partial<RegisterAgentRequest> = {}) =>
    env.CHANNEL.getByName(f.repo).registerManagedAgent(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.token}`, "Idempotency-Key": key },
      }),
      { cli: "codex", sessionId: "failure-session", resumed: false, cwd: "/repo", ...extra },
      { principalId: f.principalId, workspaceId: f.workspaceId },
    );
  const snapshot = () =>
    runInDurableObject(f.channel, (_object, state) => {
      const names = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .toArray()
        .map(({ name }) => name)
        .filter(
          (name) => !/^(sqlite_|_cf_|managed_permits$|managed_policy_floor$|registration_|alarm_deadlines$)/.test(name),
        );
      return Object.fromEntries(
        names.map((name) => [name, state.storage.sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray()]),
      );
    });
  return { ...f, register, snapshot };
}

describe("prepared registration real-handler failure boundaries", () => {
  for (const action of ["agent.execution.start", "agent.handoff.cross_owner"]) {
    for (const fault of ["expired", "wrong-host", "wrong-generation", "wrong-revision", "wrong-actor"]) {
      it(`rejects ${action} ${fault} before any shared registration effect`, async () => {
        const f = await fixture();
        const before = await f.snapshot();
        await runInDurableObject(f.org, async (object) => {
          const original = object.prepareRegistration.bind(object);
          const spy = vi.spyOn(object, "prepareRegistration").mockImplementation((input) => {
            const result = original(input);
            if (!result.ok) return result;
            const permit = result.value.permits.find((receipt) => receipt.action === action);
            if (!permit) throw new Error("receipt missing");
            if (fault === "expired") permit.expiresAt = Date.now() - 1;
            if (fault === "wrong-host") permit.resource = { ...permit.resource, hostId: "foreign/host" };
            if (fault === "wrong-generation") permit.generation++;
            if (fault === "wrong-revision") permit.policyRevision++;
            if (fault === "wrong-actor") permit.actor = { kind: "person", personId: "foreign", githubId: "999" };
            return result;
          });
          try {
            expect((await f.register()).status).toBe(503);
          } finally {
            spy.mockRestore();
          }
        });
        expect(await f.snapshot()).toEqual(before);
        await runInDurableObject(f.channel, (_object, state) => {
          expect(state.storage.sql.exec("SELECT * FROM registration_intents").toArray()).toEqual([]);
          const installed = state.storage.sql
            .exec("SELECT name FROM sqlite_master WHERE name='managed_permits'")
            .toArray();
          if (installed.length) expect(state.storage.sql.exec("SELECT * FROM managed_permits").toArray()).toEqual([]);
        });
      });
    }
  }

  for (const fault of ["denied", "unavailable"] as const) {
    it(`keeps TXN-1 invisible and cancels after activation ${fault}`, async () => {
      const f = await fixture();
      const before = await f.snapshot();
      await runInDurableObject(f.org, async (object) => {
        const spy = vi.spyOn(object, "activateRegistration").mockImplementation(async () => {
          expect(await f.snapshot()).toEqual(before);
          if (fault === "unavailable") throw new Error("authority unavailable");
          return { ok: false, status: 404, reason: "registration_denied", policyRevision: 0 };
        });
        try {
          expect((await f.register()).status).toBe(fault === "denied" ? 404 : 503);
          expect((await f.register()).status).toBe(409);
        } finally {
          spy.mockRestore();
        }
      });
      expect(await f.snapshot()).toEqual(before);
      await runInDurableObject(f.channel, (_object, state) => {
        expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM registration_intents").one().state).toBe(
          "cancelled",
        );
      });
    });
  }

  it("recovers lost completion without repeating registration or returning the lost credential", async () => {
    const f = await fixture();
    await runInDurableObject(f.org, async (object) => {
      const original = object.completeRegistration.bind(object);
      const spy = vi.spyOn(object, "completeRegistration").mockImplementation(async (ack) => {
        const result = await original(ack);
        expect(result.ok).toBe(true);
        throw new Error("completion response lost");
      });
      try {
        expect((await f.register()).status).toBe(503);
      } finally {
        spy.mockRestore();
      }
    });
    const afterApply = await f.snapshot();
    const retry = await f.register();
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("secret");
    expect(body).not.toHaveProperty("credential");
    expect(await f.snapshot()).toEqual(afterApply);
  });

  it("cancels an activated identity after a lost activation response and never revives it", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    await runInDurableObject(f.org, async (object, state) => {
      const original = object.activateRegistration.bind(object);
      let acknowledgement: Parameters<typeof object.activateRegistration>[0] | undefined;
      const spy = vi.spyOn(object, "activateRegistration").mockImplementation(async (ack) => {
        acknowledgement = ack;
        expect((await original(ack)).ok).toBe(true);
        expect(await f.snapshot()).toEqual(before);
        throw new Error("activation response lost");
      });
      try {
        expect((await f.register()).status).toBe(503);
      } finally {
        spy.mockRestore();
      }
      if (!acknowledgement) throw new Error("activation not reached");
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM registration_reservations").one().state).toBe(
        "cancelled",
      );
      expect((await original(acknowledgement)).ok).toBe(false);
      const ended = state.storage.sql
        .exec<{ body: string }>("SELECT body FROM executions WHERE id=?", acknowledgement.executionId)
        .one();
      expect(JSON.parse(ended.body).status).toBe("ended");
    });
    expect(await f.snapshot()).toEqual(before);
    expect((await f.register()).status).toBe(409);
  });

  for (const fault of ["expired", "wrong-host", "wrong-generation", "wrong-actor", "original-receipt"] as const) {
    it(`rejects fresh apply ${fault} without registration effects or a credential`, async () => {
      const f = await fixture();
      const before = await f.snapshot();
      await runInDurableObject(f.org, async (object) => {
        const original = object.activateRegistration.bind(object);
        const spy = vi.spyOn(object, "activateRegistration").mockImplementation(async (ack) => {
          const result = await original(ack);
          if (!result.ok) throw new Error("activation denied unexpectedly");
          if (fault === "expired") result.value.expiresAt = Date.now() - 1;
          if (fault === "wrong-host") result.value.resource.hostId = "foreign/host";
          if (fault === "wrong-generation") result.value.generation++;
          if (fault === "wrong-actor") result.value.actor = { kind: "person", personId: "foreign", githubId: "999" };
          if (fault === "original-receipt") result.value.id = ack.startPermitId;
          return result;
        });
        try {
          const response = await f.register();
          expect(response.status).toBe(503);
          expect(await response.text()).not.toContain('"token"');
        } finally {
          spy.mockRestore();
        }
      });
      expect(await f.snapshot()).toEqual(before);
      await runInDurableObject(f.channel, (_object, state) => {
        expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM registration_intents").one().state).toBe(
          "cancelled",
        );
      });
    });
  }

  it("reconciles unavailable cancellation without applying or acquiring replacement permits", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    await runInDurableObject(f.org, async (object) => {
      const activation = vi.spyOn(object, "activateRegistration").mockImplementation(async () => {
        throw new Error("activation unavailable");
      });
      const cancellation = vi.spyOn(object, "cancelRegistration").mockImplementation(async () => {
        throw new Error("cancellation unavailable");
      });
      try {
        expect((await f.register()).status).toBe(503);
        await runInDurableObject(f.channel, (_object, state) => {
          expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM registration_intents").one().state).toBe(
            "cancelling",
          );
        });
      } finally {
        activation.mockRestore();
        cancellation.mockRestore();
      }
      const prepare = vi.spyOn(object, "prepareRegistration");
      try {
        expect((await f.register()).status).toBe(409);
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
      }
    });
    expect(await f.snapshot()).toEqual(before);
    await runInDurableObject(f.channel, (_object, state) => {
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM registration_intents").one().state).toBe(
        "cancelled",
      );
    });
  });

  for (const fault of [
    "missing-consumption",
    "other-intent",
    "binding-change",
    "revision-change",
    "authority-revoked",
  ] as const) {
    it(`fences ${fault} after activation and before the synchronous apply`, async () => {
      const f = await fixture();
      const before = await f.snapshot();
      await runInDurableObject(f.org, async (object, orgState) => {
        const original = object.activateRegistration.bind(object);
        const spy = vi.spyOn(object, "activateRegistration").mockImplementation(async (ack) => {
          if (fault === "authority-revoked")
            orgState.storage.sql.exec(
              "UPDATE principals SET body=json_set(body,'$.status','revoked') WHERE id=?",
              f.principalId,
            );
          const result = await original(ack);
          if (fault !== "authority-revoked") {
            expect(result.ok).toBe(true);
            await runInDurableObject(f.channel, (channel, state) => {
              if (fault === "missing-consumption")
                state.storage.sql.exec("DELETE FROM managed_permits WHERE id=?", ack.handoffPermitId);
              if (fault === "other-intent")
                state.storage.sql.exec(
                  "UPDATE managed_permits SET body=json_set(body,'$.consumedByIntentId','another-intent') WHERE id=?",
                  ack.startPermitId,
                );
              if (fault === "revision-change" && result.ok)
                state.storage.sql.exec("UPDATE managed_policy_floor SET revision=?", result.value.policyRevision + 1);
              if (fault === "binding-change")
                Object.assign(channel, {
                  binding: {
                    version: 1,
                    generation: 2,
                    workspace: f.workspaceId,
                    operation: "binding",
                    state: "linked",
                  },
                });
            });
          }
          return result;
        });
        try {
          expect((await f.register()).status).toBe(
            fault === "binding-change" || fault === "authority-revoked" ? 404 : 503,
          );
        } finally {
          spy.mockRestore();
        }
        const executions = orgState.storage.sql
          .exec<{ body: string }>("SELECT body FROM executions WHERE id != ?", f.executionId)
          .toArray();
        expect(executions.every((row) => JSON.parse(row.body).status === "ended")).toBe(true);
      });
      expect(await f.snapshot()).toEqual(before);
    });
  }

  it("uses live Tasks and queue rows changed during activation without restoring or double draining", async () => {
    const f = await fixture();
    const agent = "alice/codex/failure-session";
    await runInDurableObject(f.channel, (_object, state) => {
      for (const table of ["lost_claims", "deliveries", "directive_deliveries"]) {
        state.storage.sql.exec(`INSERT INTO ${table} VALUES(?,?,?,?)`, "already-acknowledged", agent, 1, "{}");
      }
      state.storage.sql.exec(
        "INSERT INTO tasks(number,data) VALUES(?,?)",
        9001,
        JSON.stringify({ number: 9001, title: "before", status: "open", updatedAt: new Date().toISOString() }),
      );
    });
    await runInDurableObject(f.org, async (object) => {
      const original = object.activateRegistration.bind(object);
      const spy = vi.spyOn(object, "activateRegistration").mockImplementation(async (ack) => {
        await runInDurableObject(f.channel, (_channel, state) => {
          for (const table of ["lost_claims", "deliveries", "directive_deliveries"]) {
            state.storage.sql.exec(`DELETE FROM ${table}`);
            state.storage.sql.exec(`INSERT INTO ${table} VALUES(?,?,?,?)`, "newly-queued", agent, 2, "{}");
          }
          state.storage.sql.exec(
            "UPDATE tasks SET data=json_set(data,'$.title','changed-during-activation') WHERE number=9001",
          );
        });
        return original(ack);
      });
      try {
        expect((await f.register()).status).toBe(200);
      } finally {
        spy.mockRestore();
      }
    });
    await runInDurableObject(f.channel, (_object, state) => {
      for (const table of ["lost_claims", "deliveries", "directive_deliveries"])
        expect(state.storage.sql.exec(`SELECT * FROM ${table} WHERE agent=?`, agent).toArray()).toEqual([]);
      expect(
        JSON.parse(state.storage.sql.exec<{ data: string }>("SELECT data FROM tasks WHERE number=9001").one().data)
          .title,
      ).toBe("changed-during-activation");
    });
    const applied = await f.snapshot();
    expect((await f.register()).status).toBe(200);
    expect(await f.snapshot()).toEqual(applied);
  });

  it("rolls back a late apply failure including live queue drains, spawn SQL and Host waiter notification", async () => {
    const f = await fixture();
    const notify = vi.fn();
    await runInDurableObject(f.channel, (object, state) => {
      const hosts = (
        object as unknown as {
          hosts: {
            register(person: string, request: { name: string; roots: string[] }): unknown;
            waiting: Map<string, () => void>;
          };
        }
      ).hosts;
      hosts.register("alice", { name: "rollback-host", roots: ["/repo"] });
      hosts.waiting.set("rollback-spawn", notify);
      state.storage.sql.exec(
        "INSERT INTO host_spawns(id,person,host,state,requested_at) VALUES(?,?,?,'pending',?)",
        "rollback-spawn",
        "alice",
        "rollback-host",
        Date.now(),
      );
      for (const table of ["lost_claims", "deliveries", "directive_deliveries"])
        state.storage.sql.exec(
          `INSERT INTO ${table} VALUES(?,?,?,?)`,
          "rollback-queue",
          "alice/codex/failure-session",
          1,
          "{}",
        );
    });
    const before = await f.snapshot();
    await runInDurableObject(f.org, async (object) => {
      const original = object.activateRegistration.bind(object);
      const spy = vi.spyOn(object, "activateRegistration").mockImplementation(async (ack) => {
        const result = await original(ack);
        await runInDurableObject(f.channel, (_channel, state) => {
          state.storage.sql.exec(`CREATE TRIGGER abort_after_registration BEFORE UPDATE ON registration_intents
            WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT, 'late registration rollback'); END`);
        });
        return result;
      });
      try {
        expect((await f.register("late-rollback", { host: "rollback-host", spawn: "rollback-spawn" })).status).toBe(
          503,
        );
      } finally {
        spy.mockRestore();
      }
    });
    expect(await f.snapshot()).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  });

  it("records terminal applied failure after completion denial without undoing or repeating committed registration", async () => {
    const f = await fixture();
    await runInDurableObject(f.org, async (object) => {
      const complete = vi
        .spyOn(object, "completeRegistration")
        .mockResolvedValue({ ok: false, status: 404, reason: "registration_denied", policyRevision: 1 });
      try {
        expect((await f.register()).status).toBe(404);
      } finally {
        complete.mockRestore();
      }
    });
    const applied = await f.snapshot();
    expect((await f.register()).status).toBe(409);
    expect(await f.snapshot()).toEqual(applied);
    await runInDurableObject(f.channel, (_object, state) => {
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM registration_intents").one().state).toBe(
        "applied-failed",
      );
      expect(
        state.storage.sql
          .exec<{ active: number }>(
            "SELECT active FROM m1_agent_executions WHERE agent=?",
            "alice/codex/failure-session",
          )
          .one().active,
      ).toBe(0);
    });
  });

  for (const action of ["agent.execution.start", "agent.handoff.cross_owner"]) {
    it(`rolls back BOTH receipts when ${action} was already consumed at TXN-1`, async () => {
      const f = await fixture();
      const before = await f.snapshot();
      await runInDurableObject(f.channel, async (_object, state) => {
        const original = LocalMutationPermits.prototype.install;
        const install = vi.spyOn(LocalMutationPermits.prototype, "install").mockImplementation(function (
          this: LocalMutationPermits,
          permit,
        ) {
          original.call(this, permit);
          if (permit.action === action)
            state.storage.sql.exec(
              "UPDATE managed_permits SET body=json_set(body,'$.used',json('true')) WHERE id=?",
              permit.id,
            );
        });
        try {
          expect((await f.register()).status).toBe(503);
        } finally {
          install.mockRestore();
        }
        expect(state.storage.sql.exec("SELECT * FROM registration_intents").toArray()).toEqual([]);
        const exists = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='managed_permits'").toArray();
        if (exists.length) expect(state.storage.sql.exec("SELECT * FROM managed_permits").toArray()).toEqual([]);
      });
      expect(await f.snapshot()).toEqual(before);
    });
  }

  it("refuses apply when the immutable intent TTL expires after activation", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    await runInDurableObject(f.org, async (object) => {
      const original = object.activateRegistration.bind(object);
      let clock: ReturnType<typeof vi.spyOn> | undefined;
      const activate = vi.spyOn(object, "activateRegistration").mockImplementation(async (ack) => {
        const result = await original(ack);
        expect(result.ok).toBe(true);
        const expired = Date.now() + 31_000;
        clock = vi.spyOn(Date, "now").mockReturnValue(expired);
        return result;
      });
      try {
        expect((await f.register()).status).toBe(503);
      } finally {
        clock?.mockRestore();
        activate.mockRestore();
      }
    });
    expect(await f.snapshot()).toEqual(before);
    expect((await f.register()).status).toBe(409);
  });

  it("recovers cancellation from the real alarm without reapplying registration", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    await runInDurableObject(f.org, async (object) => {
      const activation = vi.spyOn(object, "activateRegistration").mockImplementation(async () => {
        throw new Error("activation unavailable");
      });
      const cancellation = vi.spyOn(object, "cancelRegistration").mockImplementation(async () => {
        throw new Error("cancel unavailable");
      });
      try {
        expect((await f.register()).status).toBe(503);
      } finally {
        activation.mockRestore();
        cancellation.mockRestore();
      }
    });
    await runInDurableObject(f.channel, async (object, state) => {
      state.storage.sql.exec("DELETE FROM alarm_deadlines");
      state.storage.sql.exec("INSERT INTO alarm_deadlines VALUES('registration-intents',?)", Date.now() - 1);
      await object.alarm();
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM registration_intents").one().state).toBe(
        "cancelled",
      );
    });
    expect(await f.snapshot()).toEqual(before);
  });

  it("cannot rotate an activated but unapplied identity into a usable credential", async () => {
    const f = await fixture();
    await runInDurableObject(f.org, async (object, state) => {
      const original = object.activateRegistration.bind(object);
      const activate = vi.spyOn(object, "activateRegistration").mockImplementation(async (ack) => {
        const result = await original(ack);
        expect(result.ok).toBe(true);
        const metadata = await object.metadata(f.actor);
        const rotated = await object.mutateIdentity({
          actor: f.actor,
          key: "rotate-before-complete",
          requestId: "rotate-before-complete",
          expectedRevision: metadata?.policyRevision,
          command: { kind: "execution.rotate", executionId: ack.executionId, expectedGeneration: 0 },
        });
        expect(rotated.ok).toBe(false);
        if (!rotated.ok) expect(rotated.status).toBe(409);
        expect(rotated).not.toHaveProperty("value.secret");
        expect(
          state.storage.sql
            .exec("SELECT id FROM execution_credentials WHERE json_extract(body,'$.executionId')=?", ack.executionId)
            .toArray(),
        ).toEqual([]);
        return result;
      });
      try {
        expect((await f.register()).status).toBe(200);
      } finally {
        activate.mockRestore();
      }
    });
  });

  it("preserves a prior execution when its live Resume ticket disappears during activation", async () => {
    const f = await fixture();
    await runInDurableObject(f.channel, (object, state) => {
      const hosts = (
        object as unknown as {
          hosts: { register(person: string, request: { name: string; roots: string[] }): unknown };
        }
      ).hosts;
      hosts.register("alice", { name: "resume-host", roots: ["/repo"] });
      state.storage.sql.exec("UPDATE agents SET presence='paused',host='alice/resume-host' WHERE id=?", f.targetId);
      state.storage.sql.exec("INSERT INTO host_resumes VALUES(?,?)", f.targetId, Date.now());
    });
    let afterLiveChange: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    await runInDurableObject(f.org, async (object, state) => {
      const original = object.activateRegistration.bind(object);
      const activate = vi.spyOn(object, "activateRegistration").mockImplementation(async (ack) => {
        const result = await original(ack);
        expect(result.ok).toBe(true);
        await runInDurableObject(f.channel, (_channel, channelState) => {
          channelState.storage.sql.exec("DELETE FROM host_resumes WHERE agent=?", f.targetId);
        });
        afterLiveChange = await f.snapshot();
        return result;
      });
      try {
        expect(
          (await f.register("resume-race", { sessionId: "session", resumed: true, host: "resume-host" })).status,
        ).toBe(409);
      } finally {
        activate.mockRestore();
      }
      expect(
        JSON.parse(
          state.storage.sql.exec<{ body: string }>("SELECT body FROM executions WHERE id=?", f.executionId).one().body,
        ).status,
      ).toBe("active");
    });
    expect(afterLiveChange).toBeDefined();
    expect(await f.snapshot()).toEqual(afterLiveChange);
  });

  for (const phase of ["prepared", "activated", "receipt-invalidated"] as const) {
    it(`recovers a crashed ${phase} intent by cancellation only at its durable alarm`, async () => {
      const f = await fixture();
      const before = await f.snapshot();
      const request = JSON.stringify({ cli: "codex", sessionId: "failure-session", resumed: false, cwd: "/repo" });
      const prepared = await f.org.prepareRegistration({
        actor: f.actor,
        principalId: f.principalId,
        workspaceId: f.workspaceId,
        channelId: f.repo,
        generation: 1,
        agentId: "alice/codex/failure-session",
        hostId: null,
        requestId: "crash-intent",
        request,
        credentialExpiresAt: Date.now() + 600_000,
      });
      if (!prepared.ok) throw new Error("crash preparation denied");
      const p = prepared.value.reservation;
      const ack = {
        reservationId: p.reservationId,
        intentId: p.intentId,
        startPermitId: p.startPermitId,
        handoffPermitId: p.handoffPermitId,
        executionId: p.executionId,
        workspaceId: p.workspaceId,
        channelId: p.channelId,
        generation: p.generation,
      };
      await runInDurableObject(f.channel, (_object, state) => {
        state.storage.sql.exec("INSERT OR REPLACE INTO alarm_deadlines VALUES('registration-intents',?)", p.expiresAt);
        state.storage.transactionSync(() =>
          new RegistrationIntents(state.storage.sql).prepare(
            {
              intentId: p.intentId,
              organizationId: p.organizationId,
              workspaceId: p.workspaceId,
              channelId: p.channelId,
              bindingGeneration: p.generation,
              actorPersonId: p.actorPersonId,
              actorGithubId: p.actorGithubId,
              principalId: p.principalId,
              reservedExecutionId: p.executionId,
              agentId: p.agentId,
              hostId: p.hostId,
              ownerPersonId: p.ownerPersonId,
              predecessorExecutionId: null,
              predecessorAgentId: null,
              requestId: p.requestId,
              reservationId: p.reservationId,
              startPermitId: p.startPermitId,
              handoffPermitId: p.handoffPermitId,
              policyRevision: p.policyRevision,
              verifiedOwnerHandoff: true,
              createdAt: p.createdAt,
              expiresAt: p.expiresAt,
              request: p.request,
            },
            prepared.value.permits.map((permit) => ({
              permit,
              binding: {
                actor: f.actor,
                action: permit.action,
                resource: {
                  kind: "workspace",
                  organizationId: f.organizationId,
                  id: f.workspaceId,
                  channel: f.repo,
                  targetId: p.agentId,
                  ownerPersonId: f.actor.personId,
                  operation: `agent.register.prepare:${p.intentId}`,
                },
                requestId: p.requestId,
                generation: 1,
                policyRevision: p.policyRevision,
              },
            })),
          ),
        );
      });
      expect(await f.snapshot()).toEqual(before);
      if (phase !== "prepared") {
        expect((await f.org.activateRegistration(ack)).ok).toBe(true);
        await runInDurableObject(f.channel, (_object, state) => {
          new RegistrationIntents(state.storage.sql).transition(p.intentId, "prepared", "activated");
          if (phase === "receipt-invalidated") state.storage.sql.exec("DELETE FROM managed_permits");
        });
      }
      await runInDurableObject(f.channel, async (object, state) => {
        state.storage.sql.exec("DELETE FROM alarm_deadlines WHERE job != 'registration-intents'");
        const clock = vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
        try {
          await object.alarm();
        } finally {
          clock.mockRestore();
        }
        expect(new RegistrationIntents(state.storage.sql).get(p.intentId)?.state).toBe("expired");
      });
      expect(await f.snapshot()).toEqual(before);
      expect((await f.org.activateRegistration(ack)).ok).toBe(false);
    });
  }

  it("serializes identical concurrent handler retries and rejects a changed body without replaying a credential", async () => {
    const f = await fixture();
    const [first, replay] = await Promise.all([f.register(), f.register()]);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const initial = (await first.json()) as { token?: string };
    const repeated = (await replay.json()) as Record<string, unknown>;
    expect(initial.token).toBeTypeOf("string");
    expect(repeated).not.toHaveProperty("token");
    expect(repeated).not.toHaveProperty("credential");
    expect(repeated).not.toHaveProperty("secret");
    const applied = await f.snapshot();
    expect((await f.register("failure-registration", { cwd: "/changed" })).status).toBe(409);
    expect(await f.snapshot()).toEqual(applied);
    await runInDurableObject(f.channel, (_object, state) => {
      expect(state.storage.sql.exec("SELECT intentId FROM registration_intents").toArray()).toHaveLength(1);
      expect(
        state.storage.sql
          .exec("SELECT id FROM events WHERE type='session.start' AND actor_id=?", "alice/codex/failure-session")
          .toArray(),
      ).toHaveLength(1);
    });
  });

  it("times out pending activation with 503 and refuses its delayed response after cancellation", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    await runInDurableObject(f.org, async (object) => {
      const original = object.activateRegistration.bind(object);
      let release: (() => void) | undefined;
      let delayed: ReturnType<typeof original> | undefined;
      const activate = vi.spyOn(object, "activateRegistration").mockImplementation((ack) => {
        delayed = new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => original(ack));
        return delayed;
      });
      try {
        expect((await f.register()).status).toBe(503);
      } finally {
        release?.();
        activate.mockRestore();
      }
      if (!delayed) throw new Error("activation not reached");
      expect((await delayed).ok).toBe(false);
    });
    expect(await f.snapshot()).toEqual(before);
  });

  it("preserves the earliest durable recovery deadline across overlapping intents and reconciles both", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    await runInDurableObject(f.org, async (object) => {
      const activate = vi.spyOn(object, "activateRegistration").mockImplementation(async () => {
        throw new Error("activation unavailable");
      });
      const cancel = vi.spyOn(object, "cancelRegistration").mockImplementation(async () => {
        throw new Error("cancel unavailable");
      });
      try {
        expect((await f.register("first-overlap")).status).toBe(503);
        expect((await f.register("second-overlap", { sessionId: "overlap-session" })).status).toBe(503);
      } finally {
        activate.mockRestore();
        cancel.mockRestore();
      }
    });
    await runInDurableObject(f.channel, async (object, state) => {
      const rows = state.storage.sql.exec<{ payload: string }>("SELECT payload FROM registration_intents").toArray();
      expect(rows).toHaveLength(2);
      const deadline = state.storage.sql
        .exec<{ at: number }>("SELECT at FROM alarm_deadlines WHERE job='registration-intents'")
        .one().at;
      expect(deadline).toBe(Math.min(...rows.map((row) => JSON.parse(row.payload).expiresAt)));
      state.storage.sql.exec("DELETE FROM alarm_deadlines WHERE job != 'registration-intents'");
      await object.alarm();
      expect(
        state.storage.sql
          .exec<{ state: string }>("SELECT state FROM registration_intents")
          .toArray()
          .map((row) => row.state),
      ).toEqual(["cancelled", "cancelled"]);
    });
    expect(await f.snapshot()).toEqual(before);
  });
});
