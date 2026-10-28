// The Host's check of an allow-list change sent from the owner's Dashboard (ADR 0028):
// applied only for a fresh, new change signed by an attach key this machine trusts for
// the Host's own Person.

import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { attachKeyFingerprint, signedAllowChange, toBase64 } from "../../shared/src/index";
import { type AllowContext, checkAllowChange } from "../src/host/allow";

async function browserKey() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await webcrypto.subtle.exportKey("spki", pair.publicKey));
  return { pair, spki, fingerprint: await attachKeyFingerprint(spki) };
}

async function signed(
  key: Awaited<ReturnType<typeof browserKey>>,
  fields: { allow?: string[]; allowChannel?: boolean; at?: number; seq?: number; host?: string; repo?: string } = {},
) {
  const { allow = ["bob"], allowChannel = false, at = Date.now(), seq = 1, host = "laptop", repo = "o/r" } = fields;
  const message = new TextEncoder().encode(signedAllowChange(repo, host, at, seq, allow, allowChannel));
  const sig = new Uint8Array(
    await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.pair.privateKey, message),
  );
  return { type: "host.allow", id: "x", allow, allowChannel, key: toBase64(key.spki), at, seq, sig: toBase64(sig) };
}

const context = (fingerprint: string, extra: Partial<AllowContext> = {}): AllowContext => ({
  owner: "alice",
  host: "laptop",
  repo: "o/r",
  list: {
    attachersAnswerPrompts: true,
    keys: [{ fingerprint, person: "alice", addedAt: "" }],
  },
  now: Date.now(),
  seqs: new Map(),
  ...extra,
});

describe("an allow-list change from the Dashboard", () => {
  it("is applied for a key the owner trusts on this machine, without the owner in the list", async () => {
    const key = await browserKey();
    const result = await checkAllowChange(
      await signed(key, { allow: ["carol", "bob", "alice"] }),
      context(key.fingerprint),
    );
    expect(result).toEqual({ ok: true, allow: ["bob", "carol"], allowChannel: false, fingerprint: key.fingerprint });
  });

  it("tells the owner exactly which command trusts an unknown browser key", async () => {
    const key = await browserKey();
    const result = await checkAllowChange(await signed(key), context("AAAA-BBBB-CCCC-DDDD-EEEE"));
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining(`switchboard attach allow ${key.fingerprint}`),
    });
  });

  it("does not take a key that belongs to another Person, or is limited to an Agent or another Channel", async () => {
    const key = await browserKey();
    for (const entry of [
      { person: "bob" },
      { person: "alice", agent: "alice/claude/ab12" },
      { person: "alice", repo: "x/y" },
    ]) {
      const list = { attachersAnswerPrompts: true, keys: [{ fingerprint: key.fingerprint, addedAt: "", ...entry }] };
      expect(await checkAllowChange(await signed(key), context(key.fingerprint, { list }))).toMatchObject({
        ok: false,
      });
    }
  });

  it("refuses a change that was altered, signed for another Host or Channel, stale, or replayed", async () => {
    const key = await browserKey();
    const ctx = () => context(key.fingerprint);
    const good = await signed(key);
    expect(await checkAllowChange({ ...good, allow: ["bob", "mallory"] }, ctx())).toMatchObject({ ok: false });
    expect(await checkAllowChange({ ...good, allowChannel: true }, ctx())).toMatchObject({ ok: false });
    expect(await checkAllowChange(await signed(key, { host: "desk" }), ctx())).toMatchObject({ ok: false });
    expect(await checkAllowChange(await signed(key, { repo: "x/y" }), ctx())).toMatchObject({ ok: false });
    expect(await checkAllowChange(await signed(key, { at: Date.now() - 10 * 60_000 }), ctx())).toMatchObject({
      ok: false,
      reason: expect.stringContaining("too old"),
    });
    const used = ctx();
    expect(await checkAllowChange(good, used)).toMatchObject({ ok: true });
    expect(await checkAllowChange(good, used)).toMatchObject({ ok: false, reason: expect.stringContaining("already") });
    // The next one, with a higher seq, still passes.
    expect(await checkAllowChange(await signed(key, { seq: 2 }), used)).toMatchObject({ ok: true });
  });

  it("refuses what is not a change at all", async () => {
    const key = await browserKey();
    for (const bad of [{ allow: undefined }, { allow: "bob" }, { allow: ["Bob Smith"], allowChannel: false }]) {
      expect(await checkAllowChange({ ...(await signed(key)), ...bad }, context(key.fingerprint))).toMatchObject({
        ok: false,
      });
    }
  });
});
