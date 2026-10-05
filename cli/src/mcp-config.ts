// Gives one wrapped session Switchboard's MCP tools, for that session only. A
// private temp directory holds a file with the session's Agent ID and, when the
// CLI's hooks cannot hand it over, what the Agent must be told at its next turn.
// Each CLI adapter passes the server to its CLI its own way (Claude Code:
// `--mcp-config <file>`; Codex: `-c mcp_servers...`; Gemini CLI: its session
// settings). Nothing global (~/.claude.json, ~/.codex, ~/.gemini, the repo's own
// config) is ever touched, and the directory is removed when the session ends.

import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../../shared/src/index";
import { REPO_ENV } from "./channel-choice";
import { configDir } from "./config";
import { AGENT_FILE_ENV, MCP_SERVER_NAME, NEXT_TURN_FILE_ENV, REPO_DIR_ENV } from "./mcp-server";

/** A stdio MCP server, the way every agent CLI describes one. */
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface SessionTools {
  /** The `switchboard mcp` server for this session. */
  server: McpServerSpec;
  /** The session's private directory, for files an adapter writes. */
  dir: string;
  /** Names the session's Agent and hands over its token, once known. The tools refuse until then. */
  setAgent(id: AgentId, token: string): void;
  /** Leaves `text` for the `read_channel` tool to hand over at the Agent's next call. */
  leaveForNextTurn(text: string): void;
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

/** Claude Code's MCP config file for the server, written in `dir`. Returns its path. */
export function writeClaudeMcpConfig(tools: SessionTools): string {
  const { name, command, args, env } = tools.server;
  const path = join(tools.dir, "mcp.json");
  const config = { mcpServers: { [name]: { type: "stdio", command, args, env } } };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * Prepares the session's MCP server. It is this same `switchboard` program run as
 * `switchboard mcp`, with the same config directory, so it reads the Worker's URL
 * itself, and with the repo of the Channel the wrapper chose (ADR 0008), so the
 * tools are on the same Channel as the rest of the session. It acts only with the Agent's token (ADR 0007), which the
 * wrapper writes to the session's private directory with the Agent ID; nothing
 * given to the agent CLI on its command line holds a credential.
 */
export function prepareSessionTools(cwd: string, repo: string, env: NodeJS.ProcessEnv = process.env): SessionTools {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-session-"));
  const agentFile = join(dir, "agent");
  const nextTurnFile = join(dir, "next-turn");
  const script = process.argv[1];
  if (!script) throw new Error("Cannot tell where the switchboard program is.");
  return {
    server: {
      name: MCP_SERVER_NAME,
      command: process.execPath,
      args: [script, "mcp"],
      env: {
        [AGENT_FILE_ENV]: agentFile,
        [NEXT_TURN_FILE_ENV]: nextTurnFile,
        [REPO_DIR_ENV]: cwd,
        [REPO_ENV]: repo,
        SWITCHBOARD_CONFIG_DIR: configDir(env),
      },
    },
    dir,
    setAgent: (id, token) => {
      // Written whole and renamed into place, so the server never reads half a file.
      writeFileSync(`${agentFile}.new`, `${id}\n${token}\n`, { mode: 0o600 });
      renameSync(`${agentFile}.new`, agentFile);
    },
    leaveForNextTurn: (text) => appendFileSync(nextTurnFile, `${text.trimEnd()}\n\n`, { mode: 0o600 }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
