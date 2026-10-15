// The live terminal on the wrapper's side (ADR 0021): which input frames it types, what
// its screen shows watchers, and when it sends it. The Channel is not trusted, so every
// check here is one a frame from it must pass before reaching the session.

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentId,
  attachKeyFingerprint,
  signedInput,
  type TerminalInputFrame,
  toBase64,
} from "../../shared/src/index";
import { type AttachList, attachCommand, readAttachList } from "../src/terminal/attach-keys";
import { AttachGate } from "../src/terminal/gate";
import { redactLine, ScreenStream, TerminalScreen } from "../src/terminal/screen";

const AGENT = "shlok/claude/7f3a" as AgentId;
const NONCE = "run-1";

/** A browser's attach key: signs frames as the Dashboard does. */
async function browserKey() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const fingerprint = await attachKeyFingerprint(spki);
  const frame = async (
    seq: number,
    text: string,
    signed: { agent?: string; nonce?: string; text?: string } = {},
  ): Promise<TerminalInputFrame> => {
    const message = signedInput(signed.agent ?? AGENT, signed.nonce ?? NONCE, seq, signed.text ?? text);
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(message),
    );
    return { type: "terminal.input", agent: AGENT, key: toBase64(spki), seq, text, sig: toBase64(new Uint8Array(sig)) };
  };
  return { fingerprint, spki: toBase64(spki), frame };
}

function gateFor(list: AttachList, prompt = { open: false }) {
  return new AttachGate({
    owner: "shlok",
    agent: () => AGENT,
    nonce: NONCE,
    list: async () => list,
    promptOpen: () => prompt.open,
  });
}

const allow = (fingerprint: string, person: string, agent?: string) => ({
  fingerprint,
  person,
  ...(agent === undefined ? {} : { agent }),
  addedAt: "2026-10-15T00:00:00Z",
});

describe("AttachGate", () => {
  it("types a frame signed by an allowed key, naming the Person the owner gave it", async () => {
    const bob = await browserKey();
    const gate = gateFor({ attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob")] });
    expect(await gate.check(await bob.frame(1, "ls\r"))).toEqual({
      ok: true,
      text: "ls\r",
      person: "bob",
      fingerprint: bob.fingerprint,
      first: true,
    });
    expect(await gate.check(await bob.frame(2, "x"))).toMatchObject({ ok: true, first: false });
  });

  it("refuses a key that is not on the list, or is only allowed for another Agent", async () => {
    const bob = await browserKey();
    const gate = gateFor({ attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob", "shlok/claude/0000")] });
    expect(await gate.check(await bob.frame(1, "ls\r"))).toEqual({
      ok: false,
      fingerprint: bob.fingerprint,
      reason: `key ${bob.fingerprint} is not allowed to type into ${AGENT}`,
    });
    expect(await gateFor({ attachersAnswerPrompts: true, keys: [] }).check(await bob.frame(1, "ls"))).toMatchObject({
      ok: false,
    });
  });

  it("refuses frames whose signature does not cover what they carry", async () => {
    const bob = await browserKey();
    const mallory = await browserKey();
    const gate = gateFor({ attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob")] });
    const altered = await bob.frame(1, "rm -rf ~\r", { text: "ls\r" });
    const otherRun = await bob.frame(2, "ls\r", { nonce: "run-0" });
    const otherAgent = await bob.frame(3, "ls\r", { agent: "shlok/claude/0000" });
    const reseq = { ...(await bob.frame(4, "ls\r")), seq: 40 };
    const borrowed = { ...(await mallory.frame(5, "ls\r")), key: bob.spki };
    for (const frame of [altered, otherRun, otherAgent, reseq, borrowed]) {
      expect(await gate.check(frame)).toMatchObject({ ok: false, reason: "the signature does not match" });
    }
    // None of them used up a sequence number: the real frame 1 still types.
    expect(await gate.check(await bob.frame(1, "ls\r"))).toMatchObject({ ok: true });
  });

  it("refuses a frame for another Agent whatever its signature", async () => {
    const bob = await browserKey();
    const gate = gateFor({ attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob")] });
    const frame = {
      ...(await bob.frame(1, "ls", { agent: "shlok/claude/0000" })),
      agent: "shlok/claude/0000" as AgentId,
    };
    expect(await gate.check(frame)).toMatchObject({ ok: false, reason: "this wrapper does not run that Agent" });
  });

  it("refuses a sequence number it already took from that key, so the Channel cannot replay", async () => {
    const bob = await browserKey();
    const gate = gateFor({ attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob")] });
    const five = await bob.frame(5, "y\r");
    expect(await gate.check(five)).toMatchObject({ ok: true });
    expect(await gate.check(five)).toMatchObject({ ok: false, reason: "a sequence number already used" });
    expect(await gate.check(await bob.frame(4, "y\r"))).toMatchObject({ ok: false });
    expect(await gate.check(await bob.frame(6, "y\r"))).toMatchObject({ ok: true });
  });

  it("checks frames in the order they came, so a slow check never lets a later frame type first", async () => {
    const bob = await browserKey();
    let calls = 0;
    const gate = new AttachGate({
      owner: "shlok",
      agent: () => AGENT,
      nonce: NONCE,
      // The first read of the list is slow.
      list: async () => {
        calls++;
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 50));
        return { attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob")] };
      },
      promptOpen: () => false,
    });
    const [first, second] = await Promise.all([
      gate.check(await bob.frame(1, "a")),
      gate.check(await bob.frame(2, "b")),
    ]);
    expect([first.ok, second.ok]).toEqual([true, true]);
  });

  it("refuses empty or oversized input before checking anything else", async () => {
    const bob = await browserKey();
    const gate = gateFor({ attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob")] });
    expect(await gate.check(await bob.frame(1, ""))).toMatchObject({
      ok: false,
      reason: "input is 1 to 1024 characters",
    });
    expect(await gate.check(await bob.frame(2, "x".repeat(1025)))).toMatchObject({ ok: false });
    expect(await gate.check(await bob.frame(3, "x".repeat(1024)))).toMatchObject({ ok: true });
  });

  it("holds an attacher back from an open permission prompt when the owner said so, never the owner", async () => {
    const bob = await browserKey();
    const owner = await browserKey();
    const prompt = { open: true };
    const keys = [allow(bob.fingerprint, "bob"), allow(owner.fingerprint, "shlok")];
    const off = gateFor({ attachersAnswerPrompts: false, keys }, prompt);
    expect(await off.check(await bob.frame(1, "1\r"))).toMatchObject({
      ok: false,
      reason: "a permission prompt is open, and only its owner answers prompts here",
    });
    expect(await off.check(await owner.frame(1, "1\r"))).toMatchObject({ ok: true, person: "shlok" });
    // A held-back frame keeps its number: the attacher types it once the prompt closes.
    prompt.open = false;
    expect(await off.check(await bob.frame(1, "x"))).toMatchObject({ ok: true });
    // Assumption A's working answer: with the flag on, attachers answer prompts too.
    prompt.open = true;
    expect(
      await gateFor({ attachersAnswerPrompts: true, keys }, prompt).check(await bob.frame(1, "1\r")),
    ).toMatchObject({ ok: true });
  });

  it("reads the list for each frame, so a revoke takes effect at the next keystroke", async () => {
    const bob = await browserKey();
    const list: AttachList = { attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob")] };
    const gate = gateFor(list);
    expect(await gate.check(await bob.frame(1, "a"))).toMatchObject({ ok: true });
    list.keys = [];
    expect(await gate.check(await bob.frame(2, "b"))).toMatchObject({ ok: false });
  });

  it("types nothing when the list cannot be read", async () => {
    const bob = await browserKey();
    const gate = new AttachGate({
      owner: "shlok",
      agent: () => AGENT,
      nonce: NONCE,
      list: async () => {
        throw new Error("Unexpected token");
      },
      promptOpen: () => false,
    });
    expect(await gate.check(await bob.frame(1, "a"))).toMatchObject({
      ok: false,
      reason: "the allow list could not be read: Unexpected token",
    });
  });
});

describe("switchboard attach", () => {
  let dir = "";
  let env: NodeJS.ProcessEnv = {};
  const FP = "K7QX-2MRD-PA4L-7TZE-WCBN";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "switchboard-attach-"));
    env = { SWITCHBOARD_CONFIG_DIR: dir };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("allows nobody and lets attachers answer prompts when there is no list yet", async () => {
    expect(await readAttachList(env)).toEqual({ attachersAnswerPrompts: true, keys: [] });
  });

  it("saves an allowed key readable by its owner only, however the fingerprint is typed", async () => {
    expect(await attachCommand(["allow", "k7qx2mrdpa4l7tzewcbn", "--person", "bob", "--agent", AGENT], env)).toBe(0);
    const list = await readAttachList(env);
    expect(list.keys).toMatchObject([{ fingerprint: FP, person: "bob", agent: AGENT }]);
    expect((await stat(join(dir, "attach.json"))).mode & 0o777).toBe(0o600);
    // Allowing it again replaces it.
    expect(await attachCommand(["allow", FP, "--person", "bob"], env)).toBe(0);
    expect((await readAttachList(env)).keys).toMatchObject([{ fingerprint: FP, person: "bob" }]);
    expect((await readAttachList(env)).keys[0]?.agent).toBeUndefined();
  });

  it("labels a key with the signed-in Person when --person is left out, and refuses when there is none", async () => {
    expect(await attachCommand(["allow", FP], env)).toBe(2);
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ person: "shlok", url: "http://x", repo: "o/r", session: "s" }),
    );
    expect(await attachCommand(["allow", FP], env)).toBe(0);
    expect((await readAttachList(env)).keys).toMatchObject([{ person: "shlok" }]);
  });

  it("refuses what is not a fingerprint", async () => {
    expect(await attachCommand(["allow", "K7QX-2MRD", "--person", "bob"], env)).toBe(2);
    expect(await attachCommand(["allow", "K7QX-2MRD-PA4L-7TZE-WCB1", "--person", "bob"], env)).toBe(2);
  });

  it("revokes a key, and says so when it was not allowed", async () => {
    await attachCommand(["allow", FP, "--person", "bob"], env);
    expect(await attachCommand(["revoke", FP], env)).toBe(0);
    expect((await readAttachList(env)).keys).toEqual([]);
    expect(await attachCommand(["revoke", FP], env)).toBe(1);
  });

  it("turns attachers' answers to permission prompts off and on", async () => {
    await attachCommand(["allow", FP, "--person", "bob"], env);
    expect(await attachCommand(["prompts", "off"], env)).toBe(0);
    expect(await readAttachList(env)).toMatchObject({ attachersAnswerPrompts: false, keys: [{ fingerprint: FP }] });
    expect(await attachCommand(["prompts", "on"], env)).toBe(0);
    expect((await readAttachList(env)).attachersAnswerPrompts).toBe(true);
    expect(await attachCommand(["prompts", "maybe"], env)).toBe(2);
  });

  it("treats a damaged list as an error, never as allowing everyone", async () => {
    await writeFile(join(dir, "attach.json"), "{ not json");
    await expect(readAttachList(env)).rejects.toThrow();
    expect(await readFile(join(dir, "attach.json"), "utf8")).toBe("{ not json");
  });

  it("drops entries it cannot read rather than guessing", async () => {
    await writeFile(
      join(dir, "attach.json"),
      JSON.stringify({
        keys: [{ fingerprint: "nope", person: "x" }, { fingerprint: FP }, { fingerprint: FP, person: "bob" }],
      }),
    );
    expect((await readAttachList(env)).keys).toMatchObject([{ fingerprint: FP, person: "bob" }]);
  });
});

describe("the screen watchers see", () => {
  const written = (screen: TerminalScreen, data: string) => new Promise<void>((resolve) => screen.write(data, resolve));

  it("is the terminal's text, without colours or escape sequences", async () => {
    const screen = new TerminalScreen(40, 4);
    await written(screen, "\x1b[1;32mgreen\x1b[0m and plain\r\n\x1b]0;title\x07next");
    const shot = screen.snapshot();
    expect(shot.lines).toEqual(["green and plain", "next", "", ""]);
    expect(shot.cursor).toEqual({ x: 4, y: 1 });
    expect(shot.lines.join("")).not.toContain("\x1b");
    screen.dispose();
  });

  it("masks a secret, even one the terminal wrapped onto the next row", async () => {
    const secret = `sk-ant-api03-${"Z".repeat(60)}`;
    const screen = new TerminalScreen(30, 6);
    await written(screen, `export KEY=${secret}\r\nAuthorization: Bearer abc.def.ghi\r\n`);
    const text = screen.snapshot().lines.join("\n");
    expect(text).not.toMatch(/ZZZZ/);
    expect(text).toContain("Authorization: Bearer ****");
    expect(text).not.toContain("abc.def.ghi");
    screen.dispose();
  });

  it("masks the rows still on screen when the top of a wrapped line has scrolled away", async () => {
    const secret = `sk-ant-api03-${"Y".repeat(60)}`;
    const screen = new TerminalScreen(30, 2);
    // The secret wraps over three rows; only its last two stay on a two-row screen.
    await written(screen, `${secret}`);
    expect(screen.snapshot().lines.join("")).not.toMatch(/YYYY/);
    screen.dispose();
  });

  it("follows a resize", async () => {
    const screen = new TerminalScreen(10, 2);
    screen.resize(20, 3);
    expect(screen.snapshot()).toMatchObject({ cols: 20, rows: 3 });
    screen.dispose();
  });

  it("redactLine keeps the header name and scheme, and masks cookies", () => {
    expect(redactLine("curl -H 'x-api-key: abc123' -H 'Cookie: a=1; b=2'")).toBe(
      "curl -H 'x-api-key: ****' -H 'Cookie: ****'",
    );
    expect(redactLine("Proxy-Authorization: Basic dXNlcjpwYXNz")).toBe("Proxy-Authorization: Basic ****");
  });
});

describe("ScreenStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends nothing while no one watches, at once when someone starts watching, then only what changed", () => {
    const send = vi.fn();
    const stream = new ScreenStream(send, 125);
    stream.changed();
    vi.advanceTimersByTime(1000);
    expect(send).not.toHaveBeenCalled();

    stream.setWatchers(1);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
    // Many changes inside one interval make one frame.
    stream.changed();
    stream.changed();
    vi.advanceTimersByTime(125);
    expect(send).toHaveBeenCalledTimes(2);
    // A second watcher has no screen yet: everyone gets it again, at once.
    stream.setWatchers(2);
    expect(send).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(3);
    // The last one leaving stops it.
    stream.setWatchers(0);
    stream.changed();
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(3);
    stream.stop();
  });
});
