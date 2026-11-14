import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentId, PersonName } from "../../shared/src/index";
import type { BindingOperation, NativeResult } from "../../shared/src/m1";
import { Channel } from "../src/channel";
import { GitHubApp, installGitHub, installGitHubApp, RestGitHub } from "../src/github/index";
import { handleMcp } from "../src/mcp/server";
import { signAccess } from "../src/mcp/tokens";
import { signSession } from "../src/session";
import { FakeGitHub } from "./fake-github";
import { nativeDirectory, nativeFetch, nativeIdentity } from "./m1-helpers";

const channel = () => env.CHANNEL.getByName("binding/fixture");
const workspace = "11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";

beforeEach(() => reset());
afterEach(() => {
  installGitHub(null);
  installGitHubApp(null);
  vi.restoreAllMocks();
});

async function bindingFixture() {
  const { actor, token } = await nativeIdentity();
  const created = await nativeDirectory().createOrganization(actor, "Org", "create", "request");
  if (!created.ok) throw new Error(created.reason);
  const org = env.ORGANIZATION.getByName(created.value.id);
  const result = await org.mutate({
    actor,
    key: "workspace",
    requestId: "workspace",
    command: { kind: "workspace.create", name: "Operations", description: "", acceptManager: true },
  });
  if (!result.ok || !("id" in result.value)) throw new Error("Missing workspace");
  const workspaceId = result.value.id;
  const github = new FakeGitHub();
  github.permissions.set("native-human", "admin");
  installGitHub(github);
  const reader = new RestGitHub({ token: async () => "fixture", invalidate: () => {} }, github.repo);
  const proof = { permission: "admin", user: { id: 900 } };
  vi.spyOn(reader, "call").mockImplementation(async () => Response.json(proof));
  const app = new GitHubApp({ appId: "fixture", privateKey: "fixture", clientId: "fixture", clientSecret: "fixture" });
  vi.spyOn(app, "repo").mockReturnValue(reader);
  installGitHubApp(app);
  const boundChannel = env.CHANNEL.getByName(github.repo);
  const change = async (mode: "bind" | "unbind", key: string, extra: Record<string, unknown> = {}, as = token) => {
    const revision = (await org.metadata(actor))?.policyRevision ?? 0;
    return nativeFetch(`/api/m1/workspaces/${workspaceId}/channel`, as, {
      method: mode === "bind" ? "POST" : "DELETE",
      headers: { "Idempotency-Key": key, "If-Match": String(revision) },
      body: JSON.stringify({
        repo: github.repo,
        ...(mode === "unbind" ? { acknowledgeLegacyAccess: true } : {}),
        ...extra,
      }),
    });
  };
  return {
    actor,
    token,
    org,
    organizationId: created.value.id,
    workspaceId,
    github,
    reader,
    proof,
    repo: github.repo,
    channel: boundChannel,
    change,
  };
}

describe("Channel binding fence foundation", () => {
  it("binds with fresh repo admin and workspace manage", async () => {
    const f = await bindingFixture();
    const response = await f.change("bind", "binding");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = (await response.json()) as NativeResult<BindingOperation>;
    expect(result).toMatchObject({ ok: true, value: { phase: "done", mode: "bind" } });
    expect(await f.channel.bindingState()).toMatchObject({ generation: 1, state: "linked", workspace: f.workspaceId });
    expect(await f.org.workspace(f.actor, f.workspaceId, true)).toMatchObject({ channel: f.repo });
    expect(
      await f.channel.admit(f.repo, { kind: "session", person: "native-human" as PersonName }, true),
    ).toMatchObject({ ok: false, status: 403 });
    expect(f.github.permissionChecks).toBeGreaterThan(0);
    const audit = await f.org.auditRecords(f.actor);
    expect(audit).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "channel.bind", decision: "allow" })]),
    );
  });

  it("closes existing sockets at the pending transition", async () => {
    const response = await channel().fetch(
      new Request("https://channel.test/?person=alice", {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing socket");
    socket.accept();
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    expect(await channel().prepareBinding(workspace, "operation-a", 0)).toBe(true);
    expect(await closed).toBe(1008);
  });

  it("replays pending preparation and rejects stale generations and competing workspaces", async () => {
    expect(await channel().prepareBinding(workspace, "operation-a", 0)).toBe(true);
    expect(await channel().prepareBinding(workspace, "operation-a", 0)).toBe(true);
    expect(await channel().prepareBinding(workspace, "operation-a", 1)).toBe(false);
    expect(await channel().prepareBinding(`${workspace}-other`, "operation-a", 0)).toBe(false);
    expect(await channel().prepareBinding(workspace, "operation-b", 0)).toBe(false);
    expect(await channel().bindingState()).toMatchObject({ generation: 1, state: "pending", workspace });
  });

  it("rolls back the pending fence if its durable outbox cannot commit", async () => {
    await runInDurableObject(channel(), (_object, state) => {
      state.storage.sql.exec(`CREATE TRIGGER fail_binding BEFORE INSERT ON m1_binding_outbox
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    });
    await runInDurableObject(channel(), (object) => {
      expect(() => object.prepareBinding(workspace, "operation-a", 0)).toThrow("injected failure");
    });
    expect(await channel().bindingState()).toMatchObject({ generation: 0, state: "unlinked", workspace: null });
  });

  it("denies pending admission and reconnects without changing legacy membership authority", async () => {
    expect(await channel().prepareBinding(workspace, "operation-a", 0)).toBe(true);
    expect(
      await channel().admit("binding/fixture", { kind: "session", person: "alice" as PersonName }, true),
    ).toMatchObject({ ok: false, status: 403 });
    const response = await channel().fetch(
      new Request("https://channel.test/?person=alice", {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("keeps unknown schemas closed and refuses to overwrite them", async () => {
    await runInDurableObject(channel(), async (_object, state) => {
      state.storage.sql.exec("UPDATE m1_binding SET version=99 WHERE id=1");
      const object = new Channel(state, env);
      expect(object.prepareBinding(workspace, "operation-a", 0)).toBe(false);
      expect(
        await object.admit("binding/fixture", { kind: "session", person: "alice" as PersonName }, true),
      ).toMatchObject({ ok: false, status: 403 });
    });
  });

  it("refuses admission when binding starts during the GitHub permission lookup", async () => {
    const github = new FakeGitHub();
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checking = new Promise<void>((resolve) => {
      started = resolve;
    });
    github.permission = async () => {
      started();
      await waiting;
      return "admin";
    };
    installGitHub(github);
    await runInDurableObject(env.CHANNEL.getByName(github.repo), async (object) => {
      const admission = object.admit(github.repo, { kind: "session", person: "alice" as PersonName }, false, true);
      await checking;
      try {
        expect(object.prepareBinding(workspace, "during-admission", 0)).toBe(true);
      } finally {
        release();
      }
      expect(await admission).toMatchObject({ ok: false, status: 403 });
    });
  });

  it("keeps mismatched operation and invalid generation states closed", async () => {
    await runInDurableObject(channel(), async (_object, state) => {
      for (const [generation, operation] of [
        [0, "orphan-operation"],
        [-1, null],
        [0.5, null],
      ] as const) {
        state.storage.sql.exec("UPDATE m1_binding SET generation=?,operation=? WHERE id=1", generation, operation);
        const object = new Channel(state, env);
        expect(
          await object.admit("binding/fixture", { kind: "session", person: "alice" as PersonName }, true),
        ).toMatchObject({ ok: false, status: 403 });
        expect(object.prepareBinding(workspace, "new-operation", generation)).toBe(false);
      }
    });
  });

  it("rejects invalid pending transition inputs without writing operation evidence", async () => {
    expect(await channel().prepareBinding(workspace, "", 0)).toBe(false);
    expect(await channel().prepareBinding("", "operation", 0)).toBe(false);
    expect(await channel().prepareBinding(workspace, "operation", Number.MAX_SAFE_INTEGER)).toBe(false);
    await runInDurableObject(channel(), (object, state) => {
      expect(object.bindingState()).toMatchObject({ generation: 0, workspace: null, state: "unlinked" });
      expect(state.storage.sql.exec("SELECT * FROM m1_binding_outbox").toArray()).toEqual([]);
    });
  });

  it("discards history captured before a pending transition while its result is outstanding", async () => {
    await runInDurableObject(channel(), async (object, state) => {
      state.storage.sql.exec(`INSERT INTO events(id,at,type,actor,capture,payload,actor_kind,actor_id)
        VALUES('private-event','2026-01-01T00:00:00Z','update','{"kind":"person","person":"alice"}','manual','{"text":"retained history"}','person','alice')`);
      const history = object.latestEvents(10);
      const denied = expect(history).rejects.toThrow("Managed Channel access is closed until P3.");
      expect(object.prepareBinding(workspace, "during-history", 0)).toBe(true);
      await denied;
      await expect(object.latestEvents(10)).rejects.toThrow("Managed Channel access is closed until P3.");
      expect(state.storage.sql.exec("SELECT id FROM events WHERE id='private-event'").toArray()).toEqual([
        { id: "private-event" },
      ]);
    });
  });

  it("denies transcript and screen reads before resolving managed Channel resource identities", async () => {
    expect(await channel().prepareBinding(workspace, "private-reads", 0)).toBe(true);
    const caller = { person: "alice" as PersonName };
    const absent = "absent-agent" as AgentId;
    expect(await channel().readTranscript(caller, absent, 0)).toMatchObject({ ok: false, status: 403 });
    expect(await channel().readTerminal(caller, absent)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("native dual-authority binding coordinator", () => {
  it("refuses binding without repo admin even with cached collaborator admission", async () => {
    const f = await bindingFixture();
    f.github.permissions.set("native-human", "write");
    expect(
      await f.channel.admit(f.repo, { kind: "session", person: "native-human" as PersonName }, false),
    ).toMatchObject({ ok: true });
    expect((await f.change("bind", "no-admin")).status).toBe(403);
    expect(await f.channel.bindingState()).toMatchObject({ generation: 0, state: "unlinked" });
  });

  it("refuses binding without workspace manage", async () => {
    const f = await bindingFixture();
    const outsider = await nativeIdentity("901", "outsider");
    f.github.permissions.set("outsider", "admin");
    expect((await f.change("bind", "no-workspace", {}, outsider.token)).status).toBe(404);
    expect(await f.channel.bindingState()).toMatchObject({ generation: 0, state: "unlinked" });
    expect(
      await f.org.coordinateBinding({
        actor: outsider.actor,
        login: "outsider",
        workspaceId: f.workspaceId,
        repo: f.repo,
        mode: "bind",
        key: "direct",
        requestId: "direct",
      }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses active workspace viewers binding and unbinding despite fresh repo admin", async () => {
    const f = await bindingFixture();
    const viewer = await nativeIdentity("901", "viewer");
    const invite = await f.org.mutate({
      actor: f.actor,
      key: "viewer",
      requestId: "viewer",
      command: {
        kind: "invitation.create",
        githubId: "901",
        organizationRole: "member",
        workspaceId: f.workspaceId,
        workspaceRole: "viewer",
      },
    });
    if (!invite.ok || !("id" in invite.value)) throw new Error("Missing invitation");
    expect(
      await f.org.mutate({
        actor: viewer.actor,
        key: "accept",
        requestId: "accept",
        command: { kind: "invitation.accept", invitationId: invite.value.id },
      }),
    ).toMatchObject({ ok: true });
    f.github.permissions.set("viewer", "admin");
    expect((await f.change("bind", "viewer-bind", {}, viewer.token)).status).toBe(403);
    expect((await f.change("bind", "owner-bind")).status).toBe(200);
    expect((await f.change("unbind", "viewer-unbind", {}, viewer.token)).status).toBe(403);
    expect(await f.channel.bindingState()).toMatchObject({ state: "linked", generation: 1 });
  });

  it("refuses binding when GitHub lookup fails without legacy grace", async () => {
    const f = await bindingFixture();
    expect(
      await f.channel.admit(f.repo, { kind: "session", person: "native-human" as PersonName }, false),
    ).toMatchObject({ ok: true });
    f.github.permissionsDown = true;
    expect((await f.change("bind", "outage")).status).toBe(403);
    expect(await f.channel.bindingState()).toMatchObject({ generation: 0, state: "unlinked" });
  });

  it("refuses recycled login or unavailable numeric identity proof", async () => {
    const f = await bindingFixture();
    f.proof.user.id = 901;
    expect((await f.change("bind", "recycled")).status).toBe(403);
    vi.mocked(f.reader.call).mockRejectedValue(new Error("identity lookup down"));
    expect((await f.change("bind", "unavailable-proof")).status).toBe(403);
  });

  it("rejects nonhuman binding actors and legacy sessions", async () => {
    const f = await bindingFixture();
    for (const token of [
      "sb_agent_fixture",
      "sb_connector_fixture",
      "sb_host_fixture",
      await signSession("test-session-secret-at-least-32-characters-long", "native-human" as PersonName),
    ]) {
      expect((await f.change("bind", "nonhuman", {}, token)).status).toBe(401);
    }
    expect(
      await f.org.coordinateBinding({
        actor: { ...f.actor, kind: "agent" } as never,
        login: "native-human",
        workspaceId: f.workspaceId,
        repo: f.repo,
        mode: "bind",
        key: "nonhuman-direct",
        requestId: "direct",
      }),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects a channel already bound to another workspace and releases the losing reservation", async () => {
    const f = await bindingFixture();
    expect((await f.change("bind", "first")).status).toBe(200);
    const other = await f.org.mutate({
      actor: f.actor,
      key: "other",
      requestId: "other",
      command: { kind: "workspace.create", name: "Other", description: "", acceptManager: true },
    });
    if (!other.ok || !("id" in other.value)) throw new Error("Missing workspace");
    expect(
      await f.org.coordinateBinding({
        actor: f.actor,
        login: "native-human",
        workspaceId: other.value.id,
        repo: f.repo,
        mode: "bind",
        key: "compete",
        requestId: "compete",
      }),
    ).toMatchObject({ ok: false, status: 409 });
    expect((await f.change("unbind", "detach")).status).toBe(200);
  });

  it("replays binding operations by key and operation ID without incrementing generation", async () => {
    const f = await bindingFixture();
    const first = (await (await f.change("bind", "first")).json()) as { value: BindingOperation };
    const replay = (await (await f.change("bind", "first")).json()) as { value: BindingOperation };
    expect(replay.value).toEqual(first.value);
    const byId = (await (await f.change("bind", "another-key", { operationId: first.value.id })).json()) as {
      value: BindingOperation;
    };
    expect(byId.value).toEqual(first.value);
    expect(await f.channel.bindingState()).toMatchObject({ generation: 1 });
    expect((await f.change("bind", "first", { repo: "shlok1806/other" })).status).toBe(403);
  });

  it("scopes operation reads to the original actor or an organization admin", async () => {
    const f = await bindingFixture();
    const result = (await (await f.change("bind", "first")).json()) as { value: BindingOperation };
    expect((await nativeFetch(`/api/m1/operations/${result.value.id}`, f.token)).status).toBe(200);
    const outsider = await nativeIdentity("901", "outsider");
    expect((await nativeFetch(`/api/m1/operations/${result.value.id}`, outsider.token)).status).toBe(404);
    const invite = await f.org.mutate({
      actor: f.actor,
      key: "invite",
      requestId: "invite",
      command: { kind: "invitation.create", githubId: "901", organizationRole: "admin" },
    });
    if (!invite.ok || !("id" in invite.value)) throw new Error("Missing invite");
    expect(
      await f.org.mutate({
        actor: outsider.actor,
        key: "accept",
        requestId: "accept",
        command: { kind: "invitation.accept", invitationId: invite.value.id },
      }),
    ).toMatchObject({ ok: true });
    expect((await nativeFetch(`/api/m1/operations/${result.value.id}`, outsider.token)).status).toBe(200);
  });

  it("unbinds only with both authorities and explicit warning then restores legacy behavior", async () => {
    const f = await bindingFixture();
    expect((await f.change("bind", "first")).status).toBe(200);
    expect((await f.change("unbind", "warning", { acknowledgeLegacyAccess: false })).status).toBe(400);
    f.github.permissions.set("native-human", "write");
    expect((await f.change("unbind", "no-admin")).status).toBe(403);
    f.github.permissions.set("native-human", "admin");
    const response = await f.change("unbind", "detach");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      value: { phase: "done", warning: "Unbinding restores legacy repository access." },
    });
    expect(await f.channel.bindingState()).toMatchObject({
      generation: 2,
      workspace: null,
      operation: null,
      state: "unlinked",
    });
    expect(
      await f.channel.admit(f.repo, { kind: "session", person: "native-human" as PersonName }, false),
    ).toMatchObject({ ok: true });
    expect(await f.org.workspace(f.actor, f.workspaceId, true)).not.toHaveProperty("channel");
    const audit = await f.org.auditRecords(f.actor);
    expect(audit).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "channel.unbind", decision: "allow" })]),
    );
  });
});

describe("binding operation recovery", () => {
  for (const mode of ["bind", "unbind"] as const) {
    for (const interruption of ["generation", "pending", "prepared", "committed", "activation", "done"] as const) {
      it(`recovers ${mode} interruption at ${interruption} without repeating its generation`, async () => {
        const f = await bindingFixture();
        if (mode === "unbind") expect((await f.change("bind", "initial")).status).toBe(200);
        const before = await f.channel.bindingState();
        const local = interruption === "pending" || interruption === "activation";
        if (local) {
          await runInDurableObject(f.channel, (_object, state) => {
            state.storage.sql.exec(
              `CREATE TRIGGER s3_fault BEFORE ${interruption === "pending" ? "INSERT" : "UPDATE"} ON m1_binding_outbox BEGIN SELECT RAISE(ABORT,'interrupted'); END`,
            );
          });
        } else {
          await runInDurableObject(f.org, (_object, state) => {
            const condition =
              interruption === "generation"
                ? "json_extract(NEW.body,'$.phase')='reserved' AND json_extract(NEW.body,'$.generation') IS NOT NULL"
                : `json_extract(NEW.body,'$.phase')='${interruption}'`;
            state.storage.sql.exec(
              `CREATE TRIGGER s3_fault BEFORE UPDATE ON binding_operations WHEN ${condition} BEGIN SELECT RAISE(ABORT,'interrupted'); END`,
            );
          });
        }
        const interrupted = await f.change(mode, "recover");
        expect(interrupted.status).toBe(503);
        const failure = (await interrupted.json()) as { operationId: string };
        const journal = await runInDurableObject(f.org, (_object, state) => {
          const row = state.storage.sql
            .exec<{ body: string }>(
              "SELECT body FROM binding_operations WHERE json_extract(body,'$.mode')=? ORDER BY rowid DESC LIMIT 1",
              mode,
            )
            .one();
          return JSON.parse(row.body) as BindingOperation;
        });
        expect(failure.operationId).toBe(journal.id);
        expect((await nativeFetch(`/api/m1/operations/${journal.id}`, f.token)).status).toBe(200);
        const snapshot = await f.channel.bindingState();
        if (interruption === "pending") {
          // A failed prepare must retain both the durable fence and its cached value.
          expect(snapshot).toEqual(before);
        } else if (interruption === "activation") {
          expect(snapshot).toMatchObject({
            generation: before.generation + 1,
            state: mode === "bind" ? "pending" : "pending_unlink",
          });
        }
        if (local) {
          await runInDurableObject(f.channel, (_object, state) => {
            const durable = state.storage.sql.exec("SELECT * FROM m1_binding WHERE id=1").one();
            expect(durable).toMatchObject(snapshot);
            const evidence = state.storage.sql
              .exec<{ body: string }>("SELECT body FROM m1_binding_outbox WHERE operation=?", journal.id)
              .toArray();
            expect(evidence.map((row) => JSON.parse(row.body).outcome)).toEqual(
              interruption === "pending" ? [] : ["pending"],
            );
          });
        }
        if (snapshot.state !== "unlinked") {
          expect(
            await f.channel.admit(f.repo, { kind: "session", person: "native-human" as PersonName }, true),
          ).toMatchObject({ ok: false, status: 403 });
        } else if (mode === "unbind") {
          // Only final journal acknowledgment may be missing after both sides cleared the link.
          expect(interruption).toBe("done");
          expect(await f.org.workspace(f.actor, f.workspaceId, true)).not.toHaveProperty("channel");
        }
        await runInDurableObject(local ? f.channel : f.org, (_object, state) => {
          state.storage.sql.exec("DROP TRIGGER s3_fault");
        });
        const retry = await f.change(mode, "recover-again", { operationId: journal.id });
        expect(retry.status).toBe(200);
        expect(await retry.json()).toMatchObject({ value: { id: journal.id, phase: "done" } });
        expect(await f.channel.bindingState()).toMatchObject({
          generation: mode === "bind" ? 1 : 2,
          state: mode === "bind" ? "linked" : "unlinked",
        });
        const replay = await f.change(mode, "recover");
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({ value: { id: journal.id, phase: "done" } });
      });
    }
  }
});

describe("binding transition result boundaries", () => {
  it("fences MCP admitted before its request body completes including batches", async () => {
    const f = await bindingFixture();
    const secret = "test-session-secret-at-least-32-characters-long";
    const endpoint = new URL(`https://switchboard.test/r/${f.repo}/mcp`);
    await runInDurableObject(f.channel, (object) =>
      object.startMcpGrant("fence-grant", "native-human" as PersonName, "client", Date.now() + 60_000),
    );
    const token = await signAccess(secret, "native-human" as PersonName, f.repo, "fence-grant", endpoint.href);
    const request = new Request(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "{}",
    });
    let started!: () => void;
    const parsing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(request, "json").mockImplementation(async () => {
      started();
      await waiting;
      return [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "channel", arguments: {} } }];
    });
    const response = handleMcp(request, endpoint, env, f.repo, f.channel);
    await parsing;
    expect(await f.channel.prepareBinding(f.workspaceId, "mcp-transition", 0)).toBe(true);
    release();
    const result = await response;
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({ error: { code: -32002 } });
  });

  it("discards MCP tool results outstanding at the pending transition", async () => {
    const f = await bindingFixture();
    const endpoint = new URL(`https://switchboard.test/r/${f.repo}/mcp`);
    await runInDurableObject(f.channel, (object) =>
      object.startMcpGrant("tool-grant", "native-human" as PersonName, "client", Date.now() + 60_000),
    );
    const token = await signAccess(
      "test-session-secret-at-least-32-characters-long",
      "native-human" as PersonName,
      f.repo,
      "tool-grant",
      endpoint.href,
    );
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.reader.call).mockImplementation(async () => {
      started();
      await waiting;
      return Response.json([]);
    });
    const response = handleMcp(
      new Request(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "github", arguments: { about: "issues" } },
        }),
      }),
      endpoint,
      env,
      f.repo,
      f.channel,
    );
    await reading;
    expect(await f.channel.prepareBinding(f.workspaceId, "outstanding-tool", 0)).toBe(true);
    release();
    expect((await response).status).toBe(403);
  });

  it("refuses stale HTTP stream upgrades after bind and unbind while fresh legacy upgrades work", async () => {
    const f = await bindingFixture();
    const upgrade = (generation: number) =>
      f.channel.fetch(
        new Request(`https://channel.test/?person=alice&generation=${generation}`, {
          headers: { Upgrade: "websocket" },
        }),
      );
    expect((await f.change("bind", "first")).status).toBe(200);
    expect((await upgrade(0)).status).toBe(403);
    expect((await f.change("unbind", "detach")).status).toBe(200);
    expect((await upgrade(0)).status).toBe(403);
    const fresh = await upgrade(2);
    expect(fresh.status).toBe(101);
    fresh.webSocket?.accept();
    fresh.webSocket?.close();
    expect(await f.channel.bindingCurrent(0)).toBe(false);
    expect(await f.channel.bindingCurrent(2)).toBe(true);
  });
});

it("discards HTTP history results admitted before a pending transition", async () => {
  const f = await bindingFixture();
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await runInDurableObject(f.channel, (object) => {
    // Keep the prototype RPC method intact; pause its internal history merge.
    vi.spyOn(
      object as unknown as { withLocalEvents(): Promise<{ events: []; unavailable: [] }> },
      "withLocalEvents",
    ).mockImplementation(async () => {
      started();
      await waiting;
      return { events: [], unavailable: [] };
    });
  });
  const token = await signSession("test-session-secret-at-least-32-characters-long", "native-human" as PersonName);
  const history = nativeFetch(`/r/${f.repo}/api/events?tail=10`, token);
  await reading;
  expect(await f.channel.prepareBinding(f.workspaceId, "outstanding-http-history", 0)).toBe(true);
  release();
  expect((await history).status).toBe(403);
});

it("rejects changed-mode idempotency replay and competing operations", async () => {
  const f = await bindingFixture();
  expect((await f.change("bind", "same-key")).status).toBe(200);
  expect((await f.change("unbind", "same-key")).status).toBe(409);
  await runInDurableObject(f.org, (_object, state) => {
    state.storage.sql.exec(`CREATE TRIGGER s3_compete BEFORE UPDATE ON binding_operations
      WHEN json_extract(NEW.body,'$.phase')='prepared' BEGIN SELECT RAISE(ABORT,'interrupted'); END`);
  });
  expect((await f.change("unbind", "first-detach")).status).toBe(503);
  expect((await f.change("unbind", "second-detach")).status).toBe(409);
  expect(await f.channel.bindingState()).toMatchObject({ state: "pending_unlink", generation: 2 });
});

it("fences queued WS dispatch from old generations after legacy access resumes", async () => {
  await runInDurableObject(channel(), async (object, state) => {
    const response = await object.fetch(
      new Request("https://channel.test/?person=alice", { headers: { Upgrade: "websocket" } }),
    );
    response.webSocket?.accept();
    const server = state.getWebSockets()[0];
    if (!server) throw new Error("Missing server socket");
    const close = vi.spyOn(server, "close");
    expect(object.prepareBinding(workspace, "bind-queued", 0)).toBe(true);
    expect(object.finishBinding(workspace, "bind-queued", 1, false)).toBe(true);
    expect(object.prepareBinding(workspace, "unbind-queued", 1, true)).toBe(true);
    expect(object.finishBinding(workspace, "unbind-queued", 2, true)).toBe(true);
    close.mockClear();
    object.webSocketMessage(server, JSON.stringify({ type: "hook" }));
    expect(close).toHaveBeenCalledWith(1008, "Managed Channel access is closed until P3.");
    expect(object.bindingCurrent(0)).toBe(false);
  });
});

it("keeps linked HTTP history persons and stream data closed until Package 3", async () => {
  const f = await bindingFixture();
  expect((await f.change("bind", "first")).status).toBe(200);
  const legacy = await signSession("test-session-secret-at-least-32-characters-long", "native-human" as PersonName);
  for (const path of ["events?tail=10", "persons", "stream"]) {
    expect((await nativeFetch(`/r/${f.repo}/api/${path}`, legacy)).status).toBe(403);
  }
});
