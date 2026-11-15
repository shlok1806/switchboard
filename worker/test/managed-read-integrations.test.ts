import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentIdFor } from "../../shared/src/index";
import type { IdentityCommand } from "../../shared/src/m1";
import { type GitHubApp, installGitHubApp } from "../src/github/index";
import { managedOperationRoute } from "../src/managed-channel";
import type { ChannelAuthorization } from "../src/organization";
import { bareChannel, managedAuthorityFixture } from "./managed-helpers";

afterEach(() => installGitHubApp(null));

function fixture(
  options: {
    deny?: string;
    release?: boolean;
    changeGeneration?: boolean;
    outage?: boolean;
    hungAuthority?: boolean;
    upstreamError?: boolean;
    partialError?: boolean;
  } = {},
) {
  const repo = "shlok1806/other";
  const organizationId = crypto.randomUUID();
  const workspace = `${organizationId}:${crypto.randomUUID()}`;
  const binding = { version: 1, generation: 1, workspace, operation: "binding", state: "linked" };
  const channel = bareChannel(binding);
  const calls: ChannelAuthorization[] = [];
  const reads: { repo: string; path: string; body?: string }[] = [];
  let preparation = 0;
  installGitHubApp({
    repo: (requested: string) => {
      preparation++;
      return {
        call: async (path: string, init?: RequestInit) => {
          reads.push({ repo: requested, path, body: init?.body as string | undefined });
          if (options.changeGeneration) binding.generation++;
          if (options.upstreamError) throw new Error("upstream-private-marker");
          if (path !== "/graphql") return Response.json({ tree: [], truncated: false });
          return Response.json({
            ...(options.partialError ? { errors: [{ message: "upstream-private-marker" }] } : {}),
            data: {
              merged: { nodes: [], issueCount: 0 },
              opened: { nodes: [], issueCount: 0 },
              closed: { nodes: [], issueCount: 0 },
              found: { nodes: [], issueCount: 0 },
              repository: {
                open: { nodes: [], totalCount: 0 },
                issueOrPullRequest: {
                  __typename: "Issue",
                  number: 7,
                  title: "authorized-github-marker",
                  body: "shared issue",
                  state: "OPEN",
                  createdAt: "2026-11-15T00:00:00Z",
                  author: { login: "alice" },
                  labels: { nodes: [] },
                  comments: { totalCount: 0 },
                  url: "https://github.com/shlok1806/other/issues/7",
                },
                url: `https://github.com/${requested}`,
                defaultBranchRef: { name: "main", target: null },
                object: {
                  __typename: "Blob",
                  text: "authorized-github-marker",
                  byteSize: 24,
                  isBinary: false,
                  isTruncated: false,
                },
              },
            },
          });
        },
      };
    },
  } as unknown as GitHubApp);
  Object.assign(channel, {
    ctx: { id: env.CHANNEL.idFromName(repo) },
    env: {
      CHANNEL: env.CHANNEL,
      ORGANIZATION: {
        getByName: () => ({
          authorizeChannelRead: async (input: ChannelAuthorization) => {
            calls.push(input);
            if (options.hungAuthority) return new Promise(() => {});
            if (options.outage) throw new Error("authority-private-marker");
            if (options.deny && (!options.release || calls.length === 2))
              return { ok: false, status: 403, reason: options.deny, policyRevision: 1 };
            return { ok: true, value: {}, policyRevision: 1 };
          },
        }),
      },
    },
  });
  return {
    calls,
    reads,
    prepared: () => preparation,
    request: (query = "about=README.md") =>
      channel.managedRequest(
        new Request(`https://switchboard.test/r/${repo}/api/github?${query}`, {
          headers: { Authorization: "Bearer m1.synthetic-authority-stub" },
        }),
        repo,
      ),
  };
}

describe("managed GitHub HTTP read", () => {
  it("admits the real handler through task.read and the exact registered binding at admission and release", async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      text: expect.stringContaining("authorized-github-marker"),
      isError: false,
    });
    expect(managedOperationRoute("GET", "/api/github")).toEqual({
      id: "github.read",
      action: "task.read",
      mode: "read",
      targetId: "github",
      operation: "github.read",
    });
    expect(f.calls).toHaveLength(2);
    for (const call of f.calls) {
      expect(call).toMatchObject({
        action: "task.read",
        generation: 1,
        resource: { channel: "shlok1806/other", targetId: "github", operation: "github.read" },
      });
    }
    expect(f.reads).toHaveLength(1);
    expect(f.reads[0]).toMatchObject({ repo: "shlok1806/other", path: "/graphql" });
    expect(JSON.parse(f.reads[0]?.body ?? "{}").variables).toMatchObject({
      owner: "shlok1806",
      name: "other",
      expression: "HEAD:README.md",
    });
  });
  for (const reason of [
    "non_member",
    "foreign_organization",
    "foreign_workspace",
    "revoked_execution",
    "expired_execution",
    "wrong_generation",
    "insufficient_role",
    "insufficient_scope",
  ]) {
    for (const release of [false, true]) {
      for (const query of ["about=README.md", "about=%237", "about=stale%20claims", ""]) {
        it(`withholds GitHub bytes on ${reason} at ${release ? "release" : "admission"} for ${query || "activity"}`, async () => {
          const f = fixture({ deny: reason, release });
          const response = await f.request(query);
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
          expect(f.prepared()).toBe(release ? 1 : 0);
          expect(f.reads.length).toBe(release ? (query.includes("stale") ? 2 : 1) : 0);
          expect(f.calls).toHaveLength(release ? 2 : 1);
        });
      }
    }
  }
  for (const query of ["", "about=%237", "about=stale%20claims", "about=docs%2Fadr"]) {
    it(`admits the existing GitHub query variant ${query || "activity"} through the same scoped handler`, async () => {
      const f = fixture();
      const response = await f.request(query);
      expect(response.status).toBe(200);
      expect(f.calls).toHaveLength(2);
      for (const read of f.reads) {
        expect(read.repo).toBe("shlok1806/other");
        if (read.body) expect(JSON.parse(read.body).variables).toMatchObject({ owner: "shlok1806", name: "other" });
      }
    });
  }
  it("bounds a hung authority at two seconds before preparing a GitHub read", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ hungAuthority: true });
      const pending = f.request();
      await vi.advanceTimersByTimeAsync(2000);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(f.prepared()).toBe(0);
      expect(await response.text()).not.toContain("authorized-github-marker");
    } finally {
      vi.useRealTimers();
    }
  });
  it("discards the GitHub result when generation changes during the upstream wait", async () => {
    const f = fixture({ changeGeneration: true });
    const response = await f.request();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("authorized-github-marker");
    expect(f.calls).toHaveLength(1);
  });
  it("fails closed before client preparation on an authority outage without exposing its error", async () => {
    const f = fixture({ outage: true });
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-marker");
    expect(f.prepared()).toBe(0);
    expect(f.reads).toHaveLength(0);
  });
  it("redacts tool-caught upstream errors", async () => {
    const f = fixture({ upstreamError: true });
    const response = await f.request();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, reason: "managed_read_unavailable" });
  });
  it("rejects partial GraphQL success without exposing upstream error messages", async () => {
    const f = fixture({ partialError: true });
    const response = await f.request();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(/upstream-private-marker|authorized-github-marker/);
  });
  it("rejects invalid input after admission before creating the App client", async () => {
    const f = fixture();
    const response = await f.request(`about=${"x".repeat(201)}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, reason: "invalid_github_query" });
    expect(f.prepared()).toBe(0);
    expect(f.calls).toHaveLength(2);
  });
  it("ignores caller-supplied repository and API selectors", async () => {
    const f = fixture();
    const response = await f.request("about=README.md&repo=foreign/private&url=https://foreign.test&query=mutation");
    expect(response.status).toBe(200);
    expect(f.reads[0]?.repo).toBe("shlok1806/other");
    const body = JSON.parse(f.reads[0]?.body ?? "{}");
    expect(body.variables).toMatchObject({ owner: "shlok1806", name: "other" });
    expect(body.query).not.toMatch(/\bmutation\b/);
  });
});

describe("GitHub handler with real Organization policy", () => {
  // Each case provisions the same named Channel; discard the prior linked fixture.
  beforeEach(async () => {
    await reset();
  });
  for (const denial of [
    "none",
    "non_member",
    "foreign_organization",
    "foreign_workspace",
    "revoked_execution",
    "expired_execution",
    "wrong_generation",
    "insufficient_scope",
  ] as const) {
    it(`uses decide and withholds upstream access for ${denial}`, async () => {
      const f = { ...(await managedAuthorityFixture()), targetId: agentIdFor("alice", "codex", "session") };
      let sequence = 0;
      const mutate = async (command: IdentityCommand) =>
        f.org.mutateIdentity({
          actor: f.actor,
          command,
          key: `github-${++sequence}`,
          requestId: "github-fixture",
          expectedRevision: (await f.org.metadata(f.actor))?.policyRevision,
        });
      const actions = ["task.read", "channel.update.write"];
      for (const workspaceId of [undefined, f.workspaceId]) {
        expect((await mutate({ kind: "identity.policy", workspaceId, actions })).ok).toBe(true);
      }
      const created = await mutate({
        kind: "principal.create",
        sponsor: { kind: "person", id: f.actor.personId },
        displayName: "GitHub reader",
        capabilities: [],
      });
      if (!created.ok || !created.value.principal) throw new Error("fixture principal denied");
      const principalId = created.value.principal.id;
      expect(
        (
          await mutate({
            kind: "grant.put",
            principalId,
            workspaceId: f.workspaceId,
            actions,
            constraints: {},
            expiresAt: Date.now() + 600000,
          })
        ).ok,
      ).toBe(true);
      const started = await mutate({
        kind: "execution.start",
        principalId,
        workspaceId: f.workspaceId,
        cli: "codex",
        registration: { agentId: f.targetId, sessionId: "session", channel: f.repo },
      });
      if (!started.ok || !started.value.execution || !started.value.secret) throw new Error("fixture execution denied");
      const executionId = started.value.execution.id;
      const credential = started.value.secret;
      // Credential verification consults the actual Channel DO, not the bare
      // handler below. After reset, register its server-derived AgentId before linking.
      await runInDurableObject(env.CHANNEL.getByName(f.repo), async (object, state) => {
        const registered = await object.registerAgent("alice", {
          cli: "codex",
          sessionId: "session",
          resumed: false,
          cwd: "/repo",
        });
        if (!registered.ok) throw new Error("fixture roster denied");
        state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS m1_agent_executions (
          agent TEXT PRIMARY KEY, organizationId TEXT NOT NULL, executionId TEXT NOT NULL, active INTEGER NOT NULL)`);
        state.storage.sql.exec(
          "INSERT OR REPLACE INTO m1_agent_executions VALUES(?,?,?,1)",
          f.targetId,
          f.organizationId,
          executionId,
        );
        Object.assign(object, {
          binding: { version: 1, generation: 1, workspace: f.workspaceId, operation: "binding", state: "linked" },
        });
      });
      await runInDurableObject(f.org, (_object, state) => {
        if (denial === "non_member") {
          const row = JSON.parse(
            state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
          );
          delete row.workspaceMembers[f.workspaceId][f.actor.personId];
          state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(row));
        }
        if (denial === "revoked_execution" || denial === "expired_execution") {
          state.storage.sql.exec(
            "UPDATE executions SET body=json_set(body, '$.status', 'revoked') WHERE id=? AND ?='revoked_execution'",
            executionId,
            denial,
          );
          state.storage.sql.exec(
            "UPDATE execution_credentials SET body=json_set(body, '$.expiresAt', 0) WHERE json_extract(body, '$.executionId')=? AND ?='expired_execution'",
            executionId,
            denial,
          );
        }
        if (denial === "insufficient_scope") {
          state.storage.sql.exec(
            "UPDATE grants SET body=json_set(body, '$.actions', json(?)) WHERE json_extract(body, '$.principalId')=?",
            JSON.stringify(["channel.update.write"]),
            principalId,
          );
        }
      });
      let reads = 0;
      installGitHubApp({
        repo: () => {
          reads++;
          return {
            call: async () =>
              Response.json({
                data: {
                  repository: {
                    url: `https://github.com/${f.repo}`,
                    defaultBranchRef: { name: "main", target: { history: { nodes: [] } } },
                    object: {
                      __typename: "Blob",
                      text: "authorized-marker",
                      byteSize: 17,
                      isBinary: false,
                      isTruncated: false,
                    },
                  },
                },
              }),
          };
        },
      } as unknown as GitHubApp);
      const workspace =
        denial === "foreign_organization"
          ? `${crypto.randomUUID()}:${crypto.randomUUID()}`
          : denial === "foreign_workspace"
            ? `${f.organizationId}:${crypto.randomUUID()}`
            : f.workspaceId;
      const channel = bareChannel({
        version: 1,
        generation: denial === "wrong_generation" ? 2 : 1,
        workspace,
        operation: "binding",
        state: "linked",
      });
      Object.assign(channel, { ctx: { id: env.CHANNEL.idFromName(f.repo) }, env });
      const response = await channel.managedRequest(
        new Request(`https://switchboard.test/r/${f.repo}/api/github?about=README.md`, {
          headers: { Authorization: `Bearer ${credential}` },
        }),
        f.repo,
      );
      expect(response.status).toBe(denial === "none" ? 200 : 404);
      expect(reads).toBe(denial === "none" ? 1 : 0);
      if (denial === "none") expect(await response.text()).toContain("authorized-marker");
      else expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
    });
  }
});
