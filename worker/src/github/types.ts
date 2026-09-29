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

  /* Mirroring what Switchboard owns (ADR 0001): the Claim, status labels, Step checkmarks. */

  /** The login of the user the token acts as. Every Agent acts through that one token. */
  login(): Promise<string>;
  addAssignees(number: TaskNumber, logins: string[]): Promise<void>;
  /** Removing someone who is not assigned is not an error. */
  removeAssignees(number: TaskNumber, logins: string[]): Promise<void>;
  /** Adds labels, creating any the repo does not have yet. */
  addLabels(number: TaskNumber, labels: string[]): Promise<void>;
  /** Removing a label the Issue does not carry is not an error. */
  removeLabel(number: TaskNumber, label: string): Promise<void>;
  addComment(number: TaskNumber, body: string): Promise<void>;
  setBody(number: TaskNumber, body: string): Promise<void>;
}
