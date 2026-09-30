// The GitHub sync seam (ADR 0001). Everything the Channel reads from or writes to
// GitHub goes through this interface, so tests can swap in an in-memory fake.

import type { TaskNumber } from "../../../shared/src/index";

export type IssueState = "open" | "closed";

/** One GitHub Issue, reduced to the fields a Task mirrors. Never a pull request. */
export interface GitHubIssue {
  number: TaskNumber;
  title: string;
  /** The Issue body, "" when empty. */
  body: string;
  labels: string[];
  state: IssueState;
  url: string;
  /** Login of whoever opened it. */
  author: string;
  /** Login of whoever closed it, when closed and known. */
  closedBy?: string;
  /** Parent Issue number when this is a sub-issue in the same repo. */
  parent?: TaskNumber;
  /** How many sub-issues it has. Zero means there is no need to list them. */
  subIssueCount: number;
  /** How many open Issues block it. Zero means there is no need to list them. */
  openBlockerCount: number;
}

/** Another Issue in the same repo, as listed by a relationship. */
export interface IssueRef {
  number: TaskNumber;
  state: IssueState;
}

export interface NewIssue {
  title: string;
  body: string;
  labels: string[];
}

/** A pull request to open, from a branch into another in the same repo. */
export interface NewPullRequest {
  title: string;
  body: string;
  /** The branch with the work. */
  head: string;
  /** The branch it merges into. */
  base: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
}

/** One file in a comparison. `patch` is GitHub's unified diff, absent for binary or very large files. */
export interface ComparedFile {
  path: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/** What changed between two commits: GitHub's compare API, `base...head`. */
export interface Comparison {
  /** Oldest first. */
  commits: { sha: string; message: string }[];
  files: ComparedFile[];
}

/** A collaborator's permission on the repo. Write or above is membership (ADR 0007). */
export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

/** Whether a permission lets its Person into the Channel: write access to the repo. */
export function canWrite(permission: Permission): boolean {
  return permission === "admin" || permission === "maintain" || permission === "write";
}

export interface GitHub {
  /** `owner/name`. */
  readonly repo: string;
  /** Every open Issue, pull requests excluded. */
  listOpenIssues(): Promise<GitHubIssue[]>;
  /** One Issue, or null when it was deleted, moved to another repo or is a pull request. */
  getIssue(number: TaskNumber): Promise<GitHubIssue | null>;
  createIssue(issue: NewIssue): Promise<GitHubIssue>;
  /** The Issue's sub-issues in this repo, open and closed. */
  listSubIssues(number: TaskNumber): Promise<IssueRef[]>;
  /** Issues in this repo that block it (its "blocked by" dependencies). */
  listBlockedBy(number: TaskNumber): Promise<IssueRef[]>;
  /** Issues in this repo that it blocks. */
  listBlocking(number: TaskNumber): Promise<IssueRef[]>;

  /** A GitHub user's permission on the repo: the membership check (ADR 0007). */
  permission(login: string): Promise<Permission>;

  /* Mirroring what Switchboard owns (ADR 0001): the Claim, status labels, Step checkmarks. */

  /** Assignees are the holder's Person, so GitHub notifies the old and the new assignee. */
  addAssignees(number: TaskNumber, logins: string[]): Promise<void>;
  /** Removing someone who is not assigned is not an error. */
  removeAssignees(number: TaskNumber, logins: string[]): Promise<void>;
  /** Adds labels, creating any the repo does not have yet. */
  addLabels(number: TaskNumber, labels: string[]): Promise<void>;
  /** Removing a label the Issue does not carry is not an error. */
  removeLabel(number: TaskNumber, label: string): Promise<void>;
  /** Posts a comment and returns its ID. */
  createComment(number: TaskNumber, body: string): Promise<number>;
  /** Edits a comment. False when it no longer exists (someone deleted it). */
  updateComment(id: number, body: string): Promise<boolean>;
  setBody(number: TaskNumber, body: string): Promise<void>;

  /* Branches and pull requests (ADR 0006). */

  /** The repo's default branch, into which Task pull requests merge. */
  defaultBranch(): Promise<string>;
  /**
   * Opens a pull request. When an open one from `head` into `base` already exists,
   * returns that one instead.
   */
  createPullRequest(pr: NewPullRequest): Promise<PullRequestRef>;
  /** The commits and changed files between `base` and `head` (the compare API, three-dot). */
  compare(base: string, head: string): Promise<Comparison>;
}
