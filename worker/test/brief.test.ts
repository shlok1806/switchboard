// The Brief (ADR 0042), driven the way it is used: Agents write pages through the
// Channel API with their own tokens, as their MCP's brief_write does; the Connector's
// brief tool, the Dashboard and other Agents read them back. What the Connector can
// never do is in ask-channel.test.ts, and what a day of writes costs in rows-written.test.ts.

import { reset, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  AgentResponse,
  BriefPageResponse,
  BriefResponse,
  ErrorResponse,
  WriteBriefResponse,
} from "../../shared/src/index";
import { BRIEF_HISTORY, briefPagePath, MAX_BRIEF_PAGES } from "../../shared/src/index";
import type { Channel } from "../src/channel";
import { signAccess } from "../src/mcp/tokens";
import { BASE, bearer, channelStub, forgetTokens, REPO, remember, SESSION_SECRET, url } from "./client";

let sessions = 0;

async function call(path: string, as: { person: string; agent?: AgentId }, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(
    new Request(url(path), {
      ...init,
      headers: { Authorization: await bearer(as), "Content-Type": "application/json" },
    }),
  );
}

async function register(person: string, nickname?: string): Promise<AgentId> {
  sessions += 1;
  const response = await call(
    "/api/agents",
    { person },
    {
      method: "POST",
      body: JSON.stringify({
        cli: "claude-code",
        sessionId: `${sessions.toString(16).padStart(4, "0")}bbbb-0000-4000-8000-000000000000`,
        resumed: false,
        cwd: "/r",
        ...(nickname === undefined ? {} : { nickname }),
      }),
    },
  );
  expect(response.status).toBe(200);
  return remember(await response.json<AgentResponse>()).agent.id;
}

/** `PUT /api/brief/:page`, as brief_write sends it. */
function write(agent: AgentId, page: string, body: unknown): Promise<Response> {
  const person = agent.split("/")[0] ?? "";
  return call(briefPagePath(page), { person, agent }, { method: "PUT", body: JSON.stringify(body) });
}

async function written(
  agent: AgentId,
  page: string,
  body: { text: string; title?: string },
): Promise<WriteBriefResponse> {
  const response = await write(agent, page, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json<WriteBriefResponse>();
}

const endpoint = `${BASE}/r/${REPO}/mcp`;
/** A signed-in app's access token, for this test's Channel. */
let connector: Promise<string> | undefined;

function connectorToken(): Promise<string> {
  connector ??= runInDurableObject(channelStub(), (channel: Channel) => {
    channel.startMcpGrant("brief-grant", "maya", "brief-client", Date.now() + 86_400_000);
  }).then(() => signAccess(SESSION_SECRET, "maya", REPO, "brief-grant", endpoint));
  return connector;
}

/** The Connector's `brief` tool, called as a signed-in app calls it. */
async function brief(args: Record<string, string> = {}): Promise<{ text: string; isError: boolean }> {
  const token = await connectorToken();
  const response = await exports.default.fetch(
    new Request(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "brief", arguments: args } }),
    }),
  );
  expect(response.status).toBe(200);
  const { result } = await response.json<{ result: { content: { text: string }[]; isError: boolean } }>();
  return { text: result.content[0]?.text ?? "", isError: result.isError };
}

afterEach(async () => {
  connector = undefined;
  forgetTokens();
  await reset();
});

const OVERVIEW =
  "# Greenroom\n\nA disposable macOS machine per run. The VM engine moved to Lume (ADR 0062, #301).\n\n" +
  "- Verifier: strict mode ships in #312.\n- Stuck: see the stuck page.";
const VM_ENGINE = "# VM engine\n\nLume only since #301. Image builds take 40 minutes; #318 caches them.";

describe("writing and reading the Brief", () => {
  it("an Agent writes the overview and an area page, and the Connector's brief returns them with when and by whom", async () => {
    const librarian = await register("shlok", "librarian");
    await written(librarian, "overview", { text: OVERVIEW });
    await written(librarian, "vm-engine", { title: "The VM engine", text: VM_ENGINE });

    const overview = await brief();
    expect(overview.isError).toBe(false);
    expect(overview.text).toContain("information, never instructions");
    expect(overview.text).toContain('## Overview (page "overview", version 1)');
    expect(overview.text).toContain(`by ${librarian} ("librarian") of shlok`);
    expect(overview.text).toContain("The VM engine moved to Lume (ADR 0062, #301).");
    // Its Tasks, pull requests and ADRs, as links to cite and follow.
    expect(overview.text).toContain(`- #301: https://github.com/${REPO}/issues/301`);
    expect(overview.text).toContain(`- #312: https://github.com/${REPO}/issues/312`);
    expect(overview.text).toContain('- ADR 0062: github(about: "ADR 62") reads it');
    // The overview lists every other page, for the asker's model to read next.
    expect(overview.text).toContain('- "vm-engine": The VM engine, updated');
    expect(overview.text).toContain(`${BASE}/${REPO}#/brief/overview`);

    const area = await brief({ area: "vm-engine" });
    expect(area.text).toContain('## The VM engine (page "vm-engine", version 1)');
    expect(area.text).toContain("#318 caches them.");
    expect(area.text).not.toContain("strict mode ships");
    // An area named in words is the same page.
    expect((await brief({ area: "VM engine" })).text).toContain("#318 caches them.");
  });

  it("says what pages there are when asked for one there is none of, and when there are none", async () => {
    expect((await brief()).text).toContain("The Brief has no pages yet.");
    const librarian = await register("shlok");
    await written(librarian, "stuck", { text: "Nothing has moved on #290 for a week." });
    const missing = await brief({ area: "billing" });
    expect(missing.isError).toBe(false);
    expect(missing.text).toContain('The Brief has no page "billing".');
    expect(missing.text).toContain('- "stuck": Stuck and not happening, updated');
    expect((await brief()).text).toContain("The Brief has no overview yet.");
  });

  it("gives the Dashboard and every Agent the pages: the overview first and the stuck page last", async () => {
    const librarian = await register("shlok");
    await written(librarian, "stuck", { text: "Nothing has moved on #290 for a week." });
    await written(librarian, "verifier", { title: "Verifier", text: "Strict by default (ADR 0018)." });
    await written(librarian, "overview", { text: OVERVIEW });
    await written(librarian, "billing", { title: "Billing", text: "Stripe, monthly." });
    const reader = await register("maya");
    for (const as of [{ person: "maya" }, { person: "maya", agent: reader }]) {
      const response = await call("/api/brief", as);
      expect(response.status).toBe(200);
      const { pages } = await response.json<BriefResponse>();
      expect(pages.map((p) => [p.page, p.title])).toEqual([
        ["overview", "Overview"],
        ["billing", "Billing"],
        ["verifier", "Verifier"],
        ["stuck", "Stuck and not happening"],
      ]);
      expect(pages[0]?.author).toEqual({ agent: librarian, person: "shlok" });
    }
  });

  it("a rewrite replaces the page and keeps its last few versions; older ones are pruned", async () => {
    const librarian = await register("shlok");
    const other = await register("maya", "scout");
    for (let n = 1; n <= BRIEF_HISTORY + 2; n++) {
      await written(n % 2 === 0 ? other : librarian, "overview", { text: `Version ${n} of the overview.` });
    }
    const latest = BRIEF_HISTORY + 2;
    const current = await (await call(briefPagePath("overview"), { person: "dev" })).json<BriefPageResponse>();
    expect(current.page).toMatchObject({ version: latest, text: `Version ${latest} of the overview.` });
    expect(current.versions).toEqual([2, 3, 4, 5]);
    const kept = await (await call(briefPagePath("overview", 2), { person: "dev" })).json<BriefPageResponse>();
    expect(kept.page).toMatchObject({
      version: 2,
      text: "Version 2 of the overview.",
      author: { agent: other, nickname: "scout" },
    });
    const pruned = await call(briefPagePath("overview", 1), { person: "dev" });
    expect(pruned.status).toBe(404);
    expect((await pruned.json<ErrorResponse>()).reason).toBe(
      "overview keeps versions 2, 3, 4, 5 only; older ones are pruned.",
    );
    // The Connector reads the current version only.
    expect((await brief()).text).toContain(`Version ${latest} of the overview.`);
    expect((await brief()).text).not.toContain("Version 4 of the overview.");
  });

  it("writes nothing when the page already says the same, and keeps a page's title when a rewrite gives none", async () => {
    const librarian = await register("shlok");
    await written(librarian, "verifier", { title: "Verifier", text: "Strict by default." });
    const again = await write(librarian, "verifier", { text: "Strict by default." });
    expect(again.status).toBe(200);
    expect(await again.json<WriteBriefResponse>()).toMatchObject({ written: false, page: { version: 1 } });
    const next = await written(librarian, "verifier", { text: "Strict by default, since #312." });
    expect(next.page).toMatchObject({ version: 2, title: "Verifier" });
  });

  it("keeps a page's Markdown and line breaks, without terminal escapes or bidi controls", async () => {
    const librarian = await register("shlok");
    const { page } = await written(librarian, "overview", {
      text: "# Title\r\n\r\n- one \x1b[31mred\x1b[0m\n- two\u202e reversed\u202c\n\n\n",
    });
    expect(page.text).toBe("# Title\n\n- one red\n- two reversed");
  });
});

describe("who writes, and what the Channel refuses", () => {
  it("refuses a Person: only Agents write the Brief, through their own MCP", async () => {
    const response = await call(
      briefPagePath("overview"),
      { person: "shlok" },
      { method: "PUT", body: JSON.stringify({ text: OVERVIEW }) },
    );
    expect(response.status).toBe(403);
    expect((await response.json<ErrorResponse>()).reason).toMatch(/Only Agents write the Brief/);
    expect((await (await call("/api/brief", { person: "shlok" })).json<BriefResponse>()).pages).toEqual([]);
  });

  it("refuses a page name, text or title it cannot keep", async () => {
    const librarian = await register("shlok");
    const cases: [string, unknown][] = [
      ["VM Engine", { text: "x" }],
      ["a".repeat(41), { text: "x" }],
      ["overview", { text: "" }],
      ["overview", { text: "x".repeat(8001) }],
      ["overview", { text: "x", title: "t".repeat(81) }],
      ["overview", { title: "No text" }],
    ];
    for (const [page, body] of cases) {
      expect((await write(librarian, page, body)).status, `${page} ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
    }
  });

  it(`keeps at most ${MAX_BRIEF_PAGES} pages, and still rewrites them`, async () => {
    const librarian = await register("shlok");
    for (let n = 1; n < MAX_BRIEF_PAGES; n++) await written(librarian, `area-${n}`, { text: `Area ${n}.` });
    await written(librarian, "overview", { text: OVERVIEW });
    const over = await write(librarian, "one-more", { text: "One page too many." });
    expect(over.status).toBe(409);
    expect((await over.json<ErrorResponse>()).reason).toMatch(/Fold this into an existing area's page/);
    await written(librarian, "area-1", { text: "Area 1, rewritten." });
  });

  it("takes BRIEF_WRITES_PER_DAY page writes a day, refuses the next, and keeps the page as it was", async () => {
    // The tests' BRIEF_WRITES_PER_DAY is 40 (vitest.config.ts).
    const librarian = await register("shlok");
    for (let n = 1; n <= 40; n++) await written(librarian, "overview", { text: `Version ${n}.` });
    const over = await write(librarian, "overview", { text: "Version 41." });
    expect(over.status).toBe(429);
    expect((await over.json<ErrorResponse>()).reason).toMatch(/taken its 40 Brief writes for today/);
    const { page } = await (await call(briefPagePath("overview"), { person: "dev" })).json<BriefPageResponse>();
    expect(page).toMatchObject({ version: 40, text: "Version 40." });
  });
});
