#!/usr/bin/env node
// A stand-in for `claude` in the end-to-end test. It reads the session ID the way
// Claude Code does (`--session-id` or `--resume`), writes a session file where
// Claude Code would, reports what it got, and runs the hooks in its `--settings`
// file the way Claude Code does: each command through a shell, with the hook's
// JSON input on stdin, waiting for it to finish. Then it answers typed lines:
//   work  -> prints some output
//   turn  -> one model turn: runs a command, writes, edits and reads files,
//            calls an MCP tool, then ends the turn (PostToolUse and Stop hooks)
//   call <tool> <json>
//         -> calls a Switchboard MCP tool from the `--mcp-config` servers, starting
//            the server the way Claude Code does (stdio), then its PostToolUse hook
//   quit  -> exits 0, after the SessionEnd hook

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let args = process.argv.slice(2);
const flagValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

// Like Claude Code, take the MCP config out; the rest is reported as the arguments.
const mcpConfig = flagValue("--mcp-config");
if (mcpConfig !== undefined) {
  const i = args.indexOf("--mcp-config");
  args = [...args.slice(0, i), ...args.slice(i + 2)];
}
const sessionId = flagValue("--session-id") ?? flagValue("--resume");
if (!sessionId) {
  console.log("FAKE-CLAUDE no session id");
  process.exit(3);
}

const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const project = join(claudeDir, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(project, { recursive: true });
const transcript = join(project, `${sessionId}.jsonl`);
appendFileSync(transcript, `${JSON.stringify({ at: Date.now() })}\n`);

const settingsPath = flagValue("--settings");
const settings = settingsPath ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};

/** Runs every command hook configured for `name` (and matching `tool`), like Claude Code. */
function runHooks(name, input, tool) {
  for (const group of settings.hooks?.[name] ?? []) {
    const matcher = group.matcher ?? "";
    if (tool !== undefined && matcher !== "" && matcher !== "*" && !new RegExp(`^(${matcher})$`).test(tool)) continue;
    for (const hook of group.hooks ?? []) {
      const payload = {
        session_id: sessionId,
        transcript_path: transcript,
        cwd: process.cwd(),
        hook_event_name: name,
        ...input,
      };
      const started = Date.now();
      const result = spawnSync("/bin/sh", ["-c", hook.command], {
        input: JSON.stringify(payload),
        timeout: (hook.timeout ?? 60) * 1000,
      });
      const ms = Date.now() - started;
      const out = `${result.stdout ?? ""}`.trim();
      console.log(
        `FAKE-CLAUDE hook ${name}${tool ? `:${tool}` : ""} exit=${result.status} ms=${ms}${out ? ` out=${out}` : ""}`,
      );
    }
  }
}

function toolUse(tool_name, tool_input, tool_response = {}) {
  runHooks("PostToolUse", { permission_mode: "default", tool_name, tool_input, tool_response }, tool_name);
}

/** One MCP client per server in the config, started on first use. */
const clients = new Map();

async function mcpClient(server) {
  if (clients.has(server)) return clients.get(server);
  if (mcpConfig === undefined) throw new Error("no --mcp-config");
  const spec = JSON.parse(readFileSync(mcpConfig, "utf8")).mcpServers[server];
  if (!spec) throw new Error(`no MCP server ${server}`);
  const client = new Client({ name: "fake-claude", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...process.env, ...spec.env } }),
  );
  const { tools } = await client.listTools();
  console.log(`FAKE-CLAUDE tools=${JSON.stringify(tools.map((t) => t.name))}`);
  clients.set(server, client);
  return client;
}

async function callTool(name, input) {
  try {
    const result = await (await mcpClient("switchboard")).callTool({ name, arguments: input });
    const text = result.content.map((c) => c.text).join("\n");
    console.log(`FAKE-CLAUDE ${name}${result.isError ? " ERROR" : ""}: ${text}`);
    toolUse(`mcp__switchboard__${name}`, input, result.content);
  } catch (error) {
    console.log(`FAKE-CLAUDE ${name} FAILED: ${error.message}`);
  }
  console.log(`FAKE-CLAUDE done ${name}`);
}

console.log(`FAKE-CLAUDE args=${JSON.stringify(args)}`);
console.log(`FAKE-CLAUDE mcp=${mcpConfig ?? ""}`);
console.log(`FAKE-CLAUDE agent=${process.env.SWITCHBOARD_AGENT_ID ?? ""}`);
console.log(`FAKE-CLAUDE session=${sessionId}`);
runHooks("SessionStart", { source: flagValue("--resume") ? "resume" : "startup" });

const cwd = process.cwd();
const lines = createInterface({ input: process.stdin });
// Lines run one at a time, in order, like turns.
let queue = Promise.resolve();
lines.on("line", (line) => {
  queue = queue.then(() => answer(line.trim()));
});

async function answer(command) {
  const call = /^call (\w+) (.*)$/.exec(command);
  if (call) await callTool(call[1], JSON.parse(call[2]));
  if (command === "quit") {
    for (const client of clients.values()) await client.close();
    runHooks("SessionEnd", { reason: "prompt_input_exit" });
    console.log("FAKE-CLAUDE bye");
    process.exit(0);
  }
  if (command === "work") console.log("FAKE-CLAUDE working on it");
  if (command === "turn") {
    const longCommand = `echo ${"a".repeat(2000)}`;
    toolUse(
      "Bash",
      { command: "npm test", description: "Run tests" },
      { stdout: "ok", stderr: "", interrupted: false },
    );
    toolUse("Bash", { command: longCommand });
    toolUse(
      "Write",
      { file_path: join(cwd, "src/new.ts"), content: "export const SECRET_CONTENT = 1;\nexport const b = 2;\n" },
      { type: "create", filePath: join(cwd, "src/new.ts"), structuredPatch: [] },
    );
    toolUse(
      "Edit",
      { file_path: join(cwd, "src/app.ts"), old_string: "old line", new_string: "new line\nanother" },
      {
        filePath: join(cwd, "src/app.ts"),
        structuredPatch: [{ lines: [" ctx", "-old line", "+new line", "+another"] }],
      },
    );
    toolUse("MultiEdit", {
      file_path: join(cwd, "src/app.ts"),
      edits: [{ old_string: "x", new_string: "y" }],
    });
    toolUse("Read", { file_path: join(cwd, "README.md") }, { file: { content: "SECRET_CONTENT" } });
    toolUse("mcp__switchboard__claim", { task: 7, note: "taking it" }, { ok: true });
    runHooks("Stop", { stop_hook_active: false });
    console.log("FAKE-CLAUDE turn done");
  }
}
