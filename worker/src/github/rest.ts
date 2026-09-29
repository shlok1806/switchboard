// The real GitHub: the REST API, authenticated with the GITHUB_TOKEN Worker secret.

import type { TaskNumber } from "../../../shared/src/index";
import type { GitHub, GitHubIssue, IssueRef, IssueState, NewIssue } from "./types";

const API = "https://api.github.com";

/** The fields of a REST Issue object this module reads. */
interface RestIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url: string;
  repository_url?: string;
  user?: { login: string } | null;
  closed_by?: { login: string } | null;
  labels: (string | { name?: string })[];
  pull_request?: unknown;
  parent_issue_url?: string | null;
  sub_issues_summary?: { total: number };
  issue_dependencies_summary?: { blocked_by: number };
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function state(value: string): IssueState {
  return value === "closed" ? "closed" : "open";
}

export class RestGitHub implements GitHub {
  constructor(
    private readonly token: string,
    readonly repo: string,
  ) {}

  async listOpenIssues(): Promise<GitHubIssue[]> {
    const issues = await this.paginate<RestIssue>(`/repos/${this.repo}/issues?state=open`);
    return issues.filter((issue) => issue.pull_request === undefined).map((issue) => this.toIssue(issue));
  }

  async getIssue(number: TaskNumber): Promise<GitHubIssue | null> {
    const response = await this.request(`/repos/${this.repo}/issues/${number}`);
    // 404: never existed. 410: deleted. 301: transferred to another repo.
    if (response.status === 404 || response.status === 410 || response.status === 301) return null;
    const issue = await this.read<RestIssue>(response);
    if (issue.pull_request !== undefined || !this.isHome(issue)) return null;
    return this.toIssue(issue);
  }

  async createIssue(issue: NewIssue): Promise<GitHubIssue> {
    const response = await this.request(`/repos/${this.repo}/issues`, {
      method: "POST",
      body: JSON.stringify(issue),
    });
    return this.toIssue(await this.read<RestIssue>(response));
  }

  listSubIssues(number: TaskNumber): Promise<IssueRef[]> {
    return this.refs(`/repos/${this.repo}/issues/${number}/sub_issues`);
  }

  listBlockedBy(number: TaskNumber): Promise<IssueRef[]> {
    return this.refs(`/repos/${this.repo}/issues/${number}/dependencies/blocked_by`);
  }

  listBlocking(number: TaskNumber): Promise<IssueRef[]> {
    return this.refs(`/repos/${this.repo}/issues/${number}/dependencies/blocking`);
  }

  private async refs(path: string): Promise<IssueRef[]> {
    const issues = await this.paginate<RestIssue>(path);
    return issues
      .filter((issue) => this.isHome(issue))
      .map((issue) => ({ number: issue.number, state: state(issue.state) }));
  }

  private isHome(issue: RestIssue): boolean {
    if (issue.repository_url !== undefined) {
      return issue.repository_url.toLowerCase() === `${API}/repos/${this.repo}`.toLowerCase();
    }
    return issue.html_url.toLowerCase().startsWith(`https://github.com/${this.repo.toLowerCase()}/`);
  }

  private toIssue(issue: RestIssue): GitHubIssue {
    const parentUrl = `${API}/repos/${this.repo}/issues/`.toLowerCase();
    const parent = issue.parent_issue_url?.toLowerCase().startsWith(parentUrl)
      ? Number(issue.parent_issue_url.slice(parentUrl.length))
      : Number.NaN;
    const result: GitHubIssue = {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean),
      state: state(issue.state),
      url: issue.html_url,
      author: issue.user?.login ?? "ghost",
      subIssueCount: issue.sub_issues_summary?.total ?? 0,
      openBlockerCount: issue.issue_dependencies_summary?.blocked_by ?? 0,
    };
    if (issue.closed_by?.login) result.closedBy = issue.closed_by.login;
    if (Number.isInteger(parent)) result.parent = parent;
    return result;
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = `${API}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next !== null) {
      const response = await this.request(next);
      items.push(...(await this.read<T[]>(response)));
      next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("Link") ?? "")?.[1] ?? null;
    }
    return items;
  }

  private request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${API}${pathOrUrl}`;
    return fetch(url, {
      ...init,
      redirect: "manual",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "switchboard-channel",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  }

  private async read<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new GitHubApiError(response.status, `GitHub answered ${response.status}: ${detail.slice(0, 200)}`);
    }
    return response.json<T>();
  }
}
