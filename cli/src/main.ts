#!/usr/bin/env node
// The Switchboard laptop CLI.
//
//   switchboard login --url <channel url> [--repo <owner>/<repo>]
//   switchboard run claude [--nickname <name>] [--proxy raw|digest|off] [--no-mask] [...args for Claude Code]
//   switchboard run codex|gemini [--nickname <name>] [...args for Codex or Gemini CLI]
//   switchboard whoami
//   switchboard mcp    (internal: the MCP server `run claude` gives the session)

import { parseArgs } from "node:util";
import { ADAPTERS } from "./clis/index";
import { configPath, readConfig } from "./config";
import { LoginError, login as signIn } from "./login";
import { runMcpServer } from "./mcp-server";
import { runCli } from "./run";

const USAGE = `Usage:
  switchboard login --url <channel url> [--repo <owner>/<repo>]
  switchboard run claude [--nickname <name>] [--proxy raw|digest|off] [--no-mask] [...arguments for Claude Code]
  switchboard run codex [--nickname <name>] [...arguments for Codex]
  switchboard run gemini [--nickname <name>] [...arguments for Gemini CLI]
  switchboard whoami

\`login\` signs you in with GitHub (a code to enter at github.com) for one Channel.
The Channel URL is its Dashboard's, https://<host>/<owner>/<repo>. You need write
access to the repo.

\`run claude\` starts Claude Code as usual and joins the session to the Channel as an Agent.
Its model traffic goes through a local proxy (the Proxy Capture): --proxy sets the
starting Proxy mode (digest by default; off runs without the proxy), and --no-mask
turns off secret masking. Every other argument goes to Claude Code, including
--resume and --continue.

\`run codex\` and \`run gemini\` do the same for Codex and Gemini CLI, without the
Proxy Capture (it reads Anthropic's API only). Codex runs Switchboard's hooks once
you trust them in its /hooks screen; until then Queued Events reach the Agent
through the read_channel tool.`;

async function login(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { url: { type: "string" }, repo: { type: "string" }, "dev-login": { type: "string" } },
  });
  if (!values.url) {
    console.error("Usage: switchboard login --url <channel url> [--repo <owner>/<repo>]");
    return 2;
  }
  try {
    const { path, config } = await signIn({
      url: values.url,
      ...(values.repo === undefined ? {} : { repo: values.repo }),
      ...(values["dev-login"] === undefined ? {} : { devLogin: values["dev-login"] }),
      say: (line) => console.log(line),
    });
    console.log(`Signed in to ${config.repo} on ${config.url} as ${config.person}. Saved to ${path}.`);
    return 0;
  } catch (error) {
    if (error instanceof LoginError || (error as { status?: number }).status !== undefined) {
      console.error(`switchboard: ${(error as Error).message}`);
      return 1;
    }
    throw error;
  }
}

async function whoami(): Promise<number> {
  const config = await readConfig();
  if (!config) {
    console.error(`Not logged in (no ${configPath()}).`);
    return 1;
  }
  console.log(`${config.person} on ${config.repo} at ${config.url}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "login":
      return login(rest);
    case "whoami":
      return whoami();
    case "mcp":
      return runMcpServer();
    case "run": {
      const [cli, ...args] = rest;
      const adapter = cli === undefined ? undefined : ADAPTERS[cli];
      if (!adapter) {
        console.error(cli ? `switchboard can run ${Object.keys(ADAPTERS).join(", ")}, not ${cli}.` : USAGE);
        return 2;
      }
      return runCli(adapter, args);
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return command === undefined ? 2 : 0;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(`switchboard: ${error.message}`);
    process.exit(1);
  },
);
