// Cursor CLI (`cursor-agent`). Everything is per session: a temporary project
// `.cursor/hooks.json` and `.cursor/mcp.json` hold the hooks and Switchboard MCP
// server; the Person's `~/.cursor` hooks and MCP files are never written. Backups
// of any existing project files are restored when the session ends.
//
// - Session: `create-chat` picks an ID for a new session (`--resume <id>` on the
//   command line); `--resume <uuid>` and `--continue` are read from the Person's args.
// - Hooks: Cursor's camelCase events, translated to Claude Code names for the capture.
// - Next turn: `sessionStart` answers with `additional_context`; later turns use
//   `read_channel` when `beforeSubmitPrompt` cannot carry context (see research note).
// - Interrupts: downgraded to Queue until typing mid-turn is verified on the real CLI.
// - MCP tools: merged into the session's `.cursor/mcp.json`; `--approve-mcps` on the CLI.
// - Proxy Capture: not yet (`CURSOR_API_ENDPOINT` exists; no digest reader).

import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HOOK_SOCKET_ENV } from "../hooks/capture";
import type { ClaudeHookInput } from "../hooks/summarize";
import type { CliAdapter, SessionPlan } from "./adapter";

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Flags that print something and exit without starting a session. */
const NO_SESSION_FLAGS = new Set(["-h", "--help", "-v", "--version", "--list-models"]);

/** Subcommands that are not an interactive agent session. */
const OTHER_SUBCOMMANDS = new Set([
  "persist",
  "install-shell-integration",
  "uninstall-shell-integration",
  "login",
  "logout",
  "mcp",
  "plugin",
  "worker",
  "status",
  "whoami",
  "models",
  "team",
  "bedrock",
  "about",
  "update",
  "create-chat",
  "generate-rule",
  "rule",
  "ls",
  "help",
]);

/** Cursor hook events Switchboard installs, mapped to Claude Code names the capture reads. */
export const CURSOR_HOOKS: Record<string, string> = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  beforeSubmitPrompt: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  beforeShellExecution: "PreToolUse",
  afterShellExecution: "PostToolUse",
  stop: "Stop",
};

const HOOK_TIMEOUT: Record<string, number> = { sessionEnd: 3, stop: 10 };

function cursorBin(env: NodeJS.ProcessEnv): string {
  return env.SWITCHBOARD_CURSOR_BIN || "cursor-agent";
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The first positional argument and its index. */
function firstPositional(args: string[]): { index: number; value: string } | null {
  const VALUE_OPTIONS = new Set([
    "--api-key",
    "-H",
    "--header",
    "-e",
    "--endpoint",
    "--output-format",
    "--mode",
    "--model",
    "--sandbox",
    "--workspace",
    "--add-dir",
    "--plugin-dir",
    "-w",
    "--worktree-base",
    "--resume",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") return null;
    if (VALUE_OPTIONS.has(arg) || (arg === "--resume" && args[i + 1] !== undefined && !args[i + 1]?.startsWith("-"))) {
      i++;
      continue;
    }
    if (arg.startsWith("--resume=")) continue;
    if (!arg.startsWith("-")) return { index: i, value: arg };
  }
  return null;
}

async function createChat(env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run(cursorBin(env), ["create-chat"], { env });
  const id = stdout.trim();
  if (!UUID.test(id)) throw new Error("cursor-agent create-chat did not return a session ID.");
  return id.toLowerCase();
}

function withResume(args: string[], sessionId: string): string[] {
  if (args.some((a) => a === "--continue" || a === "--resume" || a.startsWith("--resume="))) return args;
  return ["--resume", sessionId, ...args];
}

function ensureFlags(args: string[]): string[] {
  const out = [...args];
  if (!out.includes("--trust")) out.unshift("--trust");
  if (!out.includes("--approve-mcps")) out.unshift("--approve-mcps");
  return out;
}

/** Works out a Cursor session from the Person's arguments. */
export async function planCursorSession(args: string[], ctx: { env: NodeJS.ProcessEnv }): Promise<SessionPlan> {
  if (args.some((arg) => NO_SESSION_FLAGS.has(arg))) return { kind: "none", args };
  const sub = firstPositional(args);
  if (sub && OTHER_SUBCOMMANDS.has(sub.value)) return { kind: "none", args };
  const resumeAt = args.findIndex((a) => a === "--resume" || a.startsWith("--resume="));
  if (resumeAt !== -1) {
    const arg = args[resumeAt] ?? "";
    const value = arg.startsWith("--resume=") ? arg.slice("--resume=".length) : args[resumeAt + 1];
    if (value !== undefined && UUID.test(value)) {
      return { kind: "known", args, sessionId: value.toLowerCase(), resumed: true };
    }
    return { kind: "discover", args, resumed: true };
  }
  if (args.includes("--continue")) return { kind: "discover", args, resumed: true };
  const sessionId = await createChat(ctx.env);
  return {
    kind: "known",
    args: ensureFlags(withResume(args, sessionId)),
    sessionId,
    resumed: false,
    picked: true,
  };
}

/** Cursor hook input, in Claude Code's shape. */
export function translateCursorHook(raw: Record<string, unknown>): ClaudeHookInput {
  const input = { ...raw } as ClaudeHookInput & Record<string, unknown>;
  const event = typeof raw.hook_event_name === "string" ? raw.hook_event_name : undefined;
  if (event !== undefined) input.hook_event_name = CURSOR_HOOKS[event] ?? event;
  const sessionId = str(raw.session_id) ?? str(raw.conversation_id);
  if (sessionId) input.session_id = sessionId;
  if (typeof raw.transcript_path === "string") input.transcript_path = raw.transcript_path;
  const tool = str(raw.tool_name);
  const toolInput = obj(raw.tool_input);
  if (tool === "Shell" || event === "beforeShellExecution" || event === "afterShellExecution") {
    input.tool_name = "Bash";
    const command = str(toolInput.command) ?? str(raw.command);
    if (command) input.tool_input = { ...toolInput, command };
  } else if (tool?.startsWith("mcp_")) {
    input.tool_name = tool;
  }
  if (typeof raw.tool_output === "string") {
    try {
      const out = JSON.parse(raw.tool_output) as Record<string, unknown>;
      const code = out.exitCode ?? out.exit_code;
      if (code !== undefined) input.tool_response = { exit_code: Number(code) };
    } catch {
      /* not JSON */
    }
  }
  return input;
}

/** Cursor `sessionStart` injects `additional_context`; other context hooks have no documented field. */
export function cursorHookAnswer(hook: string | undefined, text: string): string {
  if (text === "" || hook !== "SessionStart") return "";
  return `${JSON.stringify({ additional_context: text.trimEnd() })}\n`;
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    return obj(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

/** `~/.cursor/projects`, where agent transcripts are stored. */
export function cursorProjects(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CURSOR_CONFIG_DIR || join(homedir(), ".cursor");
  return join(base, "projects");
}

export const cursor: CliAdapter = {
  cli: "cursor",
  label: "Cursor",
  command: "cursor-agent",
  binEnv: "SWITCHBOARD_CURSOR_BIN",
  interrupts: false,
  idleClears: false,
  wakes: false,
  remoteDeny: false,
  memoryNudges: [],
  proxy: false,
  sessionFromHooks: true,

  plan: (args, ctx) => planCursorSession(args, ctx),

  translateHook: translateCursorHook,
  hookAnswer: cursorHookAnswer,

  untrustedHooksHint:
    "Cursor did not run project hooks. Pass --trust (Switchboard adds it by default) and open the workspace as trusted so .cursor/hooks.json runs.",

  async install({ args, cwd, hooks, tools }) {
    const cursorDir = join(cwd, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const hooksPath = join(cursorDir, "hooks.json");
    const mcpPath = join(cursorDir, "mcp.json");
    const backupHooks = await readJsonFile(hooksPath);
    const backupMcp = await readJsonFile(mcpPath);
    const socket = hooks.socketPath;
    const cmd = hooks.command(true);
    const entry = (name: string) => [
      {
        command: cmd,
        type: "command",
        timeout: HOOK_TIMEOUT[name] ?? 10,
        ...(name === "postToolUse" || name === "afterShellExecution" ? { matcher: "*" } : {}),
        ...(name === "beforeShellExecution" ? { matcher: ".*" } : {}),
      },
    ];
    const existing = obj(backupHooks?.hooks);
    const mergedHooks: Record<string, unknown> = {
      version: backupHooks?.version ?? 1,
      hooks: {
        ...existing,
        ...Object.fromEntries(
          Object.keys(CURSOR_HOOKS).map((name) => {
            const prior = Array.isArray(existing[name]) ? (existing[name] as unknown[]) : [];
            return [name, [...prior, ...entry(name)]];
          }),
        ),
      },
    };
    const ownMcp = obj(backupMcp?.mcpServers);
    const mergedMcp = {
      ...backupMcp,
      mcpServers: {
        ...ownMcp,
        [tools.server.name]: {
          command: tools.server.command,
          args: tools.server.args,
          env: tools.server.env,
        },
      },
    };
    await writeFile(hooksPath, `${JSON.stringify(mergedHooks, null, 2)}\n`, { mode: 0o600 });
    await writeFile(mcpPath, `${JSON.stringify(mergedMcp, null, 2)}\n`, { mode: 0o600 });
    const restore = async () => {
      if (backupHooks === null) await unlink(hooksPath).catch(() => {});
      else await writeFile(hooksPath, `${JSON.stringify(backupHooks, null, 2)}\n`, { mode: 0o600 });
      if (backupMcp === null) await unlink(mcpPath).catch(() => {});
      else await writeFile(mcpPath, `${JSON.stringify(backupMcp, null, 2)}\n`, { mode: 0o600 });
    };
    return {
      args: ensureFlags(args),
      env: { [HOOK_SOCKET_ENV]: socket },
      dispose: restore,
    };
  },
};
