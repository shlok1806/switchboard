import { describe, expect, it } from "vitest";
import {
  type CandidateWindow,
  managedQueryResponse,
  type ProjectionContext,
  type QueryPlan,
  type QueryRow,
  runManagedQuery,
} from "../src/managed-query";
import { createManagedQuery } from "../src/managed-query-registry";
import type { ChannelAuthorization } from "../src/organization";

function fixture(project?: (row: QueryRow, context: ProjectionContext) => Promise<unknown | null>) {
  const organizationId = crypto.randomUUID();
  const workspaceId = `${organizationId}:${crypto.randomUUID()}`;
  const actor = { kind: "person" as const, personId: crypto.randomUUID(), githubId: "123" };
  const authorization: ChannelAuthorization = {
    actor,
    action: "workspace.read",
    generation: 1,
    requestId: "query",
    resource: {
      kind: "workspace",
      organizationId,
      id: workspaceId,
      channel: "owner/repo",
      targetId: "persons",
      operation: "persons.read",
    },
  };
  let floor = 0;
  let current = true;
  let now = 1000;
  const windows: CandidateWindow[] = [];
  const calls: ChannelAuthorization[] = [];
  const positions: (string | null)[] = [];
  const plan: QueryPlan<unknown> = {
    scope: {
      id: "persons",
      authorization,
      binding: { organizationId, workspaceId, channel: "owner/repo", generation: 1, operation: "binding" },
    },
    constituents: [
      {
        id: "persons",
        authorization,
        page: { source: "stored", selector: { kind: "tail" }, wakesOnly: false, limit: 2 },
        projection: { id: "test", project: project ?? (async (row) => row.value) },
        readWindow: async (position) => {
          positions.push(position);
          return windows.shift() ?? { rows: [], nextInternal: null, exhausted: true };
        },
      },
    ],
    assemble: (parts) => ({ persons: parts.get("persons") }),
  };
  const guard = { bindingCurrent: () => current, revisionFloor: () => floor, now: () => now };
  const authority = {
    check: async (input: ChannelAuthorization) => {
      calls.push(input);
      return { ok: true as const, policyRevision: 1, value: { actor, deadline: 20000 } };
    },
  };
  return {
    plan,
    guard,
    authority,
    calls,
    windows,
    positions,
    floor: () => {
      floor = 2;
    },
    transition: () => {
      current = false;
    },
    expire: () => {
      now = 20000;
    },
  };
}

describe("managed query executor bounds and release", () => {
  it("rejects unregistered plans before any source or authority access", async () => {
    const f = fixture();
    const result = await runManagedQuery(f.plan, f.authority, f.guard);
    expect(result).toEqual({ ok: false, error: { status: 404, reason: "resource_denied" } });
    expect(f.calls).toHaveLength(0);
    expect(f.positions).toHaveLength(0);
  });
  it("rejects duplicate constituents and unknown plans at the trusted registry", () => {
    const f = fixture();
    expect(() =>
      createManagedQuery({ ...f.plan, constituents: [...f.plan.constituents, ...f.plan.constituents] }),
    ).toThrow();
    expect(() =>
      createManagedQuery({ ...f.plan, scope: { ...f.plan.scope, id: "constructor" as "persons" } }),
    ).toThrow();
  });
  it("continues short and empty windows until explicit exhaustion and deduplicates admitted rows", async () => {
    const f = fixture();
    f.windows.push(
      { rows: [], nextInternal: "first", exhausted: false },
      { rows: [{ key: "a", value: "visible" }], nextInternal: "second", exhausted: false },
      { rows: [{ key: "a", value: "duplicate" }], nextInternal: "third", exhausted: false },
      { rows: [], nextInternal: null, exhausted: true },
    );
    const result = await runManagedQuery(createManagedQuery(f.plan), f.authority, f.guard);
    expect(result.ok).toBe(true);
    expect(await managedQueryResponse(result, f.guard).json()).toEqual({ persons: ["visible"] });
    expect(f.positions).toEqual([null, "first", "second", "third"]);
    expect(f.calls).toHaveLength(2);
  });
  it("denies non-progressing windows without returning partial content", async () => {
    const f = fixture();
    f.windows.push(
      { rows: [{ key: "a", value: "visible" }], nextInternal: "same", exhausted: false },
      { rows: [], nextInternal: "same", exhausted: false },
    );
    const result = await runManagedQuery(createManagedQuery(f.plan), f.authority, f.guard);
    expect(result).toEqual({ ok: false, error: { status: 503, reason: "managed_read_unavailable" } });
  });
  it("rolls back successful dependencies of a subsequently omitted row", async () => {
    const f = fixture(async (_row, context) => {
      await context.check({
        ...f.plan.scope.authorization,
        resource: { ...f.plan.scope.authorization.resource, targetId: "omitted-author" },
      });
      return null;
    });
    f.windows.push({ rows: [{ key: "omitted", value: "private" }], nextInternal: null, exhausted: true });
    const result = await runManagedQuery(createManagedQuery(f.plan), f.authority, f.guard);
    expect(result.ok).toBe(true);
    expect(f.calls.filter((call) => call.resource.targetId === "omitted-author")).toHaveLength(1);
    expect(await managedQueryResponse(result, f.guard).json()).toEqual({ persons: [] });
  });
  it("retains synchronous execution pins only for admitted projection rows", async () => {
    const pins: string[] = [];
    const f = fixture(async (row, context) => {
      context.onRetain(() => pins.push(row.key));
      return row.key === "omitted" ? null : row.value;
    });
    f.windows.push({
      rows: [
        { key: "omitted", value: "hidden" },
        { key: "included", value: "visible" },
      ],
      nextInternal: null,
      exhausted: true,
    });
    const result = await runManagedQuery(createManagedQuery(f.plan), f.authority, f.guard);
    expect(result.ok).toBe(true);
    expect(pins).toEqual(["included"]);
    expect(await managedQueryResponse(result, f.guard).json()).toEqual({ persons: ["visible"] });
  });
  for (const change of ["floor", "transition", "expire"] as const) {
    it(`rechecks ${change} synchronously after preparation and before serialization`, async () => {
      const f = fixture();
      const result = await runManagedQuery(createManagedQuery(f.plan), f.authority, f.guard);
      expect(result.ok).toBe(true);
      f[change]();
      const response = managedQueryResponse(result, f.guard);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
    });
  }
});
