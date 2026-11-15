import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MANAGED_OPERATIONS, managedOperationRoute, managedReadRoute, managedWriteRoute } from "../src/managed-channel";
import type { ChannelAuthorization } from "../src/organization";
import { bareChannel } from "./managed-helpers";

describe("managed facade migration", () => {
  it("covers every registered descriptor with a concrete admitted route", () => {
    const examples: [string, string][] = [
      ["POST", "/api/skill-files/read"],
      ["GET", "/api/memory"],
      ["GET", "/api/skills"],
      ["GET", "/api/skills/example"],
      ["GET", "/api/artifacts/example/page"],
      ["GET", "/api/agents"],
      ["GET", "/api/agents/alice%2Fcodex%2Fs/summary"],
      ...["transcript", "terminal", "touched-files"].map((suffix): [string, string] => [
        "GET",
        `/api/agents/alice%2Fcodex%2Fs/${suffix}`,
      ]),
      ["GET", "/api/tasks"],
      ["GET", "/api/relay"],
      ["PUT", "/api/brief/example"],
      ["PUT", "/api/artifacts/example"],
      ["DELETE", "/api/artifacts/example"],
      ["POST", "/api/memory"],
      ["POST", "/api/directives"],
      ["POST", "/api/updates"],
      ...["claim", "release", "branch", "finish", "takeover", "steps/0/complete"].map((suffix): [string, string] => [
        "POST",
        `/api/tasks/1/${suffix}`,
      ]),
    ];
    const resolved = examples.map(([method, path]) => managedOperationRoute(method, path));
    expect(resolved.every(Boolean)).toBe(true);
    expect(resolved.map((route) => route?.id).sort()).toEqual(Object.keys(MANAGED_OPERATIONS).sort());
    for (const route of resolved) {
      if (!route) throw new Error("missing descriptor");
      expect(route).toMatchObject(MANAGED_OPERATIONS[route.id]);
    }
  });
  it("resolves existing routes through registered descriptors without opening deferred families", () => {
    expect(managedOperationRoute("GET", "/api/relay")).toMatchObject({
      id: "relay.read",
      mode: "read",
      action: "workspace.read",
      targetId: "relay",
    });
    expect(managedOperationRoute("POST", "/api/tasks/12/steps/3/complete")).toMatchObject({
      id: "task.step.complete",
      mode: "write",
      action: "task.update",
      targetId: "12",
      operation: "task.steps/3/complete",
    });
    for (const path of ["/api/events", "/api/persons", "/api/accounts", "/api/stream", "/api/settings/langfuse"])
      expect(managedReadRoute("GET", path)).toBeNull();
    expect(managedWriteRoute("POST", "/api/agents")).toBeNull();
    expect(Object.hasOwn(MANAGED_OPERATIONS, "constructor")).toBe(false);
  });

  function fixture(denial?: string, release = false) {
    const repo = "shlok1806/other";
    const organizationId = crypto.randomUUID();
    const workspace = `${organizationId}:${crypto.randomUUID()}`;
    const binding = { version: 1, generation: 1, workspace, operation: "binding", state: "linked" };
    const channel = bareChannel(binding);
    const calls: ChannelAuthorization[] = [];
    Object.assign(channel, {
      ctx: { id: env.CHANNEL.idFromName(repo) },
      env: {
        CHANNEL: env.CHANNEL,
        ORGANIZATION: {
          getByName: () => ({
            authorizeChannelRead: async (input: ChannelAuthorization) => {
              calls.push(input);
              if (denial && (!release || calls.length === 2))
                return { ok: false, status: 403, reason: denial, policyRevision: 1 };
              return { ok: true, value: {}, policyRevision: 1 };
            },
          }),
        },
      },
    });
    const request = () =>
      channel.managedRequest(
        new Request(`https://switchboard.test/r/${repo}/api/relay`, {
          headers: { Authorization: "Bearer m1.synthetic-authority-stub" },
        }),
        repo,
      );
    return { request, calls };
  }

  it("admits real relay HTTP reads with the registered action and exact binding at admission and release", async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("relay");
    expect(f.calls).toHaveLength(2);
    for (const call of f.calls) {
      expect(call.action).toBe("workspace.read");
      expect(call.generation).toBe(1);
      expect(call.resource).toMatchObject({ targetId: "relay", operation: "relay.read" });
    }
  });

  for (const reason of [
    "non_member",
    "foreign_workspace",
    "revoked_execution",
    "expired_execution",
    "wrong_generation",
    "insufficient_scope",
  ]) {
    for (const release of [false, true]) {
      it(`withholds real relay HTTP bytes on ${reason} at ${release ? "release" : "admission"}`, async () => {
        const f = fixture(reason, release);
        const response = await f.request();
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
        expect(f.calls).toHaveLength(release ? 2 : 1);
      });
    }
  }
});
