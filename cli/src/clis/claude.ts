// Claude Code. Everything is per session: hooks and the proxy's base URL go in a
// settings file of the session's own (`--settings`), the MCP tools in an MCP
// config of its own (`--mcp-config`). The Person's ~/.claude is never touched.
//
// - Session: the wrapper picks the ID (`--session-id`) or reads it from `--resume`;
//   `--continue` and the picker are worked out in claude-session.ts.
// - Hooks: every hook Switchboard uses, as Claude Code names them.
// - Next turn: SessionStart and UserPromptSubmit hooks add to the model's context.
// - Interrupts: Claude Code takes typed input mid-turn.
// - Proxy Capture: ANTHROPIC_BASE_URL.

import { claudeConfigDir, planSession, projectDir, waitForPickedSession } from "../claude-session";
import { withMcpConfig, writeClaudeMcpConfig } from "../mcp-config";
import { anthropicMessages } from "../proxy/anthropic";
import { originalBaseUrl } from "../proxy/options";
import { applySessionSettings } from "../session-settings";
import type { CliAdapter } from "./adapter";

export const claude: CliAdapter = {
  cli: "claude-code",
  label: "Claude Code",
  command: "claude",
  binEnv: "SWITCHBOARD_CLAUDE_BIN",
  interrupts: true,
  idleClears: true,
  wakes: true,
  proxy: true,
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

  async install({ args, dir, cwd, hooks, tools, proxyUrl }) {
    // Claude Code settings can set ANTHROPIC_BASE_URL too, and they win over the
    // environment, so the session's own settings point it at the proxy as well.
    const proxySettings = proxyUrl ? [{ env: { ANTHROPIC_BASE_URL: proxyUrl } }] : [];
    const withSettings = await applySessionSettings(args, dir, cwd, [hooks.settings(), ...proxySettings]);
    // Claude Code settings cannot hold MCP servers, so they go in --mcp-config.
    return {
      args: withMcpConfig(withSettings, writeClaudeMcpConfig(tools)),
      env: proxyUrl ? { ANTHROPIC_BASE_URL: proxyUrl } : ({} as Record<string, string>),
    };
  },
};
