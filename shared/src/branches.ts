/**
 * One branch and one pull request per Task (ADR 0006). The wrapper creates the
 * Task branch and its worktree on the holder's machine when an Agent claims a
 * Task, and tells the Channel; finishing the Task opens a pull request that
 * closes the Issue. Pushes to Task branches and merges into main reach the
 * Channel from the GitHub webhook as `push` and `merge` Events.
 */
import type { TaskNumber } from "./domain";

/** The `status:*` label a Task in review carries on GitHub (ADR 0001). */
export const REVIEW_LABEL = "status:review";

/** The longest slug a Task branch name gets from the Issue title, in characters. */
const MAX_SLUG_LENGTH = 40;

/** `task/<issue#>-<slug>`. The slug is whatever follows the first "-". */
const TASK_BRANCH = /^task\/([1-9]\d{0,9})(?:-.+)?$/;

/** The branch name for a Task: `task/<issue#>-<slug of its title>`, such as `task/10-branch-per-task`. */
export function taskBranch(number: TaskNumber, title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug === "" ? word : `${slug}-${word}`;
    if (next.length > MAX_SLUG_LENGTH) break;
    slug = next;
  }
  if (slug === "" && words[0] !== undefined) slug = words[0].slice(0, MAX_SLUG_LENGTH);
  return slug === "" ? `task/${number}` : `task/${number}-${slug}`;
}

/** True for `task/*` branches, the only branches whose pushes become Events. */
export function isTaskBranch(branch: string): boolean {
  return branch.startsWith("task/") && branch.length > "task/".length;
}

/** The Task a branch belongs to, or null when it is not named `task/<issue#>-...`. */
export function taskOfBranch(branch: string): TaskNumber | null {
  const match = TASK_BRANCH.exec(branch);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Diff hunks in `push` and `merge` Events keep at most this many lines per file ... */
export const DIFF_LINES_PER_FILE = 100;
/** ... and this many lines across all files of one Event. */
export const DIFF_LINES_PER_EVENT = 400;

/**
 * `POST /api/tasks/:number/branch`: the holder's wrapper reports the Task branch it
 * created and pushed. Only the holder (or a holding Agent's Person) may.
 */
export interface RecordBranchRequest {
  branch: string;
}

/**
 * `POST /api/tasks/:number/finish`: the holder finishes the Task. The Channel opens a
 * pull request from the Task branch into main whose body closes the Issue and names
 * the holder, then marks the Task in review. Finishing again returns the same PR.
 */
export interface FinishTaskRequest {
  /** A short summary of the work, added to the pull request body. */
  summary?: string;
}

/** The longest finish summary the Channel accepts, in characters. */
export const MAX_FINISH_SUMMARY_LENGTH = 4000;

export function branchPath(task: TaskNumber): string {
  return `/api/tasks/${task}/branch`;
}

export function finishPath(task: TaskNumber): string {
  return `/api/tasks/${task}/finish`;
}
