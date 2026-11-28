// Links a session to how it turned out (ADR 0054): its repo, branches and commits from
// its own files and the checkout; its pull requests' fates from GitHub (`gh`); its
// Agent's Tasks and Claims from the Channel; and the Greenroom runs it started, with
// their verdicts. Every link it cannot make is written down with why, so a gap is never
// read as "no outcome". It only reads: nothing of the Dataset leaves the machine.

import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ChannelEvent, Cli, HistoryResponse } from "../../../shared/src/index";
import { agentIdFor } from "../../../shared/src/index";
import { ChannelClient, ChannelError, targetOf } from "../channel-client";
import type { Config } from "../config";
import type { ParsedSession } from "./parse";
import {
  type ChannelOutcome,
  DATASET_SCHEMA,
  type DatasetCli,
  type DatasetOutcome,
  type GreenroomOutcome,
  type PullRequestOutcome,
} from "./schema";

const run = promisify(execFile);

/** How long a repo's pull requests, as `gh` listed them, are reused. */
const GITHUB_CACHE_MS = 30 * 60_000;
/** The most pull requests listed for one repo. */
const GITHUB_PR_LIMIT = 2000;
/** The most of an Agent's Events read from the Channel. */
const CHANNEL_TAIL = 1000;

/** What linking may reach. Each is optional, so a test or `--offline` links from local files only. */
export interface LinkDeps {
  /** Lists a repo's pull requests; null when it cannot, with why. */
  pullRequests?: (repo: string) => Promise<GithubPr[] | { error: string }>;
  /** An Agent's Events on a Channel, or why they cannot be read. */
  agentEvents?: (repo: string, agent: string) => Promise<ChannelEvent[] | { error: string }>;
  /** The Person the Channel knows the owner as. */
  person?: string;
  /** `~/.greenroom/runs`. */
  greenroomRuns: string;
  /** The GitHub repo (`owner/name`) of a checkout, or why there is none. */
  repoOf: (cwd: string) => Promise<string | { why: string }>;
}

export interface GithubPr {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  url: string;
  mergedAt: string | null;
  closedAt: string | null;
  mergeCommit: { oid: string } | null;
}

/** `owner/name` of a GitHub remote URL, ssh or https. */
export function githubSlug(url: string): string | null {
  const match = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1] ?? null;
}

/** Why a working directory gave no repo. */
export const REPO_GONE = "its working directory no longer exists, nor a checkout above it";
export const REPO_NOT_GITHUB = "its working directory is not in a git checkout with a GitHub origin";

/**
 * The GitHub repo of a checkout, asked of git. A directory that is gone (a removed
 * worktree) is looked up from the nearest folder above it that still exists.
 */
export function gitRepoOf(): (cwd: string) => Promise<string | { why: string }> {
  const known = new Map<string, Promise<string | { why: string }>>();
  const ask = async (cwd: string): Promise<string | { why: string }> => {
    let dir = cwd;
    let gone = false;
    for (;;) {
      try {
        if ((await stat(dir)).isDirectory()) break;
      } catch {
        // Gone: try its parent.
      }
      gone = true;
      const up = dirname(dir);
      if (up === dir) return { why: REPO_GONE };
      dir = up;
    }
    try {
      const { stdout } = await run("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 5000 });
      return githubSlug(stdout) ?? { why: REPO_NOT_GITHUB };
    } catch {
      return { why: gone ? REPO_GONE : REPO_NOT_GITHUB };
    }
  };
  return (cwd) => {
    let answer = known.get(cwd);
    if (answer === undefined) {
      answer = ask(cwd);
      known.set(cwd, answer);
    }
    return answer;
  };
}

/** Lists a repo's pull requests with `gh`, cached in the Dataset's `cache/` for half an hour. */
export function ghPullRequests(
  cacheDir: string,
  now = Date.now(),
): (repo: string) => Promise<GithubPr[] | { error: string }> {
  const known = new Map<string, Promise<GithubPr[] | { error: string }>>();
  const fetchRepo = async (repo: string): Promise<GithubPr[] | { error: string }> => {
    const file = join(cacheDir, "github", `${repo.replace("/", "__")}.json`);
    try {
      const cached = JSON.parse(await readFile(file, "utf8")) as { fetchedAt: number; prs: GithubPr[] };
      if (now - cached.fetchedAt < GITHUB_CACHE_MS) return cached.prs;
    } catch {
      // None yet.
    }
    try {
      const { stdout } = await run(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          "all",
          "--limit",
          String(GITHUB_PR_LIMIT),
          "--json",
          "number,title,state,url,mergedAt,closedAt,mergeCommit",
        ],
        { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      );
      const prs = JSON.parse(stdout) as GithubPr[];
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ fetchedAt: now, prs }));
      return prs;
    } catch (error) {
      const text =
        String((error as { stderr?: string }).stderr || (error as Error).message)
          .trim()
          .split("\n")[0] ?? "";
      return { error: `gh could not list its pull requests: ${text.slice(0, 160)}` };
    }
  };
  return (repo) => {
    let answer = known.get(repo);
    if (answer === undefined) {
      answer = fetchRepo(repo);
      known.set(repo, answer);
    }
    return answer;
  };
}

/** Reads an Agent's Events from a Channel on the owner's Worker, as the owner. */
export function channelEvents(
  config: Config,
): (repo: string, agent: string) => Promise<ChannelEvent[] | { error: string }> {
  return async (repo, agent) => {
    const client = new ChannelClient(targetOf(config, repo));
    try {
      const page = await client.request<HistoryResponse>(
        `/api/events?tail=${CHANNEL_TAIL}&agent=${encodeURIComponent(agent)}`,
      );
      return page.events;
    } catch (error) {
      if (error instanceof ChannelError)
        return { error: `the Channel ${repo} answered ${error.status}: ${error.message}` };
      return { error: `the Channel ${repo} could not be reached: ${(error as Error).message}` };
    }
  };
}

const CLI: Record<DatasetCli, Cli> = { "claude-code": "claude-code", codex: "codex" };

/** The Tasks, Claims and pull requests an Agent's own Events on the Channel record. */
export function channelOutcome(repo: string, agent: string, events: readonly ChannelEvent[]): ChannelOutcome {
  const tasks = new Map<number, ChannelOutcome["tasks"][number]>();
  const of = (task: number) => {
    let entry = tasks.get(task);
    if (entry === undefined) {
      entry = { task, stepsCompleted: 0 };
      tasks.set(task, entry);
    }
    return entry;
  };
  for (const event of events) {
    if (event.actor.kind !== "agent" || event.actor.agentId !== agent || event.task === undefined) continue;
    if (event.type === "claim") of(event.task).claimedAt ??= event.at;
    else if (event.type === "claim.release") of(event.task).releasedAt = event.at;
    else if (event.type === "step.complete") of(event.task).stepsCompleted++;
    else if (event.type === "task.review") of(event.task).pr = event.payload.pr;
    else if (event.type === "task.done") of(event.task).done = true;
  }
  return { channel: repo, agent, tasks: [...tasks.values()].sort((a, b) => a.task - b.task) };
}

/** A Greenroom run's record: its name, its verifier's verdict and how its job ended. */
async function greenroomRun(
  dir: string,
  runId: string,
  relation: GreenroomOutcome["relation"],
): Promise<GreenroomOutcome | null> {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(join(dir, runId, "manifest.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const verdict = manifest.verdict as { verdict?: unknown } | undefined;
  const finish = manifest.finish as { outcome?: unknown; summary?: unknown } | undefined;
  return {
    runId,
    relation,
    ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
    ...(typeof verdict?.verdict === "string" ? { verdict: verdict.verdict } : {}),
    ...(typeof finish?.outcome === "string" ? { outcome: finish.outcome } : {}),
    ...(typeof finish?.summary === "string" ? { summary: finish.summary.slice(0, 500) } : {}),
  };
}

/** Links one parsed session to every outcome it can. */
export async function linkOutcome(
  cli: DatasetCli,
  session: ParsedSession,
  deps: LinkDeps,
  now = new Date(),
): Promise<DatasetOutcome> {
  const unlinked: DatasetOutcome["unlinked"] = [];
  // The repo: the checkout's origin, else what the CLI recorded.
  let repo: string | null = null;
  let noRepo: string | undefined;
  for (const cwd of session.cwds) {
    const found = await deps.repoOf(cwd);
    if (typeof found === "string") {
      repo = found;
      break;
    }
    noRepo ??= found.why;
  }
  if (repo === null && session.refs.repoUrl !== undefined) repo = githubSlug(session.refs.repoUrl);
  if (repo === null) repo = session.refs.prs[0]?.repo ?? null;
  if (repo === null) unlinked.push({ what: "repo", why: noRepo ?? "the session names no working directory" });

  // Pull requests: the CLI's own record and `gh pr create`'s output, then the Channel's.
  const prs = new Map<string, PullRequestOutcome>();
  const addPr = (pr: { repo: string; number: number; url: string }, via: PullRequestOutcome["via"][number]) => {
    const key = `${pr.repo.toLowerCase()}#${pr.number}`;
    const known = prs.get(key);
    if (known) {
      if (!known.via.includes(via)) known.via.push(via);
      return;
    }
    prs.set(key, {
      repo: pr.repo,
      number: pr.number,
      url: pr.url || `https://github.com/${pr.repo}/pull/${pr.number}`,
      via: [via],
    });
  };
  for (const pr of session.refs.prs) addPr(pr, pr.via);

  // The Channel: only for a session that ran through Switchboard.
  let switchboard: ChannelOutcome | undefined;
  if (session.refs.usedSwitchboard) {
    if (deps.agentEvents === undefined || deps.person === undefined) {
      unlinked.push({
        what: "switchboard",
        why: deps.agentEvents === undefined ? "linked offline" : "not signed in to Switchboard on this machine",
      });
    } else if (repo === null) {
      unlinked.push({ what: "switchboard", why: "its repo, and so its Channel, is unknown" });
    } else {
      const agent = agentIdFor(deps.person, CLI[cli], session.id);
      const events = await deps.agentEvents(repo, agent);
      if ("error" in events) unlinked.push({ what: "switchboard", why: events.error });
      else {
        switchboard = channelOutcome(repo, agent, events);
        for (const task of switchboard.tasks) {
          if (task.pr !== undefined) addPr({ repo, number: task.pr, url: "" }, "channel");
        }
      }
    }
  }

  // Each pull request's fate, and whether a later one reverted it.
  for (const pr of prs.values()) {
    if (deps.pullRequests === undefined) {
      unlinked.push({ what: `pr ${pr.repo}#${pr.number}`, why: "linked offline" });
      continue;
    }
    const listed = await deps.pullRequests(pr.repo);
    if ("error" in listed) {
      unlinked.push({ what: `pr ${pr.repo}#${pr.number}`, why: listed.error });
      continue;
    }
    const found = listed.find((p) => p.number === pr.number);
    if (found === undefined) {
      unlinked.push({ what: `pr ${pr.repo}#${pr.number}`, why: "not among the repo's pull requests gh lists" });
      continue;
    }
    pr.state = found.state === "MERGED" ? "merged" : found.state === "CLOSED" ? "closed" : "open";
    if (found.mergedAt) pr.mergedAt = found.mergedAt;
    if (found.closedAt) pr.closedAt = found.closedAt;
    if (found.mergeCommit?.oid) pr.mergeCommit = found.mergeCommit.oid;
    const revert = listed.find((p) => p.title === `Revert "${found.title}"` && p.state === "MERGED");
    if (revert !== undefined) pr.revertedBy = `${pr.repo}#${revert.number}`;
  }

  // Greenroom runs it started or named.
  const greenroom: GreenroomOutcome[] = [];
  for (const [runId, relation] of session.refs.runs) {
    const record = await greenroomRun(deps.greenroomRuns, runId, relation);
    if (record !== null) greenroom.push(record);
    else if (relation === "created")
      unlinked.push({ what: `greenroom ${runId}`, why: "the run has no record in ~/.greenroom/runs" });
  }

  return {
    schema: DATASET_SCHEMA,
    session: session.id,
    cli,
    linkedAt: now.toISOString(),
    ...(repo === null ? {} : { repo }),
    branches: session.gitBranches,
    commits: session.refs.commits,
    prs: [...prs.values()],
    ...(switchboard === undefined ? {} : { switchboard }),
    greenroom,
    corrections: Object.values(session.correctionKinds).reduce((sum, n) => sum + n, 0),
    unlinked,
  };
}

/** `~/.greenroom/runs`. */
export function greenroomRunsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), ".greenroom", "runs");
}

/** Whether an outcome can still change: an open pull request or a Task not yet done. */
export function unsettled(outcome: DatasetOutcome): boolean {
  return (
    outcome.prs.some((pr) => pr.state === undefined || pr.state === "open") ||
    (outcome.switchboard?.tasks.some((task) => task.done !== true && task.releasedAt === undefined) ?? false) ||
    outcome.unlinked.some((gap) => gap.why === "linked offline")
  );
}
