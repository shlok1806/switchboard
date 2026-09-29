#!/usr/bin/env node
// The Switchboard laptop CLI.
//
//   switchboard login --url <channel url> --secret <join secret> --name <your name>
//   switchboard run claude [--nickname <name>] [--proxy raw|digest|off] [--no-mask] [...args for Claude Code]
//   switchboard whoami
//   switchboard mcp    (internal: the MCP server `run claude` gives the session)

import { parseArgs } from "node:util";
import { normalizePersonName } from "../../shared/src/index";
import { ChannelClient } from "./channel-client";
import { configPath, readConfig, writeConfig } from "./config";
import { runMcpServer } from "./mcp-server";
import { runClaude } from "./run";

const USAGE = `Usage:
  switchboard login --url <channel url> --secret <join secret> --name <your name>
  switchboard run claude [--nickname <name>] [--proxy raw|digest|off] [--no-mask] [...arguments for Claude Code]
  switchboard whoami

\`run claude\` starts Claude Code as usual and joins the session to the Channel as an Agent.
Its model traffic goes through a local proxy (the Proxy Capture): --proxy sets the
starting Proxy mode (digest by default; off runs without the proxy), and --no-mask
turns off secret masking. Every other argument goes to Claude Code, including
--resume and --continue.`;

async function login(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { url: { type: "string" }, secret: { type: "string" }, name: { type: "string" } },
  });
  if (!values.url || !values.secret || !values.name) {
    console.error("Usage: switchboard login --url <channel url> --secret <join secret> --name <your name>");
    return 2;
  }
  let url: URL;
  try {
    url = new URL(values.url);
  } catch {
    console.error(`Not a URL: ${values.url}`);
    return 2;
  }
  const person = normalizePersonName(values.name);
  if (person === null) {
    console.error("Pick a name of 1 to 32 characters: letters, digits, '-' or '_', starting with a letter or digit.");
    return 2;
  }
  const config = { url: url.origin + url.pathname.replace(/\/+$/, ""), secret: values.secret, person };
  // Joining checks the URL, the secret and the name before we save them.
  const joined = await new ChannelClient(config).join();
  const path = await writeConfig({ ...config, person: joined.person.name });
  console.log(`Joined ${config.url} as ${joined.person.name}. Saved to ${path}.`);
  return 0;
}

async function whoami(): Promise<number> {
  const config = await readConfig();
  if (!config) {
    console.error(`Not logged in (no ${configPath()}).`);
    return 1;
  }
  console.log(`${config.person} on ${config.url}`);
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
      if (cli !== "claude") {
        console.error(cli ? `switchboard can only run claude for now, not ${cli}.` : USAGE);
        return 2;
      }
      return runClaude(args);
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
