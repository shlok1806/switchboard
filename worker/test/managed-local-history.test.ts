import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ManagedHistoryOptions,
  type ManagedHistoryRequest,
  ManagedLocalHistory,
} from "../src/managed-local-history";
import type { AuthorityValue } from "../src/managed-query";
import { runManagedQuery } from "../src/managed-query";
import { createManagedQuery } from "../src/managed-query-registry";
import type { ChannelAuthorization } from "../src/organization";
import { decide, type OwnerConsent } from "../src/policy";
import { bareChannel } from "./managed-helpers";
import { queryDenials } from "./managed-query-cases";

function fixture(adapter = new ManagedLocalHistory()) {
  const organizationId = crypto.randomUUID();
  const binding = {
    organizationId,
    workspaceId: `${organizationId}:${crypto.randomUUID()}`,
    channel: "owner/repo",
    generation: 1,
    operation: "binding",
  };
  const actor = { kind: "person" as const, personId: crypto.randomUUID(), githubId: "123" };
  const authorization: ChannelAuthorization = {
    actor,
    action: "channel.history.read",
    generation: 1,
    requestId: "query",
    resource: {
      kind: "workspace",
      organizationId,
      id: binding.workspaceId,
      channel: binding.channel,
      targetId: "events",
      operation: "history.read",
    },
  };
  const connection = {};
  const target = {
    connection,
    hostId: "trusted-host",
    executionId: "target-execution",
    principalId: "principal",
    ownerPersonId: actor.personId,
    agentId: "alice/codex/session",
  };
  let current = true;
  let holderCurrent = true;
  let denied: string | undefined;
  let lease = true;
  let releaseDenied = false;
  let outage = false;
  let deadline = Date.now() + 10000;
  const sent: ManagedHistoryRequest[] = [];
  const checks: ChannelAuthorization[] = [];
  const options: ManagedHistoryOptions = {
    queryId: crypto.randomUUID(),
    binding,
    authorization,
    holder: target,
    selector: { kind: "before", boundary: 50, limit: 20 },
    policyRevision: 1,
    preparationDeadline: Date.now() + 10000,
    configuredHistoryWaitMs: 3000,
    now: () => Date.now(),
    holderCurrent: () => holderCurrent,
    localCeiling: () => ({
      workspaceId: binding.workspaceId,
      generation: 1,
      hostId: target.hostId,
      executionId: target.executionId,
      ownerPersonId: target.ownerPersonId,
      resolvedCwd: "/repo/project",
      roots: ["/repo"],
      mode: "default",
      maxMode: "default",
      activeExecutions: 1,
      maxExecutions: 2,
      allowedPersonIds: [],
      expiresAt: Date.now() + 10000,
    }),
    recipientLease: () => (lease ? { generation: 1, policyRevision: 1, expiresAt: Date.now() + 5000 } : null),
    send: (socket, request) => {
      expect(socket).toBe(connection);
      sent.push(request);
    },
    context: {
      consumeCandidates: () => {},
      boundary: () => {
        if (!current) throw new Error("resource_denied");
      },
      onRetain: () => {},
      check: async (input): Promise<AuthorityValue | null> => {
        checks.push(input);
        if (outage) throw new Error("authority_unavailable");
        if (denied || (releaseDenied && sent.length)) return null;
        return { actor, deadline, ...(input.action === "agent.view" ? { target } : {}) };
      },
    },
  };
  const reply = (events: unknown[], overrides: Record<string, unknown> = {}, socket = connection) => {
    const request = sent[0];
    if (!request) throw new Error("request not sent");
    return adapter.reply(
      socket,
      JSON.stringify({
        type: "managed.history.page",
        id: request.id,
        hostId: target.hostId,
        executionId: target.executionId,
        generation: 1,
        policyRevision: 1,
        selector: request.selector,
        events,
        exhausted: true,
        next: null,
        ...overrides,
      }),
    );
  };
  const event = (id = "visible", seq = 2) => ({
    id,
    seq,
    at: new Date().toISOString(),
    actor: { kind: "agent", agentId: target.agentId },
    type: "update",
    payload: { text: "shared" },
    capture: "tool",
    session: "private-session-marker",
  });
  return {
    adapter,
    options,
    sent,
    checks,
    connection,
    target,
    reply,
    event,
    deny: (reason: string) => {
      denied = reason;
    },
    invalidate: () => {
      current = false;
      adapter.invalidate();
    },
    replace: () => {
      holderCurrent = false;
    },
    noLease: () => {
      lease = false;
    },
    denyRelease: () => {
      releaseDenied = true;
    },
    outage: () => {
      outage = true;
    },
    expire: () => {
      deadline = Date.now();
    },
  };
}
async function dispatched(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 20 && !f.sent.length; i++) await Promise.resolve();
  expect(f.sent).toHaveLength(1);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("guarded managed local-history preparation (no Channel transport admission)", () => {
  for (const change of ["replacement", "binding", "deadline"] as const) {
    it(`retains the synchronous holder fence until final query release: ${change}`, async () => {
      const f = fixture();
      const retained: Array<() => void> = [];
      f.options.context.onRetain = (effect) => retained.push(effect);
      const result = f.adapter.request(f.options);
      await dispatched(f);
      expect(f.reply([f.event()])).toBe(true);
      expect(await result).toMatchObject({ available: true });
      expect(retained).toHaveLength(1);
      expect(() => retained[0]?.()).not.toThrow();
      if (change === "replacement") f.replace();
      else if (change === "binding") f.invalidate();
      else vi.setSystemTime(f.options.preparationDeadline);
      const checks = f.checks.length;
      expect(() => retained[0]?.()).toThrow("resource_denied");
      expect(f.checks).toHaveLength(checks);
      expect(f.adapter.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  }
  it("charges every accepted raw holder candidate before projection, including private and duplicate rows", async () => {
    const f = fixture();
    const charged: number[] = [];
    f.options.context.consumeCandidates = (count) => charged.push(count);
    const result = f.adapter.request(f.options);
    await dispatched(f);
    const event = f.event();
    expect(f.reply([event, event, { ...event, id: "private", type: "directive" }])).toBe(true);
    expect(charged).toEqual([3]);
    expect(await result).toMatchObject({ available: true, events: [{ id: event.id }] });
    expect(f.adapter.size).toBe(0);
  });
  it("aborts and clears timers when the shared query budget rejects a holder reply", async () => {
    const f = fixture();
    f.options.context.consumeCandidates = () => {
      throw new Error("managed_read_unavailable");
    };
    const result = f.adapter.request(f.options);
    await dispatched(f);
    expect(f.reply([f.event()])).toBe(false);
    await expect(result).rejects.toThrow("managed_read_unavailable");
    expect(f.adapter.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.reply([])).toBe(false);
  });
  it("rejects a historical author decision naming a replacement execution", async () => {
    const f = fixture();
    const check = f.options.context.check;
    f.options.context.check = async (input) => {
      const result = await check(input);
      return result && input.resource.operation === "history.author"
        ? { ...result, target: { ...f.target, executionId: "replacement" } }
        : result;
    };
    const result = f.adapter.request(f.options);
    await dispatched(f);
    expect(f.reply([f.event()])).toBe(true);
    await expect(result).rejects.toThrow("resource_denied");
    expect(f.adapter.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  for (const change of ["none", "release", "floor", "outage"] as const) {
    it(`uses the registered executor's authority/release boundary: ${change}`, async () => {
      const f = fixture();
      let replied = false;
      let floor = 0;
      const calls: ChannelAuthorization[] = [];
      f.options.send = (connection, request) => {
        f.sent.push(request);
        expect(connection).toBe(f.connection);
        if (change === "floor") floor = 2;
        f.reply([f.event()]);
        replied = true;
      };
      const authorization = f.options.authorization;
      const page = { source: "local" as const, selector: { kind: "tail" as const }, wakesOnly: false, limit: 1 };
      const plan = createManagedQuery({
        scope: { id: "history", binding: f.options.binding, authorization },
        constituents: [
          {
            id: "agents",
            authorization: {
              ...authorization,
              action: "agent.view",
              resource: { ...authorization.resource, targetId: "agents" },
            },
            page,
            projection: { id: "empty", project: async () => null },
            readWindow: async () => ({ rows: [], nextInternal: null, exhausted: true }),
          },
          {
            id: "events",
            authorization: { ...authorization, action: "channel.update.read" },
            page,
            projection: {
              id: "guarded-holder",
              project: async (_row, context) => {
                const result = await f.adapter.request({ ...f.options, context });
                return result.available ? result.events : [];
              },
            },
            readWindow: async () => ({ rows: [{ key: "holder", value: null }], nextInternal: null, exhausted: true }),
          },
        ],
        assemble: (parts) => ({ events: parts.get("events")?.flat() }),
      });
      const result = await runManagedQuery(
        plan,
        {
          check: async (input) => {
            calls.push(input);
            if (change === "outage") throw new Error("private-authority-error");
            if (replied && change === "release")
              return { ok: false, status: 403, reason: "resource_denied", policyRevision: 1 };
            return {
              ok: true,
              policyRevision: 1,
              value: {
                actor: { kind: "person", personId: f.target.ownerPersonId, githubId: "123" },
                deadline: Date.now() + 10000,
                ...(input.action === "agent.view" ? { target: f.target } : {}),
              },
            };
          },
        },
        { bindingCurrent: () => true, revisionFloor: () => floor, now: () => Date.now() },
      );
      expect(f.adapter.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      if (change === "none") {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.envelope.value).toMatchObject({ events: [{ payload: { text: "shared" } }] });
        expect(calls.filter((input) => input.resource.operation === "history.author")).toHaveLength(2);
      } else {
        expect(result).toEqual({
          ok: false,
          error: {
            status: change === "outage" ? 503 : 404,
            reason: change === "outage" ? "authority_unavailable" : "resource_denied",
          },
        });
        expect(JSON.stringify(result)).not.toContain("private-authority-error");
      }
    });
  }
  it("independently checks HR, UR and exact-target AV and releases only projected shared Events", async () => {
    const f = fixture();
    const result = f.adapter.request(f.options);
    await dispatched(f);
    expect(f.checks.map((input) => input.action)).toEqual([
      "channel.history.read",
      "channel.update.read",
      "agent.view",
    ]);
    expect(f.sent[0]).toMatchObject({
      projection: "shared.events",
      requester: {
        kind: "person",
        personId: "personId" in f.options.authorization.actor ? f.options.authorization.actor.personId : "",
      },
      binding: f.options.binding,
      executionId: f.target.executionId,
    });
    expect(JSON.stringify(f.sent)).not.toContain("githubId");
    const shared = f.event();
    expect(
      f.reply([
        shared,
        { ...shared, id: "private", type: "directive", payload: { text: "private-marker" } },
        { ...shared, id: "directed", payload: { text: "private-marker", to: [f.target.agentId] } },
      ]),
    ).toBe(true);
    const value = await result;
    expect(value).toEqual({
      available: true,
      events: [
        {
          id: shared.id,
          seq: shared.seq,
          at: shared.at,
          actor: shared.actor,
          type: "update",
          payload: { text: "shared" },
        },
      ],
    });
    expect(JSON.stringify(value)).not.toContain("private");
    expect(f.checks.filter((input) => input.action === "channel.history.read")).toHaveLength(2);
    expect(f.checks.at(-1)).toMatchObject({
      action: "agent.view",
      targetExecutionId: f.target.executionId,
      eventAt: Date.parse(shared.at),
      resource: { operation: "history.author", targetId: f.target.agentId },
    });
    expect(f.adapter.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  for (const denial of queryDenials) {
    it(`never dispatches on authority denial: ${denial}`, async () => {
      const f = fixture();
      f.deny(denial);
      await expect(f.adapter.request(f.options)).rejects.toThrow("resource_denied");
      expect(f.sent).toEqual([]);
      expect(f.adapter.size).toBe(0);
    });
  }
  for (const action of ["channel.history.read", "channel.update.read", "agent.view"]) {
    it(`requires ${action} before dispatch`, async () => {
      const f = fixture();
      const check = f.options.context.check;
      f.options.context.check = (input) => (input.action === action ? Promise.resolve(null) : check(input));
      await expect(f.adapter.request(f.options)).rejects.toThrow("resource_denied");
      expect(f.sent).toEqual([]);
    });
  }
  for (const [wait, budget, expected] of [
    [3000, 10000, 2000],
    [100, 10000, 100],
    [3000, 80, 80],
  ]) {
    it(`caps holder wait at min(configured=${wait}, remaining=${budget}, 2000) and unregisters immediately`, async () => {
      const f = fixture();
      f.options.configuredHistoryWaitMs = wait as number;
      f.options.preparationDeadline = Date.now() + (budget as number);
      const result = f.adapter.request(f.options);
      // Expiry of the overall authority/query budget denies; holder-only timeout is unavailable.
      const observed = result.then(
        (value) => value,
        (error: Error) => error.message,
      );
      await dispatched(f);
      await vi.advanceTimersByTimeAsync((expected as number) - 1);
      expect(f.adapter.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.adapter.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(await observed).toEqual(budget === expected ? "resource_denied" : { available: false });
      expect(f.reply([])).toBe(false);
    });
  }
  for (const kind of ["connection", "host", "execution", "generation", "revision", "selector", "request"] as const) {
    it(`rejects forged ${kind} replies without settling the authentic pending request`, async () => {
      const f = fixture();
      const result = f.adapter.request(f.options);
      await dispatched(f);
      const overrides =
        kind === "host"
          ? { hostId: "foreign" }
          : kind === "execution"
            ? { executionId: "replacement" }
            : kind === "generation"
              ? { generation: 2 }
              : kind === "revision"
                ? { policyRevision: 2 }
                : kind === "selector"
                  ? { selector: { kind: "tail", limit: 1000 } }
                  : kind === "request"
                    ? { id: crypto.randomUUID() }
                    : {};
      expect(f.reply([f.event()], overrides, kind === "connection" ? {} : f.connection)).toBe(false);
      expect(f.adapter.size).toBe(1);
      expect(f.reply([])).toBe(true);
      expect(await result).toEqual({ available: true, events: [] });
      expect(f.reply([])).toBe(false);
    });
  }
  it("rejects malformed, oversized, foreign-author and expanded-selector payloads before projection", async () => {
    const f = fixture();
    const result = f.adapter.request(f.options);
    await dispatched(f);
    expect(f.adapter.reply(f.connection, "{")).toBe(false);
    expect(f.adapter.reply(f.connection, "x".repeat(1024 * 1024 + 1))).toBe(false);
    expect(f.reply([{ ...f.event(), actor: { kind: "agent", agentId: "foreign" } }])).toBe(false);
    expect(f.reply([f.event("out-of-range", 50)])).toBe(false);
    expect(f.reply([{ ...f.event(), payload: { text: 123 } }])).toBe(false);
    expect(f.reply(Array.from({ length: 21 }, (_, i) => f.event(`event-${i}`)))).toBe(false);
    expect(f.reply([])).toBe(true);
    await result;
  });
  for (const reason of ["noLease", "expire", "replace"] as const) {
    it(`does not dispatch with ${reason}`, async () => {
      const f = fixture();
      f[reason]();
      await expect(f.adapter.request(f.options)).rejects.toThrow("resource_denied");
      expect(f.sent).toEqual([]);
      expect(f.adapter.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  }
  it("withholds prepared rows when requester authority changes after reply", async () => {
    const f = fixture();
    const result = f.adapter.request(f.options);
    await dispatched(f);
    f.denyRelease();
    expect(f.reply([f.event()])).toBe(true);
    await expect(result).rejects.toThrow("resource_denied");
    expect(f.adapter.size).toBe(0);
  });
  it("cancels pending reads on invalidation and denies rather than reporting an authority failure as offline", async () => {
    const f = fixture();
    const result = f.adapter.request(f.options);
    await dispatched(f);
    f.invalidate();
    await expect(result).rejects.toThrow("resource_denied");
    expect(f.reply([])).toBe(false);
    expect(f.adapter.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns safe unavailability only for an authorized disconnected holder", async () => {
    const f = fixture();
    const result = f.adapter.request(f.options);
    await dispatched(f);
    f.adapter.disconnect({});
    expect(f.adapter.size).toBe(1);
    f.adapter.disconnect(f.connection);
    expect(await result).toEqual({ available: false });
    expect(f.adapter.size).toBe(0);
  });
  it("propagates authority outage without dispatch or holder metadata", async () => {
    const f = fixture();
    f.outage();
    await expect(f.adapter.request(f.options)).rejects.toThrow("authority_unavailable");
    expect(f.sent).toEqual([]);
    expect(f.adapter.size).toBe(0);
  });
  it("bounds pending requests to 32 per query and 128 per Channel without evicting admitted requests", async () => {
    const adapter = new ManagedLocalHistory();
    const pending: Promise<unknown>[] = [];
    const fixtures = Array.from({ length: 4 }, () => fixture(adapter));
    for (const f of fixtures) {
      for (let i = 0; i < 32; i++) pending.push(adapter.request(f.options));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(f.sent).toHaveLength(32);
      await expect(adapter.request(f.options)).rejects.toThrow("managed_read_unavailable");
    }
    expect(adapter.size).toBe(128);
    const excess = fixture(adapter);
    await expect(adapter.request(excess.options)).rejects.toThrow("managed_read_unavailable");
    expect(excess.sent).toEqual([]);
    adapter.invalidate();
    expect((await Promise.allSettled(pending)).every((result) => result.status === "rejected")).toBe(true);
    expect(adapter.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("B1q3a Host-local ceilings and consent", () => {
  for (const reason of [
    "missing",
    "root",
    "mode",
    "capacity",
    "owner",
    "host",
    "execution",
    "workspace",
    "generation",
    "expired",
  ] as const) {
    for (const phase of ["dispatch", "release"] as const) {
      it(`denies a ${reason} machine ceiling at ${phase}`, async () => {
        const f = fixture();
        const ceiling = f.options.localCeiling();
        if (!ceiling) throw new Error("fixture ceiling missing");
        const deny = () => {
          if (reason === "missing") {
            f.options.localCeiling = () => null;
            return;
          }
          f.options.localCeiling = () => ({
            ...ceiling,
            ...(reason === "root" ? { resolvedCwd: "/elsewhere" } : {}),
            ...(reason === "mode" ? { mode: "bypassPermissions" } : {}),
            ...(reason === "capacity" ? { activeExecutions: 3 } : {}),
            ...(reason === "owner" ? { ownerPersonId: crypto.randomUUID() } : {}),
            ...(reason === "host" ? { hostId: "replacement" } : {}),
            ...(reason === "execution" ? { executionId: "replacement" } : {}),
            ...(reason === "workspace" ? { workspaceId: "foreign" } : {}),
            ...(reason === "generation" ? { generation: 2 } : {}),
            ...(reason === "expired" ? { expiresAt: Date.now() } : {}),
          });
        };
        if (phase === "dispatch") deny();
        const result = f.adapter.request(f.options);
        if (phase === "release") {
          await dispatched(f);
          deny();
          expect(f.reply([f.event()])).toBe(false);
        }
        await expect(result).rejects.toThrow("resource_denied");
        if (phase === "dispatch") expect(f.sent).toHaveLength(0);
        expect(f.adapter.size).toBe(0);
      });
    }
  }
  for (const consent of [
    "absent",
    "present",
    "expired",
    "revoked",
    "wrong_host",
    "wrong_execution",
    "screen_read",
    "terminal_control",
  ] as const) {
    it(`keeps cross-owner history closed for ${consent} consent without an expressible Host read scope`, async () => {
      const f = fixture();
      f.target.ownerPersonId = crypto.randomUUID();
      const actor = f.options.authorization.actor;
      if (!("kind" in actor) || actor.kind !== "person") throw new Error("fixture person missing");
      const offered: OwnerConsent | undefined = ["absent", "revoked"].includes(consent)
        ? undefined
        : {
            ownerPersonId: f.target.ownerPersonId,
            personId: actor.personId,
            workspaceId: f.options.binding.workspaceId,
            targetId:
              consent === "wrong_host"
                ? f.target.hostId
                : consent === "wrong_execution"
                  ? "replacement"
                  : f.target.agentId,
            action: consent === "terminal_control" ? "terminal_control" : "agent.private_screen.read",
            expiresAt: consent === "expired" ? Date.now() : Date.now() + 10000,
          };
      const screen = decide(
        actor,
        "agent.private_screen.read",
        {
          ...f.options.authorization.resource,
          targetId: f.target.agentId,
          ownerPersonId: f.target.ownerPersonId,
        },
        {
          organizationId: f.options.binding.organizationId,
          available: true,
          managedPolicy: true,
          policyRevision: 1,
          workspaceActive: true,
          now: Date.now(),
          consent: offered,
          organizationMembership: {
            personId: actor.personId,
            role: "member",
            status: "active",
            grantedBy: actor.personId,
            grantedAt: 0,
          },
          workspaceMembership: {
            personId: actor.personId,
            workspaceId: f.options.binding.workspaceId,
            role: "contributor",
            status: "active",
            grantedBy: actor.personId,
            grantedAt: 0,
            reason: "fixture",
          },
        },
      );
      expect(screen.decision).toBe(["present", "screen_read"].includes(consent) ? "allow" : "deny");
      // Existing authority stores private Agent-action consents, not Host read
      // consent. Even a general allowed HR/AV decision must not become consent.
      await expect(f.adapter.request(f.options)).rejects.toThrow("resource_denied");
      expect(f.sent).toHaveLength(0);
      expect(f.adapter.size).toBe(0);
    });
  }
  it("rejects control expansion in a history selector before authority or dispatch", async () => {
    const f = fixture();
    Object.assign(f.options.selector, { input: "keystrokes", action: "approve", projection: "screen" });
    await expect(f.adapter.request(f.options)).rejects.toThrow("resource_denied");
    expect(f.checks).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  });
  it("requires explicit holder exhaustion and progress instead of inferring it from a short reply", async () => {
    const f = fixture();
    const evidence: unknown[] = [];
    f.options.holderProgress = (value) => evidence.push(value);
    const result = f.adapter.request(f.options);
    await dispatched(f);
    expect(f.reply([], { exhausted: undefined, next: undefined })).toBe(false);
    expect(f.reply([], { exhausted: false, next: 50 })).toBe(false);
    expect(f.reply([], { exhausted: false, next: 40 })).toBe(true);
    expect(await result).toEqual({ available: true, events: [] });
    expect(evidence).toEqual([{ exhausted: false, next: 40 }]);
  });
  it("cancels a pending holder through the real Channel invalidation method", async () => {
    const f = fixture();
    const channel = bareChannel({
      version: 1,
      generation: 1,
      state: "linked",
      operation: "binding",
      workspace: f.options.binding.workspaceId,
    });
    Object.assign(channel, {
      managedHistoryAdapter: f.adapter,
      ctx: { storage: { sql: { exec: () => ({ toArray: () => [] }) } } },
    });
    const result = f.adapter.request(f.options);
    await dispatched(f);
    channel.invalidateManagedPolicy(f.options.binding.workspaceId, 2);
    await expect(result).rejects.toThrow("resource_denied");
    expect(f.adapter.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does no managed work when an unlinked Channel receives invalidation", () => {
    const channel = bareChannel({ version: 1, generation: 0, state: "unlinked", operation: null, workspace: null });
    Object.defineProperty(channel, "managedHistoryAdapter", {
      get: () => {
        throw new Error("unlinked managed work");
      },
    });
    expect(() => channel.invalidateManagedPolicy("workspace", 2)).not.toThrow();
  });
});

describe("B1q3a holder ordering", () => {
  it("sorts admitted local rows by time and identity independent of reply order", async () => {
    const f = fixture();
    const result = f.adapter.request(f.options);
    await dispatched(f);
    expect(f.reply([f.event("b", 2), f.event("a", 3)])).toBe(true);
    const value = await result;
    expect(value.available && value.events.map((event) => event.id)).toEqual(["a", "b"]);
  });
  it("denies conflicting duplicate holder identities instead of letting reply order choose content", async () => {
    const f = fixture();
    const result = f.adapter.request(f.options);
    await dispatched(f);
    expect(f.reply([f.event("same", 2), { ...f.event("same", 2), payload: { text: "conflicting" } }])).toBe(true);
    await expect(result).rejects.toThrow("resource_denied");
  });
});

it("disconnects the exact holder through the real Channel socket-close handler", async () => {
  const f = fixture();
  Object.assign(f.connection, { close: () => {}, deserializeAttachment: () => null });
  const channel = bareChannel({
    version: 1,
    generation: 1,
    state: "linked",
    operation: "binding",
    workspace: f.options.binding.workspaceId,
  });
  Object.assign(channel, { managedHistoryAdapter: f.adapter, ctx: { getTags: () => [] } });
  const result = f.adapter.request(f.options);
  await dispatched(f);
  await channel.webSocketClose(f.connection as WebSocket, 1000, "closed");
  expect(await result).toEqual({ available: false });
  expect(f.adapter.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
