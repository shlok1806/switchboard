// Gives one wrapped Claude Code session Switchboard's MCP tools, for that session
// only: a private temp directory holds an MCP config naming `switchboard mcp` and a
// file with the session's Agent ID, and Claude Code gets `--mcp-config <file>`.
// Nothing global (~/.claude.json, the repo's .mcp.json) is ever touched, and the
// directory is removed when the session ends.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../../shared/src/index";
import { configDir } from "./config";
import { AGENT_FILE_ENV, MCP_SERVER_NAME } from "./mcp-server";

export interface SessionTools {
  /** Arguments for Claude Code, with `--mcp-config` added. */
  args(claudeArgs: string[]): string[];
  /** Names the session's Agent, once known. The tools refuse until then. */
  setAgent(id: AgentId): void;
  /** Removes the session's files. */
  dispose(): void;
}

/**
 * `--mcp-config` takes several values, so it goes just before another flag (or at
 * the end) to never swallow a positional argument such as a prompt.
 */
export function withMcpConfig(args: string[], path: string): string[] {
  const at = args.findIndex((arg) => arg.startsWith("-"));
  const flag = ["--mcp-config", path];
  return at === -1 ? [...args, ...flag] : [...args.slice(0, at), ...flag, ...args.slice(at)];
}

/**
 * Writes the session's MCP config. The server is this same `switchboard` program
 * run as `switchboard mcp`, with the same config directory, so it reads the stored
 * Channel URL and join secret itself; the config file holds no secret.
 */
export function prepareSessionTools(env: NodeJS.ProcessEnv = process.env): SessionTools {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-session-"));
  const agentFile = join(dir, "agent");
  const configFile = join(dir, "mcp.json");
  const script = process.argv[1];
  if (!script) throw new Error("Cannot tell where the switchboard program is.");
  const mcp = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: process.execPath,
        args: [script, "mcp"],
        env: { [AGENT_FILE_ENV]: agentFile, SWITCHBOARD_CONFIG_DIR: configDir(env) },
      },
    },
  };
  writeFileSync(configFile, `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600 });
  return {
    args: (claudeArgs) => withMcpConfig(claudeArgs, configFile),
    setAgent: (id) => writeFileSync(agentFile, `${id}\n`, { mode: 0o600 }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
