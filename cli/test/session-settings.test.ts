// The per-session Claude Code settings the wrapper passes with --settings, and
// how a hook's input becomes small Hook Events.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HookSummarizer, SWITCHBOARD_TOOL, shortCommand } from "../src/hooks/summarize";
import { MCP_SERVER_NAME } from "../src/mcp-server";
import { applySessionSettings, mergeSettings } from "../src/session-settings";

const hook = (command: string) => ({ type: "command" as const, command });

describe("session settings", () => {
  it("adds up every part's hooks and lets other keys sit next to them", () => {
    expect(
      mergeSettings(
        { hooks: { Stop: [{ hooks: [hook("a")] }] }, env: { A: "1" } },
        { hooks: { Stop: [{ hooks: [hook("b")] }], SessionEnd: [{ hooks: [hook("c")] }] } },
        { mcpServers: { switchboard: {} } },
      ),
    ).toEqual({
      hooks: { Stop: [{ hooks: [hook("a")] }, { hooks: [hook("b")] }], SessionEnd: [{ hooks: [hook("c")] }] },
      env: { A: "1" },
      mcpServers: { switchboard: {} },
    });
  });

  it("writes the session's settings file and points --settings at it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "switchboard-settings-"));
    const args = await applySessionSettings(["--model", "opus"], dir, dir, [
      { hooks: { Stop: [{ hooks: [hook("x")] }] } },
    ]);
    expect(args).toEqual(["--settings", join(dir, "settings.json"), "--model", "opus"]);
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))).toEqual({
      hooks: { Stop: [{ hooks: [hook("x")] }] },
    });
  });

  it("keeps the Person's own --settings, as a file or as JSON, and adds ours", async () => {
    const dir = await mkdtemp(join(tmpdir(), "switchboard-settings-"));
    await writeFile(join(dir, "mine.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [hook("mine")] }] } }));
    const ours = { hooks: { Stop: [{ hooks: [hook("ours")] }] } };

    const fromFile = await applySessionSettings(["--settings", "mine.json", "-p", "hi"], dir, dir, [ours]);
    expect(fromFile).toEqual(["--settings", join(dir, "settings.json"), "-p", "hi"]);
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).hooks.Stop).toEqual([
      { hooks: [hook("mine")] },
      { hooks: [hook("ours")] },
    ]);

    await applySessionSettings(['--settings={"model":"opus"}'], dir, dir, [ours]);
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))).toEqual({ model: "opus", ...ours });
  });
});

describe("summarizing hooks", () => {
  it("drops heredoc bodies from commands", () => {
    expect(shortCommand("cat > f <<'EOF'\nsecret body\nEOF")).toBe("cat > f <<'EOF'\n…");
    expect(shortCommand("ls -la")).toBe("ls -la");
  });

  it("keeps paths outside the repo as given, and counts turns", () => {
    const hooks = new HookSummarizer("/repo");
    expect(
      hooks.summarize({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/etc/hosts" } }),
    ).toEqual([
      { type: "tool.call", payload: { tool: "Edit", arg: "/etc/hosts", ok: true } },
      { type: "file.edit", payload: { path: "/etc/hosts", additions: 0, deletions: 0 } },
    ]);
    expect(hooks.summarize({ hook_event_name: "Stop" })).toEqual([{ type: "turn.end", payload: { turn: 1 } }]);
    expect(hooks.summarize({ hook_event_name: "Stop" })).toEqual([{ type: "turn.end", payload: { turn: 2 } }]);
    expect(hooks.summarize({ hook_event_name: "Notification" })).toEqual([]);
  });

  it("gives one Event per tool call: a shell call is its command, Switchboard's own tools none (#55)", () => {
    const hooks = new HookSummarizer("/repo");
    const post = (tool_name: string, tool_input: Record<string, unknown>, tool_response: unknown = {}) =>
      hooks.summarize({ hook_event_name: "PostToolUse", tool_name, tool_input, tool_response });
    // A shell call (Codex's and Gemini CLI's arrive as Bash): one `command`, with the command and exit code.
    expect(post("Bash", { command: "npm test" }, { exitCode: 1 })).toEqual([
      { type: "command", payload: { command: "npm test", exitCode: 1 } },
    ]);
    // Switchboard's own MCP tools are the Tool Capture's: Claude Code and Codex name them
    // mcp__switchboard__<tool>, Gemini CLI mcp_switchboard_<tool>.
    for (const tool of [
      "mcp__switchboard__claim_task",
      "mcp__switchboard__read_channel",
      "mcp__switchboard__post_update",
      "mcp__switchboard__complete_step",
      "mcp__switchboard__finish_task",
      "mcp_switchboard_claim_task",
    ]) {
      expect(post(tool, { task: 7 }), tool).toEqual([]);
    }
    // Other MCP tools, and a server merely named like it, are still one tool.call.
    expect(post("mcp__github__get_issue", { number: 7 })).toEqual([
      { type: "tool.call", payload: { tool: "mcp__github__get_issue", arg: "number=7", ok: true } },
    ]);
    expect(post("mcp__switchboardx__claim", { task: 7 })).toHaveLength(1);
    // A shell call with no command text falls back to a tool.call.
    expect(post("Bash", {})).toEqual([{ type: "tool.call", payload: { tool: "Bash", arg: "", ok: true } }]);
    // The pattern follows the server's name.
    expect(SWITCHBOARD_TOOL.test(`mcp__${MCP_SERVER_NAME}__x`)).toBe(true);
  });
});
