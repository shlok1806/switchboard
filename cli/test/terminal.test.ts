// The live terminal on the wrapper's side (ADR 0021): which input frames it types, what
// its screen shows watchers, and when it sends it. The Channel is not trusted, so every
// check here is one a frame from it must pass before reaching the session.

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentId,
  attachKeyFingerprint,
  signedInput,
  TERMINAL_ATTACHED_MS,
  type TerminalInputFrame,
  toBase64,
} from "../../shared/src/index";
import { type AttachList, attachCommand, cachedAttachList, readAttachList } from "../src/terminal/attach-keys";
import { AttachGate } from "../src/terminal/gate";
import { PASTE_END, PASTE_START, PasteGuard } from "../src/terminal/paste";
import { TerminalPresence, terminalNotification } from "../src/terminal/presence";
import { redactLine, ScreenStream, TerminalScreen } from "../src/terminal/screen";

const AGENT = "shlok/claude/7f3a" as AgentId;
const NONCE = "run-1";
const REPO = "shlok1806/switchboard";

/** A browser's attach key: signs frames as the Dashboard does. */
async function browserKey() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const fingerprint = await attachKeyFingerprint(spki);
  const frame = async (
    seq: number,
    text: string,
    signed: { repo?: string; agent?: string; nonce?: string; text?: string } = {},
  ): Promise<TerminalInputFrame> => {
    const message = signedInput(
      signed.repo ?? REPO,
      signed.agent ?? AGENT,
      signed.nonce ?? NONCE,
      seq,
      signed.text ?? text,
    );
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(message),
    );
    return { type: "terminal.input", agent: AGENT, key: toBase64(spki), seq, text, sig: toBase64(new Uint8Array(sig)) };
  };
  return { fingerprint, spki: toBase64(spki), frame };
}

function gateFor(list: AttachList, dialog: { open: string | null } = { open: null }) {
  return new AttachGate({
    owner: "shlok",
    repo: REPO,
    agent: () => AGENT,
    nonce: NONCE,
    list: async () => list,
    dialog: () => dialog.open,
  });
}

const allow = (fingerprint: string, person: string, agent?: string, repo?: string) => ({
  fingerprint,
  person,
  ...(repo === undefined ? {} : { repo }),
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
    });
    expect(await gate.check(await bob.frame(2, "x"))).toMatchObject({ ok: true });
  });

  it("refuses a key that is not on the list, or is only allowed for another Agent", async () => {
    const bob = await browserKey();
    const gate = gateFor({ attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob", "shlok/claude/0000")] });
    expect(await gate.check(await bob.frame(1, "ls\r"))).toEqual({
      ok: false,
      fingerprint: bob.fingerprint,
      reason: `key ${bob.fingerprint} is not allowed to type into ${AGENT} in ${REPO}`,
    });
    expect(await gateFor({ attachersAnswerPrompts: true, keys: [] }).check(await bob.frame(1, "ls"))).toMatchObject({
      ok: false,
    });
  });

  it("refuses a key allowed only in another Channel, and takes one allowed in this one", async () => {
    const bob = await browserKey();
    const elsewhere = gateFor({
      attachersAnswerPrompts: true,
      keys: [allow(bob.fingerprint, "bob", AGENT, "shlok1806/other")],
    });
    expect(await elsewhere.check(await bob.frame(1, "ls"))).toMatchObject({ ok: false, reason: /not allowed/ });
    const here = gateFor({ attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob", AGENT, REPO)] });
    expect(await here.check(await bob.frame(1, "ls"))).toMatchObject({ ok: true });
  });

  it("refuses frames whose signature does not cover what they carry", async () => {
    const bob = await browserKey();
    const mallory = await browserKey();
    const gate = gateFor({ attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob")] });
    const altered = await bob.frame(1, "rm -rf ~\r", { text: "ls\r" });
    const otherRun = await bob.frame(2, "ls\r", { nonce: "run-0" });
    const otherAgent = await bob.frame(3, "ls\r", { agent: "shlok/claude/0000" });
    const otherChannel = await bob.frame(6, "ls\r", { repo: "shlok1806/other" });
    const reseq = { ...(await bob.frame(4, "ls\r")), seq: 40 };
    const borrowed = { ...(await mallory.frame(5, "ls\r")), key: bob.spki };
    for (const frame of [altered, otherRun, otherAgent, otherChannel, reseq, borrowed]) {
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
      repo: REPO,
      agent: () => AGENT,
      nonce: NONCE,
      // The first read of the list is slow.
      list: async () => {
        calls++;
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 50));
        return { attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob")] };
      },
      dialog: () => null,
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

  it("drops frames past the rate before checking them, and takes them again as it refills", async () => {
    const bob = await browserKey();
    const clock = { now: 0 };
    const gate = new AttachGate({
      owner: "shlok",
      repo: REPO,
      agent: () => AGENT,
      nonce: NONCE,
      list: async () => ({ attachersAnswerPrompts: true, keys: [allow(bob.fingerprint, "bob")] }),
      dialog: () => null,
      perSecond: 2,
      now: () => clock.now,
    });
    // A burst of twice the rate passes.
    const frames = await Promise.all([1, 2, 3, 4, 5].map((seq) => bob.frame(seq, "x")));
    const results = await Promise.all(frames.map((f) => gate.check(f)));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, false]);
    expect(results[4]).toMatchObject({ limited: true });
    clock.now = 499;
    expect(await gate.check(await bob.frame(6, "x"))).toMatchObject({ ok: false, limited: true });
    clock.now = 500;
    expect(await gate.check(await bob.frame(7, "x"))).toMatchObject({ ok: true });
  });

  it("holds an attacher back from an open dialog when the owner said so, never the owner", async () => {
    const bob = await browserKey();
    const owner = await browserKey();
    const prompt: { open: string | null } = { open: "ExitPlanMode" };
    const keys = [allow(bob.fingerprint, "bob"), allow(owner.fingerprint, "shlok")];
    const off = gateFor({ attachersAnswerPrompts: false, keys }, prompt);
    expect(await off.check(await bob.frame(1, "1\r"))).toMatchObject({
      ok: false,
      reason: "a dialog may be open (ExitPlanMode), and only the owner answers dialogs here",
    });
    expect(await off.check(await owner.frame(1, "1\r"))).toMatchObject({ ok: true, person: "shlok" });
    // A held-back frame keeps its number: the attacher types it once the prompt closes.
    prompt.open = null;
    expect(await off.check(await bob.frame(1, "x"))).toMatchObject({ ok: true });
    // Assumption A's working answer: with the flag on, attachers answer prompts too.
    prompt.open = "permission for Bash";
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
      repo: REPO,
      agent: () => AGENT,
      nonce: NONCE,
      list: async () => {
        throw new Error("Unexpected token");
      },
      dialog: () => null,
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

  it("reads the list again only once it changed, so a revoke is seen at the next frame", async () => {
    const list = cachedAttachList(env);
    expect((await list()).keys).toEqual([]);
    await attachCommand(["allow", FP, "--person", "bob"], env);
    expect((await list()).keys).toMatchObject([{ fingerprint: FP }]);
    // Unreadable now, but unchanged: the list read last is still the list.
    await chmod(join(dir, "attach.json"), 0o000);
    expect((await list()).keys).toMatchObject([{ fingerprint: FP }]);
    await chmod(join(dir, "attach.json"), 0o600);
    // An edit in place that keeps the size, as an editor saving over the file makes, is seen too.
    const path = join(dir, "attach.json");
    await writeFile(path, (await readFile(path, "utf8")).replace('"bob"', '"bub"'));
    expect((await list()).keys).toMatchObject([{ person: "bub" }]);
    await attachCommand(["revoke", FP], env);
    expect((await list()).keys).toEqual([]);
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

  it("allows a key in one Channel only with --repo, named as the Dashboard names it, and refuses what is not a repo", async () => {
    expect(await attachCommand(["allow", FP, "--person", "bob", "--repo", "Shlok1806/Switchboard"], env)).toBe(0);
    expect((await readAttachList(env)).keys).toMatchObject([{ fingerprint: FP, repo: "shlok1806/switchboard" }]);
    expect(await attachCommand(["allow", FP, "--person", "bob", "--repo", "not a repo"], env)).toBe(2);
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

  it("drops bidi controls, which would reorder the text in a viewer's browser, and still masks a key split by one", async () => {
    const screen = new TerminalScreen(60, 3);
    await written(screen, "rm -rf /tmp/x \u202e# safe\u202c\r\nghp_abcdefghij\u2066klmnopqrstuvwxyz0123\u2069 done");
    const lines = screen.snapshot().lines;
    expect(lines[0]).toBe("rm -rf /tmp/x # safe");
    expect(lines[1]).toBe("ghp_**** done");
    expect(lines.join("")).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
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

  it("masks a key a colour change glues to a word, splits, or both", async () => {
    const screen = new TerminalScreen(80, 4);
    await written(
      screen,
      [
        "OK\x1b[32mghp_abcdefghijklmnopqrstuvwxyz0123\x1b[0m",
        "sk-ant-api03-\x1b[1mABCDEFGH\x1b[22mIJKLMNOP",
        "OK\x1b[32mghp_abcdefghijklmnopqrstuvwxyz\x1b[1m0123\x1b[0m4567 done",
      ].join("\r\n"),
    );
    expect(screen.snapshot().lines.slice(0, 4)).toEqual(["OKghp_****", "sk-ant-****", "OKghp_**** done", ""]);
    screen.dispose();
  });

  it("masks a key a colour change glues to a word, split where its first row holds too little of it to know", async () => {
    const glued = `OK\x1b[32mghp_${"A".repeat(14)}`;
    // The terminal wraps it.
    const wrapped = new TerminalScreen(20, 3);
    await written(wrapped, `${glued}${"B".repeat(30)} done`);
    expect(wrapped.snapshot().lines.join("\n")).not.toMatch(/AAAA|BBBB/);
    wrapped.dispose();
    // The CLI breaks it itself, indented under the first row.
    const broken = new TerminalScreen(20, 4);
    await written(broken, `${glued}\r\n     ${"B".repeat(30)}\r\nnext`);
    expect(broken.snapshot().lines.join("\n")).not.toMatch(/AAAA|BBBB/);
    expect(broken.snapshot().lines.at(-1)).toBe("next");
    broken.dispose();
    // Glued to a digit.
    const digit = new TerminalScreen(20, 3);
    await written(digit, `v2\x1b[32mghp_${"A".repeat(14)}${"B".repeat(30)} done`);
    expect(digit.snapshot().lines.join("\n")).not.toMatch(/AAAA|BBBB/);
    digit.dispose();
    // Glued, then split by a second colour change and a break.
    const both = new TerminalScreen(20, 6);
    await written(both, `token\x1b[32msk-ant-api03-\x1b[1mQQ\r\n     ${"R".repeat(60)}\r\nnext`);
    expect(both.snapshot().lines.join("\n")).not.toMatch(/QQ|RRRR/);
    expect(both.snapshot().lines[0]).toBe("tokensk-ant-****");
    both.dispose();
  });

  it("masks a key a colour change glues to the word that ends the row before", async () => {
    const screen = new TerminalScreen(30, 3);
    // The colour changes exactly where the terminal wraps.
    await written(screen, `${"x".repeat(30)}\x1b[32mghp_abcdefghijklmnopqrstuvwxyz0123`);
    expect(screen.snapshot().lines.join("")).not.toContain("abcdefghij");
    screen.dispose();
  });

  it("keeps a wrapped row in place when the row before holds wide characters and a colour change", async () => {
    const screen = new TerminalScreen(10, 2);
    // 你 and 好 take two cells each: the first row is full with eight characters.
    await written(screen, "\x1b[31m你好\x1b[0mabcdefghijkl");
    expect(screen.snapshot().lines).toEqual(["你好abcdef", "ghijkl"]);
    screen.dispose();
  });

  it("masks a key the CLI broke over rows itself, indented under the first", async () => {
    // Ink breaks a long token at the last column with its own CR LF: no row is marked wrapped.
    const key = `sk-ant-api03-${"Q".repeat(40)}${"R".repeat(48)}`;
    const head = `  ⎿  ${key.slice(0, 55)}`;
    const screen = new TerminalScreen(60, 4);
    await written(screen, `${head}\r\n     ${key.slice(55)}\r\nnext line`);
    const shot = screen.snapshot().lines;
    expect(shot.join("\n")).not.toMatch(/QQQQ|RRRR/);
    expect(shot).toEqual(["  ⎿  sk-ant-****", "", "next line", ""]);
    screen.dispose();
  });

  it("masks a key the CLI broke where its first row holds too little of it to know", async () => {
    const screen = new TerminalScreen(20, 5);
    // The terminal wraps the second line too, after the CLI broke it from the first.
    await written(screen, `${"x".repeat(11)} sk-ant-a\r\n     pi03-${"Z".repeat(30)} done`);
    expect(screen.snapshot().lines).toEqual(["xxxxxxxxxxx sk-ant-****", "", "", " done", ""]);
    screen.dispose();
  });

  it("keeps every row in place when a mask shortens a row in a box drawn to the last column", async () => {
    const screen = new TerminalScreen(60, 4);
    const row = (text: string) => `│ ${text.padEnd(56)} │`;
    const key = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    await written(screen, [row(`export KEY=${key}`), row("second row"), row("third row")].join("\r\n"));
    expect(screen.snapshot().lines).toEqual([
      row(`export KEY=${key}`).replace(key, "ghp_****"),
      row("second row"),
      row("third row"),
      "",
    ]);
    screen.dispose();
  });

  it("masks a key the CLI broke over three rows, when only the last two are on screen", async () => {
    const key = `ghp_${"A".repeat(36)}${"B".repeat(40)}${"C".repeat(30)}`;
    const screen = new TerminalScreen(40, 3);
    await written(screen, `${key.slice(0, 40)}\r\n${key.slice(40, 80)}\r\n${key.slice(80)}\r\nafter`);
    // Only the rows from the second on are on screen: the key's start has scrolled away.
    expect(screen.snapshot().lines.join("\n")).not.toMatch(/BBBB|CCCC/);
    expect(screen.snapshot().lines.at(-1)).toBe("after");
    screen.dispose();
  });

  it("joins only a row whose text reaches the last column", async () => {
    const screen = new TerminalScreen(40, 3);
    await written(screen, "export PREFIX=sk-ant-api03-\r\nREADME_AND_MORE_WORDS\r\n");
    expect(screen.snapshot().lines.slice(1, 2)).toEqual(["README_AND_MORE_WORDS"]);
    screen.dispose();
  });

  it("masks every line of a private key printed on screen, its BEGIN line scrolled away or not", async () => {
    const body = [
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
      "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5d2FsZG8x",
    ];
    const screen = new TerminalScreen(80, 4);
    await written(
      screen,
      ["$ cat key.pem", "-----BEGIN PRIVATE KEY-----", ...body, "-----END PRIVATE KEY-----", "$ "].join("\r\n"),
    );
    const text = screen.snapshot().lines.join("\n");
    expect(text).not.toContain("MIIE");
    expect(text).not.toContain("Zm9v");
    expect(screen.snapshot().lines).toEqual(["****", "****", "-----END PRIVATE KEY-----", "$"]);
    screen.dispose();
  });

  it("masks a private key whose BEGIN and END lines the CLI wrapped over two rows", async () => {
    const screen = new TerminalScreen(20, 6);
    // Ink wraps the BEGIN and END lines at their spaces: no row is marked wrapped or full.
    await written(
      screen,
      ["-----BEGIN PRIVATE", "  KEY-----", "MIIEvQIBADANBgkqhk", "-----END PRIVATE", "  KEY-----", "$ "].join("\r\n"),
    );
    expect(screen.snapshot().lines).toEqual([
      "-----BEGIN PRIVATE",
      "  KEY-----",
      "****",
      "-----END PRIVATE",
      "  KEY-----",
      "$",
    ]);
    screen.dispose();
  });

  it("masks a private key whose BEGIN line the CLI broke at the last column", async () => {
    const screen = new TerminalScreen(20, 5);
    // No END line has come: every row after the BEGIN line is masked.
    await written(screen, ["-----BEGIN PRIVATE K", "EY-----", "MIIEvQIBADANBgkqhk", "$ "].join("\r\n"));
    expect(screen.snapshot().lines).toEqual(["-----BEGIN PRIVATE K", "EY-----", "****", "****", "****"]);
    screen.dispose();
  });

  it("masks a private key's body whose BEGIN line went past the scrollback, and not a short base64 line", async () => {
    const line = (i: number) => `${"Zm9vYmFy".repeat(8).slice(0, 60)}${String(i).padStart(4, "0")}`;
    const screen = new TerminalScreen(80, 5);
    await written(
      screen,
      [
        "-----BEGIN PRIVATE KEY-----",
        ...Array.from({ length: 300 }, (_, i) => line(i)),
        "-----END PRIVATE KEY-----",
        "c0ffee12deadbeef",
        "$ ",
      ].join("\r\n"),
    );
    // The buffer holds 205 rows: the BEGIN line went out of it long ago.
    expect(screen.snapshot().lines.join("\n")).not.toContain("Zm9v");
    expect(screen.snapshot().lines).toEqual(["****", "****", "-----END PRIVATE KEY-----", "c0ffee12deadbeef", "$"]);
    screen.dispose();
  });

  it("masks a block of long base64 lines anywhere, but leaves two alone", async () => {
    const b64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w";
    const three = new TerminalScreen(80, 5);
    await written(three, ["$ cat blob", b64, b64, b64, "$ "].join("\r\n"));
    expect(three.snapshot().lines).toEqual(["$ cat blob", "****", "****", "****", "$"]);
    three.dispose();
    const two = new TerminalScreen(80, 4);
    await written(two, ["$ cat blob", b64, b64, "$ "].join("\r\n"));
    expect(two.snapshot().lines.slice(1, 3)).toEqual([b64, b64]);
    two.dispose();
  });

  it("keeps the next line in place when a private key on one line wraps over rows", async () => {
    const screen = new TerminalScreen(30, 5);
    await written(screen, `-----BEGIN PRIVATE KEY-----${"K".repeat(40)}-----END PRIVATE KEY-----\r\nnext`);
    const lines = screen.snapshot().lines;
    expect(lines.join("")).not.toContain("KKKK");
    expect(lines.indexOf("next")).toBe(4);
    screen.dispose();
  });

  it("keeps a broken row's indent and its text after a key masked over the break", async () => {
    const screen = new TerminalScreen(20, 3);
    await written(screen, `${"x".repeat(11)} sk-ant-a\r\n     pi03-ZZZZ done`);
    expect(screen.snapshot().lines).toEqual(["xxxxxxxxxxx sk-ant-****", "      done", ""]);
    screen.dispose();
  });

  it("keeps the rows after a private key whose lines fill the terminal exactly", async () => {
    const screen = new TerminalScreen(27, 5);
    await written(
      screen,
      ["-----BEGIN PRIVATE KEY-----", "K".repeat(27), "-----END PRIVATE KEY-----", "next"].join("\r\n"),
    );
    const lines = screen.snapshot().lines;
    expect(lines.join("")).not.toContain("KKKK");
    expect(lines.indexOf("next")).toBe(3);
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

describe("a paste from the Dashboard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const guarded = () => {
    const ended: string[] = [];
    return { ended, guard: new PasteGuard((end) => ended.push(end), 2000) };
  };

  it("ends a paste whose next frame was refused, dropped in a flood, or never came", () => {
    const { ended, guard } = guarded();
    guard.typed("alice", `${PASTE_START}first part`);
    guard.lost("bob");
    expect(ended).toEqual([]);
    guard.lost("alice");
    expect(ended).toEqual([PASTE_END]);

    guard.typed("alice", `${PASTE_START}first part`);
    guard.lost();
    expect(ended).toEqual([PASTE_END, PASTE_END]);

    guard.typed("alice", `${PASTE_START}first part`);
    vi.advanceTimersByTime(1500);
    guard.typed("alice", "middle part");
    vi.advanceTimersByTime(1500);
    expect(ended).toHaveLength(2);
    vi.advanceTimersByTime(600);
    expect(ended).toHaveLength(3);
    guard.dispose();
  });

  it("leaves a paste alone that ended, and ends one before another key types", () => {
    const { ended, guard } = guarded();
    guard.typed("alice", `${PASTE_START}all of it${PASTE_END}`);
    vi.advanceTimersByTime(5000);
    guard.typed("alice", `${PASTE_START}first part`);
    guard.typed("alice", `last part${PASTE_END}`);
    guard.lost("alice");
    vi.advanceTimersByTime(5000);
    expect(ended).toEqual([]);

    guard.typed("alice", `${PASTE_START}first part`);
    guard.before("alice");
    expect(ended).toEqual([]);
    guard.before("bob");
    expect(ended).toEqual([PASTE_END]);
    guard.dispose();
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

describe("who is at the terminal", () => {
  it("records an attach at a key's first keystroke, and again after a quiet spell", () => {
    const clock = { now: 0 };
    const presence = new TerminalPresence("shlok", () => clock.now);
    expect(presence.keyTyped("ABCD-EFGH", "bob")).toBe(true);
    clock.now = TERMINAL_ATTACHED_MS - 1;
    expect(presence.keyTyped("ABCD-EFGH", "bob")).toBe(false);
    expect(presence.attached()).toEqual([{ person: "bob", key: "ABCD" }]);
    // Quiet for the whole window: the screen stops naming it, and its next keystroke attaches again.
    clock.now += TERMINAL_ATTACHED_MS;
    expect(presence.attached()).toEqual([]);
    expect(presence.keyTyped("ABCD-EFGH", "bob")).toBe(true);
  });

  it("says who started watching, never the owner, and sums the run up", () => {
    const presence = new TerminalPresence("shlok");
    expect(presence.summary()).toBeNull();
    expect(presence.watchers(["bob", "shlok"])).toEqual(["bob"]);
    expect(presence.watchers(["bob", "carol"])).toEqual(["carol"]);
    expect(presence.watchers([])).toEqual([]);
    expect(presence.watchers(["bob"])).toEqual(["bob"]);
    presence.keyTyped("WXYZ-0000", "carol");
    expect(presence.summary()).toBe(
      "This run's terminal was watched from the Dashboard: bob, carol; typed from the Dashboard: carol (key WXYZ).",
    );
  });

  it("notifies through the terminal without printing anything a person could be fooled by", () => {
    expect(terminalNotification("bob\x07\x1b[2J is ‮typing")).toBe("\x1b]9;bob  [2J is  typing\x07");
  });
});
