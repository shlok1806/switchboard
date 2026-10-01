// The body of the stand-ins for `codex` and `gemini` in the end-to-end tests
// (fake-codex.mjs, fake-gemini.mjs). Each reads its session hooks and MCP servers
// from where the real CLI would, the way the real CLI would:
//
// - codex: `-c hooks.<Event>=[...]` and `-c mcp_servers.<name>.*` overrides. It runs
//   hooks only when FAKE_CODEX_TRUSTED=1, as Codex runs session hooks only once the
//   Person trusts them in /hooks. It picks a UUIDv7-like thread ID (or takes
//   `resume <id>`) and writes its session file under $CODEX_HOME/sessions.
// - gemini: the settings file in $GEMINI_CLI_SYSTEM_SETTINGS_PATH (`hooks`,
//   `mcpServers`), with Gemini's hook names; it runs hooks with a sanitized
//   environment. It picks a UUID (or takes `--resume <id>`).
//
// Hooks get each CLI's own input (event and tool names, fields) on stdin; a hook's
// `hookSpecificOutput.additionalContext` is what the model would see, and is printed.
// Then it answers typed lines:
//   work              -> prints some output
//   turn              -> one model turn: a shell command and a file edit, then the turn ends
//   shell <command>   -> codex: one shell tool call, the command run for real in the
//                        current directory (`\n` is a line break), between its
//                        PreToolUse and PostToolUse hooks
//   call <tool> <json>-> calls a Switchboard MCP tool (stdio), then the after-tool hook
//   prompt <text>     -> the Person submits a prompt: runs the prompt-submit hook
//   busy <seconds>    -> works for a while, printing as it goes
//   model <prompt>    -> one model turn, the way the CLI calls its model API:
//                        codex: a `response.create` on a WebSocket at
//                        `<openai_base_url>/responses`, falling back to `POST
//                        /responses` (SSE) when the upgrade is refused, as Codex does;
//                        gemini: `:streamGenerateContent?alt=sse` at Code Assist
//                        (CODE_ASSIST_ENDPOINT) or the Gemini API
//                        (GOOGLE_GEMINI_BASE_URL), by auth type, as Gemini CLI does.
//                        Prints where it went and a hash of what it got back.
//   permission <tool> -> an approval dialog: the next line answers it
//   quit              -> exits 0, after the SessionEnd hook
// Like Codex, it turns bracketed paste on; a paste then Enter is one prompt, printed as
// `<TAG> pasted prompt=<json> during=<what it was doing>`.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connect } from "./ws-client.mjs";

/** A TOML value from a `-c` override: strings, arrays and inline tables of them, as Switchboard writes them. */
function tomlValue(text) {
  const json = text.replace(/([{,])\s*(\w+)\s*=/g, '$1"$2":').replace(/("(?:[^"\\]|\\.)*")\s*=/g, "$1:");
  return JSON.parse(json);
}

export async function runFake(dialect) {
  const TAG = dialect === "codex" ? "FAKE-CODEX" : "FAKE-GEMINI";
  const say = (line) => console.log(`${TAG} ${line}`);
  const args = process.argv.slice(2);
  const cwd = process.cwd();

  // Where this CLI's session hooks and MCP servers come from.
  const hooks = {};
  const mcpServers = {};
  /** Codex's other `-c` overrides; Gemini CLI's settings. */
  const config = {};
  let rest = args;
  if (dialect === "codex") {
    rest = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== "-c") {
        rest.push(args[i]);
        continue;
      }
      const override = args[++i] ?? "";
      const eq = override.indexOf("=");
      const key = override.slice(0, eq);
      const value = tomlValue(override.slice(eq + 1));
      const hook = /^hooks\.(\w+)$/.exec(key);
      if (hook) hooks[hook[1]] = value;
      const mcp = /^mcp_servers\.(\w+)\.(\w+)$/.exec(key);
      if (mcp) mcpServers[mcp[1]] = { ...mcpServers[mcp[1]], [mcp[2]]: value };
      if (!hook && !mcp) config[key] = value;
    }
  } else {
    const path = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    const settings = path ? JSON.parse(readFileSync(path, "utf8")) : {};
    Object.assign(hooks, settings.hooks ?? {});
    Object.assign(mcpServers, settings.mcpServers ?? {});
    Object.assign(config, settings);
  }
  const trusted = dialect !== "codex" || process.env.FAKE_CODEX_TRUSTED === "1";

  // The session: named by the Person on resume, else picked by the CLI.
  let sessionId;
  let resumed = false;
  /** Codex starts its session (session file, SessionStart hook) at the first prompt (seen with codex-cli 0.159.1). */
  let writeSessionFile = () => {};
  if (dialect === "codex") {
    const at = rest.indexOf("resume");
    if (at !== -1 && rest[at + 1] && !rest[at + 1].startsWith("-")) {
      sessionId = rest[at + 1];
      resumed = true;
    } else {
      // UUIDv7-like: the clock first, so every session starts the same.
      const hex = `01a0f2${randomBytes(13).toString("hex")}`;
      sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    }
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    const now = new Date();
    const two = (n) => String(n).padStart(2, "0");
    const dir = join(home, "sessions", String(now.getFullYear()), two(now.getMonth() + 1), two(now.getDate()));
    const file = join(dir, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, "-")}-${sessionId}.jsonl`);
    writeSessionFile = () => {
      writeSessionFile = () => {};
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } })}\n`);
      sessionStart();
    };
  } else {
    const at = rest.findIndex((a) => a === "--resume" || a === "-r");
    sessionId = at !== -1 && rest[at + 1] ? rest[at + 1] : randomUUID();
    resumed = at !== -1;
  }

  /** Runs every command hook configured for `event` (matching `tool`), the way the CLI does. */
  function runHooks(event, input, tool) {
    if (!trusted) return;
    for (const group of hooks[event] ?? []) {
      const matcher = group.matcher ?? "";
      if (tool !== undefined && matcher !== "" && matcher !== "*" && !new RegExp(`^(${matcher})$`).test(tool)) continue;
      for (const hook of group.hooks ?? []) {
        const payload = { session_id: sessionId, transcript_path: null, cwd, hook_event_name: event, ...input };
        // Gemini CLI runs hooks with a sanitized environment.
        const env =
          dialect === "gemini"
            ? { PATH: process.env.PATH ?? "", GEMINI_SESSION_ID: sessionId, GEMINI_PROJECT_DIR: cwd }
            : process.env;
        const timeoutMs = dialect === "gemini" ? (hook.timeout ?? 60_000) : (hook.timeout ?? 600) * 1000;
        const result = spawnSync("/bin/sh", ["-c", hook.command], {
          input: JSON.stringify(payload),
          env,
          timeout: timeoutMs,
        });
        const out = `${result.stdout ?? ""}`.trim();
        let context = "";
        if (out) {
          try {
            context = JSON.parse(out).hookSpecificOutput?.additionalContext ?? "";
          } catch {
            context = `UNPARSEABLE ${out}`;
          }
        }
        say(
          `hook ${event}${tool ? `:${tool}` : ""} exit=${result.status}${context ? ` context=${JSON.stringify(context)}` : ""}`,
        );
      }
    }
  }

  const EVENTS =
    dialect === "codex"
      ? { start: "SessionStart", prompt: "UserPromptSubmit", after: "PostToolUse", stop: "Stop", end: "SessionEnd" }
      : { start: "SessionStart", prompt: "BeforeAgent", after: "AfterTool", stop: "AfterAgent", end: "SessionEnd" };

  function toolUse(tool_name, tool_input, tool_response) {
    runHooks(EVENTS.after, { tool_name, tool_input, tool_response }, tool_name);
  }

  const clients = new Map();
  async function mcpClient(name) {
    if (clients.has(name)) return clients.get(name);
    const spec = mcpServers[name];
    if (!spec) throw new Error(`no MCP server ${name}`);
    const client = new Client({ name: `fake-${dialect}`, version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...process.env, ...spec.env } }),
    );
    const { tools } = await client.listTools();
    say(`tools=${JSON.stringify(tools.map((t) => t.name))}`);
    clients.set(name, client);
    return client;
  }

  async function callTool(name, input) {
    try {
      const result = await (await mcpClient("switchboard")).callTool({ name, arguments: input });
      const text = result.content.map((c) => c.text).join("\n");
      say(`${name}${result.isError ? " ERROR" : ""}: ${JSON.stringify(text)}`);
      const toolName = dialect === "codex" ? `mcp__switchboard__${name}` : `mcp_switchboard_${name}`;
      toolUse(toolName, input, text);
    } catch (error) {
      say(`${name} FAILED: ${error.message}`);
    }
    say(`done ${name}`);
  }

  say(`args=${JSON.stringify(rest)}`);
  say(`agent=${process.env.SWITCHBOARD_AGENT_ID ?? ""}`);
  say(`session=${sessionId}`);
  say(`mcp=${JSON.stringify(Object.keys(mcpServers))}`);
  // Gemini CLI runs SessionStart at launch; Codex when the session starts, at the first prompt.
  const sessionStart = () => runHooks(EVENTS.start, { source: resumed ? "resume" : "startup" });
  if (dialect === "gemini") sessionStart();
  process.stdout.write("\x1b[?2004h");

  const lines = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  let doing = "nothing";
  const PASTE_START = "\x1b[200~";
  const PASTE_END = "\x1b[201~";
  let pasted = null;
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
      const text = pasted.join("\n");
      pasted = null;
      const prompt = text.slice(text.indexOf(PASTE_START) + PASTE_START.length, text.lastIndexOf(PASTE_END));
      say(`pasted prompt=${JSON.stringify(prompt)} during=${doing}`);
      queue = queue.then(() => {
        writeSessionFile();
        runHooks(EVENTS.prompt, { prompt });
      });
      return;
    }
    queue = queue.then(() => answer(line.trim()));
  });

  /** One model turn, the way the real CLI makes it. */
  async function modelTurn(prompt) {
    if (dialect === "codex") {
      const base = config.openai_base_url ?? "https://api.openai.com/v1";
      const headers = { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` };
      const create = { type: "response.create", model: "gpt-6-sol", input: [{ role: "user", content: prompt }] };
      try {
        const ws = await connect(`${base.replace(/^http/, "ws")}/responses`, headers);
        const done = new Promise((resolve) => {
          ws.onMessage = (text) => {
            if (JSON.parse(text).type === "response.completed") resolve();
          };
        });
        await ws.send(JSON.stringify(create));
        await done;
        const sha = createHash("sha256").update(ws.messages.join("\n")).digest("hex");
        say(`model base=${base} via=websocket events=${ws.messages.length} sha=${sha}`);
        ws.close();
        return;
      } catch (error) {
        say(`model websocket refused (${error.message}); falling back to HTTPS`);
      }
      const response = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ ...create, type: undefined, stream: true }),
      });
      const body = Buffer.from(await response.arrayBuffer());
      const sha = createHash("sha256").update(body).digest("hex");
      say(`model base=${base} via=https status=${response.status} sha=${sha}`);
      return;
    }
    // Gemini CLI: its auth type from its settings, else from the environment.
    const env = process.env;
    const auth =
      config.security?.auth?.selectedType ??
      (env.GOOGLE_GENAI_USE_GCA === "true"
        ? "oauth-personal"
        : env.GOOGLE_GEMINI_BASE_URL
          ? "gateway"
          : env.GEMINI_API_KEY
            ? "gemini-api-key"
            : undefined);
    const google = auth === "oauth-personal";
    const base = google
      ? (env.CODE_ASSIST_ENDPOINT ?? "https://cloudcode-pa.googleapis.com")
      : (env.GOOGLE_GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com");
    const path = google
      ? "/v1internal:streamGenerateContent?alt=sse"
      : "/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse";
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: google
        ? { authorization: "Bearer ya29.fake-oauth-token", "content-type": "application/json" }
        : { "x-goog-api-key": env.GEMINI_API_KEY ?? "", "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const sha = createHash("sha256").update(body).digest("hex");
    say(`model base=${base} auth=${auth} status=${response.status} sha=${sha}`);
  }

  async function answer(command) {
    if (command !== "work" && command !== "quit") writeSessionFile();
    const call = /^call (\w+) (.*)$/.exec(command);
    if (call) await callTool(call[1], JSON.parse(call[2]));
    if (command === "quit") {
      for (const client of clients.values()) await client.close();
      runHooks(EVENTS.end, { reason: dialect === "codex" ? "exit" : "exit" });
      say("bye");
      process.exit(0);
    }
    const model = /^model (.*)$/.exec(command);
    if (model) {
      try {
        await modelTurn(model[1]);
      } catch (error) {
        say(`model FAILED: ${error.message}`);
      }
    }
    const prompt = /^prompt (.*)$/.exec(command);
    if (prompt) {
      runHooks(EVENTS.prompt, { prompt: prompt[1] });
      say("prompted");
    }
    if (command === "work") say("working on it");
    const shell = /^shell (.+)$/.exec(command);
    if (shell && dialect === "codex") {
      // A shell tool call the way Codex makes one: PreToolUse, the command for real, PostToolUse.
      const script = shell[1].replaceAll("\\n", "\n");
      const tool_input = { command: ["bash", "-lc", script] };
      const tool_use_id = `call_${randomBytes(6).toString("hex")}`;
      runHooks("PreToolUse", { tool_name: "shell", tool_input, tool_use_id }, "shell");
      const result = spawnSync("/bin/sh", ["-c", script], { cwd });
      runHooks(
        EVENTS.after,
        { tool_name: "shell", tool_input, tool_use_id, tool_response: `Exit code: ${result.status}\nOutput:\n` },
        "shell",
      );
      say(`shell done exit=${result.status}`);
    }
    const busy = /^busy (\d+(?:\.\d+)?)$/.exec(command);
    if (busy) {
      doing = "busy";
      const until = Date.now() + Number(busy[1]) * 1000;
      while (Date.now() < until) {
        say("busy");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      doing = "nothing";
      say("busy done");
    }
    const permission = /^permission (\w+)$/.exec(command);
    if (permission) {
      if (dialect === "codex") runHooks("PermissionRequest", { tool_name: permission[1], tool_input: {} });
      else
        runHooks("Notification", {
          notification_type: "ToolPermission",
          message: "?",
          details: { tool_name: permission[1] },
        });
      say(`asking permission for ${permission[1]}`);
      doing = "dialog";
      const reply = await new Promise((resolve) => {
        dialogAnswer = resolve;
      });
      doing = "nothing";
      say(`permission answered ${JSON.stringify(reply.trim())}`);
    }
    if (command === "turn") {
      if (dialect === "codex") {
        toolUse("shell", { command: ["bash", "-lc", "npm test"] }, "Exit code: 0\nWall time: 1s\nOutput:\nok");
        toolUse(
          "apply_patch",
          {
            input:
              "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old line\n+new line\n+another\n*** Add File: src/new.ts\n+export const b = 2;\n*** End Patch",
          },
          "Success",
        );
      } else {
        toolUse("run_shell_command", { command: "npm test" }, { output: "ok" });
        toolUse(
          "replace",
          { file_path: join(cwd, "src/app.ts"), old_string: "old line", new_string: "new line\nanother" },
          {},
        );
        toolUse("write_file", { file_path: join(cwd, "src/new.ts"), content: "export const b = 2;\n" }, {});
      }
      runHooks(EVENTS.stop, { prompt: "turn", prompt_response: "done" });
      say("turn done");
    }
  }
}
