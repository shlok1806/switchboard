// The Codex and Gemini CLI adapters: how a launch's session is worked out, how
// each CLI's hook input is read, and how context is handed back.

import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  codexHookAnswer,
  codexHookOverrides,
  codexMcpOverrides,
  findCodexSession,
  planCodexSession,
  translateCodexHook,
} from "../src/clis/codex";
import { geminiHookAnswer, planGeminiSession, translateGeminiHook } from "../src/clis/gemini";

const ID = "01a0f2bb-063c-7f33-be98-906c8b79d278";

describe("planCodexSession", () => {
  it("leaves a new session to Codex, and knows a resumed one by its ID", () => {
    expect(planCodexSession(["-m", "o3", "fix the bug"])).toEqual({
      kind: "discover",
      args: ["-m", "o3", "fix the bug"],
      resumed: false,
    });
    expect(planCodexSession(["resume", ID])).toEqual({
      kind: "known",
      args: ["resume", ID],
      sessionId: ID,
      resumed: true,
    });
    expect(planCodexSession(["-c", "model=o3", "resume", "--last"])).toMatchObject({ kind: "discover", resumed: true });
    expect(planCodexSession(["resume"])).toMatchObject({ kind: "discover", resumed: true });
    expect(planCodexSession(["fork", ID])).toMatchObject({ kind: "discover", resumed: false });
  });

  it("runs non-session commands as they are", () => {
    for (const args of [["--help"], ["--version"], ["exec", "hi"], ["login"], ["-m", "o3", "mcp", "list"]]) {
      expect(planCodexSession(args)).toEqual({ kind: "none", args });
    }
  });
});

describe("Codex's session overrides", () => {
  it("installs every hook with the same command, and the MCP server, as TOML", () => {
    const hooks = codexHookOverrides("'/node' '/hook.js'");
    expect(hooks.filter((a) => a === "-c")).toHaveLength(7);
    expect(hooks).toContain(`hooks.SessionStart=[{hooks=[{type="command",command="'/node' '/hook.js'",timeout=10}]}]`);
    expect(hooks).toContain(`hooks.SessionEnd=[{hooks=[{type="command",command="'/node' '/hook.js'",timeout=3}]}]`);
    expect(
      codexMcpOverrides({ name: "switchboard", command: "/node", args: ["/sb.js", "mcp"], env: { A: 'x"y' } }),
    ).toEqual([
      "-c",
      'mcp_servers.switchboard.command="/node"',
      "-c",
      'mcp_servers.switchboard.args=["/sb.js","mcp"]',
      "-c",
      'mcp_servers.switchboard.env={"A"="x\\"y"}',
      "-c",
      'mcp_servers.switchboard.default_tools_approval_mode="approve"',
    ]);
  });
});

describe("translateCodexHook", () => {
  it("reads a shell call, and an apply_patch as one edit per file", () => {
    expect(
      translateCodexHook({
        hook_event_name: "PostToolUse",
        tool_name: "shell",
        tool_input: { command: ["bash", "-lc", "npm test"] },
        tool_response: "Exit code: 1\nOutput:\nfail",
      }),
    ).toMatchObject({ tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 1 } });
    const edits = translateCodexHook({
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n+z\n*** Add File: b.ts\n+one\n*** End Patch",
      },
    });
    expect(edits).toEqual([
      expect.objectContaining({
        tool_name: "Edit",
        tool_input: { file_path: "a.ts", old_string: "x", new_string: "y\nz" },
      }),
      expect.objectContaining({ tool_name: "Write", tool_input: { file_path: "b.ts", content: "one\n" } }),
    ]);
  });

  it("hands context back as additionalContext, only where Codex reads it", () => {
    expect(JSON.parse(codexHookAnswer("UserPromptSubmit", "told\n"))).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "told" },
    });
    expect(codexHookAnswer("Stop", "told")).toBe("");
    expect(codexHookAnswer("SessionStart", "")).toBe("");
  });
});

describe("findCodexSession", () => {
  let home = "";
  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("finds the session Codex wrote for this directory since launch", async () => {
    home = await mkdtemp(join(tmpdir(), "codex-home-"));
    const now = new Date();
    const two = (n: number) => String(n).padStart(2, "0");
    const dir = join(home, "sessions", String(now.getFullYear()), two(now.getMonth() + 1), two(now.getDate()));
    await mkdir(dir, { recursive: true });
    const write = async (id: string, cwd: string) =>
      writeFile(
        join(dir, `rollout-x-${id}.jsonl`),
        `${JSON.stringify({ type: "session_meta", payload: { id, cwd } })}\n`,
      );
    const since = Date.now() - 1000;
    const old = "01a0f2bb-0000-7000-8000-000000000001";
    await write(old, "/repo");
    await utimes(join(dir, `rollout-x-${old}.jsonl`), new Date(since - 60_000), new Date(since - 60_000));
    await write("01a0f2bb-0000-7000-8000-000000000002", "/elsewhere");
    expect(await findCodexSession(home, "/repo", since, false)).toBeNull();
    await write(ID, "/repo");
    expect(await findCodexSession(home, "/repo", since, false)).toBe(ID);
  });
});

describe("Gemini CLI", () => {
  it("plans sessions from --resume", () => {
    const uuid = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    expect(planGeminiSession(["--resume", uuid])).toEqual({
      kind: "known",
      args: ["--resume", uuid],
      sessionId: uuid,
      resumed: true,
    });
    expect(planGeminiSession(["--resume", "latest"])).toMatchObject({ kind: "discover", resumed: true });
    expect(planGeminiSession(["-m", "gemini-3-pro"])).toMatchObject({ kind: "discover", resumed: false });
    expect(planGeminiSession(["--list-sessions"])).toMatchObject({ kind: "none" });
  });

  it("reads Gemini's hook and tool names as Claude Code's", () => {
    expect(
      translateGeminiHook({ hook_event_name: "AfterTool", tool_name: "replace", tool_input: { file_path: "/r/a.ts" } }),
    ).toMatchObject({ hook_event_name: "PostToolUse", tool_name: "Edit" });
    expect(translateGeminiHook({ hook_event_name: "BeforeAgent", prompt: "hi" })).toMatchObject({
      hook_event_name: "UserPromptSubmit",
    });
    expect(translateGeminiHook({ hook_event_name: "AfterAgent" })).toMatchObject({ hook_event_name: "Stop" });
    expect(
      translateGeminiHook({
        hook_event_name: "Notification",
        notification_type: "ToolPermission",
        details: { tool_name: "run_shell_command" },
      }),
    ).toMatchObject({ hook_event_name: "PermissionRequest" });
    expect(JSON.parse(geminiHookAnswer("UserPromptSubmit", "told"))).toEqual({
      hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: "told" },
    });
  });
});
