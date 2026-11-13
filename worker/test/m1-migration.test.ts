import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { PersonName } from "../../shared/src/index";
import { Channel } from "../src/channel";

const channel = () => env.CHANNEL.getByName("migration/fixture");
beforeEach(() => reset());

describe("additive M1 Channel migration", () => {
  it("preserves pre-M1 Events persons and stored Skills and Artifacts across repeated startup", async () => {
    await runInDurableObject(channel(), (_object, state) => {
      state.storage.sql.exec("DROP TABLE m1_binding; DROP TABLE m1_binding_outbox");
      state.storage.sql.exec("INSERT INTO persons VALUES('alice','America/Chicago','2026-01-01T00:00:00Z')");
      state.storage.sql.exec(`INSERT INTO events(id,at,type,actor,capture,payload,actor_kind,actor_id)
        VALUES('legacy-event','2026-01-01T00:00:00Z','update','{"kind":"person","person":"alice"}','manual','{"text":"legacy update"}','person','alice')`);
      state.storage.sql.exec(`INSERT INTO skill_versions VALUES('fixture',1,'alice',NULL,'2026-01-01T00:00:00Z','digest',3,'fixture');
        INSERT INTO skill_entries VALUES('fixture',1,'SKILL.md','digest',3,'utf8');
        INSERT INTO skill_blobs VALUES('digest',3,1,1,NULL,'2026-01-01T00:00:00Z');
        INSERT INTO skill_chunks VALUES('digest',0,X'010203');
        INSERT INTO artifact_versions VALUES('fixture',1,'alice','Fixture',3,'digest','{"person":"alice"}','2026-01-01T00:00:00Z');
        INSERT INTO artifact_chunks VALUES('fixture',1,0,X'040506');`);
      const before = {
        persons: state.storage.sql.exec("SELECT * FROM persons").toArray(),
        events: state.storage.sql.exec("SELECT * FROM events").toArray(),
        skill: state.storage.sql.exec("SELECT * FROM skill_chunks").toArray(),
        artifact: state.storage.sql.exec("SELECT * FROM artifact_chunks").toArray(),
      };
      const first = new Channel(state, env);
      const second = new Channel(state, env);
      expect(first.bindingState()).toEqual(second.bindingState());
      expect(second.bindingState()).toMatchObject({ version: 1, generation: 0, workspace: null, state: "unlinked" });
      expect(state.storage.sql.exec("SELECT * FROM persons").toArray()).toEqual(before.persons);
      expect(state.storage.sql.exec("SELECT * FROM events").toArray()).toEqual(before.events);
      expect(state.storage.sql.exec("SELECT * FROM skill_chunks").toArray()).toEqual(before.skill);
      expect(state.storage.sql.exec("SELECT * FROM artifact_chunks").toArray()).toEqual(before.artifact);
    });
  });

  it("preserves unlinked session admission and does not erase unknown binding versions on startup", async () => {
    expect(
      await channel().admit("migration/fixture", { kind: "session", person: "alice" as PersonName }, true),
    ).toMatchObject({ ok: true, person: "alice" });
    await runInDurableObject(channel(), (_object, state) => {
      state.storage.sql.exec("UPDATE m1_binding SET version=99 WHERE id=1");
      expect(new Channel(state, env).bindingState().version).toBe(99);
    });
  });

  it("keeps missing binding state closed when prior migration or pending outbox evidence remains", async () => {
    await runInDurableObject(channel(), async (_object, state) => {
      state.storage.sql.exec("DELETE FROM m1_binding WHERE id=1");
      const missingRow = new Channel(state, env);
      expect(missingRow.bindingState().state).toBe("recovery_required");
      expect(
        await missingRow.admit("migration/fixture", { kind: "session", person: "alice" as PersonName }, true),
      ).toMatchObject({ ok: false, status: 403 });

      state.storage.sql.exec("DROP TABLE m1_binding");
      state.storage.sql.exec("INSERT INTO m1_binding_outbox VALUES('pending-operation',1,'{}')");
      const missingTable = new Channel(state, env);
      expect(missingTable.bindingState().state).toBe("recovery_required");
      expect(
        await missingTable.admit("migration/fixture", { kind: "session", person: "alice" as PersonName }, true),
      ).toMatchObject({ ok: false, status: 403 });
      expect(state.storage.sql.exec("SELECT operation FROM m1_binding_outbox").toArray()).toEqual([
        { operation: "pending-operation" },
      ]);
      expect(new Channel(state, env).bindingState()).toEqual(missingTable.bindingState());
    });
  });
});

it("preserves pending linked and unbinding fences across repeated startup", async () => {
  await runInDurableObject(channel(), async (object, state) => {
    const workspace = "11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
    expect(object.prepareBinding(workspace, "restart-bind", 0)).toBe(true);
    const pending = new Channel(state, env);
    expect(pending.bindingState()).toMatchObject({ state: "pending", generation: 1 });
    expect(
      await pending.admit("migration/fixture", { kind: "session", person: "alice" as PersonName }, true),
    ).toMatchObject({ ok: false });
    expect(pending.finishBinding(workspace, "restart-bind", 1, false)).toBe(true);
    const linked = new Channel(state, env);
    expect(linked.bindingState()).toMatchObject({ state: "linked", generation: 1 });
    expect(linked.prepareBinding(workspace, "restart-unbind", 1, true)).toBe(true);
    const detaching = new Channel(state, env);
    expect(detaching.bindingState()).toMatchObject({ state: "pending_unlink", generation: 2 });
    expect(
      await detaching.admit("migration/fixture", { kind: "session", person: "alice" as PersonName }, true),
    ).toMatchObject({ ok: false });
    expect(detaching.finishBinding(workspace, "restart-unbind", 2, true)).toBe(true);
    const detached = new Channel(state, env);
    expect(detached.bindingState()).toMatchObject({ state: "unlinked", generation: 2 });
    expect(
      await detached.admit("migration/fixture", { kind: "session", person: "alice" as PersonName }, true),
    ).toMatchObject({ ok: true });
  });
});
