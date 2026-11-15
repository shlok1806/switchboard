import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelAuthorization } from "../src/organization";
import { bareChannel } from "./managed-helpers";

function fixture(deny?: string, atRelease = false, change?: "enrollment" | "revision") {
  const repo = "shlok1806/other";
  const org = crypto.randomUUID();
  const workspace = `${org}:${crypto.randomUUID()}`;
  const channel = bareChannel({ version: 1, generation: 1, workspace, operation: "binding", state: "linked" });
  const calls: ChannelAuthorization[] = [];
  const association = { active: 1, executionId: "execution", organizationId: org };
  const agent = {
    id: "alice/codex/session",
    cli: "codex",
    presence: "live",
    startedAt: "now",
    lastSeenAt: "now",
    account: "private-marker",
    context: { private: "private-marker" },
    session: "private-marker",
  };
  Object.assign(channel, {
    ctx: { id: env.CHANNEL.idFromName(repo) },
    managedAssociation: () => association,
    agents: { list: () => [agent], find: () => agent },
    env: {
      CHANNEL: env.CHANNEL,
      ORGANIZATION: {
        getByName: () => ({
          authorizeChannelRead: async (input: ChannelAuthorization) => {
            calls.push(input);
            if (calls.length === 3 && change === "enrollment") association.executionId = "replacement";
            if (deny && (!atRelease || calls.length === 3))
              return { ok: false, status: 403, reason: deny, policyRevision: 2 };
            return {
              ok: true,
              value: { target: { principalId: "principal", executionId: "execution", ownerPersonId: "owner" } },
              policyRevision: change === "revision" && calls.length === 3 ? 3 : 2,
            };
          },
        }),
      },
    },
  });
  return {
    calls,
    request: () =>
      channel.managedRequest(
        new Request(`https://switchboard.test/r/${repo}/api/agents`, {
          headers: { Authorization: "Bearer m1.synthetic-authority-stub" },
        }),
        repo,
      ),
  };
}

describe("managed facade roster handler", () => {
  it("rechecks each constituent and releases only SafeAgent allowlist fields", async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("private-marker");
    expect(JSON.parse(body)).toEqual({
      agents: [
        {
          id: "alice/codex/session",
          cli: "codex",
          presence: "live",
          startedAt: "now",
          lastSeenAt: "now",
          principalId: "principal",
          executionId: "execution",
          ownerPersonId: "owner",
        },
      ],
    });
    expect(f.calls).toHaveLength(4);
    expect(f.calls.every((check) => check.action === "agent.view" && check.generation === 1)).toBe(true);
    expect(f.calls[1]?.targetExecutionId).toBe("execution");
    expect(f.calls[2]?.targetExecutionId).toBe("execution");
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
      it(`withholds roster bytes on ${reason} at ${release ? "release" : "admission"}`, async () => {
        const response = await fixture(reason, release).request();
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
      });
    }
  }
  for (const change of ["enrollment", "revision"] as const) {
    it(`discards prepared roster on ${change} change during release`, async () => {
      const response = await fixture(undefined, false, change).request();
      expect(response.status).toBe(404);
      expect(await response.text()).not.toMatch(/agents|private-marker|principal/);
    });
  }
});
