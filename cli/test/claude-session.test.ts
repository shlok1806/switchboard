// How `switchboard run claude` works out the session, and so the Agent ID, from
// the arguments the Person passes to Claude Code.

import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planSession, projectDir } from "../src/claude-session";
import { takeNickname } from "../src/run";

const NEW = "11111111-2222-4333-8444-555555555555";
const OLD = "7f3a0000-0000-4000-8000-000000000000";
const cwd = "/work/repo";

async function plan(args: string[], claudeConfigDir = "/nonexistent") {
  return planSession(args, { cwd, claudeConfigDir, newSessionId: () => NEW });
}

describe("planSession", () => {
  it("picks the session ID of a new session", async () => {
    expect(await plan(["--model", "opus"])).toEqual({
      kind: "known",
      args: ["--session-id", NEW, "--model", "opus"],
      sessionId: NEW,
      resumed: false,
    });
  });

  it("uses a session ID the Person gave", async () => {
    expect(await plan(["--session-id", OLD])).toMatchObject({ kind: "known", sessionId: OLD, resumed: false });
    expect(await plan([`--session-id=${OLD}`])).toMatchObject({ kind: "known", sessionId: OLD });
  });

  it("keeps the session ID of a resumed session", async () => {
    for (const args of [["--resume", OLD], ["-r", OLD], [`--resume=${OLD}`]]) {
      expect(await plan(args)).toEqual({ kind: "known", args, sessionId: OLD, resumed: true });
    }
  });

  it("gives a forked session its own new ID", async () => {
    expect(await plan(["--resume", OLD, "--fork-session"])).toEqual({
      kind: "known",
      args: ["--resume", OLD, "--fork-session", "--session-id", NEW],
      sessionId: NEW,
      resumed: false,
    });
  });

  it("waits for the picker when --resume has no session ID", async () => {
    expect(await plan(["--resume"])).toEqual({ kind: "picker", args: ["--resume"] });
    expect(await plan(["--resume", "login bug"])).toMatchObject({ kind: "picker" });
  });

  it("turns --continue into --resume of the latest session in this directory", async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), "switchboard-claude-"));
    const dir = projectDir(claudeDir, cwd);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${NEW}.jsonl`), "{}\n");
    await writeFile(join(dir, `${OLD}.jsonl`), "{}\n");
    await writeFile(join(dir, "notes.txt"), "not a session\n");
    await utimes(join(dir, `${NEW}.jsonl`), new Date(1000), new Date(1000));

    expect(await plan(["-c", "--model", "opus"], claudeDir)).toEqual({
      kind: "known",
      args: ["--resume", OLD, "--model", "opus"],
      sessionId: OLD,
      resumed: true,
    });
    await expect(plan(["--continue"])).rejects.toThrow("No conversation found to continue");
  });

  it("runs --help and --version without a session", async () => {
    expect(await plan(["--help"])).toEqual({ kind: "none", args: ["--help"] });
    expect(await plan(["-v"])).toEqual({ kind: "none", args: ["-v"] });
  });
});

describe("takeNickname", () => {
  it("takes the wrapper's --nickname out of the agent CLI's arguments", () => {
    expect(takeNickname(["--nickname", "scout", "--model", "opus"])).toEqual({
      nickname: "scout",
      rest: ["--model", "opus"],
    });
    expect(takeNickname(["--nickname=scout"])).toEqual({ nickname: "scout", rest: [] });
    expect(takeNickname(["--", "--nickname", "x"])).toEqual({ rest: ["--", "--nickname", "x"] });
  });
});
