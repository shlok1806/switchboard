// Artifacts (ADR 0053), driven the way they are used: an Agent publishes an HTML page
// through the Channel API with its own token, as its MCP's artifact_publish does, or a
// Person does from the Dashboard or the terminal; anyone on the Channel lists it, reads
// it and loads the page, which the Channel serves in a sandbox.

import { reset, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  AgentResponse,
  ArtifactResponse,
  ArtifactsResponse,
  DeleteArtifactResponse,
  ErrorResponse,
  PublishArtifactResponse,
} from "../../shared/src/index";
import {
  ARTIFACT_SANDBOX,
  ARTIFACT_VERSIONS_KEPT,
  ARTIFACTS_PATH,
  artifactPagePath,
  artifactPath,
  MAX_ARTIFACT_BYTES,
} from "../../shared/src/index";
import { type As, bearer, channelStub, forgetTokens, remember, url } from "./client";

let sessions = 0;

async function call(path: string, as: As, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(
    new Request(url(path), {
      ...init,
      headers: { Authorization: await bearer(as), "Content-Type": "application/json", ...init.headers },
    }),
  );
}

async function agent(person: string, extra: { nickname?: string; librarian?: boolean } = {}): Promise<As> {
  sessions += 1;
  const response = await call(
    "/api/agents",
    { person },
    {
      method: "POST",
      body: JSON.stringify({
        cli: "claude-code",
        sessionId: `${sessions.toString(16).padStart(4, "0")}eeee-0000-4000-8000-000000000000`,
        resumed: false,
        cwd: "/r",
        ...extra,
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return { person, agent: remember(await response.json<AgentResponse>()).agent.id as AgentId };
}

function remove(as: As, name: string): Promise<Response> {
  return call(artifactPath(name), as, { method: "DELETE" });
}

/** The rows the Channel still holds for `name`, versions and chunks. */
async function rowsOf(name: string): Promise<{ versions: number; chunks: number }> {
  return runInDurableObject(channelStub(), (_channel, state: DurableObjectState) => {
    const count = (table: string) =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE name = ?`, name).one().n;
    return { versions: count("artifact_versions"), chunks: count("artifact_chunks") };
  });
}

function publish(as: As, name: string, body: unknown): Promise<Response> {
  return call(artifactPath(name), as, { method: "PUT", body: JSON.stringify(body) });
}

async function published(
  as: As,
  name: string,
  body: { html: string; title?: string },
): Promise<PublishArtifactResponse> {
  const response = await publish(as, name, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json<PublishArtifactResponse>();
}

async function refusal(response: Response, status: number): Promise<string> {
  expect(response.status).toBe(status);
  return (await response.json<ErrorResponse>()).reason;
}

afterEach(async () => {
  forgetTokens();
  await reset();
});

const REPORT = `<!doctype html>
<html><head><title>Receipt splitter &amp; tips</title></head>
<body><h1>Split it</h1><script>document.title += " ✓";</script></body></html>`;

describe("publishing and reading artifacts", () => {
  it("an Agent publishes a page, and anyone on the Channel lists it, reads it and loads it byte for byte", async () => {
    const claude = await agent("shlok", { nickname: "splitter" });
    const answer = await published(claude, "receipt-splitter", { html: REPORT });
    expect(answer.published).toBe(true);
    expect(answer.artifact).toMatchObject({
      name: "receipt-splitter",
      // The page's own <title> names it when the publisher gives none.
      title: "Receipt splitter & tips",
      owner: "shlok",
      version: 1,
      size: new TextEncoder().encode(REPORT).length,
      publishedBy: { person: "shlok", agent: claude.agent, nickname: "splitter" },
    });

    const maya = { person: "maya" };
    const list = await (await call(ARTIFACTS_PATH, maya)).json<ArtifactsResponse>();
    expect(list.artifacts.map((a) => a.name)).toEqual(["receipt-splitter"]);

    const read = await (await call(artifactPath("receipt-splitter"), maya)).json<ArtifactResponse>();
    expect(read.versions).toEqual([1]);
    expect(read.artifact.digest).toBe(answer.artifact.digest);

    const page = await call(artifactPagePath("receipt-splitter"), maya);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toBe(REPORT);
  });

  it("serves the page in a sandbox that never runs as the Channel's origin", async () => {
    const claude = await agent("shlok");
    await published(claude, "chart", { html: REPORT });
    const page = await call(artifactPagePath("chart"), { person: "maya" });
    const csp = page.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain(`sandbox ${ARTIFACT_SANDBOX}`);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-top-navigation");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const download = await call(artifactPagePath("chart", 1, true), { person: "maya" });
    expect(download.headers.get("Content-Disposition")).toBe('attachment; filename="chart-v1.html"');
    expect(download.headers.get("Content-Security-Policy")).toContain("sandbox");
  });

  it("stores a page larger than one row's limit in chunks and reads it back whole", async () => {
    const claude = await agent("shlok");
    // About 3 MB of multi-byte text, so chunk boundaries fall inside characters.
    const html = `<!doctype html><title>Big</title><p>${"é漢🙂".repeat(330_000)}</p>`;
    const answer = await published(claude, "big", { html });
    expect(answer.artifact.size).toBeGreaterThan(2 * 1024 * 1024);
    const page = await call(artifactPagePath("big"), { person: "maya" });
    expect(await page.text()).toBe(html);
  });

  it("publishes nothing for the same page again, and a new version for a change", async () => {
    const claude = await agent("shlok");
    await published(claude, "report", { html: REPORT, title: "Weekly report" });
    const again = await publish(claude, "report", { html: REPORT, title: "Weekly report" });
    expect(again.status).toBe(200);
    expect((await again.json<PublishArtifactResponse>()).published).toBe(false);

    const second = await published(claude, "report", { html: `${REPORT}\n<!-- v2 -->`, title: "Weekly report" });
    expect(second.artifact.version).toBe(2);
    const v1 = await call(artifactPagePath("report", 1), { person: "maya" });
    expect(await v1.text()).toBe(REPORT);
  });

  it(`keeps the last ${ARTIFACT_VERSIONS_KEPT} versions and says which when an older one is asked for`, async () => {
    const claude = await agent("shlok");
    for (let n = 1; n <= ARTIFACT_VERSIONS_KEPT + 1; n++) {
      await published(claude, "notes", { html: `<p>version ${n}</p>` });
    }
    const read = await (await call(artifactPath("notes"), { person: "maya" })).json<ArtifactResponse>();
    expect(read.versions).toEqual([2, 3, 4, 5, 6]);
    const pruned = await refusal(await call(artifactPagePath("notes", 1), { person: "maya" }), 404);
    expect(pruned).toBe("notes keeps versions 2, 3, 4, 5, 6 only; it has no version 1.");
  });
});

describe("who may publish", () => {
  it("a name belongs to the Person who first published it, and their Agents", async () => {
    const claude = await agent("shlok");
    await published({ person: "shlok" }, "plan", { html: "<p>from the Dashboard</p>" });
    // The owner's Agent publishes its next version.
    const next = await published(claude, "plan", { html: "<p>from the Agent</p>" });
    expect(next.artifact.publishedBy).toEqual({ person: "shlok", agent: claude.agent });

    const theirs = await agent("maya");
    const reason = await refusal(await publish(theirs, "plan", { html: "<p>mine</p>" }), 403);
    expect(reason).toBe("plan belongs to shlok, who published it first. Publish yours under another name.");
    await refusal(await publish({ person: "maya" }, "plan", { html: "<p>mine</p>" }), 403);
  });

  it("the librarian, which writes Brief pages and nothing else, cannot publish one", async () => {
    const librarian = await agent("shlok", { librarian: true });
    expect((await publish(librarian, "page", { html: "<p>x</p>" })).status).toBe(403);
  });
});

describe("deleting an artifact", () => {
  it("its owner, as a Person, deletes every version and chunk, and the name is free for whoever publishes next", async () => {
    const claude = await agent("shlok");
    // A page over one chunk, so more than one chunk row is removed.
    const big = `<!doctype html><title>Plan</title><p>${"x".repeat(1_500_000)}</p>`;
    await published(claude, "plan", { html: big });
    await published(claude, "plan", { html: "<p>second</p>" });
    await published(claude, "other", { html: "<p>stays</p>" });
    expect(await rowsOf("plan")).toEqual({ versions: 2, chunks: 3 });
    const viewed = await call(artifactPagePath("plan", 2), { person: "maya" });
    const cached = viewed.headers.get("ETag") ?? "";
    expect(viewed.headers.get("Cache-Control")).not.toContain("immutable");
    const unchanged = await call(
      artifactPagePath("plan", 2),
      { person: "maya" },
      { headers: { "If-None-Match": cached } },
    );
    expect(unchanged.status).toBe(304);

    const answer = await remove({ person: "shlok" }, "plan");
    expect(answer.status, await answer.clone().text()).toBe(200);
    expect(await answer.json<DeleteArtifactResponse>()).toEqual({ ok: true, deleted: "plan", versions: 2 });
    expect(await rowsOf("plan")).toEqual({ versions: 0, chunks: 0 });

    const list = await (await call(ARTIFACTS_PATH, { person: "maya" })).json<ArtifactsResponse>();
    expect(list.artifacts.map((a) => a.name)).toEqual(["other"]);
    expect(await refusal(await call(artifactPagePath("plan"), { person: "maya" }), 404)).toBe(
      "No artifact is named plan on this Channel.",
    );

    // Republished, the name starts again at version 1 and belongs to whoever published it.
    const again = await published({ person: "maya" }, "plan", { html: "<p>maya's</p>" });
    expect(again.artifact).toMatchObject({ version: 1, owner: "maya", publishedBy: { person: "maya" } });
    const firstOld = await call(
      artifactPagePath("plan", 1),
      { person: "shlok" },
      { headers: { "If-None-Match": cached } },
    );
    expect(firstOld.status).toBe(200);
    expect(await firstOld.text()).toBe("<p>maya's</p>");
  });

  it("refuses an Agent token, even the owner's own Agent, deleting nothing", async () => {
    const claude = await agent("shlok");
    await published(claude, "plan", { html: "<p>x</p>" });
    const reason = await refusal(await remove(claude, "plan"), 403);
    expect(reason).toContain("Dashboard or with `switchboard artifacts delete`");
    expect(await rowsOf("plan")).toEqual({ versions: 1, chunks: 1 });
  });

  it("refuses another Person, and answers 404 for no such artifact", async () => {
    await published({ person: "shlok" }, "plan", { html: "<p>x</p>" });
    expect(await refusal(await remove({ person: "maya" }, "plan"), 403)).toBe(
      "plan belongs to shlok, who published it first. Only they delete it.",
    );
    expect(await rowsOf("plan")).toEqual({ versions: 1, chunks: 1 });
    expect(await refusal(await remove({ person: "shlok" }, "nothing"), 404)).toBe(
      "No artifact is named nothing on this Channel.",
    );
  });
});

describe("what the Channel refuses", () => {
  it("refuses a bad name, an empty page, a NUL, an oversized page and a secret, publishing nothing", async () => {
    const claude = await agent("shlok");
    expect(await refusal(await publish(claude, "Bad Name", { html: "<p>x</p>" }), 400)).toContain(
      "is not an artifact name",
    );
    expect(await refusal(await publish(claude, "empty", { html: "  " }), 400)).toContain('{ "html"');
    expect(await refusal(await publish(claude, "nul", { html: "<p>\u0000</p>" }), 400)).toContain("NUL");
    expect(await refusal(await publish(claude, "huge", { html: "x".repeat(MAX_ARTIFACT_BYTES + 1) }), 400)).toContain(
      "an artifact is at most",
    );
    const secret = await refusal(
      await publish(claude, "leak", {
        html: "<html>\n<script>\nconst token = 'ghp_R8f2kLq9Zt3Xw7Vn1Bc6Hd4Jm0Ps5Yg2Ue8A';\n</script></html>",
      }),
      400,
    );
    expect(secret).toContain("line 3");
    expect(secret).not.toContain("ghp_");

    const list = await (await call(ARTIFACTS_PATH, claude)).json<ArtifactsResponse>();
    expect(list.artifacts).toEqual([]);
  });

  it("a placeholder in a page is not a secret", async () => {
    const claude = await agent("shlok");
    await published(claude, "setup", { html: "<pre>export GITHUB_TOKEN=ghp_...\nAPI_KEY=$API_KEY</pre>" });
  });

  it("takes a Channel's daily cap of publishes, then refuses without writing", async () => {
    const claude = await agent("shlok");
    // ARTIFACT_PUBLISHES_PER_DAY is 8 in the tests.
    for (let n = 1; n <= 8; n++) await published(claude, `page-${n}`, { html: `<p>${n}</p>` });
    const reason = await refusal(await publish(claude, "page-9", { html: "<p>9</p>" }), 429);
    expect(reason).toContain("its 8 artifact publishes for today");
    // An unchanged publish is not counted, so it still answers.
    expect((await publish(claude, "page-1", { html: "<p>1</p>" })).status).toBe(200);
    expect((await call(artifactPath("page-9"), claude)).status).toBe(404);
  });
});
