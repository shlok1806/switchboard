// Codex. Everything is per session, passed as `-c key=value` overrides on the
// command line; the Person's ~/.codex (config.toml, hooks.json) is never written.
//
// - Session: Codex picks the thread ID itself (a UUIDv7), so a new session's ID is
//   learnt after launch: from its first hook, or else from the session file Codex
//   writes under $CODEX_HOME/sessions at the session's first prompt (so without
//   hooks, a new Codex Agent registers when its Person first submits a prompt). `codex resume <id>` names it up front.
//   The Agent ID takes the ID's last 4 characters (its first ones are the clock).
// - Hooks: `-c hooks.<Event>=[...]` overrides. Codex may run hooks only once the
//   Person has trusted them in its `/hooks` screen (codex-cli 0.159.1 ran these
//   without asking). Trust is kept by the hook's command, so the command is the
//   same in every session: the hook finds the wrapper's socket in the environment,
//   not in its command. If no SessionStart arrives after the first prompt, the
//   wrapper says how to trust them, and leaves next-turn notices for `read_channel`.
// - Next turn: SessionStart and UserPromptSubmit hooks answer with
//   `hookSpecificOutput.additionalContext`.
// - Interrupts: Codex's prompt takes typed input mid-turn and adds it to the turn
//   (seen with codex-cli 0.159.1). Its approval dialogs are told by PermissionRequest.
// - MCP tools: `-c mcp_servers.switchboard...`, approved for the session (Codex
//   otherwise asks before each call, and refuses them all under `-a never`).
// - Proxy Capture: `-c openai_base_url=<proxy>`, which the built-in openai provider
//   uses whether logged in with ChatGPT or an API key (codex-route.ts works out the
//   real upstream). Codex runs turns over a WebSocket at `/responses` and falls back
//   to `POST /responses` (SSE); the proxy tunnels both unchanged and reads the
//   Responses API format (proxy/openai-responses.ts). Other model providers are not read.
// - Codex's sandbox confines the commands the model runs, not hooks or MCP servers,
//   which Codex runs itself. A hook that cannot reach the socket exits 0 quietly.

import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOOK_SOCKET_ENV } from "../hooks/capture";
import type { ClaudeHookInput } from "../hooks/summarize";
import type { CliAdapter, SessionPlan } from "./adapter";
import { CODEX_BASE_URL_KEY, codexProxyRoute, withoutBaseUrlOverride } from "./codex-route";
import { patchFiles, SHELL_TOOLS, shellCommand } from "./codex-tools";

export { patchFiles };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Flags that print something and exit without starting a session. */
const NO_SESSION_FLAGS = new Set(["-h", "--help", "-V", "--version"]);

/** Codex's options that take a value, so the value is not taken for a subcommand or prompt. */
const VALUE_OPTIONS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "-a",
  "--ask-for-approval",
]);

/** Codex's subcommands that are not an interactive session (`resume` and `fork` are); they run as is. */
const OTHER_SUBCOMMANDS = new Set([
  "agents",
  "exec",
  "e",
  "review",
  "login",
  "logout",
  "mcp",
  "plugin",
  "app-server",
  "remote-control",
  "app",
  "completion",
  "update",
  "doctor",
  "sandbox",
  "debug",
  "apply",
  "a",
  "queue",
  "archive",
  "delete",
  "migrate-rollouts",
  "unarchive",
  "cloud",
  "exec-server",
  "features",
  "help",
]);

/** The hooks Switchboard installs in Codex, all named as Claude Code names them. */
export const CODEX_HOOKS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "SessionEnd",
] as const;

/** The first positional argument (a subcommand or the prompt) and where it is. */
function firstPositional(args: string[]): { index: number; value: string } | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") return null;
    if (VALUE_OPTIONS.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith("-")) return { index: i, value: arg };
  }
  return null;
}

/** Works out a Codex session from the Person's arguments. */
export function planCodexSession(args: string[]): SessionPlan {
  if (args.some((arg) => NO_SESSION_FLAGS.has(arg))) return { kind: "none", args };
  const sub = firstPositional(args);
  if (sub && OTHER_SUBCOMMANDS.has(sub.value)) return { kind: "none", args };
  if (sub?.value === "resume") {
    const rest = args.slice(sub.index + 1);
    const target = firstPositional(rest)?.value;
    if (target !== undefined && UUID.test(target) && !rest.includes("--last")) {
      return { kind: "known", args, sessionId: target.toLowerCase(), resumed: true };
    }
    // `--last`, the picker or a session name: known once Codex has picked it.
    return { kind: "discover", args, resumed: true };
  }
  // `fork` starts a new session from an old one; anything else is a new session.
  return { kind: "discover", args, resumed: false };
}

/** A TOML string. JSON's escapes are TOML's basic-string escapes. */
function tomlString(text: string): string {
  return JSON.stringify(text);
}

function tomlInlineTable(entries: Record<string, string>): string {
  return `{${Object.entries(entries)
    .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
    .join(",")}}`;
}

/** The `-c` overrides that install Switchboard's hooks for one session. */
export function codexHookOverrides(command: string): string[] {
  return CODEX_HOOKS.flatMap((name) => {
    // Codex holds SessionEnd hooks to at most 3 seconds.
    const timeout = name === "SessionEnd" ? 3 : 10;
    return ["-c", `hooks.${name}=[{hooks=[{type="command",command=${tomlString(command)},timeout=${timeout}}]}]`];
  });
}

/** The `-c` overrides that give one session Switchboard's MCP server. */
export function codexMcpOverrides(server: {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}): string[] {
  const key = `mcp_servers.${server.name}`;
  return [
    "-c",
    `${key}.command=${tomlString(server.command)}`,
    "-c",
    `${key}.args=[${server.args.map(tomlString).join(",")}]`,
    "-c",
    `${key}.env=${tomlInlineTable(server.env)}`,
    // Codex asks before every MCP tool call, and refuses them under `-a never`.
    // Switchboard's own tools only talk to the Channel, so they are approved.
    "-c",
    `${key}.default_tools_approval_mode="approve"`,
  ];
}

const SNAKE_EVENTS: Record<string, string> = Object.fromEntries(
  [...CODEX_HOOKS, "PreCompact", "PostCompact", "SubagentStart", "SubagentStop"].map((name) => [
    name.replace(/[A-Z]/g, (c, i) => (i === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`)),
    name,
  ]),
);

/** Codex's hook input, in Claude Code's shape. An apply_patch stands for one edit per file. */
export function translateCodexHook(raw: Record<string, unknown>): ClaudeHookInput | ClaudeHookInput[] {
  const patch = patchOf(raw);
  if (patch !== undefined) {
    const base = translateOne({ ...raw, tool_name: "apply_patch" });
    const files = patchFiles(patch);
    if (files.length > 0) {
      return files.map((file) => ({
        ...base,
        tool_name: file.kind === "Add" ? "Write" : "Edit",
        tool_input: {
          file_path: file.path,
          ...(file.kind === "Add"
            ? { content: file.added.map((l) => `${l}\n`).join("") }
            : { old_string: file.removed.join("\n"), new_string: file.added.join("\n") }),
        },
        tool_response: {},
      }));
    }
  }
  return translateOne(raw);
}

/** The patch text of an apply_patch call, if this hook is one. */
function patchOf(raw: Record<string, unknown>): string | undefined {
  if (raw.tool_name !== "apply_patch") return undefined;
  const input = raw.tool_input;
  if (typeof input === "string") return input;
  const fields = (input ?? {}) as Record<string, unknown>;
  for (const key of ["input", "patch", "command"]) {
    const value = fields[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function translateOne(raw: Record<string, unknown>): ClaudeHookInput {
  const input = { ...raw } as ClaudeHookInput & Record<string, unknown>;
  const event = typeof raw.hook_event_name === "string" ? raw.hook_event_name : undefined;
  if (event !== undefined) input.hook_event_name = SNAKE_EVENTS[event] ?? event;
  const tool = typeof raw.tool_name === "string" ? raw.tool_name : undefined;
  const toolInput = (raw.tool_input ?? {}) as Record<string, unknown>;
  if (tool !== undefined && SHELL_TOOLS.has(tool)) {
    input.tool_name = "Bash";
    const command = shellCommand(toolInput);
    input.tool_input = command === undefined ? toolInput : { ...toolInput, command };
  }
  // Codex asks the Person a question with request_user_input: a dialog, like AskUserQuestion.
  if (tool === "request_user_input") input.tool_name = "AskUserQuestion";
  // Codex reports a command's output as text that starts with its exit code.
  if (typeof raw.tool_response === "string") {
    const code = /^Exit code: (-?\d+)/m.exec(raw.tool_response)?.[1];
    input.tool_response = code === undefined ? {} : { exit_code: Number(code) };
  }
  return input;
}

/** Codex adds a SessionStart or UserPromptSubmit hook's `additionalContext` to the model's context. */
export function codexHookAnswer(hook: string | undefined, text: string): string {
  if (text === "" || (hook !== "SessionStart" && hook !== "UserPromptSubmit")) return "";
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: hook, additionalContext: text.trimEnd() } })}\n`;
}

/** Codex's home: `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

function dayDir(sessions: string, at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return join(sessions, String(at.getFullYear()), two(at.getMonth() + 1), two(at.getDate()));
}

/** The `cwd` in a session file's first line (its session_meta). */
async function sessionCwd(path: string): Promise<string | undefined> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const match = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buffer.subarray(0, bytesRead).toString("utf8"));
    return match?.[1] === undefined ? undefined : (JSON.parse(match[1]) as string);
  } finally {
    await file.close();
  }
}

/**
 * The session Codex started or resumed in `cwd` since `since`: the session file
 * (`rollout-<time>-<id>.jsonl`) written since then for that directory. For a new
 * session, one created since then. Null when there is none yet.
 */
export async function findCodexSession(
  home: string,
  cwd: string,
  since: number,
  resumed: boolean,
): Promise<string | null> {
  const sessions = join(home, "sessions");
  const days = [new Date(since - 24 * 3600_000), new Date(since), new Date()].map((d) => dayDir(sessions, d));
  let best: { id: string; mtimeMs: number } | null = null;
  for (const dir of [...new Set(days)]) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const id = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)?.[1];
      if (!id) continue;
      const path = join(dir, name);
      const info = await stat(path);
      if (info.mtimeMs < since) continue;
      if (!resumed && info.birthtimeMs > 0 && info.birthtimeMs < since - 1000) continue;
      if ((await sessionCwd(path).catch(() => undefined)) !== cwd) continue;
      if (!best || info.mtimeMs < best.mtimeMs) best = { id: id.toLowerCase(), mtimeMs: info.mtimeMs };
    }
  }
  return best?.id ?? null;
}

export const codex: CliAdapter = {
  cli: "codex",
  label: "Codex",
  command: "codex",
  binEnv: "SWITCHBOARD_CODEX_BIN",
  interrupts: true,
  // Not known to clear its composer on double Escape or Ctrl+C, so neither reads as clearing.
  idleClears: false,
  proxy: true,
  sessionFromHooks: true,

  plan: async (args) => planCodexSession(args),

  proxyRoute: ({ env }, args) => codexProxyRoute(codexHome(env), args),

  async discover({ cwd, env }, since, signal, resumed) {
    while (!signal.aborted) {
      const id = await findCodexSession(codexHome(env), cwd, since, resumed).catch(() => null);
      if (id) return id;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  },

  translateHook: translateCodexHook,
  hookAnswer: codexHookAnswer,

  async install({ args, hooks, tools, proxyUrl }) {
    // The proxy stands in for the session's base URL; a Person's own one is its upstream.
    const proxy = proxyUrl ? ["-c", `${CODEX_BASE_URL_KEY}=${tomlString(proxyUrl)}`] : [];
    return {
      // Codex takes `-c` before its subcommand.
      args: [
        ...codexHookOverrides(hooks.command(true)),
        ...codexMcpOverrides(tools.server),
        ...proxy,
        ...(proxyUrl ? withoutBaseUrlOverride(args) : args),
      ],
      env: { [HOOK_SOCKET_ENV]: hooks.socketPath },
    };
  },

  untrustedHooksHint:
    "Codex has not run Switchboard's hooks yet. Open /hooks in Codex and trust the switchboard hooks " +
    "(once; they stay trusted). Until then, Queued Events reach this Agent through the read_channel tool.",
};
