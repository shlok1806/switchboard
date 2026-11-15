import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_CHANNEL_SKILL_BYTES, SKILL_CHUNK_BYTES, sha256Hex } from "../../shared/src/index";
import { managedWriteRoute } from "../src/managed-channel";
import { Skills } from "../src/skills";

beforeEach(async () => {
  await reset();
});

async function chunk(text = "prepared skill bytes") {
  const data = new TextEncoder().encode(text);
  return { digest: await sha256Hex(data), size: data.length, index: 0, data };
}

describe("managed skill upload preparation", () => {
  it("hashes without storage writes and commits synchronously once", async () => {
    const input = await chunk();
    await runInDurableObject(env.CHANNEL.getByName("test/preparation"), async (_object, state) => {
      const skills = new Skills(state.storage);
      const prepared = await skills.prepareUpload([input]);
      expect(prepared.ok).toBe(true);
      expect(state.storage.sql.exec("SELECT * FROM skill_blobs").toArray()).toHaveLength(0);
      expect(state.storage.sql.exec("SELECT * FROM skill_chunks").toArray()).toHaveLength(0);
      if (!prepared.ok) throw new Error("preparation denied");
      const result = state.storage.transactionSync(() => prepared.value.commit());
      expect(result).toEqual({ ok: true, value: { complete: [input.digest] } });
      expect(prepared.value.commit()).toMatchObject({ ok: false, reason: "preparation_used" });
      expect(state.storage.sql.exec("SELECT complete FROM skill_blobs").one()).toEqual({ complete: 1 });
    });
  });

  it("rejects invalid digests without deleting or writing chunks", async () => {
    const input = await chunk();
    input.digest = "0".repeat(64);
    await runInDurableObject(env.CHANNEL.getByName("test/preparation"), async (_object, state) => {
      const result = await new Skills(state.storage).prepareUpload([input]);
      expect(result).toMatchObject({ ok: false, reason: "digest_mismatch" });
      expect(state.storage.sql.exec("SELECT * FROM skill_blobs").toArray()).toHaveLength(0);
      expect(state.storage.sql.exec("SELECT * FROM skill_chunks").toArray()).toHaveLength(0);
    });
  });

  it("rejects concurrent chunk changes before committing prepared bytes", async () => {
    const input = await chunk();
    await runInDurableObject(env.CHANNEL.getByName("test/preparation"), async (_object, state) => {
      const skills = new Skills(state.storage);
      const prepared = await skills.prepareUpload([input]);
      if (!prepared.ok) throw new Error("preparation denied");
      state.storage.sql.exec(
        "INSERT INTO skill_blobs (digest,size,complete,uploaded_at) VALUES(?,?,0,?)",
        input.digest,
        input.size,
        new Date().toISOString(),
      );
      expect(prepared.value.commit()).toMatchObject({ ok: false, reason: "upload_changed" });
      expect(state.storage.sql.exec("SELECT * FROM skill_chunks").toArray()).toHaveLength(0);
      expect(state.storage.sql.exec("SELECT complete FROM skill_blobs").one()).toEqual({ complete: 0 });
    });
  });

  it("copies caller bytes before asynchronous preparation", async () => {
    const input = await chunk();
    await runInDurableObject(env.CHANNEL.getByName("test/preparation"), async (_object, state) => {
      const pending = new Skills(state.storage).prepareUpload([input]);
      input.data.fill(0);
      const prepared = await pending;
      if (!prepared.ok) throw new Error("preparation denied");
      expect(prepared.value.commit()).toMatchObject({ ok: true });
      const row = state.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM skill_chunks").one();
      expect(new TextDecoder().decode(row.data)).toBe("prepared skill bytes");
    });
  });

  it("rechecks current capacity and leaves no partial writes on refusal", async () => {
    const input = await chunk();
    await runInDurableObject(env.CHANNEL.getByName("test/preparation"), async (_object, state) => {
      const prepared = await new Skills(state.storage).prepareUpload([input]);
      if (!prepared.ok) throw new Error("preparation denied");
      state.storage.sql.exec(
        "INSERT INTO skill_blobs (digest,size,complete,uploaded_at) VALUES(?,?,0,?)",
        "f".repeat(64),
        MAX_CHANNEL_SKILL_BYTES,
        new Date().toISOString(),
      );
      expect(prepared.value.commit()).toMatchObject({ ok: false, reason: "skill_capacity" });
      expect(state.storage.sql.exec("SELECT * FROM skill_chunks").toArray()).toHaveLength(0);
      expect(state.storage.sql.exec("SELECT * FROM skill_blobs WHERE digest=?", input.digest).toArray()).toHaveLength(
        0,
      );
    });
  });

  it("hashes a completed multipart overlay and preserves the prior partial upload", async () => {
    const data = new Uint8Array(SKILL_CHUNK_BYTES + 1).fill(97);
    const digest = await sha256Hex(data);
    await runInDurableObject(env.CHANNEL.getByName("test/preparation"), async (_object, state) => {
      const skills = new Skills(state.storage);
      const first = await skills.prepareUpload([
        { digest, size: data.length, index: 0, data: data.slice(0, SKILL_CHUNK_BYTES) },
      ]);
      if (!first.ok) throw new Error("preparation denied");
      expect(first.value.commit()).toEqual({ ok: true, value: { complete: [] } });
      const last = await skills.prepareUpload([
        { digest, size: data.length, index: 1, data: data.slice(SKILL_CHUNK_BYTES) },
      ]);
      if (!last.ok) throw new Error("preparation denied");
      expect(state.storage.sql.exec("SELECT complete FROM skill_blobs").one()).toEqual({ complete: 0 });
      expect(last.value.commit()).toEqual({ ok: true, value: { complete: [digest] } });
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM skill_chunks").one()).toEqual({ n: 2 });
    });
  });

  it("rolls prepared bytes back with the enclosing permit transaction", async () => {
    const input = await chunk();
    await runInDurableObject(env.CHANNEL.getByName("test/preparation"), async (_object, state) => {
      const prepared = await new Skills(state.storage).prepareUpload([input]);
      if (!prepared.ok) throw new Error("preparation denied");
      expect(() =>
        state.storage.transactionSync(() => {
          expect(prepared.value.commit()).toMatchObject({ ok: true });
          throw new Error("audit failed");
        }),
      ).toThrow("audit failed");
      expect(state.storage.sql.exec("SELECT * FROM skill_blobs").toArray()).toHaveLength(0);
      expect(state.storage.sql.exec("SELECT * FROM skill_chunks").toArray()).toHaveLength(0);
    });
  });

  it("keeps upload and publication routes denied until facade and D5 coverage exist", () => {
    expect(managedWriteRoute("POST", "/api/skill-files")).toBeNull();
    expect(managedWriteRoute("POST", "/api/skills/guide")).toBeNull();
  });
});
