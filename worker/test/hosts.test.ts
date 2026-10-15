// Hosts (ADR 0015), driven through the Channel API the way the Host, its wrappers and
// the Dashboard use it. What is checked is what clients observe: the Host's socket
// getting the spawns and stops meant for it (and nothing else), the answers to spawn
// and stop, the Agent's `host`, and the Events on the Channel.

import { runDurableObjectAlarm } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ErrorResponse,
  HostResponse,
  HostStopMessage,
  SpawnAgentResponse,
  StopAgentResponse,
} from "../../shared/src/index";
import { agentPath } from "../../shared/src/index";
import { OFFLINE_GRACE_MS, SPAWN_EXPIRES_MS } from "../src/hosts";
import { channelStub, streamQuery, url } from "./client";
import {
  call,
  cleanUp,
  closeAfterTest,
  events,
  FakeHost,
  hosts,
  post,
  spawnAndStart,
  waitFor,
  wrapperRegisters,
} from "./hosts-harness";

afterEach(cleanUp);

describe("registering a Host", () => {
  it("lists it, Live only while its socket is attached, and records coming Live", async () => {
    const studio = await FakeHost.registered("shlok", "studio", ["/work/", "/work", "/repos"], "acceptEdits");
    expect((await hosts()).hosts).toEqual([
      expect.objectContaining({
        id: "shlok/studio",
        person: "shlok",
        name: "studio",
        roots: ["/work", "/repos"],
        maxPermissionMode: "acceptEdits",
        live: false,
      }),
    ]);
    await studio.connect();
    await waitFor(async () => ((await hosts()).hosts[0]?.live ? true : undefined));
    expect((await events()).filter((e) => e.type === "host.online")).toEqual([
      expect.objectContaining({ actor: { kind: "person", person: "shlok" }, payload: { host: "shlok/studio" } }),
    ]);
    expect(await hosts()).toMatchObject({ cap: 3, running: 0 });
  });

  it("refuses a bad name or folders, a socket for a Host nobody registered, and an Agent token", async () => {
    expect((await post("/api/hosts", "shlok", { name: "Studio!", roots: ["/w"] })).status).toBe(400);
    expect((await post("/api/hosts", "shlok", { name: "studio", roots: ["relative"] })).status).toBe(400);
    expect((await post("/api/hosts", "shlok", { name: "studio", roots: ["/w/../etc"] })).status).toBe(400);
    expect((await post("/api/hosts", "shlok", { name: "studio", roots: [] })).status).toBe(400);
    expect(
      (await post("/api/hosts", "shlok", { name: "studio", roots: ["/w"], maxPermissionMode: "yolo" })).status,
    ).toBe(400);

    const query = await streamQuery("shlok", { host: "nowhere" });
    const response = await exports.default.fetch(
      new Request(url(`/api/stream?${query}`), { headers: { Upgrade: "websocket" } }),
    );
    expect(response.status).toBe(404);

    const { agent } = await wrapperRegisters("shlok");
    const refused = await post("/api/hosts", "shlok", { name: "studio", roots: ["/w"] }, agent.id);
    expect(refused.status).toBe(403);
    expect((await refused.json<ErrorResponse>()).reason).toContain("only a Person can");
    const agentStream = await exports.default.fetch(
      new Request(url(`/api/stream?${await streamQuery({ person: "shlok", agent: agent.id }, { host: "studio" })}`), {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(agentStream.status).toBe(403);
    const agentList = await call("/api/hosts", "shlok", {}, agent.id);
    expect(agentList.status).toBe(403);
  });

  it("records Offline only after the Host has stayed away, so a reconnect records nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    await waitFor(async () => ((await hosts()).hosts[0]?.live ? true : undefined));

    // Gone and back within the grace: nothing recorded.
    studio.close();
    await waitFor(async () => ((await hosts()).hosts[0]?.live === false ? true : undefined));
    await studio.connect();
    vi.setSystemTime(Date.now() + OFFLINE_GRACE_MS + 1000);
    await runDurableObjectAlarm(channelStub());
    expect((await events()).filter((e) => e.type.startsWith("host.")).map((e) => e.type)).toEqual(["host.online"]);

    // Gone for good.
    studio.close();
    await waitFor(async () => ((await hosts()).hosts[0]?.live === false ? true : undefined));
    vi.setSystemTime(Date.now() + OFFLINE_GRACE_MS + 1000);
    expect(await runDurableObjectAlarm(channelStub())).toBe(true);
    expect((await events()).filter((e) => e.type.startsWith("host.")).map((e) => e.type)).toEqual([
      "host.online",
      "host.offline",
    ]);
  });

  it("removes a Host and closes its socket", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    expect((await call("/api/hosts/studio", "nate", { method: "DELETE" })).status).toBe(404);
    expect((await call("/api/hosts/studio", "shlok", { method: "DELETE" })).status).toBe(200);
    expect((await hosts()).hosts).toEqual([]);
  });
});

describe("starting an Agent", () => {
  it("sends the spawn to the Host and answers with the Agent once its wrapper registers", async () => {
    const studio = await FakeHost.registered("shlok", "studio", ["/work"], "acceptEdits");
    await studio.connect();
    const { spawn, registered, response } = await spawnAndStart(studio, {
      nickname: "scout",
      model: "opus",
      brief: "  Fix the login redirect.  ",
      permissionMode: "acceptEdits",
    });
    expect(spawn).toEqual({
      type: "host.spawn",
      spawn: expect.any(String),
      cli: "claude-code",
      cwd: "/work/app",
      nickname: "scout",
      model: "opus",
      brief: "Fix the login redirect.",
      permissionMode: "acceptEdits",
      by: "shlok",
    });
    expect(response.status).toBe(201);
    const answer = await response.json<SpawnAgentResponse>();
    expect(answer).toMatchObject({ ok: true, spawn: spawn.spawn, host: "shlok/studio" });
    expect(answer.agent?.id).toBe(registered.agent.id);
    expect(registered.agent.host).toBe("shlok/studio");
    // The Host hears that the session started, so it stops watching for the trust dialog.
    expect(await waitFor(() => studio.frames.find((f) => f.type === "host.spawned"))).toEqual({
      type: "host.spawned",
      spawn: spawn.spawn,
      agent: registered.agent.id,
    });

    const all = await events();
    const requested = all.find((e) => e.type === "agent.spawn");
    expect(requested).toMatchObject({
      id: spawn.spawn,
      actor: { kind: "person", person: "shlok" },
      payload: {
        host: "shlok/studio",
        cwd: "/work/app",
        nickname: "scout",
        permissionMode: "acceptEdits",
        brief: "Fix the login redirect.",
      },
    });
    expect(all.find((e) => e.type === "agent.spawned")).toMatchObject({
      actor: { kind: "agent", agentId: registered.agent.id },
      payload: { spawn: spawn.spawn, host: "shlok/studio", agent: registered.agent.id },
    });
    expect(await hosts()).toMatchObject({ running: 1 });
  });

  it("goes to the Person's most recently seen Live Host when none is named", async () => {
    const old = await FakeHost.registered("shlok", "old");
    const studio = await FakeHost.registered("shlok", "studio");
    await old.connect();
    await studio.connect();
    old.close();
    const { response } = await spawnAndStart(studio);
    expect(response.status).toBe(201);
    expect(old.spawns()).toEqual([]);
  });

  it("refuses what the Host does not allow, and Hosts that are not the caller's or not Live", async () => {
    const studio = await FakeHost.registered("shlok", "studio", ["/work"]);
    const refusal = async (person: string, body: Record<string, unknown>) => {
      const response = await post("/api/agents/spawn", person, { cli: "claude-code", cwd: "/work/app", ...body });
      return [response.status, (await response.json<ErrorResponse>()).reason];
    };
    expect(await refusal("shlok", {})).toEqual([409, expect.stringContaining("None of your Hosts is Live")]);
    expect(await refusal("shlok", { host: "studio" })).toEqual([409, "studio is Offline."]);
    await studio.connect();
    expect(await refusal("shlok", { cwd: "/etc" })).toEqual([
      403,
      expect.stringContaining("is not under studio's folders"),
    ]);
    expect(await refusal("shlok", { cwd: "/workshop" })).toEqual([403, expect.stringContaining("is not under")]);
    expect(await refusal("shlok", { permissionMode: "bypassPermissions" })).toEqual([
      403,
      'studio starts Agents in at most the "default" permission mode.',
    ]);
    expect(await refusal("nate", { host: "studio" })).toEqual([404, expect.stringContaining("no Host named studio")]);
    expect((await refusal("shlok", { cli: "codex" }))[0]).toBe(400);
    expect((await refusal("shlok", { cwd: "relative" }))[0]).toBe(400);
    expect((await refusal("shlok", { brief: "x".repeat(4001) }))[0]).toBe(400);
    expect(studio.spawns()).toEqual([]);

    const { agent } = await wrapperRegisters("shlok");
    const fromAgent = await post("/api/agents/spawn", "shlok", { cli: "claude-code", cwd: "/work/app" }, agent.id);
    expect(fromAgent.status).toBe(403);
    expect((await fromAgent.json<ErrorResponse>()).reason).toContain("is not a lead");
  });

  it("caps the Agents Hosts run on the Channel, counting those still starting", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    await spawnAndStart(studio);
    await spawnAndStart(studio);
    // The third is still starting when the fourth is asked for.
    const third = post("/api/agents/spawn", "shlok", { cli: "claude-code", cwd: "/work/app" });
    await studio.nextSpawn();
    const fourth = await post("/api/agents/spawn", "shlok", { cli: "claude-code", cwd: "/work/app" });
    expect(fourth.status).toBe(409);
    expect((await fourth.json<ErrorResponse>()).reason).toContain("3 Agents");
    expect((await third).status).toBe(202);
  });

  it("answers with the Host's reason when it cannot start the Agent, and ignores others' answers", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    const laptop = await FakeHost.registered("shlok", "laptop");
    await studio.connect();
    await laptop.connect();
    const spawning = post("/api/agents/spawn", "shlok", { host: "studio", cli: "claude-code", cwd: "/work/app" });
    const { spawn } = await studio.nextSpawn();
    // Another Host cannot answer for this one's spawn.
    laptop.send({ type: "host.spawn.failed", spawn, reason: "not mine" });
    studio.send({ type: "host.spawn.failed", spawn, reason: "the folder is not trusted: run claude there once" });
    const response = await spawning;
    expect(response.status).toBe(502);
    expect((await response.json<ErrorResponse>()).reason).toBe(
      "studio could not start the Agent: the folder is not trusted: run claude there once",
    );
    expect((await events()).filter((e) => e.type === "agent.spawn.failed")).toEqual([
      expect.objectContaining({
        actor: { kind: "person", person: "shlok" },
        payload: { spawn, host: "shlok/studio", reason: "the folder is not trusted: run claude there once" },
      }),
    ]);
    // A late registration for a spawn that already ended records nothing more.
    await wrapperRegisters("shlok", "studio", spawn);
    expect((await events()).filter((e) => e.type === "agent.spawned")).toEqual([]);
  });

  it("ignores a spawn failure sent from a Person's plain socket or an Agent's socket", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    const { agent } = await wrapperRegisters("shlok");
    const sockets: WebSocket[] = [];
    for (const as of ["shlok", { person: "shlok", agent: agent.id }] as const) {
      const response = await exports.default.fetch(
        new Request(url(`/api/stream?${await streamQuery(as)}`), { headers: { Upgrade: "websocket" } }),
      );
      const socket = response.webSocket;
      if (!socket) throw new Error(`No WebSocket: ${response.status}`);
      socket.accept();
      sockets.push(socket);
      closeAfterTest(socket);
    }
    const spawning = post("/api/agents/spawn", "shlok", { cli: "claude-code", cwd: "/work/app" });
    const { spawn } = await studio.nextSpawn();
    for (const socket of sockets)
      socket.send(JSON.stringify({ type: "host.spawn.failed", spawn, reason: "not a Host" }));
    // Still waiting on the Host, so the request comes back without the Agent, not failed.
    expect((await spawning).status).toBe(202);
    expect((await events()).filter((e) => e.type === "agent.spawn.failed")).toEqual([]);
  });

  it("answers 202 when the Host is slow, and fails the spawn once it is too late", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    const response = await post("/api/agents/spawn", "shlok", { cli: "claude-code", cwd: "/work/app" });
    expect(response.status).toBe(202);
    const { spawn } = await response.json<SpawnAgentResponse>();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + SPAWN_EXPIRES_MS + 1000);
    expect(await runDurableObjectAlarm(channelStub())).toBe(true);
    expect((await events()).find((e) => e.type === "agent.spawn.failed")).toMatchObject({
      payload: { spawn, reason: "shlok/studio did not start it within 2 minutes." },
    });
    expect(await hosts()).toMatchObject({ running: 0 });
  });

  it("refuses a wrapper that names a Host its Person does not have", async () => {
    const response = await post("/api/agents", "shlok", {
      cli: "claude-code",
      sessionId: "0bad0000-0000-4000-8000-000000000000",
      resumed: false,
      cwd: "/w",
      host: "nowhere",
    });
    expect(response.status).toBe(409);
  });
});

describe("stopping an Agent", () => {
  it("sends the stop to the Host that runs the Agent, for its own Person only", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    const { registered } = await spawnAndStart(studio);
    const id = registered.agent.id;

    expect((await post(`${agentPath(id)}/stop`, "nate")).status).toBe(403);
    const fromAgent = await post(`${agentPath(id)}/stop`, "shlok", {}, id);
    expect(fromAgent.status).toBe(403);

    const response = await post(`${agentPath(id)}/stop`, "shlok");
    expect(response.status).toBe(200);
    expect(await response.json<StopAgentResponse>()).toEqual({ ok: true, agent: id, host: "shlok/studio" });
    const stop = await waitFor(() => studio.frames.find((f) => f.type === "host.stop") as HostStopMessage | undefined);
    expect(stop).toEqual({ type: "host.stop", agent: id });
    expect((await events()).find((e) => e.type === "agent.stop")).toMatchObject({
      actor: { kind: "person", person: "shlok" },
      payload: { agent: id, host: "shlok/studio" },
    });
  });

  it("refuses an Agent started in a terminal, and one whose Host is Offline", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    const { agent: terminal } = await wrapperRegisters("shlok");
    const response = await post(`${agentPath(terminal.id)}/stop`, "shlok");
    expect(response.status).toBe(409);
    expect((await response.json<ErrorResponse>()).reason).toContain("runs in a terminal");

    const { registered } = await spawnAndStart(studio);
    studio.close();
    await waitFor(async () => ((await hosts()).hosts[0]?.live === false ? true : undefined));
    const offline = await post(`${agentPath(registered.agent.id)}/stop`, "shlok");
    expect(offline.status).toBe(409);
    expect((await offline.json<ErrorResponse>()).reason).toContain("is Offline");
  });
});

describe("a Host's socket", () => {
  it("carries only what is asked of that Host, never the Channel's stream", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    await post("/api/updates", "shlok", { text: "Hello" });
    const { spawn, registered } = await spawnAndStart(studio);
    await waitFor(() => (studio.frames.length === 2 ? true : undefined));
    expect(studio.frames).toEqual([spawn, { type: "host.spawned", spawn: spawn.spawn, agent: registered.agent.id }]);
  });
});

describe("the Host routes", () => {
  it("answers HostResponse for a registration", async () => {
    const response = await post("/api/hosts", "shlok", { name: "studio", roots: ["/work"] });
    const { host } = await response.json<HostResponse>();
    expect(host).toMatchObject({ id: "shlok/studio", maxPermissionMode: "default", live: false });
  });
});
