import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { managedRead } from "../src/managed-channel";
import type { ChannelAuthorization } from "../src/organization";
import { AuthorityUnavailable } from "../src/policy-permits";
import { bareChannel, invoke, legacyBinding, linkedBinding, managedAuthorityFixture } from "./managed-helpers";

const input: ChannelAuthorization = {
  actor: { kind: "person", personId: "actor", githubId: "1" },
  action: "task.read",
  generation: 1,
  requestId: "request",
  resource: {
    kind: "workspace",
    organizationId: "org",
    id: "workspace",
    channel: "owner/repo",
    targetId: "1",
    operation: "task.read",
  },
};
const allowed = { ok: true as const, value: {}, policyRevision: 1 };
const denied = { ok: false as const, status: 403 as const, reason: "denied", policyRevision: 2 };

describe("managed read release", () => {
  it("checks authority before reading and freshly before releasing without caching", async () => {
    const authorize = vi.fn().mockResolvedValue(allowed);
    const read = vi.fn().mockResolvedValue({ tasks: ["visible"] });
    for (let i = 0; i < 2; i++) {
      const response = await managedRead({ input, authorize, read, current: () => true });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ tasks: ["visible"] });
    }
    expect(authorize).toHaveBeenCalledTimes(4);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("denies nonmembers before reading counts cursors or direct IDs", async () => {
    const read = vi.fn();
    const response = await managedRead({ input, authorize: async () => denied, read, current: () => true });
    expect(response.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    expect(await response.text()).not.toMatch(/tasks|cursor|count/);
  });
  it("discards content when revocation or binding transition occurs during a read", async () => {
    const read = async () => ({ privateMarker: "never release" });
    for (const change of ["revoke", "binding"]) {
      const authorize = vi
        .fn()
        .mockResolvedValueOnce(allowed)
        .mockResolvedValueOnce(change === "revoke" ? denied : allowed);
      let checks = 0;
      const response = await managedRead({
        input,
        authorize,
        read,
        current: () => ++checks === 1 || change === "revoke",
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("never release");
    }
  });
  it("returns redacted 503 on authority failure", async () => {
    const response = await managedRead({
      input,
      authorize: async () => {
        throw new AuthorityUnavailable();
      },
      read: vi.fn(),
      current: () => true,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, reason: "authority_unavailable" });
  });
  it("bounds a hung authority call at two seconds without reading or leaking errors", async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn();
      const pending = managedRead({
        input,
        current: () => true,
        read,
        authorize: () => new Promise(() => {}),
      });
      await vi.advanceTimersByTimeAsync(2000);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, reason: "authority_unavailable" });
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("denies pending and unknown bindings synchronously and preserves the legacy direct read", () => {
    for (const binding of [
      { ...linkedBinding, state: "pending" },
      { ...linkedBinding, version: 2 },
    ])
      expect(() => invoke(bareChannel(binding), "listAgents")).toThrow("managed_actor_required");
    const channel = bareChannel(legacyBinding);
    const list = vi.fn().mockReturnValue(["legacy"]);
    Object.assign(channel, { agents: { list } });
    expect(invoke(channel, "listAgents")).toEqual(["legacy"]);
    expect(list).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("managed Organization read authority", () => {
  it("uses decide for linked reads and denies removed members foreign actors stale generations and write attenuation", async () => {
    const id = crypto.randomUUID();
    const person = { kind: "person" as const, personId: crypto.randomUUID(), githubId: "901" };
    const authority = env.ORGANIZATION.getByName(id);
    expect((await authority.initialize(id, "Read org", person, "init")).ok).toBe(true);
    const created = await authority.mutate({
      actor: person,
      key: "workspace",
      requestId: "workspace",
      command: { kind: "workspace.create", name: "Operations", description: "", acceptManager: true },
    });
    if (!created.ok || !("id" in created.value)) throw new Error("workspace missing");
    const workspaceId = created.value.id;
    await runInDurableObject(authority, (_object, state) => {
      const aggregate = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
      );
      aggregate.workspaces[workspaceId].channel = "test/read";
      state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
      state.storage.sql.exec(
        "INSERT INTO binding_operations VALUES(?,?,?)",
        "binding",
        "binding",
        JSON.stringify({
          id: "binding",
          actor: person,
          workspaceId,
          repo: "test/read",
          mode: "bind",
          phase: "done",
          generation: 0,
          key: "binding",
        }),
      );
    });
    const request: ChannelAuthorization = {
      actor: person,
      action: "task.read",
      generation: 1,
      requestId: "read",
      resource: {
        kind: "workspace",
        organizationId: id,
        id: workspaceId,
        channel: "test/read",
        targetId: "1",
        operation: "task.read",
      },
    };
    expect(await authority.authorizeChannelRead(request)).toMatchObject({ ok: true });
    expect(await authority.authorizeChannelRead({ ...request, action: "task.update" })).toMatchObject({ ok: false });
    expect(await authority.authorizeChannelRead({ ...request, generation: 0 })).toMatchObject({ ok: false });
    expect(
      await authority.authorizeChannelRead({ ...request, actor: { ...person, personId: crypto.randomUUID() } }),
    ).toMatchObject({ ok: false });
    await runInDurableObject(authority, (_object, state) => {
      const aggregate = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").one().body,
      );
      // Preserve Organization ownership: an org admin still has no content membership override.
      delete aggregate.workspaceMembers[workspaceId][person.personId];
      aggregate.organization.policyRevision++;
      state.storage.sql.exec("UPDATE aggregate SET body=? WHERE id=1", JSON.stringify(aggregate));
    });
    expect(await authority.authorizeChannelRead(request)).toMatchObject({ ok: false });
  });
  it("catalog pagination performs filtering and bounded keyset SQL reads", async () => {
    const f = await managedAuthorityFixture();
    await runInDurableObject(f.org, (_object, state) => {
      for (let i = 0; i < 105; i++) {
        const id = `${f.organizationId}:${i.toString().padStart(4, "0")}`;
        state.storage.sql.exec(
          "INSERT INTO principals VALUES(?,?)",
          id,
          JSON.stringify({
            id,
            organizationId: f.organizationId,
            sponsor: { kind: "person", id: f.actor.personId },
            displayName: `Agent ${i}`,
            capabilities: [],
            status: "active",
            createdBy: f.actor.personId,
            createdAt: Date.now(),
          }),
        );
      }
    });
    const page = await f.org.identityCatalog(f.actor);
    expect(page?.items).toHaveLength(100);
    expect(page?.next).toBe(page?.items[99]?.id);
    const next = await f.org.identityCatalog(f.actor, page?.next ?? "");
    expect(next?.items).toHaveLength(5);
    expect(next?.next).toBeNull();
    expect(await f.org.identityCatalog({ ...f.actor, personId: crypto.randomUUID() })).toBeNull();
  });
});
