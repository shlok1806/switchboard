// An in-memory GitHub for tests. It keeps Issues, sub-issues and dependencies, and
// every change made "on GitHub" returns the webhook delivery GitHub would send, so a
// test decides whether to deliver it or let it go missing.

import type { TaskNumber } from "../../shared/src/index";
import type {
  ComparedFile,
  Comparison,
  GitHub,
  GitHubIssue,
  IssueRef,
  NewIssue,
  NewPullRequest,
  Permission,
  PullRequestRef,
} from "../src/github/index";

interface FakeIssue {
  number: TaskNumber;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  author: string;
  closedBy?: string;
  parent?: TaskNumber;
  blockedBy: Set<TaskNumber>;
  assignees: string[];
  /** Comment IDs, oldest first. */
  comments: number[];
}

/** One write the Channel made to GitHub, in the order it made them. */
export type MirrorCall =
  | ["addAssignees", TaskNumber, string[]]
  | ["removeAssignees", TaskNumber, string[]]
  | ["addLabels", TaskNumber, string[]]
  | ["removeLabel", TaskNumber, string]
  | ["createComment", TaskNumber, string]
  | ["updateComment", number, string]
  | ["setBody", TaskNumber, string]
  | ["createPullRequest", string, string];

type MirrorMethod = MirrorCall[0];

export interface FakePullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: "open" | "merged";
}

/** The SHA git uses for "no commit". */
export const NO_COMMIT = "0".repeat(40);

let shas = 0;

/** A new, unique commit SHA. */
export function sha(): string {
  shas += 1;
  return shas.toString(16).padStart(40, "a");
}

export interface WebhookDelivery {
  /** The `X-GitHub-Event` header. */
  event: string;
  payload: Record<string, unknown>;
}

export class FakeGitHub implements GitHub {
  readonly repo = "shlok1806/switchboard";
  /** The GitHub App's bot; Issues and comments the Channel creates are authored by it. */
  readonly botLogin = "switchboard[bot]";
  /** Each login's permission on the repo; anyone not listed has write access. */
  readonly permissions = new Map<string, Permission>();
  /** How many times the Channel asked for someone's permission: the membership checks. */
  permissionChecks = 0;
  /** When true, the permission check fails as if GitHub were down. */
  permissionsDown = false;
  private readonly commentBodies = new Map<number, { issue: TaskNumber; body: string }>();
  private nextComment = 1000;
  /** Every delivery GitHub would have sent, oldest first. */
  readonly outbox: WebhookDelivery[] = [];
  /** Every write the Channel made, oldest first. */
  readonly calls: MirrorCall[] = [];
  /** Writes that fail, as when GitHub is down or the token lacks a permission. */
  readonly failing = new Set<MirrorMethod>();
  private readonly issues = new Map<TaskNumber, FakeIssue>();
  private readonly pulls = new Map<number, FakePullRequest>();
  /** The newest commit of each branch. */
  private readonly heads = new Map<string, string>([["main", sha()]]);
  /** What the compare API answers, by `base...head`. */
  private readonly comparisons = new Map<string, Comparison>();
  private nextNumber = 1;

  /* ── Things people do on GitHub ─────────────────────────── */

  open(input: { title: string; body?: string; labels?: string[]; by?: string }): WebhookDelivery & {
    number: TaskNumber;
  } {
    const issue: FakeIssue = {
      number: this.nextNumber++,
      title: input.title,
      body: input.body ?? "",
      labels: input.labels ?? [],
      state: "open",
      author: input.by ?? "shlok1806",
      blockedBy: new Set(),
      assignees: [],
      comments: [],
    };
    this.issues.set(issue.number, issue);
    return { number: issue.number, ...this.issueEvent("opened", issue, issue.author) };
  }

  edit(number: TaskNumber, patch: { title?: string; body?: string; labels?: string[] }, by = "shlok1806") {
    const issue = this.must(number);
    Object.assign(issue, patch);
    return this.issueEvent("edited", issue, by);
  }

  close(number: TaskNumber, by = "shlok1806"): WebhookDelivery {
    const issue = this.must(number);
    issue.state = "closed";
    issue.closedBy = by;
    return this.issueEvent("closed", issue, by);
  }

  reopen(number: TaskNumber, by = "shlok1806"): WebhookDelivery {
    const issue = this.must(number);
    issue.state = "open";
    delete issue.closedBy;
    return this.issueEvent("reopened", issue, by);
  }

  delete(number: TaskNumber, by = "shlok1806"): WebhookDelivery {
    const issue = this.must(number);
    this.issues.delete(number);
    return this.issueEvent("deleted", issue, by);
  }

  addSubIssue(parent: TaskNumber, child: TaskNumber, by = "shlok1806"): WebhookDelivery {
    this.must(parent);
    this.must(child).parent = parent;
    return this.record("sub_issues", {
      action: "sub_issue_added",
      parent_issue_id: parent,
      parent_issue: this.toPayload(this.must(parent)),
      parent_issue_repo: { full_name: this.repo },
      sub_issue_id: child,
      sub_issue: this.toPayload(this.must(child)),
      sub_issue_repo: { full_name: this.repo },
      repository: { full_name: this.repo },
      sender: { login: by },
    });
  }

  addBlocker(blocked: TaskNumber, blocking: TaskNumber, by = "shlok1806"): WebhookDelivery {
    this.must(blocked).blockedBy.add(this.must(blocking).number);
    return this.record("issue_dependencies", {
      action: "blocked_by_added",
      blocked_issue: this.toPayload(this.must(blocked)),
      blocking_issue: this.toPayload(this.must(blocking)),
      blocking_issue_repo: { full_name: this.repo },
      repository: { full_name: this.repo },
      sender: { login: by },
    });
  }

  /**
   * Someone pushes commits to a branch. The compare API then answers for the push
   * with these commits and files. A new branch is compared with main.
   */
  push(
    branch: string,
    input: { commits?: string[]; files?: ComparedFile[]; by?: string; repo?: string } = {},
  ): WebhookDelivery & { after: string } {
    const before = this.heads.get(branch) ?? NO_COMMIT;
    const commits = (input.commits ?? []).map((message) => ({ sha: sha(), message }));
    const after = commits.at(-1)?.sha ?? this.heads.get("main") ?? sha();
    this.heads.set(branch, after);
    const base = before === NO_COMMIT ? "main" : before;
    this.comparisons.set(`${base}...${after}`, { commits, files: input.files ?? [] });
    const delivery = this.record("push", {
      ref: `refs/heads/${branch}`,
      before,
      after,
      created: before === NO_COMMIT,
      deleted: false,
      forced: false,
      commits: commits.map((c) => ({ id: c.sha, message: c.message })),
      head_commit: commits.length === 0 ? null : { id: after, message: commits.at(-1)?.message },
      repository: { full_name: input.repo ?? this.repo, default_branch: "main" },
      pusher: { name: input.by ?? "shlok1806" },
      sender: { login: input.by ?? "shlok1806" },
    });
    return { ...delivery, after };
  }

  /** Someone deletes a branch. */
  deleteBranch(branch: string): WebhookDelivery {
    const before = this.heads.get(branch) ?? NO_COMMIT;
    this.heads.delete(branch);
    return this.record("push", {
      ref: `refs/heads/${branch}`,
      before,
      after: NO_COMMIT,
      created: false,
      deleted: true,
      commits: [],
      repository: { full_name: this.repo, default_branch: "main" },
      sender: { login: "shlok1806" },
    });
  }

  /**
   * Someone merges a pull request on GitHub. The compare API answers for it with
   * `files`, and every Issue its body closes ("Closes #n") is closed. Returns the
   * `pull_request` delivery, then the `issues` deliveries for the closed Issues.
   */
  merge(number: number, files: ComparedFile[] = [], by = "shlok1806"): WebhookDelivery[] {
    const pr = this.pulls.get(number);
    if (pr === undefined) throw new Error(`The fake GitHub has no pull request #${number}.`);
    pr.state = "merged";
    const baseSha = this.heads.get(pr.base) ?? sha();
    const headSha = this.heads.get(pr.head) ?? sha();
    this.comparisons.set(`${baseSha}...${headSha}`, { commits: [], files });
    const mergeSha = sha();
    this.heads.set(pr.base, mergeSha);
    const merged = this.record("pull_request", {
      action: "closed",
      number,
      pull_request: {
        number,
        state: "closed",
        merged: true,
        merge_commit_sha: mergeSha,
        title: pr.title,
        body: pr.body,
        head: { ref: pr.head, sha: headSha },
        base: { ref: pr.base, sha: baseSha },
      },
      repository: { full_name: this.repo, default_branch: "main" },
      sender: { login: by },
    });
    const closes = [
      ...pr.body.matchAll(/\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) #(\d+)/gi),
    ];
    return [merged, ...closes.map((m) => this.close(Number(m[1]), by))];
  }

  /** A pull request closed without merging. */
  closeUnmerged(number: number): WebhookDelivery {
    const pr = this.pulls.get(number);
    if (pr === undefined) throw new Error(`The fake GitHub has no pull request #${number}.`);
    return this.record("pull_request", {
      action: "closed",
      number,
      pull_request: {
        number,
        merged: false,
        head: { ref: pr.head, sha: this.heads.get(pr.head) ?? sha() },
        base: { ref: pr.base, sha: this.heads.get(pr.base) ?? sha() },
      },
      repository: { full_name: this.repo, default_branch: "main" },
      sender: { login: "shlok1806" },
    });
  }

  /** A pull request, as a test sees it on github.com. */
  pullRequest(number: number): FakePullRequest | undefined {
    const pr = this.pulls.get(number);
    return pr === undefined ? undefined : { ...pr };
  }

  /** What GitHub holds for an Issue, as a test sees it on github.com. */
  issue(number: TaskNumber): {
    title: string;
    body: string;
    labels: string[];
    state: string;
    author: string;
    assignees: string[];
    comments: string[];
  } {
    const { title, body, labels, state, author, assignees, comments } = this.must(number);
    const bodies = comments.flatMap((id) => {
      const comment = this.commentBodies.get(id);
      return comment === undefined ? [] : [comment.body];
    });
    return { title, body, labels: [...labels], state, author, assignees: [...assignees], comments: bodies };
  }

  /** The IDs of an Issue's comments that still exist, oldest first. */
  commentIds(number: TaskNumber): number[] {
    return this.must(number).comments.filter((id) => this.commentBodies.has(id));
  }

  /** Someone deletes a comment on github.com. */
  deleteComment(id: number): void {
    this.commentBodies.delete(id);
  }

  /* ── The GitHub interface the Channel calls ─────────────── */

  async listOpenIssues(): Promise<GitHubIssue[]> {
    return [...this.issues.values()].filter((issue) => issue.state === "open").map((issue) => this.toIssue(issue));
  }

  async getIssue(number: TaskNumber): Promise<GitHubIssue | null> {
    const issue = this.issues.get(number);
    return issue === undefined ? null : this.toIssue(issue);
  }

  async createIssue(input: NewIssue): Promise<GitHubIssue> {
    const { number } = this.open({ ...input, by: this.botLogin });
    return this.toIssue(this.must(number));
  }

  async listSubIssues(number: TaskNumber): Promise<IssueRef[]> {
    return this.subIssues(number).map((issue) => ({ number: issue.number, state: issue.state }));
  }

  async listBlockedBy(number: TaskNumber): Promise<IssueRef[]> {
    return [...this.must(number).blockedBy].map((n) => ({ number: n, state: this.must(n).state }));
  }

  async listBlocking(number: TaskNumber): Promise<IssueRef[]> {
    return [...this.issues.values()]
      .filter((issue) => issue.blockedBy.has(number))
      .map((issue) => ({ number: issue.number, state: issue.state }));
  }

  async permission(login: string): Promise<Permission> {
    this.permissionChecks += 1;
    if (this.permissionsDown) throw new Error("GitHub answered 502 to the permission check");
    return this.permissions.get(login) ?? "write";
  }

  async addAssignees(number: TaskNumber, logins: string[]): Promise<void> {
    const issue = this.write(["addAssignees", number, logins]);
    for (const login of logins) if (!issue.assignees.includes(login)) issue.assignees.push(login);
  }

  async removeAssignees(number: TaskNumber, logins: string[]): Promise<void> {
    const issue = this.write(["removeAssignees", number, logins]);
    issue.assignees = issue.assignees.filter((login) => !logins.includes(login));
  }

  async addLabels(number: TaskNumber, labels: string[]): Promise<void> {
    const issue = this.write(["addLabels", number, labels]);
    for (const label of labels) if (!issue.labels.includes(label)) issue.labels.push(label);
  }

  async removeLabel(number: TaskNumber, label: string): Promise<void> {
    const issue = this.write(["removeLabel", number, label]);
    issue.labels = issue.labels.filter((l) => l !== label);
  }

  async createComment(number: TaskNumber, body: string): Promise<number> {
    const issue = this.write(["createComment", number, body]);
    const id = this.nextComment++;
    this.commentBodies.set(id, { issue: number, body });
    issue.comments.push(id);
    return id;
  }

  async updateComment(id: number, body: string): Promise<boolean> {
    if (this.failing.has("updateComment")) throw new Error("GitHub answered 500 to updateComment");
    this.calls.push(["updateComment", id, body]);
    const comment = this.commentBodies.get(id);
    if (comment === undefined) return false;
    comment.body = body;
    return true;
  }

  async setBody(number: TaskNumber, body: string): Promise<void> {
    this.write(["setBody", number, body]).body = body;
  }

  async defaultBranch(): Promise<string> {
    return "main";
  }

  async createPullRequest(input: NewPullRequest): Promise<PullRequestRef> {
    if (this.failing.has("createPullRequest")) throw new Error("GitHub answered 500 to createPullRequest");
    this.calls.push(["createPullRequest", input.head, input.base]);
    const open = [...this.pulls.values()].find((pr) => pr.state === "open" && pr.head === input.head);
    const pr: FakePullRequest = open ?? { number: this.nextNumber++, ...input, state: "open" };
    this.pulls.set(pr.number, pr);
    return { number: pr.number, url: `https://github.com/${this.repo}/pull/${pr.number}` };
  }

  async compare(base: string, head: string): Promise<Comparison> {
    const comparison = this.comparisons.get(`${base}...${head}`);
    if (comparison === undefined) throw new Error(`GitHub answered 404 to compare ${base}...${head}`);
    return comparison;
  }

  /* ── Internals ──────────────────────────────────────────── */

  /** Records a write, or fails it when the test says GitHub refuses that call. */
  private write(
    call: Exclude<MirrorCall, ["createPullRequest", string, string] | ["updateComment", number, string]>,
  ): FakeIssue {
    if (this.failing.has(call[0])) throw new Error(`GitHub answered 500 to ${call[0]}`);
    this.calls.push(call);
    return this.must(call[1]);
  }

  private subIssues(parent: TaskNumber): FakeIssue[] {
    return [...this.issues.values()].filter((issue) => issue.parent === parent);
  }

  private must(number: TaskNumber): FakeIssue {
    const issue = this.issues.get(number);
    if (issue === undefined) throw new Error(`The fake GitHub has no Issue #${number}.`);
    return issue;
  }

  private url(number: TaskNumber): string {
    return `https://github.com/${this.repo}/issues/${number}`;
  }

  private toIssue(issue: FakeIssue): GitHubIssue {
    const openBlockers = [...issue.blockedBy].filter((n) => this.issues.get(n)?.state === "open");
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: [...issue.labels],
      state: issue.state,
      url: this.url(issue.number),
      author: issue.author,
      ...(issue.closedBy === undefined ? {} : { closedBy: issue.closedBy }),
      ...(issue.parent === undefined ? {} : { parent: issue.parent }),
      subIssueCount: this.subIssues(issue.number).length,
      openBlockerCount: openBlockers.length,
    };
  }

  /** The REST-shaped Issue object a webhook payload carries. */
  private toPayload(issue: FakeIssue): Record<string, unknown> {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      html_url: this.url(issue.number),
      labels: issue.labels.map((name) => ({ name })),
      user: { login: issue.author },
    };
  }

  private issueEvent(action: string, issue: FakeIssue, by: string): WebhookDelivery {
    return this.record("issues", {
      action,
      issue: this.toPayload(issue),
      repository: { full_name: this.repo },
      sender: { login: by },
    });
  }

  private record(event: string, payload: Record<string, unknown>): WebhookDelivery {
    const delivery = { event, payload };
    this.outbox.push(delivery);
    return delivery;
  }
}
