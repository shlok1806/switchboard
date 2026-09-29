// The per-session Claude Code settings the wrapper passes with --settings, and
// how a hook's input becomes small Hook Events.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HookSummarizer, shortCommand } from "../src/hooks/summarize";
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
});
