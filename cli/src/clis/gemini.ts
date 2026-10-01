// Gemini CLI. Gemini CLI was not installed where this was written, so this follows
// its documentation and is tested against a fake only; see the README's support
// table for what is unverified.
//
// Everything is per session: a system settings file of the session's own, named
// by GEMINI_CLI_SYSTEM_SETTINGS_PATH, holds the hooks and the MCP server. Gemini
// CLI merges it over the Person's own settings, which are never touched. If the
// Person already points GEMINI_CLI_SYSTEM_SETTINGS_PATH (or has
// /etc/gemini-cli/settings.json), those settings are copied in first.
//
// - Session: Gemini CLI picks the session ID; it is learnt from the first hook
//   (every hook's input carries `session_id`). `--resume <uuid>` names it up front.
// - Hooks: SessionStart, BeforeAgent (a prompt is submitted), AfterTool,
//   AfterAgent (the turn ends), Notification, SessionEnd. Gemini CLI runs hooks
//   with a sanitized environment, so the socket path is in the hook's command.
//   Only project hooks need the Person's trust; these are system-level.
// - Next turn: SessionStart and BeforeAgent answer with
//   `hookSpecificOutput.additionalContext`.
// - Interrupts: not typed; they are delivered as Queue, labelled downgraded,
//   until typing mid-turn into Gemini CLI is seen to work.
// - MCP tools: `mcpServers` in the session's settings.
// - Proxy Capture: CODE_ASSIST_ENDPOINT (Login with Google) or GOOGLE_GEMINI_BASE_URL
//   (an API key), by auth type (gemini-route.ts); the proxy reads the generateContent
//   format (proxy/gemini.ts). Vertex AI is not read.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeHookInput } from "../hooks/summarize";
import type { CliAdapter, SessionPlan } from "./adapter";
import { geminiAuth, geminiProxyRoute, readJson } from "./gemini-route";
import { GEMINI_TOOLS as TOOLS } from "./gemini-tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Flags that print something and exit without starting a session. */
const NO_SESSION_FLAGS = new Set(["-h", "--help", "-v", "--version", "--list-sessions", "--list-extensions"]);

/** The environment variable that points Gemini CLI at a system settings file. */
export const GEMINI_SYSTEM_SETTINGS_ENV = "GEMINI_CLI_SYSTEM_SETTINGS_PATH";
const DEFAULT_SYSTEM_SETTINGS = "/etc/gemini-cli/settings.json";

/** Gemini CLI's hook names, and the Claude Code names the wrapper reads them as. */
export const GEMINI_HOOKS: Record<string, string> = {
  SessionStart: "SessionStart",
  BeforeAgent: "UserPromptSubmit",
  AfterTool: "PostToolUse",
  AfterAgent: "Stop",
  Notification: "Notification",
  SessionEnd: "SessionEnd",
};

/** Works out a Gemini CLI session from the Person's arguments. */
export function planGeminiSession(args: string[]): SessionPlan {
  if (args.some((arg) => NO_SESSION_FLAGS.has(arg))) return { kind: "none", args };
  const at = args.findIndex((arg) => arg === "--resume" || arg === "-r" || arg.startsWith("--resume="));
  if (at === -1) return { kind: "discover", args, resumed: false };
  const arg = args[at] ?? "";
  const value = arg.startsWith("--resume=") ? arg.slice("--resume=".length) : args[at + 1];
  if (value !== undefined && UUID.test(value)) {
    return { kind: "known", args, sessionId: value.toLowerCase(), resumed: true };
  }
  // `latest` or an index: known from the first hook.
  return { kind: "discover", args, resumed: true };
}

/** Gemini CLI's hook input, in Claude Code's shape. */
export function translateGeminiHook(raw: Record<string, unknown>): ClaudeHookInput {
  const input = { ...raw } as ClaudeHookInput & Record<string, unknown>;
  const event = typeof raw.hook_event_name === "string" ? raw.hook_event_name : undefined;
  if (event !== undefined) input.hook_event_name = GEMINI_HOOKS[event] ?? event;
  const tool = typeof raw.tool_name === "string" ? TOOLS[raw.tool_name] : undefined;
  if (tool) {
    input.tool_name = tool.name;
    const toolInput = { ...((raw.tool_input ?? {}) as Record<string, unknown>) };
    for (const [from, to] of Object.entries(tool.fields ?? {})) {
      if (toolInput[to] === undefined && toolInput[from] !== undefined) toolInput[to] = toolInput[from];
    }
    input.tool_input = toolInput;
  } else if (typeof raw.tool_name === "string" && raw.tool_name.startsWith("mcp_")) {
    input.tool_name = raw.tool_name;
  }
  // A Notification asking for a tool's permission is a dialog, as Claude Code's PermissionRequest.
  if (event === "Notification" && raw.notification_type === "ToolPermission") {
    input.hook_event_name = "PermissionRequest";
    const details = (raw.details ?? {}) as Record<string, unknown>;
    if (typeof details.tool_name === "string") input.tool_name = details.tool_name;
  }
  return input;
}

/** Gemini CLI adds a SessionStart or BeforeAgent hook's `additionalContext` to the model's context. */
export function geminiHookAnswer(hook: string | undefined, text: string): string {
  if (text === "" || (hook !== "SessionStart" && hook !== "UserPromptSubmit")) return "";
  const hookEventName = hook === "SessionStart" ? "SessionStart" : "BeforeAgent";
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text.trimEnd() } })}\n`;
}

/** The Person's own system settings, which the session's settings start from. */
function systemSettings(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  return readJson(env[GEMINI_SYSTEM_SETTINGS_ENV] || DEFAULT_SYSTEM_SETTINGS);
}

export const gemini: CliAdapter = {
  cli: "gemini",
  label: "Gemini CLI",
  command: "gemini",
  binEnv: "SWITCHBOARD_GEMINI_BIN",
  interrupts: false,
  idleClears: false,
  proxy: true,
  sessionFromHooks: true,

  plan: async (args) => planGeminiSession(args),

  proxyRoute: async (ctx) => geminiProxyRoute(await geminiAuth(ctx, await systemSettings(ctx.env)), ctx.env),

  translateHook: translateGeminiHook,
  hookAnswer: geminiHookAnswer,

  async install({ args, dir, cwd, env, hooks, tools, proxyUrl, proxyRoute }) {
    const own = await systemSettings(env);
    const ownHooks = (own.hooks ?? {}) as Record<string, unknown[]>;
    const hook = { name: "switchboard", type: "command", command: hooks.command(), timeout: 10_000 };
    const settings: Record<string, unknown> = {
      ...own,
      // Hooks are on by default in current Gemini CLI; older ones read this switch (unverified).
      hooksConfig: { ...((own.hooksConfig ?? {}) as Record<string, unknown>), enabled: true },
      hooks: {
        ...ownHooks,
        ...Object.fromEntries(
          Object.keys(GEMINI_HOOKS).map((name) => [
            name,
            [...(ownHooks[name] ?? []), { ...(name === "AfterTool" ? { matcher: "*" } : {}), hooks: [hook] }],
          ]),
        ),
      },
      mcpServers: {
        ...((own.mcpServers ?? {}) as Record<string, unknown>),
        [tools.server.name]: { command: tools.server.command, args: tools.server.args, env: tools.server.env },
      },
    };
    const proxyEnv: Record<string, string> = {};
    if (proxyUrl && proxyRoute?.setting) {
      proxyEnv[proxyRoute.setting] = proxyUrl;
      // Pointing GOOGLE_GEMINI_BASE_URL at the proxy would turn an auth type read from
      // the environment into "gateway"; name the one Gemini CLI would have picked.
      const auth = await geminiAuth({ cwd, env }, own);
      if (!auth.fromSettings && auth.type) {
        const security = (own.security ?? {}) as Record<string, unknown>;
        const authSettings = (security.auth ?? {}) as Record<string, unknown>;
        settings.security = { ...security, auth: { ...authSettings, selectedType: auth.type } };
      }
    }
    const path = join(dir, "gemini-settings.json");
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    return { args, env: { [GEMINI_SYSTEM_SETTINGS_ENV]: path, ...proxyEnv } };
  },
};
