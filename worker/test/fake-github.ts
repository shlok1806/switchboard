// An in-memory GitHub for tests. It keeps Issues, sub-issues and dependencies, and
// every change made "on GitHub" returns the webhook delivery GitHub would send, so a
// test decides whether to deliver it or let it go missing.

import type { TaskNumber } from "../../shared/src/index";
import type { GitHub, GitHubIssue, IssueRef, NewIssue } from "../src/github/index";

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
}

export interface WebhookDelivery {
  /** The `X-GitHub-Event` header. */
  event: string;
  payload: Record<string, unknown>;
}

export class FakeGitHub implements GitHub {
  readonly repo = "shlok1806/switchboard";
  /** The login the Channel's GITHUB_TOKEN belongs to; Issues it creates are authored by it. */
  readonly tokenLogin = "switchboard-bot";
  /** Every delivery GitHub would have sent, oldest first. */
  readonly outbox: WebhookDelivery[] = [];
  private readonly issues = new Map<TaskNumber, FakeIssue>();
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

  /** What GitHub holds for an Issue, as a test sees it on github.com. */
  issue(number: TaskNumber): { title: string; body: string; labels: string[]; state: string; author: string } {
    const { title, body, labels, state, author } = this.must(number);
    return { title, body, labels, state, author };
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
    const { number } = this.open({ ...input, by: this.tokenLogin });
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

  /* ── Internals ──────────────────────────────────────────── */

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
