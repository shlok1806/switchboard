import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentId } from "../../shared/src/index";
import { nativeIdentity } from "./m1-helpers";
import { b2Request } from "./managed-b2a-cases";
import { legacyBinding } from "./managed-helpers";
import { queryExecutionFixture } from "./managed-query-cases";

beforeEach(reset);

describe("managed agent controls", () => {
  it("enforces own-execution heartbeat presence and rejects foreign actors or invalid values", async () => {
    const f = await queryExecutionFixture();
    const foreign = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "foreign");
    const target = encodeURIComponent(f.targetId);

    // 1. Positive: own execution updates heartbeat presence
    const positive = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/heartbeat`, { presence: "live" }, false),
      f.repo,
    );
    expect(positive.status).toBe(200);
    const positiveBody = (await positive.json()) as { ok: boolean; agent: { presence: string; lastSeenAt: string } };
    expect(positiveBody.ok).toBe(true);
    expect(positiveBody.agent.presence).toBe("live");
    expect(Date.parse(positiveBody.agent.lastSeenAt)).toBeGreaterThan(0);

    // 2. Negative: invalid presence
    const invalidPresence = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/heartbeat`, { presence: "invalid" }, false),
      f.repo,
    );
    expect(invalidPresence.status).toBe(400);
    expect(await invalidPresence.json()).toMatchObject({ ok: false, reason: "invalid_presence" });

    // 3. Negative: human caller (even owner) cannot call heartbeat
    const humanCaller = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/heartbeat`, { presence: "live" }, true),
      f.repo,
    );
    expect(humanCaller.status).toBe(404);
    expect(await humanCaller.json()).toMatchObject({ ok: false, reason: "resource_denied" });

    // 4. Negative: foreign person cannot call heartbeat
    const foreignPerson = await f.channel.managedRequest(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents/${target}/heartbeat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${foreign.token}` },
        body: JSON.stringify({ presence: "live" }),
      }),
      f.repo,
    );
    expect(foreignPerson.status).toBe(404);

    // 5. Negative: unknown agent target
    const unknownAgent = await f.channel.managedRequest(
      b2Request(f, "/api/agents/unknown%2Fcodex%2F9999/heartbeat", { presence: "live" }, false),
      f.repo,
    );
    expect(unknownAgent.status).toBe(404);
  });

  it("handles agent session end for own execution or owner person and rejects foreign callers", async () => {
    const f = await queryExecutionFixture();
    const foreign = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "foreign");
    const target = encodeURIComponent(f.targetId);

    // 1. Negative: foreign person cannot end session
    const foreignPerson = await f.channel.managedRequest(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents/${target}/end`, {
        method: "POST",
        headers: { Authorization: `Bearer ${foreign.token}` },
        body: JSON.stringify({ detail: "exit" }),
      }),
      f.repo,
    );
    expect(foreignPerson.status).toBe(404);

    // 2. Negative: unknown agent target
    const unknownAgent = await f.channel.managedRequest(
      b2Request(f, "/api/agents/unknown%2Fcodex%2F9999/end", { detail: "exit" }, true),
      f.repo,
    );
    expect(unknownAgent.status).toBe(404);

    // 3. Positive: owner person can end session
    const ownerEnd = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/end`, { detail: "done by owner" }, true),
      f.repo,
    );
    expect(ownerEnd.status).toBe(200);
    const body = (await ownerEnd.json()) as { ok: boolean; agent: { presence: string } };
    expect(body.ok).toBe(true);
    expect(body.agent.presence).toBe("gone");

    // Association is now ended, subsequent end call fails with 404
    const secondEnd = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/end`, { detail: "again" }, true),
      f.repo,
    );
    expect(secondEnd.status).toBe(404);
  });

  it("restricts proxy-mode and nickname mutation to the owning person", async () => {
    const f = await queryExecutionFixture();
    const foreign = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "foreign");
    const target = encodeURIComponent(f.targetId);

    // --- Proxy Mode ---
    // Negative: execution caller cannot set proxy-mode
    const execProxy = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/proxy-mode`, { mode: "raw" }, false),
      f.repo,
    );
    expect(execProxy.status).toBe(404);

    // Negative: foreign person cannot set proxy-mode
    const foreignProxy = await f.channel.managedRequest(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents/${target}/proxy-mode`, {
        method: "POST",
        headers: { Authorization: `Bearer ${foreign.token}` },
        body: JSON.stringify({ mode: "raw" }),
      }),
      f.repo,
    );
    expect(foreignProxy.status).toBe(404);

    // Negative: invalid mode
    const invalidProxy = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/proxy-mode`, { mode: "invalid" }, true),
      f.repo,
    );
    expect(invalidProxy.status).toBe(400);
    expect(await invalidProxy.json()).toMatchObject({ ok: false, reason: "invalid_proxy_mode" });

    // Positive: owner person sets proxy-mode
    const ownerProxy = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/proxy-mode`, { mode: "raw" }, true),
      f.repo,
    );
    expect(ownerProxy.status).toBe(200);
    expect(await ownerProxy.json()).toMatchObject({ ok: true, agent: { proxyMode: "raw" } });

    // --- Nickname ---
    // Negative: execution caller cannot set nickname
    const execNick = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/nickname`, { nickname: "scout" }, false),
      f.repo,
    );
    expect(execNick.status).toBe(404);

    // Negative: foreign person cannot set nickname
    const foreignNick = await f.channel.managedRequest(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents/${target}/nickname`, {
        method: "POST",
        headers: { Authorization: `Bearer ${foreign.token}` },
        body: JSON.stringify({ nickname: "scout" }),
      }),
      f.repo,
    );
    expect(foreignNick.status).toBe(404);

    // Negative: invalid nickname
    const invalidNick = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/nickname`, { nickname: "" }, true),
      f.repo,
    );
    expect(invalidNick.status).toBe(400);
    expect(await invalidNick.json()).toMatchObject({ ok: false, reason: "invalid_nickname" });

    // Positive: owner person sets nickname
    const ownerNick = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/nickname`, { nickname: "scout" }, true),
      f.repo,
    );
    expect(ownerNick.status).toBe(200);
    expect(await ownerNick.json()).toMatchObject({ ok: true, agent: { nickname: "scout" } });
  });

  it("admits model updates from own execution or owner person and rejects foreign callers", async () => {
    const f = await queryExecutionFixture();
    const foreign = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "foreign");
    const target = encodeURIComponent(f.targetId);

    // Negative: foreign person
    const foreignRes = await f.channel.managedRequest(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents/${target}/model`, {
        method: "POST",
        headers: { Authorization: `Bearer ${foreign.token}` },
        body: JSON.stringify({ model: "gpt-4o", effort: "high" }),
      }),
      f.repo,
    );
    expect(foreignRes.status).toBe(404);

    // Negative: invalid model body
    const invalidRes = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/model`, { model: 123 }, true),
      f.repo,
    );
    expect(invalidRes.status).toBe(400);
    expect(await invalidRes.json()).toMatchObject({ ok: false, reason: "invalid_model" });

    // Positive: execution caller
    const execRes = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/model`, { model: "gpt-4o", effort: "high" }, false),
      f.repo,
    );
    expect(execRes.status).toBe(200);
    expect(await execRes.json()).toMatchObject({ ok: true, agent: { model: "gpt-4o", effort: "high" } });

    // Positive: owner person
    const ownerRes = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/model`, { model: "claude-3-7-sonnet", effort: "low" }, true),
      f.repo,
    );
    expect(ownerRes.status).toBe(200);
    expect(await ownerRes.json()).toMatchObject({ ok: true, agent: { model: "claude-3-7-sonnet", effort: "low" } });
  });

  it("manages approvals and requires terminal_control consent for cross-owner deny", async () => {
    const f = await queryExecutionFixture();
    const foreign = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "foreign");
    const target = encodeURIComponent(f.targetId);

    // 1. Approval set by own execution
    const openedAt = new Date().toISOString();
    const setApproval = await f.channel.managedRequest(
      b2Request(
        f,
        `/api/agents/${target}/approval`,
        { approval: { id: "app-1", tool: "bash", openedAt, detail: "run test", deniable: true } },
        false,
      ),
      f.repo,
    );
    expect(setApproval.status).toBe(200);
    expect(await setApproval.json()).toMatchObject({
      ok: true,
      agent: { approval: expect.objectContaining({ id: "app-1", tool: "bash" }) },
    });

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(f.channel, (object) => {
      (object as unknown as { interruptTo: () => boolean }).interruptTo = () => true;
    });

    // 2. Negative: person caller cannot set approval (execution only)
    const personApproval = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/approval`, { approval: null }, true),
      f.repo,
    );
    expect(personApproval.status).toBe(404);

    // 3. Approval deny: execution caller cannot deny
    const execDeny = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/approval/deny`, { id: "app-1", message: "rejected" }, false),
      f.repo,
    );
    expect(execDeny.status).toBe(404);

    // 4. Approval deny: foreign person without consent fails
    const foreignDeny = await f.channel.managedRequest(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents/${target}/approval/deny`, {
        method: "POST",
        headers: { Authorization: `Bearer ${foreign.token}` },
        body: JSON.stringify({ id: "app-1", message: "rejected" }),
      }),
      f.repo,
    );
    expect(foreignDeny.status).toBe(404);

    // 5. Positive: owner person can deny approval directly
    const ownerDeny = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/approval/deny`, { id: "app-1", message: "no" }, true),
      f.repo,
    );
    expect(ownerDeny.status).toBe(200);
    expect(await ownerDeny.json()).toMatchObject({
      ok: true,
      agent: { approval: expect.objectContaining({ id: "app-1", deniedBy: "alice" }) },
    });
  });

  it("restricts agent role management to workspace managers and rejects non-managers", async () => {
    const f = await queryExecutionFixture();
    const foreign = await nativeIdentity(String(Math.floor(Math.random() * 1e12) + 1000), "foreign");
    const target = encodeURIComponent(f.targetId);

    // Execution caller cannot manage roles
    const execRole = await f.channel.managedRequest(
      b2Request(f, `/api/agents/${target}/role`, { role: "lead" }, false),
      f.repo,
    );
    expect(execRole.status).toBe(404);

    // Non-member foreign caller cannot manage roles
    const foreignRole = await f.channel.managedRequest(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents/${target}/role`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${foreign.token}` },
        body: JSON.stringify({ role: "lead" }),
      }),
      f.repo,
    );
    expect(foreignRole.status).toBe(404);

    // Negative: invalid role
    const invalidRole = await f.channel.managedRequest(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents/${target}/role`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${f.token}` },
        body: JSON.stringify({ role: "invalid" }),
      }),
      f.repo,
    );
    expect(invalidRole.status).toBe(400);
    expect(await invalidRole.json()).toMatchObject({ ok: false, reason: "invalid_role" });

    // Positive: workspace manager (f.actor) grants lead role
    const grantRole = await f.channel.managedRequest(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents/${target}/role`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${f.token}` },
        body: JSON.stringify({ role: "lead" }),
      }),
      f.repo,
    );
    expect(grantRole.status).toBe(200);
    expect(await grantRole.json()).toMatchObject({ ok: true, agent: { role: "lead" } });

    // Positive: workspace manager revokes role via DELETE
    const revokeRole = await f.channel.managedRequest(
      new Request(`https://switchboard.test/r/${f.repo}/api/agents/${target}/role`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${f.token}` },
      }),
      f.repo,
    );
    expect(revokeRole.status).toBe(200);
    const revokeBody = (await revokeRole.json()) as { ok: boolean; agent: { role?: string } };
    expect(revokeBody.ok).toBe(true);
    expect(revokeBody.agent.role).toBeUndefined();
  });

  it("preserves synchronous unlinked dispatch without touching Organization DO or executions", async () => {
    const { env, runInDurableObject } = await import("cloudflare:test");
    const channel = env.CHANNEL.getByName("unlinked-controls");
    await runInDurableObject(channel, async (object) => {
      Object.assign(object, { binding: legacyBinding });
      const hb = await object.heartbeat("alice", "alice/codex/1234" as AgentId, "idle");
      expect(hb.ok).toBe(true);

      const role = object.setAgentRole({ person: "alice" }, "alice/codex/1234" as AgentId, "lead");
      expect(role).toBeDefined();
    });
  });
});
