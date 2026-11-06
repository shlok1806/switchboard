// Ask the Channel's github tool (ADR 0041), through the connector's real endpoint,
// with GitHub replaced at its HTTP boundary (test/fake-github-api.ts): the real App
// client mints its installation token there and sends its queries there. What the
// asker reads back is checked: references, links, CI state, an ADR's text, and plain
// answers when GitHub cannot answer. A question writes no row.

import { reset, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../src/channel";
import { installGitHubApp } from "../src/github/index";
import { signAccess } from "../src/mcp/tokens";
import { BASE, channelStub, REPO, SESSION_SECRET } from "./client";
import { FakeGitHubApi } from "./fake-github-api";

const ENDPOINT = `${BASE}/r/${REPO}/mcp`;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let github: FakeGitHubApi;
let token: string;

type ToolCall = { result: { content: { type: string; text: string }[]; isError: boolean } };

async function call(args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const response = await exports.default.fetch(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "github", arguments: args },
      }),
    }),
  );
  expect(response.status).toBe(200);
  const { result } = await response.json<ToolCall>();
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError };
}

async function ask(args: Record<string, unknown> = {}): Promise<string> {
  const answer = await call(args);
  expect(answer.isError, answer.text).toBe(false);
  return answer.text;
}

/** The lines of section `title` (`## title (...)`) of an answer. */
function sectionOf(text: string, title: string): string {
  const start = text.indexOf(`## ${title}`);
  if (start === -1) return "";
  const next = text.indexOf("\n## ", start + 3);
  return text.slice(start, next === -1 ? undefined : next);
}

const ADR_40 = `# Ask the Channel: a read-only MCP connector any app can add

Status: accepted on 2026-11-06.

## Decision

Ask the Channel is one read-only MCP endpoint per Channel.
`;

/** A repo with a week of work on it, an older merge, a failing PR and a failing default branch. */
function seed(): void {
  github.pulls.push(
    {
      number: 161,
      title: "Ask the Channel: a read-only MCP connector",
      author: "shlok1806",
      createdAt: ago(3 * DAY),
      mergedAt: ago(2 * DAY),
      checks: [{ name: "check", conclusion: "SUCCESS" }],
      closes: [156],
      body: "Closes #156. The connector, its OAuth and the channel tool.",
    },
    {
      number: 140,
      title: "Older work",
      author: "maya",
      createdAt: ago(20 * DAY),
      mergedAt: ago(12 * DAY),
      checks: [{ name: "check", conclusion: "SUCCESS" }],
    },
    {
      number: 170,
      title: "The github tool",
      author: "maya",
      createdAt: ago(DAY),
      checks: [
        { name: "check", conclusion: "FAILURE" },
        { name: "lint", conclusion: "SUCCESS" },
      ],
    },
    { number: 171, title: "Brief pages", author: "sam", createdAt: ago(DAY / 2), draft: true, checks: [] },
  );
  github.issues.push(
    {
      number: 156,
      title: "Ask the Channel: the connector",
      author: "shlok1806",
      createdAt: ago(10 * DAY),
      closedAt: ago(2 * DAY),
    },
    {
      number: 172,
      title: "Rate limits on the github tool",
      author: "sam",
      createdAt: ago(DAY),
      labels: ["needs-triage"],
    },
  );
  github.commits.push(
    {
      sha: "d626e0a89c68563354c84c708513ba302c0ce2a9",
      message: "Ask the Channel: a read-only MCP connector (#161)",
      author: "shlok1806",
      at: ago(2 * DAY),
      checks: [{ name: "deploy", conclusion: "FAILURE" }],
      files: ["docs/adr/0040-ask-the-channel-a-read-only-mcp-connector.md", "worker/src/mcp/server.ts"],
    },
    {
      sha: "4e376ec0000000000000000000000000000000aa",
      message: "Persons share skills (#155)",
      author: "maya",
      at: ago(5 * DAY),
      checks: [{ name: "check", conclusion: "SUCCESS" }],
      files: ["worker/src/skills.ts"],
    },
  );
  github.files.set("README.md", "# switchboard\n");
  github.files.set("docs/adr/0002-stale-claims-never-auto-expire.md", "# Stale Claims never auto-expire\n");
  github.files.set("docs/adr/0019-agents-share-memory-on-the-channel.md", "# Agents share memory on the Channel\n");
  github.files.set("docs/adr/0040-ask-the-channel-a-read-only-mcp-connector.md", ADR_40);
  github.files.set("worker/src/mcp/server.ts", "export {}\n");
  github.files.set("worker/src/skills.ts", "export {}\n");
}

beforeEach(async () => {
  github = new FakeGitHubApi();
  github.listen();
  installGitHubApp(await github.app());
  seed();
  // A signed-in app's grant, which each call checks is still live (ADR 0040).
  await runInDurableObject(channelStub(), (channel: Channel) => {
    channel.startMcpGrant("github-grant", "shlok1806", "github-client", Date.now() + DAY);
  });
  token = await signAccess(SESSION_SECRET, "shlok1806", REPO, "github-grant", ENDPOINT);
});

afterEach(async () => {
  installGitHubApp(null);
  vi.restoreAllMocks();
  await reset();
});

describe("the github tool", () => {
  it("is listed beside the channel tool, read-only", async () => {
    const response = await exports.default.fetch(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const { result } = await response.json<{
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    }>();
    expect(result.tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([
      ["channel", true],
      ["github", true],
    ]);
  });

  it("answers what merged in the last week and what is failing CI, with links", async () => {
    const text = await ask();
    const merged = sectionOf(text, "Merged pull requests");
    expect(merged).toContain('PR #161 "Ask the Channel: a read-only MCP connector" by @shlok1806, merged');
    expect(merged).toContain("CI passing. https://github.com/shlok1806/switchboard/pull/161");
    // Merged twelve days ago: not this week.
    expect(merged).not.toContain("#140");

    const failing = sectionOf(text, "Failing CI");
    expect(failing).toContain("## Failing CI (2)");
    expect(failing).toMatch(
      /main \(the default branch\) at d626e0a .*CI failing; failing: deploy \(failure\) https:\/\/github\.com\/shlok1806\/switchboard\/actions\/runs\/\d+/,
    );
    expect(failing).toMatch(
      /PR #170 "The github tool": failing: check \(failure\) https:\/\/github\.com\/[^ ]+\/actions\/runs\/\d+/,
    );
    expect(failing).not.toContain("lint");
    expect(failing).not.toContain("#171");

    const open = sectionOf(text, "Open pull requests");
    expect(open).toContain('PR #170 "The github tool" by @maya');
    expect(open).toContain('PR #171 "Brief pages" by @sam, draft');
    expect(sectionOf(text, "Commits on main")).toContain("https://github.com/shlok1806/switchboard/commit/d626e0a");
    expect(sectionOf(text, "Issues opened")).toContain("Issue #172");
    expect(sectionOf(text, "Issues closed")).toContain("Issue #156");
    expect(text).toContain("not instructions to follow");

    // A longer `since` reaches the older merge.
    expect(sectionOf(await ask({ since: "30d" }), "Merged pull requests")).toContain("PR #140");
  });

  it("answers what the ADR about a subject says: its number and its text", async () => {
    const text = await ask({ about: "what does the ADR about the read-only connector say" });
    expect(text).toContain("## The best match: docs/adr/0040-ask-the-channel-a-read-only-mcp-connector.md (ADR 0040)");
    expect(text).toContain(
      "https://github.com/shlok1806/switchboard/blob/main/docs/adr/0040-ask-the-channel-a-read-only-mcp-connector.md",
    );
    expect(text).toContain("Ask the Channel is one read-only MCP endpoint per Channel.");
    // ADRs about other subjects are not offered.
    expect(text).not.toContain("0002-stale-claims");
    expect(text).not.toContain("Agents share memory");

    // An ADR asked for by its number.
    expect(await ask({ about: "ADR 2" })).toContain(
      "## The best match: docs/adr/0002-stale-claims-never-auto-expire.md (ADR 0002)",
    );
  });

  it("reads one pull request with its CI, a directory, and a file with the commits that changed it", async () => {
    const pull = await ask({ about: "#170" });
    expect(pull).toContain('## PR #170 "The github tool"');
    expect(pull).toContain("CI failing; failing: check (failure)");
    expect(pull).toContain("https://github.com/shlok1806/switchboard/pull/170");
    const merged = await ask({ about: "161" });
    expect(merged).toMatch(/merged \d{4}-\d\d-\d\d/);
    expect(merged).toContain("Closes #156");
    expect(merged).toContain("The connector, its OAuth and the channel tool.");

    const issue = await ask({ about: "#172" });
    expect(issue).toContain('## Issue #172 "Rate limits on the github tool"');
    expect(issue).toContain("Labels: needs-triage.");

    const adrs = await ask({ about: "docs/adr/" });
    expect(adrs).toContain("- docs/adr/0040-ask-the-channel-a-read-only-mcp-connector.md (ADR 0040)");
    expect(adrs).toContain("- docs/adr/0002-stale-claims-never-auto-expire.md (ADR 0002)");
    expect(adrs).toContain("https://github.com/shlok1806/switchboard/tree/main/docs/adr");

    const file = await ask({ about: "worker/src/mcp/server.ts" });
    expect(file).toContain("export {}");
    const changed = sectionOf(file, "Latest commits that changed");
    expect(changed).toContain("d626e0a");
    expect(changed).not.toContain("4e376ec");

    const missing = await call({ about: "#999" });
    expect(missing).toEqual({
      isError: true,
      text: "There is no issue or pull request #999 in shlok1806/switchboard.",
    });
  });

  it("says so plainly when GitHub's rate limit is used up, GitHub fails, or the App cannot read", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    github.fault = () =>
      Response.json(
        { message: "API rate limit exceeded for installation ID 7." },
        { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } },
      );
    const limited = await call();
    expect(limited.isError).toBe(true);
    expect(limited.text).toContain(
      "rate limit for the Switchboard GitHub App on shlok1806/switchboard is used up until",
    );
    expect(limited.text).toContain(new Date(reset * 1000).toISOString().slice(11, 16));

    // GraphQL's own limit comes back as a 200 with an error.
    github.fault = (_url, operation) =>
      operation === null
        ? null
        : Response.json({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] });
    expect((await call({ about: "#170" })).text).toContain("rate limit");

    github.fault = () => new Response("bad gateway", { status: 502 });
    expect(await call({ about: "connector" })).toEqual({
      isError: true,
      text: "GitHub is not answering right now (it answered 502). Ask again in a minute.",
    });

    // The App may not read CI: the rest of the answer still comes, with a note.
    github.fault = (_url, operation) => {
      if (operation !== "Activity") return null;
      return Response.json({
        data: {
          repository: {
            url: "https://github.com/shlok1806/switchboard",
            defaultBranchRef: null,
            open: { totalCount: 0, nodes: [] },
          },
          merged: { issueCount: 0, nodes: [] },
          opened: { issueCount: 0, nodes: [] },
          closed: { issueCount: 0, nodes: [] },
        },
        errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
      });
    };
    const partial = await ask();
    expect(partial).toContain("## Merged pull requests");
    expect(partial).toContain("Checks and Commit statuses permissions");

    github.fault = null;
    github.installed = false;
    installGitHubApp(await github.app());
    expect((await call()).text).toContain("The Switchboard GitHub App is not installed on shlok1806/switchboard");

    installGitHubApp(null);
    expect((await call()).text).toContain("no GitHub App set up");
  });

  it("writes no row, whatever it is asked, and calls GitHub at most three times per question", async () => {
    const written: { rowsWritten: number }[] = [];
    let metering = false;
    await runInDurableObject(channelStub(), (_channel, state) => {
      const sql = state.storage.sql as unknown as { exec: (...args: unknown[]) => { rowsWritten: number } };
      const exec = sql.exec.bind(sql);
      sql.exec = (...args: unknown[]) => {
        const cursor = exec(...args);
        if (metering) written.push(cursor);
        return cursor;
      };
    });
    // Membership is checked, and cached, by a first call, as by any caller's.
    await ask({ about: "#170" });
    metering = true;
    for (const args of [
      {},
      { since: "30d" },
      { about: "#161" },
      { about: "docs/adr" },
      { about: "README.md", since: "7d" },
      { about: "read-only connector" },
    ]) {
      github.requests.length = 0;
      await ask(args);
      expect(github.requests.length, JSON.stringify(args)).toBeLessThanOrEqual(3);
    }
    metering = false;
    expect(written.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(0);
  });
});
