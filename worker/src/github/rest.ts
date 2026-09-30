// The real GitHub: the REST API for one repo, authenticated with the GitHub App's
// installation token for that repo (app.ts).

import type { TaskNumber } from "../../../shared/src/index";
import type {
  Comparison,
  GitHub,
  GitHubIssue,
  IssueRef,
  IssueState,
  NewIssue,
  NewPullRequest,
  Permission,
  PullRequestRef,
} from "./types";

/** Where a RestGitHub gets its token: the App's installation token, minted and cached by app.ts. */
export interface TokenSource {
  token(): Promise<string>;
  /** Forgets the cached token after GitHub refused it, so the next call mints a new one. */
  invalidate(): void;
}

const GITHUB_API = "https://api.github.com";

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

/** The fields of a REST pull request object this module reads. */
interface RestPullRequest {
  number: number;
  html_url: string;
}

/** The fields of a REST comparison this module reads. */
interface RestComparison {
  commits: { sha: string; commit: { message: string } }[];
  files?: { filename: string; additions: number; deletions: number; patch?: string }[];
}

/** A ref in a URL path: slashes in branch names stay, everything else is escaped. */
function refPath(ref: string): string {
  return encodeURIComponent(ref).replace(/%2F/gi, "/");
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
  /** The repo's default branch, read once. */
  private mainBranch: Promise<string> | null = null;

  constructor(
    private readonly tokens: TokenSource,
    readonly repo: string,
    private readonly api = GITHUB_API,
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

  async permission(login: string): Promise<Permission> {
    const response = await this.request(`/repos/${this.repo}/collaborators/${encodeURIComponent(login)}/permission`);
    // 404: no such user, or not someone GitHub will say anything about.
    if (response.status === 404) {
      await response.body?.cancel();
      return "none";
    }
    const answer = await this.read<{ permission?: string; role_name?: string }>(response);
    // `permission` folds maintain into write and triage into read; `role_name` keeps them.
    const role = answer.role_name ?? answer.permission ?? "none";
    if (role === "admin" || answer.permission === "admin") return "admin";
    if (role === "maintain") return "maintain";
    if (role === "write" || answer.permission === "write") return "write";
    if (role === "triage") return "triage";
    return role === "read" || answer.permission === "read" ? "read" : "none";
  }

  async addAssignees(number: TaskNumber, logins: string[]): Promise<void> {
    await this.write("POST", `/repos/${this.repo}/issues/${number}/assignees`, { assignees: logins });
  }

  async removeAssignees(number: TaskNumber, logins: string[]): Promise<void> {
    await this.write("DELETE", `/repos/${this.repo}/issues/${number}/assignees`, { assignees: logins });
  }

  async addLabels(number: TaskNumber, labels: string[]): Promise<void> {
    await this.write("POST", `/repos/${this.repo}/issues/${number}/labels`, { labels });
  }

  async removeLabel(number: TaskNumber, label: string): Promise<void> {
    const response = await this.request(`/repos/${this.repo}/issues/${number}/labels/${encodeURIComponent(label)}`, {
      method: "DELETE",
    });
    // 404: the Issue does not carry the label, which is what we wanted.
    if (response.status !== 404) await this.check(response);
  }

  async createComment(number: TaskNumber, body: string): Promise<number> {
    const response = await this.request(`/repos/${this.repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    return (await this.read<{ id: number }>(response)).id;
  }

  async updateComment(id: number, body: string): Promise<boolean> {
    const response = await this.request(`/repos/${this.repo}/issues/comments/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
    // 404: the comment was deleted.
    if (response.status === 404) {
      await response.body?.cancel();
      return false;
    }
    await this.check(response);
    return true;
  }

  async setBody(number: TaskNumber, body: string): Promise<void> {
    await this.write("PATCH", `/repos/${this.repo}/issues/${number}`, { body });
  }

  async defaultBranch(): Promise<string> {
    this.mainBranch ??= this.request(`/repos/${this.repo}`)
      .then((response) => this.read<{ default_branch: string }>(response))
      .then((repo) => repo.default_branch);
    try {
      return await this.mainBranch;
    } catch (error) {
      this.mainBranch = null;
      throw error;
    }
  }

  async createPullRequest(pr: NewPullRequest): Promise<PullRequestRef> {
    const response = await this.request(`/repos/${this.repo}/pulls`, { method: "POST", body: JSON.stringify(pr) });
    // 422: most often, an open pull request from this branch already exists.
    if (response.status === 422) {
      const refused = new GitHubApiError(422, `GitHub answered 422: ${(await response.text()).slice(0, 200)}`);
      const owner = this.repo.split("/")[0] ?? "";
      const query = new URLSearchParams({ head: `${owner}:${pr.head}`, base: pr.base, state: "open" });
      const open = await this.read<RestPullRequest[]>(await this.request(`/repos/${this.repo}/pulls?${query}`));
      const existing = open[0];
      if (existing === undefined) throw refused;
      return { number: existing.number, url: existing.html_url };
    }
    const created = await this.read<RestPullRequest>(response);
    return { number: created.number, url: created.html_url };
  }

  async compare(base: string, head: string): Promise<Comparison> {
    const response = await this.request(`/repos/${this.repo}/compare/${refPath(base)}...${refPath(head)}`);
    const comparison = await this.read<RestComparison>(response);
    return {
      commits: comparison.commits.map((c) => ({ sha: c.sha, message: c.commit.message })),
      files: (comparison.files ?? []).map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        ...(file.patch === undefined ? {} : { patch: file.patch }),
      })),
    };
  }

  private async write(method: string, path: string, body: unknown): Promise<void> {
    await this.check(await this.request(path, { method, body: JSON.stringify(body) }));
  }

  private async refs(path: string): Promise<IssueRef[]> {
    const issues = await this.paginate<RestIssue>(path);
    return issues
      .filter((issue) => this.isHome(issue))
      .map((issue) => ({ number: issue.number, state: state(issue.state) }));
  }

  private isHome(issue: RestIssue): boolean {
    if (issue.repository_url !== undefined) {
      return issue.repository_url.toLowerCase() === `${this.api}/repos/${this.repo}`.toLowerCase();
    }
    return issue.html_url.toLowerCase().startsWith(`https://github.com/${this.repo.toLowerCase()}/`);
  }

  private toIssue(issue: RestIssue): GitHubIssue {
    const parentUrl = `${this.api}/repos/${this.repo}/issues/`.toLowerCase();
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
    let next: string | null = `${this.api}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next !== null) {
      const response = await this.request(next);
      items.push(...(await this.read<T[]>(response)));
      next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("Link") ?? "")?.[1] ?? null;
    }
    return items;
  }

  /** One call, retried once with a fresh token when GitHub refuses the cached one. */
  private async request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.api}${pathOrUrl}`;
    const send = async () =>
      fetch(url, {
        ...init,
        redirect: "manual",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${await this.tokens.token()}`,
          "Content-Type": "application/json",
          "User-Agent": "switchboard-channel",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    const response = await send();
    if (response.status !== 401) return response;
    await response.body?.cancel();
    this.tokens.invalidate();
    return send();
  }

  private async read<T>(response: Response): Promise<T> {
    await this.check(response, false);
    return response.json<T>();
  }

  /** Throws when GitHub refused. With `drain`, a successful body is discarded. */
  private async check(response: Response, drain = true): Promise<void> {
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new GitHubApiError(response.status, `GitHub answered ${response.status}: ${detail.slice(0, 200)}`);
    }
    if (drain) await response.body?.cancel();
  }
}
