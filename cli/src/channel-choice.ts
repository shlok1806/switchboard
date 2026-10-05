// Which Channel a command uses (ADR 0008). One `switchboard login` signs the Person
// in to a Worker, and their session works for every Channel there they have write
// access to, so each command picks its Channel, in this order:
//
//   1. `--repo <owner>/<repo>` on `switchboard run`
//   2. $SWITCHBOARD_REPO
//   3. the GitHub repo of the directory's git `origin` remote, unless the Worker
//      says it has no Channel for it (`GET /auth/config`)
//   4. the default repo, the one named at `switchboard login`
//
// A session starts only in a clone of its Channel's repo (task-worktree.ts), so in
// a clone the third rule is the one that lets it start; the default serves commands
// run elsewhere.
//
// The wrapper resolves this once and hands the answer to the session's MCP server as
// $SWITCHBOARD_REPO, so every part of one session is on the same Channel. Only the
// repo is ever chosen here: the Worker stays the one the session was issued by.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AuthConfigResponse } from "../../shared/src/index";
import { channelKey } from "../../shared/src/index";
import type { Config } from "./config";
import { remoteRepo } from "./task-worktree";

/** The env var naming the Channel's repo, set by the Person or by the wrapper for its children. */
export const REPO_ENV = "SWITCHBOARD_REPO";

/** How long a command waits for the Worker to say which repos may have a Channel. */
const WORKER_TIMEOUT_MS = 5000;

export type ChoiceReason = "flag" | "env" | "origin" | "default";

export interface ChannelChoice {
  /** The Channel's repo, `owner/name`, lowercased. */
  repo: string;
  reason: ChoiceReason;
  /** What else the Person should know: why the directory's own repo was not used, or could not be confirmed. */
  note?: string;
}

export class ChannelChoiceError extends Error {}

/**
 * The GitHub repo of `cwd`'s git `origin` remote, or null when there is none. It
 * reads the URL as configured, the one that names the repo, as `channelCheckout` does.
 */
export async function originRepo(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)("git", ["config", "--get", "remote.origin.url"], { cwd });
    const repo = remoteRepo(stdout);
    return repo === null ? null : channelKey(repo);
  } catch {
    return null;
  }
}

/** The repos the Worker at `origin` allows a Channel for; empty means any. Carries no credential. */
async function channelRepos(origin: string): Promise<string[]> {
  const response = await fetch(`${origin.replace(/\/+$/, "")}/auth/config`, {
    signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { repos } = (await response.json()) as AuthConfigResponse;
  if (!Array.isArray(repos)) throw new Error("no list of repos in its answer");
  return repos;
}

function named(raw: string, from: string): string {
  const repo = channelKey(raw);
  if (repo === null) throw new ChannelChoiceError(`${from} "${raw}" is not a GitHub repo (owner/name).`);
  return repo;
}

export interface ChoiceInputs {
  /** `--repo`, when the Person gave it. */
  flag?: string;
  env?: NodeJS.ProcessEnv;
  /** The directory the Person is working in. */
  cwd: string;
}

/** Picks the Channel for a command run in `cwd` by the Person signed in as `config`. */
export async function chooseChannel(config: Config, inputs: ChoiceInputs): Promise<ChannelChoice> {
  if (inputs.flag !== undefined) return { repo: named(inputs.flag, "--repo"), reason: "flag" };
  const fromEnv = (inputs.env ?? process.env)[REPO_ENV];
  if (fromEnv) return { repo: named(fromEnv, `$${REPO_ENV}`), reason: "env" };

  const here = await originRepo(inputs.cwd);
  if (here === null || here === config.repo) return { repo: config.repo, reason: "default" };
  let repos: string[];
  try {
    repos = await channelRepos(config.url);
  } catch (error) {
    // The clone still names its repo, and a session starts only in a clone of its Channel's.
    return {
      repo: here,
      reason: "origin",
      note: `could not ask ${config.url} whether it has a Channel for it: ${(error as Error).message}`,
    };
  }
  if (repos.length === 0 || repos.includes(here)) return { repo: here, reason: "origin" };
  return { repo: config.repo, reason: "default", note: `${config.url} has no Channel for ${here}` };
}

/** Why the Channel was chosen, for the Person: "the Channel for a/b (this directory's git origin remote)". */
export function describeChoice(choice: ChannelChoice): string {
  const why: Record<ChoiceReason, string> = {
    flag: "--repo",
    env: `$${REPO_ENV}`,
    origin: "this directory's git origin remote",
    default: "your default Channel",
  };
  const note = choice.note === undefined ? "" : `; ${choice.note}`;
  return `the Channel for ${choice.repo} (${why[choice.reason]}${note})`;
}
