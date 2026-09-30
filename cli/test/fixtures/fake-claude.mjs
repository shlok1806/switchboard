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
//   prompt <text>
//         -> the Person submits a prompt: runs the UserPromptSubmit hooks, whose
//            output Claude Code adds to the model's context
//   model <prompt>
//         -> one call to the Messages API through ANTHROPIC_BASE_URL, streaming; prints
//            the status and a hash of the bytes it got back
//   busy <seconds>
//         -> works for a while, printing as it goes, like a long model turn
//   permission <tool>
//         -> opens a permission dialog for <tool>: runs the PermissionRequest hook;
//            the next line answers it
//   quit  -> exits 0, after the SessionEnd hook
//
// Like Claude Code, it turns bracketed paste on. A pasted text (between the paste
// markers) followed by Enter is one prompt however many lines it has: it prints
// `FAKE-CLAUDE pasted prompt=<json> during=<what it was doing>` when the prompt
// arrives, and runs the UserPromptSubmit hooks when it gets to it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/**
 * One model turn, the way Claude Code calls the Messages API: to ANTHROPIC_BASE_URL
 * (its settings' `env` wins over the environment), with its API key, streaming.
 */
async function modelTurn(prompt) {
  const base = settings.env?.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  try {
    const response = await fetch(`${base}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        stream: true,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const sha = createHash("sha256").update(body).digest("hex");
    console.log(`FAKE-CLAUDE model base=${base} status=${response.status} sha=${sha}`);
  } catch (error) {
    console.log(`FAKE-CLAUDE model base=${base} FAILED: ${error.message}`);
  }
}

console.log(`FAKE-CLAUDE args=${JSON.stringify(args)}`);
console.log(`FAKE-CLAUDE mcp=${mcpConfig ?? ""}`);
console.log(`FAKE-CLAUDE agent=${process.env.SWITCHBOARD_AGENT_ID ?? ""}`);
console.log(`FAKE-CLAUDE session=${sessionId}`);
runHooks("SessionStart", { source: flagValue("--resume") ? "resume" : "startup" });
// Bracketed paste on, as Claude Code does once its prompt is up.
process.stdout.write("\x1b[?2004h");

const cwd = process.cwd();
const lines = createInterface({ input: process.stdin });
// Lines run one at a time, in order, like turns.
let queue = Promise.resolve();
/** What the fake is doing, for `pasted ... during=`. */
let doing = "nothing";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** Lines of a paste still arriving; null when none is. */
let pasted = null;
/** Takes the line that answers an open dialog; null when none is open. */
let dialogAnswer = null;
lines.on("line", (line) => {
  if (dialogAnswer !== null) {
    const answerDialog = dialogAnswer;
    dialogAnswer = null;
    answerDialog(line);
    return;
  }
  if (pasted === null && line.includes(PASTE_START)) pasted = [];
  if (pasted !== null) {
    pasted.push(line);
    if (!line.includes(PASTE_END)) return;
    // The terminal turned the paste's line breaks into line ends; put them back.
    const text = pasted.join("\n");
    pasted = null;
    const before = text.slice(0, text.indexOf(PASTE_START));
    const prompt = text.slice(text.indexOf(PASTE_START) + PASTE_START.length, text.lastIndexOf(PASTE_END));
    const after = text.slice(text.lastIndexOf(PASTE_END) + PASTE_END.length);
    console.log(
      `FAKE-CLAUDE pasted prompt=${JSON.stringify(prompt)} before=${JSON.stringify(before)} after=${JSON.stringify(after)} during=${doing}`,
    );
    queue = queue.then(() => {
      runHooks("UserPromptSubmit", { prompt });
      console.log("FAKE-CLAUDE prompted");
    });
    return;
  }
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
  const prompt = /^prompt (.*)$/.exec(command);
  if (prompt) {
    runHooks("UserPromptSubmit", { prompt: prompt[1] });
    console.log("FAKE-CLAUDE prompted");
  }
  if (command === "work") console.log("FAKE-CLAUDE working on it");
  const busy = /^busy (\d+(?:\.\d+)?)$/.exec(command);
  if (busy) {
    doing = "busy";
    const until = Date.now() + Number(busy[1]) * 1000;
    while (Date.now() < until) {
      console.log("FAKE-CLAUDE busy");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    doing = "nothing";
    console.log("FAKE-CLAUDE busy done");
  }
  const permission = /^permission (\w+)$/.exec(command);
  if (permission) {
    runHooks("PermissionRequest", { tool_name: permission[1], tool_input: {} });
    console.log(`FAKE-CLAUDE asking permission for ${permission[1]}`);
    doing = "dialog";
    // The next line answers it, whatever it is.
    const reply = await new Promise((resolve) => {
      dialogAnswer = resolve;
    });
    doing = "nothing";
    toolUse(permission[1], {}, {});
    console.log(`FAKE-CLAUDE permission answered ${JSON.stringify(reply.trim())}`);
  }
  const model = /^model (.*)$/.exec(command);
  if (model) await modelTurn(model[1]);
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
