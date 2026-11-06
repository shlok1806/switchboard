// A stand-in for GitHub's HTTP API, as far as the connector's github tool reads it
// (ADR 0041): the App's installation token, the GraphQL queries it sends, and the
// recursive tree. It keeps pull requests, issues, commits and files, and answers
// from them, so a test says what is on GitHub and reads what the tool made of it.
// The real GitHubApp client talks to it, through a spied `fetch`.

import { vi } from "vitest";
import { GitHubApp } from "../src/github/index";

export const API = "https://api.github.test";
const WEB = "https://github.com";

export interface FakeCheck {
  name: string;
  /** null while it runs. */
  conclusion: "SUCCESS" | "FAILURE" | "TIMED_OUT" | "CANCELLED" | "SKIPPED" | null;
}

export interface FakePull {
  number: number;
  title: string;
  author: string;
  createdAt: string;
  mergedAt?: string;
  closedAt?: string;
  draft?: boolean;
  head?: string;
  body?: string;
  checks?: FakeCheck[];
  closes?: number[];
}

export interface FakeIssue {
  number: number;
  title: string;
  author: string;
  createdAt: string;
  closedAt?: string;
  body?: string;
  labels?: string[];
}

export interface FakeCommit {
  sha: string;
  message: string;
  author: string;
  at: string;
  checks?: FakeCheck[];
  /** The paths it changed. */
  files: string[];
}

/** What a test makes GitHub answer instead, for one request. */
export type Fault = (url: URL, operation: string | null) => Response | null;

let keyPem: Promise<string> | null = null;
let apps = 0;

async function privateKey(): Promise<string> {
  keyPem ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
  })();
  return keyPem;
}

export class FakeGitHubApi {
  readonly pulls: FakePull[] = [];
  readonly issues: FakeIssue[] = [];
  /** The default branch's commits, newest first. */
  readonly commits: FakeCommit[] = [];
  readonly files = new Map<string, string>();
  /** Every request, as `METHOD path` or `graphql Operation`. */
  readonly requests: string[] = [];
  fault: Fault | null = null;
  /** Whether the App is installed on the repo. */
  installed = true;

  constructor(readonly repo = "shlok1806/switchboard") {}

  /** A real GitHub App client pointed at this stand-in, with a fresh App ID so no token is cached. */
  async app(): Promise<GitHubApp> {
    apps += 1;
    return new GitHubApp({
      appId: `fake-${apps}`,
      privateKey: await privateKey(),
      clientId: "c",
      clientSecret: "s",
      api: API,
    });
  }

  /** Answers every request to the API from now on; every other `fetch` goes where it was going. */
  listen(): void {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== API) return real(input, init);
      return this.answer(request, url);
    });
  }

  private get repoUrl(): string {
    return `${WEB}/${this.repo}`;
  }

  private async answer(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === `/repos/${this.repo}/installation`) {
      this.requests.push(`GET ${path}`);
      return this.installed ? Response.json({ id: 7 }) : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (path === "/app/installations/7/access_tokens") {
      this.requests.push(`POST ${path}`);
      return Response.json(
        { token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      );
    }
    let operation: string | null = null;
    let body: { query: string; variables: Record<string, unknown> } | null = null;
    if (path === "/graphql" && request.method === "POST") {
      body = await request.json();
      operation = /query\s+(\w+)/.exec(body?.query ?? "")?.[1] ?? null;
      this.requests.push(`graphql ${operation}`);
    } else {
      this.requests.push(`${request.method} ${path}`);
    }
    if (request.headers.get("Authorization") !== "Bearer ghs_fake") {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    const faulted = this.fault?.(url, operation) ?? null;
    if (faulted !== null) return faulted;
    if (body !== null) {
      if (/\bmutation\b/.test(body.query)) return Response.json({ errors: [{ message: "No mutations here" }] });
      return Response.json({ data: this.query(operation, body.variables) });
    }
    if (path === `/repos/${this.repo}/git/trees/HEAD` && url.searchParams.get("recursive") === "1") {
      return Response.json({ sha: "head", truncated: false, tree: this.tree() });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }

  private tree(): { path: string; type: string }[] {
    const dirs = new Set<string>();
    for (const file of this.files.keys()) {
      const parts = file.split("/");
      for (let n = 1; n < parts.length; n++) dirs.add(parts.slice(0, n).join("/"));
    }
    return [
      ...[...dirs].map((path) => ({ path, type: "tree" })),
      ...[...this.files.keys()].map((path) => ({ path, type: "blob" })),
    ];
  }

  private query(operation: string | null, variables: Record<string, unknown>): unknown {
    const repository = { url: this.repoUrl, defaultBranchRef: { name: "main" } };
    switch (operation) {
      case "Activity": {
        const since = String(variables.since);
        const head = this.commits[0];
        const history = this.commits.filter((c) => c.at >= since);
        const open = this.pulls
          .filter((p) => p.mergedAt === undefined && p.closedAt === undefined)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return {
          repository: {
            url: this.repoUrl,
            defaultBranchRef:
              head === undefined
                ? null
                : {
                    name: "main",
                    target: {
                      oid: head.sha,
                      ...this.commitNode(head),
                      history: { totalCount: history.length, nodes: history.map((c) => this.commitNode(c)) },
                    },
                  },
            open: { totalCount: open.length, nodes: open.map((p) => this.pullNode(p)) },
          },
          merged: this.search(String(variables.merged)),
          opened: this.search(String(variables.opened)),
          closed: this.search(String(variables.closed)),
        };
      }
      case "Item": {
        const number = Number(variables.number);
        const pull = this.pulls.find((p) => p.number === number);
        const issue = this.issues.find((i) => i.number === number);
        const found =
          pull !== undefined
            ? {
                __typename: "PullRequest",
                ...this.pullNode(pull),
                state: pull.mergedAt !== undefined ? "MERGED" : pull.closedAt !== undefined ? "CLOSED" : "OPEN",
                closedAt: pull.closedAt ?? pull.mergedAt ?? null,
                body: pull.body ?? "",
                baseRefName: "main",
                additions: 120,
                deletions: 8,
                changedFiles: 4,
                labels: { nodes: [] },
                closingIssuesReferences: {
                  nodes: (pull.closes ?? []).map((n) => {
                    const closed = this.issues.find((i) => i.number === n);
                    return { number: n, title: closed?.title ?? "", url: `${this.repoUrl}/issues/${n}` };
                  }),
                },
              }
            : issue !== undefined
              ? {
                  __typename: "Issue",
                  ...this.issueNode(issue),
                  stateReason: issue.closedAt === undefined ? null : "COMPLETED",
                  body: issue.body ?? "",
                  labels: { nodes: (issue.labels ?? []).map((name) => ({ name })) },
                  comments: { totalCount: 2 },
                }
              : null;
        return { repository: { url: this.repoUrl, issueOrPullRequest: found } };
      }
      case "Path": {
        const target = String(variables.expression).replace(/^HEAD:/, "");
        const since = typeof variables.since === "string" ? variables.since : "";
        const touched = this.commits.filter(
          (c) => c.at >= since && c.files.some((f) => target === "" || f === target || f.startsWith(`${target}/`)),
        );
        return {
          repository: {
            url: this.repoUrl,
            defaultBranchRef: {
              name: "main",
              target: {
                history: { nodes: touched.map((c) => ({ ...this.commitNode(c), statusCheckRollup: undefined })) },
              },
            },
            object: this.object(target),
          },
        };
      }
      case "Blob": {
        const target = String(variables.expression).replace(/^HEAD:/, "");
        return { repository: { object: this.object(target) } };
      }
      case "Search":
        return { repository, found: this.search(String(variables.words)) };
      default:
        throw new Error(`The fake GitHub has no query ${operation}`);
    }
  }

  private object(target: string): unknown {
    const text = this.files.get(target);
    if (text !== undefined)
      return { __typename: "Blob", text, byteSize: text.length, isBinary: false, isTruncated: false };
    const prefix = target === "" ? "" : `${target}/`;
    const children = new Map<string, string>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const [first, ...rest] = file.slice(prefix.length).split("/");
      if (first !== undefined) children.set(first, rest.length > 0 ? "tree" : "blob");
    }
    if (children.size === 0) return null;
    return {
      __typename: "Tree",
      entries: [...children].map(([name, type]) => ({ name, type, path: `${prefix}${name}` })),
    };
  }

  /** GitHub's issue search, for the qualifiers the tool sends and words, all of which must match. */
  private search(query: string): { issueCount: number; nodes: unknown[] } {
    const terms = query.split(/\s+/).filter(Boolean);
    let kind: "pr" | "issue" | null = null;
    let merged = false;
    let closed = false;
    const after: Record<string, string> = {};
    const words: string[] = [];
    for (const term of terms) {
      const qualifier = /^(\w+):(>=)?(.+)$/.exec(term);
      if (qualifier === null) {
        words.push(term.toLowerCase());
        continue;
      }
      const [, key, , value = ""] = qualifier;
      if (key === "is" && (value === "pr" || value === "issue")) kind = value;
      else if (key === "is" && value === "merged") merged = true;
      else if (key === "is" && value === "closed") closed = true;
      else if (key === "merged" || key === "created" || key === "closed") after[key] = value;
      else if (key === "repo" && value.toLowerCase() !== this.repo) return { issueCount: 0, nodes: [] };
    }
    const matchesWords = (title: string, body = "") => words.every((w) => `${title} ${body}`.toLowerCase().includes(w));
    const pulls = this.pulls.filter(
      (p) =>
        kind !== "issue" &&
        (!merged || p.mergedAt !== undefined) &&
        (after.merged === undefined || (p.mergedAt ?? "") >= after.merged) &&
        (after.created === undefined || p.createdAt >= after.created) &&
        matchesWords(p.title, p.body),
    );
    const issues = this.issues.filter(
      (i) =>
        kind !== "pr" &&
        !merged &&
        (!closed || i.closedAt !== undefined) &&
        (after.closed === undefined || (i.closedAt ?? "") >= after.closed) &&
        (after.created === undefined || i.createdAt >= after.created) &&
        matchesWords(i.title, i.body),
    );
    const nodes = [
      ...pulls.map((p) => ({ __typename: "PullRequest", ...this.pullNode(p), state: p.mergedAt ? "MERGED" : "OPEN" })),
      ...issues.map((i) => ({ __typename: "Issue", ...this.issueNode(i) })),
    ];
    return { issueCount: nodes.length, nodes };
  }

  private rollup(checks: FakeCheck[] | undefined): unknown {
    if (checks === undefined || checks.length === 0) return null;
    const failing = checks.some((c) => c.conclusion !== null && !["SUCCESS", "SKIPPED"].includes(c.conclusion));
    const running = checks.some((c) => c.conclusion === null);
    return {
      state: failing ? "FAILURE" : running ? "PENDING" : "SUCCESS",
      contexts: {
        nodes: checks.map((c, n) => ({
          __typename: "CheckRun",
          name: c.name,
          conclusion: c.conclusion,
          status: c.conclusion === null ? "IN_PROGRESS" : "COMPLETED",
          detailsUrl: `${this.repoUrl}/actions/runs/${1000 + n}/job/${2000 + n}`,
        })),
      },
    };
  }

  private commitNode(commit: FakeCommit) {
    return {
      abbreviatedOid: commit.sha.slice(0, 7),
      messageHeadline: commit.message,
      committedDate: commit.at,
      url: `${this.repoUrl}/commit/${commit.sha}`,
      author: { name: commit.author, user: { login: commit.author } },
      statusCheckRollup: this.rollup(commit.checks),
    };
  }

  private pullNode(pull: FakePull) {
    return {
      number: pull.number,
      title: pull.title,
      url: `${this.repoUrl}/pull/${pull.number}`,
      isDraft: pull.draft === true,
      createdAt: pull.createdAt,
      mergedAt: pull.mergedAt ?? null,
      headRefName: pull.head ?? `task-${pull.number}`,
      author: { login: pull.author },
      commits: { nodes: [{ commit: { statusCheckRollup: this.rollup(pull.checks) } }] },
    };
  }

  private issueNode(issue: FakeIssue) {
    return {
      number: issue.number,
      title: issue.title,
      url: `${this.repoUrl}/issues/${issue.number}`,
      state: issue.closedAt === undefined ? "OPEN" : "CLOSED",
      createdAt: issue.createdAt,
      closedAt: issue.closedAt ?? null,
      author: { login: issue.author },
    };
  }
}
