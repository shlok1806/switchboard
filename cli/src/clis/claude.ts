// Claude Code. Everything is per session: hooks and the proxy's base URL go in a
// settings file of the session's own (`--settings`), the MCP tools in an MCP
// config of its own (`--mcp-config`). The Person's ~/.claude is never touched.
//
// - Session: the wrapper picks the ID (`--session-id`) or reads it from `--resume`;
//   `--continue` and the picker are worked out in claude-session.ts.
// - Hooks: every hook Switchboard uses, as Claude Code names them.
// - Next turn: SessionStart and UserPromptSubmit hooks add to the model's context.
// - Interrupts: Claude Code takes typed input mid-turn.
// - Proxy Capture: ANTHROPIC_BASE_URL, and ENABLE_TOOL_SEARCH so the proxy does not
//   turn tool search off (see toolSearchSetting).

import { claudeConfigDir, planSession, projectDir, waitForPickedSession } from "../claude-session";
import { withMcpConfig, writeClaudeMcpConfig } from "../mcp-config";
import { anthropicMessages } from "../proxy/anthropic";
import { claudeEnvSetting, originalBaseUrl } from "../proxy/options";
import { applySessionSettings } from "../session-settings";
import type { CliAdapter, ProxyRoute } from "./adapter";

export const claude: CliAdapter = {
  cli: "claude-code",
  label: "Claude Code",
  command: "claude",
  binEnv: "SWITCHBOARD_CLAUDE_BIN",
  interrupts: true,
  idleClears: true,
  wakes: true,
  remoteDeny: true,
  memoryNudges: ["stop", "compaction"],
  proxy: true,
  // Claude Code 2.1.300 sets these in its tools' environment. Inherited, they make the
  // new session a child of that one: CLAUDE_CODE_CHILD_SESSION turns its transcript
  // off, so it could not be resumed and its context could not be read.
  parentEnv: [
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
  ],
  // Claude Code's picker: its first hooks may run before the Person picks a session.
  sessionFromHooks: false,

  proxyRoute: async ({ env }) => ({
    api: anthropicMessages,
    upstream: (await originalBaseUrl(env, claudeConfigDir(env))) ?? anthropicMessages.defaultUpstream,
  }),

  async plan(args, { cwd, env }) {
    const plan = await planSession(args, { cwd, claudeConfigDir: claudeConfigDir(env) });
    // Claude Code's picker: the Person picks a session to resume.
    return plan.kind === "picker" ? { kind: "discover", args: plan.args, resumed: true } : plan;
  },

  discover: ({ cwd, env }, since, signal) => waitForPickedSession(projectDir(claudeConfigDir(env), cwd), since, signal),

  async install({ args, dir, cwd, env, hooks, tools, proxyUrl, proxyRoute }) {
    // Claude Code settings can set ANTHROPIC_BASE_URL too, and they win over the
    // environment, so the session's own settings point it at the proxy as well.
    const proxyEnv: Record<string, string> = proxyUrl
      ? { ANTHROPIC_BASE_URL: proxyUrl, ...(await toolSearchSetting(env, proxyRoute)) }
      : {};
    const proxySettings = proxyUrl ? [{ env: proxyEnv }] : [];
    const withSettings = await applySessionSettings(args, dir, cwd, [hooks.settings(), ...proxySettings]);
    // Claude Code settings cannot hold MCP servers, so they go in --mcp-config.
    return { args: withMcpConfig(withSettings, writeClaudeMcpConfig(tools)), env: proxyEnv };
  },
};

/**
 * Claude Code turns tool search off when ANTHROPIC_BASE_URL is not the Anthropic API,
 * since a gateway may drop its `tool_reference` blocks, and then sends every MCP tool's
 * schema in full on each request. The proxy is such a base URL, though it forwards
 * every byte unchanged. So when the session would have gone to the Anthropic API
 * without Switchboard, ENABLE_TOOL_SEARCH turns it back on. A Person's own
 * ENABLE_TOOL_SEARCH, or their own gateway, is left as it was.
 */
async function toolSearchSetting(env: NodeJS.ProcessEnv, route?: ProxyRoute): Promise<Record<string, string>> {
  if (route?.upstream !== anthropicMessages.defaultUpstream) return {};
  if ((await claudeEnvSetting(env, claudeConfigDir(env), "ENABLE_TOOL_SEARCH")) !== undefined) return {};
  return { ENABLE_TOOL_SEARCH: "true" };
}
