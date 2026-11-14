import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentPrincipal,
  NativeOrganization,
  NativeResult,
  NativeWorkspace,
  PersonActor,
} from "../../shared/src/m1";
import { DAY, secretDigest } from "../src/executions";
import { CONTRIBUTOR_ACTIONS } from "../src/principals";
import { signSession } from "../src/session";
import { M1_ORIGIN, M1_SECRET, nativeFetch, nativeIdentity } from "./m1-helpers";

let actor: PersonActor;
let token: string;
let organization: NativeOrganization;
let workspace: NativeWorkspace;
let principal: AgentPrincipal;
let sequence = 0;
const stub = () => env.ORGANIZATION.getByName(organization.id);
function value<T>(result: NativeResult<T>): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
async function revision() {
  return (await stub().metadata(actor))?.policyRevision ?? 0;
}
async function api(
  path: string,
  method = "GET",
  body?: unknown,
  bearer = token,
  key = `api-${++sequence}`,
  extra: Record<string, string> = {},
) {
  return nativeFetch(`/api/m1${path}`, bearer, {
    method,
    headers: { "Idempotency-Key": key, "If-Match": String(await revision()), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const agents = () => `/organizations/${organization.id}/agents`;
const grantPath = () => `/workspaces/${workspace.id}/grants/${principal.id}`;
const startPath = () => `/workspaces/${workspace.id}/executions`;
async function start(mode = "direct", key?: string) {
  const response = await api(startPath(), "POST", { principalId: principal.id, cli: "codex", mode }, token, key);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    value: { execution: { id: string; credentialGeneration: number }; secret?: string; code?: string };
    policyRevision: number;
  };
}
beforeEach(async () => {
  await reset();
  sequence = 0;
  ({ actor, token } = await nativeIdentity());
  organization = value(
    await env.IDENTITY_DIRECTORY.getByName("directory-v1").createOrganization(actor, "API org", "org", "fixture"),
  );
  workspace = value(
    await stub().mutate({
      actor,
      key: "workspace",
      requestId: "fixture",
      command: { kind: "workspace.create", name: "Operations", description: "", acceptManager: true },
    }),
  ) as NativeWorkspace;
  // Configure the otherwise-empty ceilings through their authenticated public API.
  for (const path of [`/organizations/${organization.id}`, `/workspaces/${workspace.id}`]) {
    expect((await api(path, "PATCH", { ceiling: CONTRIBUTOR_ACTIONS })).status).toBe(200);
  }
  const response = await api(agents(), "POST", {
    displayName: "helper",
    sponsor: { kind: "person", id: actor.personId },
    capabilities: [],
  });
  expect(response.status).toBe(200);
  principal = ((await response.json()) as { value: { principal: AgentPrincipal } }).value.principal;
  expect((await api(grantPath(), "PUT", { actions: CONTRIBUTOR_ACTIONS, expiresAt: Date.now() + DAY })).status).toBe(
    200,
  );
});

describe("managed execution API", () => {
  it("rejects unauthorized sponsor and body owner impersonation", async () => {
    const stranger = await nativeIdentity("901", "stranger");
    expect(
      (await api(agents(), "POST", { displayName: "forged", sponsor: { kind: "person", id: stranger.actor.personId } }))
        .status,
    ).toBe(403);
    expect(
      (
        await api(startPath(), "POST", {
          principalId: principal.id,
          cli: "codex",
          ownerPersonId: stranger.actor.personId,
        })
      ).status,
    ).toBe(400);
    expect(
      (await api(startPath(), "POST", { principalId: principal.id, cli: "codex", actor: stranger.actor })).status,
    ).toBe(400);
  });

  it("denies execution actors every lifecycle and grant mutation including self grant", async () => {
    const issued = await start();
    const bearer = issued.value.secret;
    expect(bearer).toBeTypeOf("string");
    const execution = `/executions/${issued.value.execution.id}`;
    for (const [path, method, body] of [
      [agents(), "POST", { displayName: "self" }],
      [`${agents()}/${principal.id}`, "PATCH", { status: "disabled" }],
      [grantPath(), "PUT", { actions: ["agent.grant.manage"] }],
      [grantPath(), "DELETE", {}],
      [startPath(), "POST", { principalId: principal.id, cli: "codex" }],
      [`${execution}/rotate`, "POST", { expectedGeneration: 1 }],
      [`${execution}/redemption`, "POST", { code: "invented" }],
      [execution, "DELETE", {}],
    ] as const)
      expect((await api(path, method, body, bearer)).status).toBe(403);
    const view = await api(agents(), "GET", undefined, bearer);
    expect(view.status).toBe(200);
    expect(((await view.json()) as { items: AgentPrincipal[] }).items.map((p) => p.id)).toEqual([principal.id]);
  });

  it("denies foreign organization credentials without resource metadata", async () => {
    const issued = await start();
    const other = value(
      await env.IDENTITY_DIRECTORY.getByName("directory-v1").createOrganization(actor, "Other", "other", "fixture"),
    );
    const response = await api(`/organizations/${other.id}/agents`, "GET", undefined, issued.value.secret);
    expect(response.status).toBe(404);
    const result = (await response.json()) as Record<string, unknown>;
    expect(result.policyRevision).toBe(0);
    expect(result.value).toBeUndefined();
    expect(result.items).toBeUndefined();
  });

  it("rejects tampered org and credential routing fields", async () => {
    const issued = await start();
    const parts = issued.value.secret?.split(".") ?? [];
    for (const index of [1, 2]) {
      const tampered = [...parts];
      tampered[index] = crypto.randomUUID();
      expect((await api(agents(), "GET", undefined, tampered.join("."))).status).toBe(401);
    }
  });

  it("returns invalid for wrong Person or unknown code expired 410 and used 409", async () => {
    const issued = await start("redemption");
    expect(issued.value.secret).toBeUndefined();
    const path = `/executions/${issued.value.execution.id}/redemption`;
    const stranger = await nativeIdentity("902", "wrong-person");
    for (const [code, bearer] of [
      [issued.value.code, stranger.token],
      ["unknown", token],
    ]) {
      const response = await api(path, "POST", { code }, bearer);
      expect(response.status).toBe(400);
      const failure = (await response.json()) as { error: { code: string }; policyRevision: number };
      expect(failure.error.code).toBe("CODE_INVALID");
      expect(failure.policyRevision).toBe(0);
    }
    const redeemed = await api(path, "POST", { code: issued.value.code });
    expect(redeemed.status).toBe(200);
    expect(((await redeemed.json()) as { value: { secret: string } }).value.secret).toMatch(/^m1\./);
    const used = await api(path, "POST", { code: issued.value.code });
    expect(used.status).toBe(409);
    expect(((await used.json()) as { error: { code: string } }).error.code).toBe("CODE_USED");
    const expired = await start("redemption");
    await runInDurableObject(stub(), (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ digest: string; body: string }>("SELECT digest,body FROM redemption_codes")
        .toArray();
      for (const row of rows) {
        const body = JSON.parse(row.body);
        body.expiresAt = Date.now() - 1;
        state.storage.sql.exec("UPDATE redemption_codes SET body=? WHERE digest=?", JSON.stringify(body), row.digest);
      }
    });
    const response = await api(`/executions/${expired.value.execution.id}/redemption`, "POST", {
      code: expired.value.code,
    });
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("CODE_EXPIRED");
  });

  it("serializes concurrent redemption and retains hashed tombstones for 24 hours", async () => {
    const issued = await start("redemption");
    const path = `/executions/${issued.value.execution.id}/redemption`;
    const before = Date.now();
    const responses = await Promise.all([
      api(path, "POST", { code: issued.value.code }),
      api(path, "POST", { code: issued.value.code }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const digest = Array.from(await secretDigest(issued.value.code ?? ""), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    const stored = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.sql
        .exec<{ digest: string; body: string; retain_until: number }>("SELECT * FROM redemption_codes")
        .toArray(),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.digest).toBe(digest);
    expect(stored[0]?.retain_until).toBeGreaterThanOrEqual(before + DAY - 1000);
    expect(JSON.parse(stored[0]?.body ?? "{}").used).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(issued.value.code);
  });

  it("never replays secrets or codes on idempotent retry and rejects changed bodies", async () => {
    for (const mode of ["direct", "redemption"]) {
      const key = `replay-${mode}`;
      const issued = await start(mode, key);
      expect(issued.value.secret ?? issued.value.code).toBeTypeOf("string");
      const replay = await start(mode, key);
      expect(replay.value.secret).toBeUndefined();
      expect(replay.value.code).toBeUndefined();
      expect(replay.value.execution.id).toBe(issued.value.execution.id);
      expect(
        (await api(startPath(), "POST", { principalId: principal.id, cli: "different", mode }, token, key)).status,
      ).toBe(409);
    }
    const key = "put-replay";
    const body = { actions: CONTRIBUTOR_ACTIONS, expiresAt: Date.now() + DAY };
    const rev = String(await revision());
    expect((await api(grantPath(), "PUT", body, token, key, { "If-Match": rev })).status).toBe(200);
    expect((await api(grantPath(), "PUT", body, token, key, { "If-Match": rev })).status).toBe(200);
    expect(
      (await api(grantPath(), "PUT", { ...body, actions: ["task.read"] }, token, key, { "If-Match": rev })).status,
    ).toBe(409);
  });

  it("excludes planted secret markers from audit events logs replay and Channel storage", async () => {
    const logs: unknown[][] = [];
    const spies = ["log", "info", "warn", "error", "debug"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation((...args: unknown[]) => {
        logs.push(args);
      }),
    );
    try {
      const direct = await start();
      const code = await start("redemption");
      const response = await api(`/executions/${code.value.execution.id}/redemption`, "POST", {
        code: code.value.code,
      });
      expect(response.status).toBe(200);
      const redeemed = (await response.json()) as { value: { secret: string } };
      const dump = await runInDurableObject(stub(), (_instance, state) => {
        const tables = [
          "aggregate",
          "principals",
          "executions",
          "grants",
          "execution_credentials",
          "redemption_codes",
          "replay",
          "audit",
        ];
        return JSON.stringify(tables.map((table) => state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()));
      });
      for (const marker of [direct.value.secret, code.value.code, redeemed.value.secret])
        expect(dump).not.toContain(marker);
      // No Channel is invoked by these routes; inspect a fresh Channel's SQL and KV as a regression sentinel.
      const channelDump = await runInDurableObject(env.CHANNEL.getByName("example/repo"), async (_instance, state) => {
        const tables = state.storage.sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
          .toArray();
        return JSON.stringify([
          await state.storage.list(),
          tables.map((t) => state.storage.sql.exec(`SELECT * FROM "${t.name.replaceAll('"', '""')}"`).toArray()),
        ]);
      });
      for (const marker of [direct.value.secret, code.value.code, redeemed.value.secret]) {
        expect(channelDump).not.toContain(marker);
        expect(JSON.stringify(logs)).not.toContain(marker);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("denies legacy session agent Host and connector tokens on m1 lifecycle routes", async () => {
    const legacy = await signSession(M1_SECRET, "native-human" as Parameters<typeof signSession>[1]);
    for (const bearer of [legacy, "sba_fixture", "sbh_fixture", "sbm_fixture"]) {
      expect((await api(startPath(), "POST", { principalId: principal.id, cli: "codex" }, bearer)).status).toBe(401);
    }
  });

  it("enforces no store origin revision generation pagination and foreign ID denial", async () => {
    const list = await api(agents());
    expect(list.status).toBe(200);
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    expect((await api(`${agents()}?cursor=garbage`)).status).toBe(400);
    for (const origin of [undefined, "https://evil.test", M1_ORIGIN]) {
      const response = await nativeFetch(`/api/m1${agents()}`, undefined, {
        method: "POST",
        headers: {
          Cookie: `sb_session=${token}`,
          "Idempotency-Key": `origin-${++sequence}`,
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({ displayName: "browser", sponsor: { kind: "person", id: actor.personId } }),
      });
      expect(response.status).toBe(origin === M1_ORIGIN ? 200 : 401);
    }
    expect(
      (await api(`${agents()}/${principal.id}`, "PATCH", { status: "disabled" }, token, undefined, { "If-Match": "" }))
        .status,
    ).toBe(400);
    expect(
      (await api(`${agents()}/${principal.id}`, "PATCH", { status: "disabled" }, token, undefined, { "If-Match": "0" }))
        .status,
    ).toBe(409);
    const issued = await start();
    const path = `/executions/${issued.value.execution.id}/rotate`;
    expect((await api(path, "POST", {})).status).toBe(400);
    const rotated = await api(path, "POST", { expectedGeneration: 1 });
    expect(rotated.status).toBe(200);
    expect(await stub().verifyExecution(issued.value.secret ?? "")).toBeNull();
    expect((await api(path, "POST", { expectedGeneration: 1 })).status).toBe(409);
    const foreign = `${crypto.randomUUID()}:${crypto.randomUUID()}`;
    const denied = await api(`/workspaces/${workspace.id}/grants/${foreign}`);
    expect(denied.status).toBe(404);
    expect(((await denied.json()) as { policyRevision: number }).policyRevision).toBe(0);
  });

  it("paginates principal views with actor and resource bound cursors", async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      for (let i = 0; i < 101; i++) {
        const copy = { ...principal, id: `${organization.id}:${crypto.randomUUID()}`, displayName: `helper-${i}` };
        state.storage.sql.exec("INSERT INTO principals VALUES(?,?)", copy.id, JSON.stringify(copy));
      }
    });
    const first = (await (await api(agents())).json()) as { items: AgentPrincipal[]; cursor: string };
    expect(first.items).toHaveLength(100);
    expect(first.cursor).toBeTypeOf("string");
    const second = (await (await api(`${agents()}?cursor=${encodeURIComponent(first.cursor)}`)).json()) as {
      items: AgentPrincipal[];
      cursor: null;
    };
    expect(second.items).toHaveLength(2);
    expect(second.cursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((p) => p.id)).size).toBe(102);
    const other = value(
      await env.IDENTITY_DIRECTORY.getByName("directory-v1").createOrganization(
        actor,
        "Other",
        "paging-other",
        "fixture",
      ),
    );
    expect((await api(`/organizations/${other.id}/agents?cursor=${encodeURIComponent(first.cursor)}`)).status).toBe(
      400,
    );
    const stranger = await nativeIdentity("903", "outsider");
    expect(
      (await api(`${agents()}?cursor=${encodeURIComponent(first.cursor)}`, "GET", undefined, stranger.token)).status,
    ).toBe(404);
  });

  it("rechecks principal and grant revocation on every managed bearer use", async () => {
    const issued = await start();
    expect((await api(agents(), "GET", undefined, issued.value.secret)).status).toBe(200);
    expect((await api(`${agents()}/${principal.id}`, "PATCH", { status: "disabled" })).status).toBe(200);
    expect((await api(agents(), "GET", undefined, issued.value.secret)).status).toBe(401);
    expect((await api(`${agents()}/${principal.id}`, "PATCH", { status: "active" })).status).toBe(200);
    expect((await api(agents(), "GET", undefined, issued.value.secret)).status).toBe(200);
    expect((await api(grantPath(), "DELETE")).status).toBe(200);
    expect((await api(agents(), "GET", undefined, issued.value.secret)).status).toBe(401);
  });

  it("invalidates pending codes on rotation and rolls back consumption with issuance", async () => {
    const issued = await start("redemption");
    const failed = await runInDurableObject(stub(), async (instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER reject_api_credential BEFORE INSERT ON execution_credentials BEGIN SELECT RAISE(ABORT, 'injected'); END",
      );
      try {
        await instance.mutateIdentity({
          actor,
          key: "fault",
          requestId: "fixture",
          command: { kind: "execution.redeem", executionId: issued.value.execution.id, code: issued.value.code ?? "" },
        });
        return false;
      } catch {
        return true;
      } finally {
        state.storage.sql.exec("DROP TRIGGER reject_api_credential");
      }
    });
    expect(failed).toBe(true);
    const path = `/executions/${issued.value.execution.id}/redemption`;
    expect((await api(path, "POST", { code: issued.value.code })).status).toBe(200);
    const pending = await start("redemption");
    expect(
      (await api(`/executions/${pending.value.execution.id}/rotate`, "POST", { expectedGeneration: 1 })).status,
    ).toBe(200);
    expect(
      (await api(`/executions/${pending.value.execution.id}/redemption`, "POST", { code: pending.value.code })).status,
    ).toBe(400);
  });
});
