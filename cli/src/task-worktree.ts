// The Task branch and its worktree on the holder's machine (ADR 0006).
//
// Claiming a Task creates `task/<issue#>-<slug>` from the latest main on origin,
// pushes it, and checks it out in a worktree of its own, so an Agent's work never
// mixes with anyone else's, including the Person's own checkout. A Task that
// already has a branch (a second holder, or the same Agent claiming again) gets
// that branch instead: from this machine if it has it, else from origin.
//
// Worktrees live inside the repo at `.switchboard/worktrees/<branch>`, next to the
// checkout they belong to. The directory is excluded through `.git/info/exclude`,
// which is local to the clone, so no repo has to commit a .gitignore entry.

import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { taskOfBranch } from "../../shared/src/index";

const run = promisify(execFile);

/** Where worktrees go, relative to the repo's main checkout. */
export const WORKTREES_DIR = join(".switchboard", "worktrees");

/** The line that keeps worktrees out of `git status`. */
const EXCLUDE_LINE = "/.switchboard/";

/** How long one git command may take, including a fetch or push over the network. */
const GIT_TIMEOUT_MS = 60_000;

export class GitError extends Error {}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      // Never wait on a credential prompt the Agent cannot answer.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    const detail = (stderr || message).trim().split("\n").slice(-3).join(" ");
    throw new GitError(`git ${args[0]} failed: ${detail}`);
  }
}

/** True when `git` exits 0. */
async function succeeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * The GitHub `owner/repo` a remote URL points at, lowercased, or null when it names
 * none (a local path, say). Takes every form git accepts for GitHub: https, ssh,
 * scp-like (`git@github.com:owner/repo.git`), with or without `.git` or a trailing
 * slash. The host is not checked, so an SSH host alias from ~/.ssh/config works.
 */
export function remoteRepo(url: string): string | null {
  const trimmed = url.trim();
  let path: string;
  const scp = /^(?:[^@/\s]+@)?[^:/\s]+:(?!\/\/)(.+)$/.exec(trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol === "file:") return null;
    path = parsed.pathname;
  } else if (scp) {
    path = scp[1] ?? "";
  } else {
    return null;
  }
  const parts = path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts.slice(-2).join("/").toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(key) ? key : null;
}

/** What to tell a Person who is not in a clone of `repo`. */
function cloneGuide(repo: string): string {
  return `Switchboard runs Agents in a clone of the Channel's repo, ${repo}: git clone https://github.com/${repo}.git, then run switchboard from inside it.`;
}

/** A checkout whose origin is the Channel's repo: its main checkout and shared git directory. */
export interface ChannelCheckout {
  repo: string;
  root: string;
  gitDir: string;
}

/**
 * The clone of the Channel's `repo` that `cwd` is in (its main checkout, from
 * anywhere inside it or one of its worktrees), or a GitError saying what is wrong
 * and how to fix it. Task branches are made and pushed through its origin, so a
 * directory outside such a clone cannot hold Tasks.
 */
export async function channelCheckout(cwd: string, repo: string): Promise<ChannelCheckout> {
  const gitDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => {
    throw new GitError(`${cwd} is not inside a git repository. ${cloneGuide(repo)}`);
  });
  if (basename(gitDir) !== ".git") {
    throw new GitError(`${gitDir} is a bare repository, with no checkout to work in. ${cloneGuide(repo)}`);
  }
  const root = dirname(gitDir);
  // The URL as configured: an insteadOf rewrite may point fetches elsewhere, but this names the repo.
  const url = await git(root, ["config", "--get", "remote.origin.url"]).catch(() => "");
  if (url === "") throw new GitError(`${root} has no origin remote. ${cloneGuide(repo)}`);
  const found = remoteRepo(url);
  if (found !== repo.toLowerCase()) {
    throw new GitError(`${root} is a clone of ${found ?? url}, not of ${repo}. ${cloneGuide(repo)}`);
  }
  return { repo, root, gitDir };
}

/**
 * Runs `work` in the Channel's clone at `cwd`. Its git failures say which repo
 * and directory they were about, since git's own messages name neither.
 */
async function inCheckout<T>(cwd: string, repo: string, work: (checkout: ChannelCheckout) => Promise<T>): Promise<T> {
  const checkout = await channelCheckout(cwd, repo);
  try {
    return await work(checkout);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    throw new GitError(`${error.message} (In ${checkout.root}, a clone of ${repo}.)`);
  }
}

/** origin's default branch, as origin itself reports it. */
async function remoteMain(cwd: string): Promise<string> {
  const head = await git(cwd, ["ls-remote", "--symref", "origin", "HEAD"]);
  return /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1] ?? "main";
}

/** Keeps `.switchboard/` out of `git status`, in this clone only. */
async function exclude(gitDir: string): Promise<void> {
  const path = join(gitDir, "info", "exclude");
  const current = await readFile(path, "utf8").catch(() => "");
  if (current.split(/\r?\n/).includes(EXCLUDE_LINE)) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${current === "" || current.endsWith("\n") ? "" : "\n"}${EXCLUDE_LINE}\n`);
}

/** Every worktree of the repo, with the branch it has checked out. */
async function worktrees(cwd: string): Promise<{ path: string; branch?: string }[]> {
  const list = await git(cwd, ["worktree", "list", "--porcelain"]);
  return list.split(/\n\n+/).flatMap((block) => {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    return path === undefined ? [] : [{ path, ...(branch === undefined ? {} : { branch }) }];
  });
}

async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)]);
  return x === y;
}

export interface TaskWorktree {
  branch: string;
  /** Absolute path of the worktree the Agent works in. */
  path: string;
  /** True when this call created the branch; false when it already existed. */
  created: boolean;
}

/**
 * Makes sure the Task branch exists on origin and is checked out in its own worktree
 * on this machine. `cwd` is anywhere inside a clone of the Channel's `repo`.
 */
export function openTaskWorktree(cwd: string, repo: string, branch: string): Promise<TaskWorktree> {
  return inCheckout(cwd, repo, (checkout) => openWorktree(checkout, branch));
}

async function openWorktree({ root, gitDir }: ChannelCheckout, branch: string): Promise<TaskWorktree> {
  const path = join(root, WORKTREES_DIR, branch);
  await exclude(gitDir);

  const main = await remoteMain(root);
  await git(root, ["fetch", "--quiet", "origin", `+refs/heads/${main}:refs/remotes/origin/${main}`]);

  for (const tree of await worktrees(root)) {
    if (tree.branch !== branch) continue;
    if (await same(tree.path, path)) {
      await git(path, ["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${branch}`]);
      return { branch, path, created: false };
    }
    throw new GitError(
      `${branch} is already checked out at ${tree.path}. Switch that checkout to another branch first.`,
    );
  }

  const onOrigin = (await git(root, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`])) !== "";
  const local = await succeeds(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  let created = false;
  await mkdir(dirname(path), { recursive: true });
  if (local) {
    await git(root, ["worktree", "add", "--quiet", path, branch]);
  } else if (onOrigin) {
    await git(root, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    await git(root, ["worktree", "add", "--quiet", "--track", "-b", branch, path, `refs/remotes/origin/${branch}`]);
  } else {
    await git(root, ["worktree", "add", "--quiet", "--no-track", "-b", branch, path, `refs/remotes/origin/${main}`]);
    created = true;
  }
  await git(path, ["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${branch}`]);
  return { branch, path, created };
}

/** Every `task/<task>-*` branch, on this machine or on origin. */
async function taskBranches(root: string, task: number): Promise<string[]> {
  const pattern = `refs/heads/task/${task}-*`;
  const local = await git(root, ["for-each-ref", "--format=%(refname:strip=2)", pattern]);
  const remote = await git(root, ["ls-remote", "--heads", "origin", pattern]);
  const names = [
    ...local.split("\n"),
    ...remote.split("\n").map((line) => line.split("\t")[1]?.replace(/^refs\/heads\//, "") ?? ""),
  ];
  return [...new Set(names.filter((name) => taskOfBranch(name) === task))].sort();
}

/**
 * The Task branch for a Task the Channel has no branch on record for, as when
 * setting it up on Claim failed. An existing `task/<task>-*` branch wins (one
 * the Agent made by hand, say), used from whichever checkout has it; otherwise
 * `fallback` is opened as on Claim, and `created` says it has no work on it yet.
 */
export function adoptTaskBranch(cwd: string, repo: string, task: number, fallback: string): Promise<TaskWorktree> {
  return inCheckout(cwd, repo, async (checkout) => {
    const found = await taskBranches(checkout.root, task);
    if (found.length > 1 && !found.includes(fallback)) {
      throw new GitError(
        `Task #${task} has ${found.length} branches (${found.join(", ")}). Delete all but the one with its work.`,
      );
    }
    const branch = found.length === 1 ? (found[0] as string) : fallback;
    const tree = (await worktrees(checkout.root)).find((t) => t.branch === branch);
    if (tree !== undefined) return { branch, path: tree.path, created: false };
    return openWorktree(checkout, branch);
  });
}

/**
 * Pushes the Task branch from its worktree, refusing when the worktree has changes
 * that are not committed, since they would not be in the pull request.
 */
export function pushTaskBranch(cwd: string, repo: string, branch: string): Promise<{ path: string; commit: string }> {
  return inCheckout(cwd, repo, async ({ root }) => {
    const tree = (await worktrees(root)).find((t) => t.branch === branch);
    if (tree === undefined) {
      throw new GitError(`No worktree on this machine has ${branch} checked out. Claim the Task again to open one.`);
    }
    const dirty = (await git(tree.path, ["status", "--porcelain"])).split("\n").filter(Boolean);
    if (dirty.length > 0) {
      throw new GitError(
        `${tree.path} has ${dirty.length} uncommitted ${dirty.length === 1 ? "change" : "changes"}. ` +
          "Commit them (or discard them) first, so the pull request has all of the work.",
      );
    }
    await git(tree.path, ["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${branch}`]);
    return { path: tree.path, commit: await git(tree.path, ["rev-parse", "HEAD"]) };
  });
}
