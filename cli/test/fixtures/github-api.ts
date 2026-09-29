// A stand-in for the GitHub REST API, for the end-to-end test: the Worker running in
// `wrangler dev` points GITHUB_API_URL here. It answers only the calls the Channel
// makes, keeps Issues in memory, and records every write so the test can check what
// GitHub would show.

import { createServer, type IncomingMessage, type Server } from "node:http";

export interface ApiIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  comments: string[];
  state: "open" | "closed";
}

export class GitHubApi {
  readonly issues = new Map<number, ApiIssue>();
  /** Every write, as `METHOD path`, oldest first. */
  readonly writes: string[] = [];
  readonly login = "switchboard-bot";
  private server: Server | null = null;
  private url = "";

  constructor(readonly repo: string) {}

  open(title: string, body = ""): number {
    const number = this.issues.size + 1;
    this.issues.set(number, { number, title, body, labels: [], assignees: [], comments: [], state: "open" });
    return number;
  }

  async start(port: number): Promise<string> {
    this.url = `http://127.0.0.1:${port}`;
    this.server = createServer((request, response) => {
      void this.handle(request).then(
        ({ status, body }) => {
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(body === undefined ? "" : JSON.stringify(body));
        },
        (error: Error) => {
          response.writeHead(500);
          response.end(JSON.stringify({ message: error.message }));
        },
      );
    });
    await new Promise<void>((resolve) => this.server?.listen(port, "127.0.0.1", resolve));
    return this.url;
  }

  stop(): void {
    this.server?.close();
  }

  private toRest(issue: ApiIssue) {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      html_url: `https://github.com/${this.repo}/issues/${issue.number}`,
      repository_url: `${this.url}/repos/${this.repo}`,
      user: { login: "shlok1806" },
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login })),
      sub_issues_summary: { total: 0 },
      issue_dependencies_summary: { blocked_by: 0 },
    };
  }

  private async handle(request: IncomingMessage): Promise<{ status: number; body?: unknown }> {
    const url = new URL(request.url ?? "/", this.url);
    const method = request.method ?? "GET";
    let text = "";
    for await (const chunk of request) text += chunk;
    const input = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (method === "GET" && url.pathname === "/user") return { status: 200, body: { login: this.login } };
    const prefix = `/repos/${this.repo}/issues`;
    if (!url.pathname.startsWith(prefix)) return { status: 404, body: { message: "Not Found" } };
    if (method === "GET" && url.pathname === prefix) {
      const open = [...this.issues.values()].filter((issue) => issue.state === "open");
      return { status: 200, body: open.map((issue) => this.toRest(issue)) };
    }
    const match = /^\/(\d+)(?:\/(assignees|labels|comments)(?:\/(.+))?)?$/.exec(url.pathname.slice(prefix.length));
    const issue = match ? this.issues.get(Number(match[1])) : undefined;
    if (!match || !issue) return { status: 404, body: { message: "Not Found" } };
    const [, , part, rest] = match;
    if (method !== "GET") this.writes.push(`${method} ${url.pathname}`);

    if (part === undefined && method === "GET") return { status: 200, body: this.toRest(issue) };
    if (part === undefined && method === "PATCH") {
      if (typeof input.body === "string") issue.body = input.body;
      return { status: 200, body: this.toRest(issue) };
    }
    if (part === "assignees") {
      const logins = (input.assignees as string[]) ?? [];
      issue.assignees =
        method === "POST"
          ? [...new Set([...issue.assignees, ...logins])]
          : issue.assignees.filter((l) => !logins.includes(l));
      return { status: 200, body: this.toRest(issue) };
    }
    if (part === "labels" && method === "POST") {
      issue.labels = [...new Set([...issue.labels, ...((input.labels as string[]) ?? [])])];
      return { status: 200, body: issue.labels.map((name) => ({ name })) };
    }
    if (part === "labels" && method === "DELETE" && rest) {
      const name = decodeURIComponent(rest);
      if (!issue.labels.includes(name)) return { status: 404, body: { message: "Label does not exist" } };
      issue.labels = issue.labels.filter((l) => l !== name);
      return { status: 200, body: issue.labels.map((l) => ({ name: l })) };
    }
    if (part === "comments" && method === "POST") {
      issue.comments.push(String(input.body));
      return { status: 201, body: { body: input.body } };
    }
    return { status: 404, body: { message: "Not Found" } };
  }
}
