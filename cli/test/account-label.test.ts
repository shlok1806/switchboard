// The Account Label the wrapper sends (ADR 0009): which login of its CLI an Agent
// runs under, from a flag, the environment, or the CLI's own config, masked.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountLabel, maskEmail } from "../src/account-label";

let home = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "switchboard-account-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function claudeLogin(dir: string, account: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: account, userID: "do-not-send" }));
}

describe("accountLabel", () => {
  it("masks the Claude Code login's email address, from $CLAUDE_CONFIG_DIR", async () => {
    const dir = join(home, "account-b");
    await claudeLogin(dir, { emailAddress: "shlokat2@illinois.edu", organizationName: "shlokat2@illinois.edu's Org" });
    expect(await accountLabel("claude-code", undefined, { CLAUDE_CONFIG_DIR: dir })).toBe("sh…@illinois.edu");
  });

  it("tells two logins of one Person apart by their config directory", async () => {
    await claudeLogin(join(home, "a"), { emailAddress: "shlok.thakkar@gmail.com" });
    await claudeLogin(join(home, "b"), { emailAddress: "shlokat2@illinois.edu" });
    const a = await accountLabel("claude-code", undefined, { CLAUDE_CONFIG_DIR: join(home, "a") });
    const b = await accountLabel("claude-code", undefined, { CLAUDE_CONFIG_DIR: join(home, "b") });
    expect([a, b]).toEqual(["sh…@gmail.com", "sh…@illinois.edu"]);
  });

  it("prefers the flag, then $SWITCHBOARD_ACCOUNT_LABEL, and lets either send none", async () => {
    const dir = join(home, "claude");
    await claudeLogin(dir, { emailAddress: "ada@example.com" });
    const env = { CLAUDE_CONFIG_DIR: dir, SWITCHBOARD_ACCOUNT_LABEL: "  team   account " };
    expect(await accountLabel("claude-code", "personal", env)).toBe("personal");
    expect(await accountLabel("claude-code", undefined, env)).toBe("team account");
    expect(await accountLabel("claude-code", "", env)).toBeNull();
    expect(await accountLabel("claude-code", undefined, { ...env, SWITCHBOARD_ACCOUNT_LABEL: "" })).toBeNull();
  });

  it("reads Gemini CLI's active Google account, and nothing for Codex", async () => {
    await mkdir(join(home, ".gemini"), { recursive: true });
    await writeFile(join(home, ".gemini", "google_accounts.json"), JSON.stringify({ active: "ada@example.com" }));
    expect(await accountLabel("gemini", undefined, { GEMINI_CLI_HOME: home })).toBe("ad…@example.com");
    expect(await accountLabel("codex", undefined, { CODEX_HOME: home })).toBeNull();
  });

  it("sends none when the config has no login or cannot be read", async () => {
    await claudeLogin(join(home, "x"), {});
    expect(await accountLabel("claude-code", undefined, { CLAUDE_CONFIG_DIR: join(home, "x") })).toBeNull();
    expect(await accountLabel("claude-code", undefined, { CLAUDE_CONFIG_DIR: join(home, "missing") })).toBeNull();
  });
});

describe("maskEmail", () => {
  it("keeps two characters of the local part and the domain", () => {
    expect(maskEmail("a@b.co")).toBe("a…@b.co");
    expect(maskEmail("not an address")).toBeNull();
    expect(maskEmail("@example.com")).toBeNull();
  });
});
