#!/usr/bin/env node
// The Switchboard laptop CLI.
//
//   switchboard login [--url <channel url>] [--repo <owner>/<repo>] [--force]
//   switchboard run claude [--repo <owner>/<repo>] [--nickname <name>] [--account-label <label>] [--proxy raw|digest|off] [--no-mask] [...args for Claude Code]
//   switchboard run codex|gemini [--repo <owner>/<repo>] [--nickname <name>] [--account-label <label>] [--proxy raw|digest|off] [--no-mask] [...args for Codex or Gemini CLI]
//   switchboard rename <agent> <nickname>|--clear [--repo <owner>/<repo>]
//   switchboard whoami
//   switchboard mcp    (internal: the MCP server `run claude` gives the session)

import { parseArgs } from "node:util";
import { ChannelChoiceError, chooseChannel, describeChoice } from "./channel-choice";
import { ADAPTERS } from "./clis/index";
import { configPath, readConfig } from "./config";
import { LoginError, login as signIn } from "./login";
import { runMcpServer } from "./mcp-server";
import { renameAgent } from "./rename";
import { runCli } from "./run";

const USAGE = `Usage:
  switchboard login [--url <channel url>] [--repo <owner>/<repo>] [--force]
  switchboard run claude [--repo <owner>/<repo>] [--nickname <name>] [--account-label <label>] [--proxy raw|digest|off] [--no-mask] [...arguments for Claude Code]
  switchboard run codex [--repo <owner>/<repo>] [--nickname <name>] [--account-label <label>] [--proxy raw|digest|off] [--no-mask] [...arguments for Codex]
  switchboard run gemini [--repo <owner>/<repo>] [--nickname <name>] [--account-label <label>] [--proxy raw|digest|off] [--no-mask] [...arguments for Gemini CLI]
  switchboard rename <agent> <nickname>|--clear [--repo <owner>/<repo>]
  switchboard whoami

\`login\` signs you in with GitHub (a code to enter at github.com), once: the session
works for every Channel on that host whose repo you have write access to. The
Channel URL is its Dashboard's, https://<host>/<owner>/<repo>, and that Channel
becomes your default. Logging in again for another Channel of the same host only
changes the default; --force signs in afresh.

\`run\` uses the Channel of the repo you are working in: --repo, else $SWITCHBOARD_REPO,
else the GitHub repo of this directory's git origin remote when the host has a Channel
for it, else your default. \`whoami\` shows which one that is.

\`run claude\` starts Claude Code as usual and joins the session to the Channel as an Agent.
Its model traffic goes through a local proxy (the Proxy Capture): --proxy sets the
starting Proxy mode (digest by default; off runs without the proxy), and --no-mask
turns off secret masking. Every other argument goes to Claude Code, including
--resume and --continue.

--nickname names the Agent on the Channel; it stays unique there, so a name another
running Agent holds is not set. --account-label (or $SWITCHBOARD_ACCOUNT_LABEL) says
which login of the CLI the Agent runs under; without it, Claude Code and Gemini CLI
sessions show their login's email address, masked (sh…@example.com).

\`run codex\` and \`run gemini\` do the same for Codex and Gemini CLI, with the same
flags. Custom Codex providers and Gemini Vertex AI sessions run without the Proxy
Capture, with a notice saying why. Codex runs Switchboard's hooks once you trust
them in its /hooks screen; until then Queued Events reach the Agent through the
read_channel tool.

\`rename\` changes an Agent's Nickname while it runs, as everyone on the Channel sees it.
Name the Agent by its Agent ID, the ID without your login (claude/7f3a), or its
current Nickname; --clear removes the Nickname.`;

async function login(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: "string" },
      repo: { type: "string" },
      "dev-login": { type: "string" },
      force: { type: "boolean" },
    },
  });
  try {
    const { path, config, reused } = await signIn({
      ...(values.url === undefined ? {} : { url: values.url }),
      ...(values.repo === undefined ? {} : { repo: values.repo }),
      ...(values["dev-login"] === undefined ? {} : { devLogin: values["dev-login"] }),
      ...(values.force ? { force: true } : {}),
      say: (line) => console.log(line),
    });
    console.log(
      reused
        ? `Already signed in on ${config.url} as ${config.person}, so there was no need to sign in again. ` +
            `Your default Channel is ${config.repo}. Saved to ${path}.`
        : `Signed in to ${config.repo} on ${config.url} as ${config.person}. Saved to ${path}.`,
    );
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
  console.log(`${config.person} at ${config.url}`);
  console.log(`Default Channel: ${config.repo}`);
  try {
    const choice = await chooseChannel(config, { cwd: process.cwd() });
    console.log(`In this directory, \`switchboard run\` uses ${describeChoice(choice)}.`);
  } catch (error) {
    if (!(error instanceof ChannelChoiceError)) throw error;
    console.error(`switchboard: ${error.message}`);
    return 1;
  }
  return 0;
}

async function rename(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { repo: { type: "string" }, clear: { type: "boolean" } },
  });
  const [agent, nickname, ...extra] = positionals;
  if (agent === undefined || extra.length > 0 || (nickname === undefined) === !values.clear) {
    console.error(`Usage: switchboard rename <agent> <nickname>|--clear [--repo <owner>/<repo>]`);
    return 2;
  }
  return renameAgent({
    agent,
    nickname: nickname ?? null,
    ...(values.repo === undefined ? {} : { repo: values.repo }),
    cwd: process.cwd(),
    env: process.env,
    say: (line) => console.log(line),
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "login":
      return login(rest);
    case "whoami":
      return whoami();
    case "rename":
      return rename(rest);
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
