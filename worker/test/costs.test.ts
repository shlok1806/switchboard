// The repo's own Langfuse project (ADR 0044), through the Worker's real routes: the
// owner connects it on the settings route, and the Connector's costs tool reads it live.
// Langfuse is replaced at its HTTP boundary (test/fake-langfuse.ts), which computes the
// metrics from the observations a test puts there, so the numbers the asker reads back
// are checked against what is in Langfuse. The secret key goes in and never comes back.

import { reset, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../src/channel";
import { installGitHub } from "../src/github/index";
import { sealSecretKey } from "../src/langfuse";
import { signAccess } from "../src/mcp/tokens";
import { BASE, bearer, channelStub, REPO, SESSION_SECRET, url } from "./client";
import { FakeGitHub } from "./fake-github";
import { FakeLangfuse, LANGFUSE_HOST, PROJECT, PUBLIC_KEY, SECRET_KEY } from "./fake-langfuse";

const ENDPOINT = `${BASE}/r/${REPO}/mcp`;
const SETTINGS = "/api/settings/langfuse";
const DAY = 86_400_000;
const OWNER = "shlok1806";
const MEMBER = "maya";

let github: FakeGitHub;
let langfuse: FakeLangfuse;
let token: string;

type ToolCall = { result: { content: { type: string; text: string }[]; isError: boolean } };

async function settings(person: string, method = "GET", body?: unknown): Promise<Response> {
  return exports.default.fetch(
    new Request(url(SETTINGS), {
      method,
      headers: { Authorization: await bearer(person), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const connect = (person = OWNER, keys = { host: LANGFUSE_HOST, publicKey: PUBLIC_KEY, secretKey: SECRET_KEY }) =>
  settings(person, "PUT", keys);

async function rpc(method: string, params?: Record<string, unknown>): Promise<Response> {
  return exports.default.fetch(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
    }),
  );
}

async function costs(args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const response = await rpc("tools/call", { name: "costs", arguments: args });
  expect(response.status).toBe(200);
  const { result } = await response.json<ToolCall>();
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError };
}

async function ask(args: Record<string, unknown> = {}): Promise<string> {
  const answer = await costs(args);
  expect(answer.isError, answer.text).toBe(false);
  return answer.text;
}

/** Last month, in UTC, and a time `days` and `hours` into it. */
const now = new Date();
const lastMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
const into = (days: number, hours = 10) => new Date(lastMonth + days * DAY + hours * 3_600_000).toISOString();
const dayOf = (days: number) => into(days).slice(0, 10);

/** Two verifier turns last month, one of them with a failed call; one this month; one bench run. */
function seed(): void {
  langfuse.observations.push(
    // A turn on the 3rd: two calls on two models.
    {
      type: "SPAN",
      root: true,
      traceName: "verifier turn",
      startTime: into(2),
      latencyMs: 60_000,
      environment: "production",
    },
    {
      type: "GENERATION",
      traceName: "verifier turn",
      model: "claude-opus-4-1",
      startTime: into(2),
      latencyMs: 4_000,
      cost: 1.5,
      inputTokens: 1_000,
      outputTokens: 200,
      environment: "production",
    },
    {
      type: "GENERATION",
      traceName: "verifier turn",
      model: "gpt-5",
      startTime: into(2),
      latencyMs: 1_500,
      cost: 0.25,
      inputTokens: 3_000,
      outputTokens: 500,
      environment: "production",
    },
    // A turn on the 10th, whose call failed.
    {
      type: "SPAN",
      root: true,
      traceName: "verifier turn",
      startTime: into(9),
      latencyMs: 90_000,
      environment: "production",
    },
    {
      type: "GENERATION",
      traceName: "verifier turn",
      model: "claude-opus-4-1",
      startTime: into(9),
      latencyMs: 8_000,
      cost: 2.25,
      inputTokens: 1_500,
      outputTokens: 300,
      level: "ERROR",
      environment: "production",
    },
    // This month: not last month's.
    {
      type: "GENERATION",
      traceName: "verifier turn",
      model: "claude-opus-4-1",
      startTime: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
      latencyMs: 1_000,
      cost: 10,
      environment: "production",
    },
    // A bench run last month: not production's.
    {
      type: "SPAN",
      root: true,
      traceName: "verifier turn",
      startTime: into(4),
      latencyMs: 30_000,
      environment: "bench",
    },
    {
      type: "GENERATION",
      traceName: "verifier turn",
      model: "claude-opus-4-1",
      startTime: into(4),
      latencyMs: 2_000,
      cost: 7,
      inputTokens: 100,
      outputTokens: 100,
      environment: "bench",
    },
  );
}

beforeEach(async () => {
  github = new FakeGitHub();
  github.permissions.set(OWNER, "admin");
  installGitHub(github);
  langfuse = new FakeLangfuse();
  langfuse.listen();
  seed();
  await runInDurableObject(channelStub(), (channel: Channel) => {
    channel.startMcpGrant("costs-grant", OWNER, "costs-client", Date.now() + DAY);
  });
  token = await signAccess(SESSION_SECRET, OWNER, REPO, "costs-grant", ENDPOINT);
});

afterEach(async () => {
  installGitHub(null);
  vi.restoreAllMocks();
  await reset();
});

describe("connecting the repo's Langfuse project", () => {
  it("the owner connects it; everyone sees its host, project and the public key's end, never the secret key", async () => {
    const empty = await settings(MEMBER);
    expect(await empty.json()).toEqual({ langfuse: null, canManage: false });

    const connected = await connect();
    expect(connected.status).toBe(200);
    const body = await connected.text();
    expect(body).not.toContain(SECRET_KEY);
    expect(JSON.parse(body)).toEqual({
      canManage: true,
      langfuse: {
        host: LANGFUSE_HOST,
        publicKeyEnd: "abcd",
        project: PROJECT,
        connectedBy: OWNER,
        connectedAt: expect.any(String),
      },
    });
    // The keys were tried with Langfuse before they were kept.
    expect(langfuse.requests).toEqual(["GET /api/public/projects"]);

    for (const person of [OWNER, MEMBER]) {
      const read = await (await settings(person)).text();
      expect(read).not.toContain(SECRET_KEY);
      expect(read).not.toContain(PUBLIC_KEY);
      expect(JSON.parse(read)).toMatchObject({ canManage: person === OWNER, langfuse: { publicKeyEnd: "abcd" } });
    }
  });

  it("keeps the secret key sealed at rest, and no route the Dashboard or the Connector calls sends it back", async () => {
    await connect();
    const stored = await runInDurableObject(channelStub(), (_channel, state) =>
      JSON.stringify(state.storage.sql.exec("SELECT * FROM langfuse_project").toArray()),
    );
    expect(stored).toContain(LANGFUSE_HOST);
    expect(stored).not.toContain(SECRET_KEY);
    expect(stored).not.toContain(SECRET_KEY.slice(6, 20));

    const everything: string[] = [];
    for (const path of [
      SETTINGS,
      "/api/events",
      "/api/events?tail=50",
      "/api/tasks",
      "/api/agents",
      "/api/persons",
      "/api/relay",
      "/api/brief",
      "/api/memory",
      "/api/skills",
      "/api/hosts",
    ]) {
      for (const person of [OWNER, MEMBER]) {
        const response = await exports.default.fetch(
          new Request(url(path), { headers: { Authorization: await bearer(person) } }),
        );
        everything.push(`${path} ${response.status} ${await response.text()}`);
      }
    }
    for (const method of ["initialize", "tools/list"]) everything.push(await (await rpc(method)).text());
    for (const by of ["model", "trace", "day", "week"])
      everything.push((await costs({ period: "last month", by })).text);
    everything.push(await (await settings(OWNER, "DELETE")).text());
    for (const answer of everything) {
      expect(answer).not.toContain(SECRET_KEY);
      expect(answer).not.toContain(btoa(`${PUBLIC_KEY}:${SECRET_KEY}`));
    }
    // The Connector's token is not a Person's session: it reaches no settings route.
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await exports.default.fetch(
        new Request(url(SETTINGS), { method, headers: { Authorization: `Bearer ${token}` } }),
      );
      expect(response.status, method).toBe(401);
    }
  });

  it("only the owner connects, replaces or removes it", async () => {
    const refused = await connect(MEMBER);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: expect.stringContaining("an admin of its repo") });
    expect(langfuse.requests).toEqual([]);

    await connect();
    expect((await settings(MEMBER, "DELETE")).status).toBe(403);
    expect(await (await settings(MEMBER)).json()).toMatchObject({ langfuse: { publicKeyEnd: "abcd" } });

    // The owner replaces the keys with another pair of the project's.
    langfuse.keys.set("pk-lf-5555-9z9z", "sk-lf-6666-replacement");
    const replaced = await connect(OWNER, {
      host: `${LANGFUSE_HOST}/`,
      publicKey: "pk-lf-5555-9z9z",
      secretKey: "sk-lf-6666-replacement",
    });
    expect(await replaced.json()).toMatchObject({ langfuse: { host: LANGFUSE_HOST, publicKeyEnd: "9z9z" } });

    const removed = await settings(OWNER, "DELETE");
    expect(await removed.json()).toEqual({ langfuse: null, canManage: true });
    expect(await (await settings(MEMBER)).json()).toEqual({ langfuse: null, canManage: false });
  });

  it("refuses keys Langfuse refuses, a host that is not Langfuse, and malformed fields, keeping nothing", async () => {
    const wrong = await connect(OWNER, { host: LANGFUSE_HOST, publicKey: PUBLIC_KEY, secretKey: "sk-lf-wrong" });
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toMatchObject({ reason: expect.stringContaining("refused these keys") });

    langfuse.fault = () => new Response("<html>not langfuse</html>", { status: 200 });
    const notLangfuse = await connect();
    expect(notLangfuse.status).toBe(422);
    expect(await notLangfuse.json()).toMatchObject({
      reason: expect.stringContaining("did not answer as Langfuse does"),
    });
    langfuse.fault = null;

    for (const body of [
      { host: "http://langfuse.test", publicKey: PUBLIC_KEY, secretKey: SECRET_KEY },
      { host: "https://user:pass@langfuse.test", publicKey: PUBLIC_KEY, secretKey: SECRET_KEY },
      { host: LANGFUSE_HOST, publicKey: SECRET_KEY, secretKey: PUBLIC_KEY },
      { host: LANGFUSE_HOST, publicKey: PUBLIC_KEY },
    ]) {
      const response = await connect(OWNER, body as never);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).not.toContain(SECRET_KEY);
    }
    expect(await (await settings(OWNER)).json()).toEqual({ langfuse: null, canManage: true });
  });
});

describe("the costs tool", () => {
  it("is listed read-only, and says plainly when no project is connected", async () => {
    const { result } = await (await rpc("tools/list")).json<{
      result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
    }>();
    expect(result.tools.map((t) => [t.name, t.annotations.readOnlyHint])).toContainEqual(["costs", true]);

    const answer = await ask();
    expect(answer).toContain(`No Langfuse project is connected to the Channel of ${REPO}`);
    expect(answer).toContain(`${BASE}/${REPO}#/settings`);
    expect(langfuse.requests).toEqual([]);
  });

  it("answers what verifier runs cost last month, by model, with Langfuse's own numbers", async () => {
    await connect();
    const text = await ask({ period: "last month", by: "model" });
    const month = dayOf(0).slice(0, 7);
    expect(text).toContain(`# What it cost: production, last month (${month})`);
    expect(text).toContain(`Read live from the Langfuse project "greenroom" (${LANGFUSE_HOST}/project/${PROJECT.id})`);
    expect(text).toContain("Total: $4.00, 3 generation calls, 6,500 tokens (5,500 in, 1,000 out), 2 traces, 1 error.");
    expect(text).toContain("## By model (2)");
    expect(text).toContain(
      "- claude-opus-4-1: $3.75 (94%), 2 generation calls, 3,000 tokens (2,500 in, 500 out), generation latency p50 4.0 s, p95 8.0 s, 1 error",
    );
    expect(text).toContain(
      "- gpt-5: $0.25 (6%), 1 generation call, 3,500 tokens (3,000 in, 500 out), generation latency p50 1.5 s, p95 1.5 s, 0 errors",
    );
    // The model costing most comes first.
    expect(text.indexOf("claude-opus-4-1:")).toBeLessThan(text.indexOf("gpt-5:"));
    expect(text).toContain(`${LANGFUSE_HOST}/project/${PROJECT.id}/traces`);

    // Bench runs are their own environment.
    const bench = await ask({ period: "last month", environment: "bench" });
    expect(bench).toContain("Total: $7.00, 1 generation call, 200 tokens (100 in, 100 out), 1 trace, 0 errors.");
  });

  it("groups by trace name and by day, and says when there is nothing", async () => {
    await connect();
    const traces = await ask({ period: "last month", by: "trace" });
    expect(traces).toContain(
      "- verifier turn: 2 traces, trace latency p50 60.0 s, p95 90.0 s, $4.00 (100%), 3 generation calls, 6,500 tokens (5,500 in, 1,000 out), generation latency p50 4.0 s, p95 8.0 s, 1 error",
    );

    const days = await ask({ period: `${dayOf(0)}..${dayOf(14)}`, by: "day" });
    expect(days).toContain("## By day (UTC) (2)");
    expect(days).toContain(`- ${dayOf(2)}: $1.75, 2 generation calls,`);
    expect(days).toContain(`- ${dayOf(9)}: $2.25, 1 generation call,`);
    expect(days.indexOf(dayOf(2))).toBeLessThan(days.indexOf(dayOf(9)));

    const nothing = await ask({ period: "last month", environment: "staging" });
    expect(nothing).toContain('Langfuse has nothing in environment "staging" for this period.');
  });

  it("says in words when Langfuse refuses, limits, fails or has no Metrics API v2", async () => {
    await connect();
    const answers: [() => Response, string][] = [
      [
        () => Response.json({ message: "Rate limit exceeded" }, { status: 429, headers: { "retry-after": "30" } }),
        "Langfuse's rate limit for this project is used up. Ask again in 30 seconds.",
      ],
      [() => Response.json({ message: "Invalid credentials" }, { status: 401 }), "refused the Channel's keys (401)"],
      [() => Response.json({ message: "Not found" }, { status: 404 }), "has no Metrics API v2"],
      [() => new Response("bad gateway", { status: 502 }), "failed (502). Ask again in a minute."],
      [
        () => Response.json({ message: "Invalid query: unknown dimension" }, { status: 400 }),
        "answered 400: Invalid query",
      ],
    ];
    for (const [response, words] of answers) {
      langfuse.fault = (u) => (u.pathname.endsWith("/metrics") ? response() : null);
      const answer = await costs();
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain(words);
      expect(answer.text).not.toContain(SECRET_KEY);
    }
    langfuse.fault = () => {
      throw new TypeError("fetch failed");
    };
    expect((await costs()).text).toContain(`Could not reach Langfuse at ${LANGFUSE_HOST}`);
  });

  it("refuses a period or grouping it cannot answer, and says when the key no longer opens", async () => {
    await connect();
    for (const [args, words] of [
      [{ period: "fortnight" }, '"period" is a span such as "7d"'],
      [{ period: "400d" }, "A period is at most 366 days"],
      [{ period: "120d", by: "day" }, "Ask by week for a longer period"],
      [{ by: "user" }, '"by" is one of'],
      [{ environment: "prod uction" }, '"environment" is a Langfuse environment name'],
    ] as const) {
      const answer = await costs(args);
      expect(answer.isError, JSON.stringify(args)).toBe(true);
      expect(answer.text).toContain(words);
    }

    // Sealed under another SESSION_SECRET, as after the Worker's secret was rotated.
    const sealed = await sealSecretKey("another-session-secret-of-at-least-32-chars", REPO, SECRET_KEY);
    await runInDurableObject(channelStub(), (_channel, state) => {
      state.storage.sql.exec("UPDATE langfuse_project SET secret_sealed = ?", sealed);
    });
    const unreadable = await costs();
    expect(unreadable.isError).toBe(true);
    expect(unreadable.text).toContain("The Channel's Langfuse key can no longer be read");
  });

  it("writes no row, and asks Langfuse three GETs per question with the project's keys", async () => {
    await connect();
    await ask();
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
    metering = true;
    for (const args of [{}, { by: "trace" }, { by: "day", period: "7d" }, { by: "week", period: "this month" }]) {
      langfuse.requests.length = 0;
      langfuse.authorizations.length = 0;
      await ask(args);
      expect(langfuse.requests, JSON.stringify(args)).toEqual([
        "GET /api/public/v2/metrics",
        "GET /api/public/v2/metrics",
        "GET /api/public/v2/metrics",
      ]);
      expect(new Set(langfuse.authorizations)).toEqual(new Set([`Basic ${btoa(`${PUBLIC_KEY}:${SECRET_KEY}`)}`]));
    }
    metering = false;
    expect(written.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(0);
  });
});
