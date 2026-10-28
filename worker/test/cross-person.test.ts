// Cross-Person Host control and Paused Agents (ADR 0028), driven through the Channel API
// the way two Persons, a Host and its wrappers use it. What is checked is what they
// observe: who may use which Host, what the Host's socket is sent (the requester
// included), the Events that name the requester and the owner, and what a Paused
// Agent does and does not do while it has no process.

import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentResponse,
  ControlAgentResponse,
  ErrorResponse,
  HostPauseMessage,
  HostResumeMessage,
  HostStopMessage,
  SendDirectiveResponse,
  SpawnAgentResponse,
} from "../../shared/src/index";
import { agentPath } from "../../shared/src/index";
import { channelStub } from "./client";
import { call, cleanUp, events, FakeHost, hosts, post, spawnAndStart, waitFor } from "./hosts-harness";

afterEach(cleanUp);

const reason = async (response: Response) => (await response.json<ErrorResponse>()).reason;

/** Alice's Host `laptop`, open to bob and, when `channel` is set, to every Person on the Channel. */
async function aliceHost(options: { allow?: string[]; allowChannel?: boolean } = { allow: ["bob"] }) {
  const host = await FakeHost.registered("alice", "laptop", ["/work"], undefined, options);
  await host.connect();
  return host;
}

describe("a Host's allow-list", () => {
  it("is listed with the Host, without its owner, and replaced when the Host registers again", async () => {
    await FakeHost.registered("alice", "laptop", ["/work"], undefined, { allow: ["carol", "bob", "alice", "bob"] });
    expect((await hosts()).hosts[0]).toMatchObject({ allow: ["bob", "carol"], allowChannel: false });
    await FakeHost.registered("alice", "laptop", ["/work"], undefined, { allowChannel: true });
    expect((await hosts()).hosts[0]).toMatchObject({ allow: [], allowChannel: true });
    // Without any, a Host stays owner-only.
    await FakeHost.registered("alice", "laptop");
    expect((await hosts()).hosts[0]).toMatchObject({ allow: [], allowChannel: false });
  });

  it("refuses anything that is not a list of Person logins", async () => {
    const bad = (body: Record<string, unknown>) =>
      post("/api/hosts", "alice", { name: "laptop", roots: ["/work"], ...body });
    expect((await bad({ allow: "bob" })).status).toBe(400);
    expect((await bad({ allow: ["bob smith"] })).status).toBe(400);
    expect((await bad({ allow: [7] })).status).toBe(400);
    expect((await bad({ allowChannel: "yes" })).status).toBe(400);
  });
});

describe("starting an Agent on another Person's Host", () => {
  it("runs it for the Host's owner, sends the Host who asked, and records both", async () => {
    const laptop = await aliceHost();
    const { spawn, registered, response } = await spawnAndStart(laptop, { brief: "Fix the build" }, "bob");

    expect(response.status).toBe(201);
    expect(spawn.by).toBe("bob");
    expect(registered.agent).toMatchObject({ person: "alice", host: "alice/laptop" });
    const answer = await response.json<SpawnAgentResponse>();
    expect(answer.host).toBe("alice/laptop");

    const recorded = (await events()).find((e) => e.type === "agent.spawn");
    expect(recorded).toMatchObject({
      actor: { kind: "person", person: "bob" },
      payload: { host: "alice/laptop", owner: "alice", brief: "Fix the build" },
    });
  });

  it("is refused, naming how to opt in, when the Host does not allow the Person", async () => {
    const laptop = await aliceHost({ allow: ["bob"] });
    const response = await post("/api/agents/spawn", "carol", {
      cli: "claude-code",
      cwd: "/work/app",
      host: "alice/laptop",
    });
    expect(response.status).toBe(403);
    expect(await reason(response)).toContain("switchboard host install --allow carol");
    expect(laptop.spawns()).toEqual([]);
    // A bare name is the caller's own Host, never someone else's.
    const bare = await post("/api/agents/spawn", "bob", { cli: "claude-code", cwd: "/work/app", host: "laptop" });
    expect(bare.status).toBe(404);
  });

  it("lets every Person on the Channel use a Host installed with --allow-channel", async () => {
    const laptop = await aliceHost({ allowChannel: true });
    const { registered } = await spawnAndStart(laptop, {}, "carol");
    expect(registered.agent.person).toBe("alice");
  });

  it("keeps the Host's own folders and mode for every requester", async () => {
    await aliceHost();
    const outside = await post("/api/agents/spawn", "bob", {
      cli: "claude-code",
      cwd: "/etc",
      host: "alice/laptop",
    });
    expect(outside.status).toBe(403);
    expect(await reason(outside)).toContain("alice/laptop");
    const loose = await post("/api/agents/spawn", "bob", {
      cli: "claude-code",
      cwd: "/work/app",
      host: "alice/laptop",
      permissionMode: "bypassPermissions",
    });
    expect(loose.status).toBe(403);
  });

  it("is not open to a lead, which stays on its own Person's Hosts", async () => {
    const laptop = await aliceHost();
    const bobs = await FakeHost.registered("bob", "desk");
    await bobs.connect();
    const { registered } = await spawnAndStart(bobs);
    const lead = registered.agent.id;
    expect((await call(`${agentPath(lead)}/role`, "bob", { method: "PUT", body: { role: "lead" } })).status).toBe(200);

    const response = await post(
      "/api/agents/spawn",
      "bob",
      { cli: "claude-code", cwd: "/work/app", host: "alice/laptop" },
      lead,
    );
    expect(response.status).toBe(403);
    expect(await reason(response)).toContain("own Person's Hosts");
    expect(laptop.spawns()).toEqual([]);
  });
});

describe("stopping an Agent on another Person's Host", () => {
  it("is for the Host's allowed Persons and its owner, with the requester on the frame and the Event", async () => {
    const laptop = await aliceHost();
    const { registered } = await spawnAndStart(laptop);
    const id = registered.agent.id;

    expect((await post(`${agentPath(id)}/stop`, "carol")).status).toBe(403);
    const response = await post(`${agentPath(id)}/stop`, "bob");
    expect(response.status).toBe(200);
    const stop = await waitFor(() => laptop.frames.find((f) => f.type === "host.stop") as HostStopMessage | undefined);
    expect(stop).toEqual({ type: "host.stop", agent: id, by: "bob" });
    expect((await events()).find((e) => e.type === "agent.stop")).toMatchObject({
      actor: { kind: "person", person: "bob" },
      payload: { agent: id, host: "alice/laptop", owner: "alice" },
    });
  });

  it("is refused for anyone once the owner takes the allow-list away, but never for the owner", async () => {
    const laptop = await aliceHost();
    const { registered } = await spawnAndStart(laptop);
    await FakeHost.registered("alice", "laptop");
    expect((await post(`${agentPath(registered.agent.id)}/stop`, "bob")).status).toBe(403);
    expect((await post(`${agentPath(registered.agent.id)}/stop`, "alice")).status).toBe(200);
  });
});

describe("pausing and resuming an Agent", () => {
  async function paused() {
    const laptop = await aliceHost();
    const { registered } = await spawnAndStart(laptop);
    const id = registered.agent.id;
    const response = await post(`${agentPath(id)}/pause`, "bob");
    expect(response.status).toBe(200);
    expect(await response.json<ControlAgentResponse>()).toEqual({
      ok: true,
      agent: id,
      host: "alice/laptop",
      presence: "paused",
    });
    return { laptop, id, sessionId: sessionOf(registered), registered };
  }

  /** The session ID an Agent's registration answered with, read from its Agent ID suffix. */
  function sessionOf(registered: AgentResponse): string {
    const suffix = registered.agent.id.split("/")[2] as string;
    return `${suffix}eeee-0000-4000-8000-000000000000`;
  }

  const agentNow = async (id: string) => {
    const roster = await (await call("/api/agents?include=gone", "dashboard")).json<{
      agents: AgentResponse["agent"][];
    }>();
    return roster.agents.find((a) => a.id === id);
  };

  it("pauses at once, tells the Host who asked, and records the requester and the owner", async () => {
    const { laptop, id } = await paused();
    const frame = await waitFor(
      () => laptop.frames.find((f) => f.type === "host.pause") as HostPauseMessage | undefined,
    );
    expect(frame).toEqual({ type: "host.pause", agent: id, by: "bob" });
    expect((await agentNow(id))?.presence).toBe("paused");
    expect((await events()).find((e) => e.type === "agent.pause")).toMatchObject({
      actor: { kind: "person", person: "bob" },
      payload: { agent: id, host: "alice/laptop", owner: "alice" },
    });
    // Twice is a conflict, not a second process killed.
    expect((await post(`${agentPath(id)}/pause`, "bob")).status).toBe(409);
  });

  it("is a Person's: not a stranger's, not an Agent's, not for an Agent started in a terminal", async () => {
    const laptop = await aliceHost();
    const { registered } = await spawnAndStart(laptop);
    const id = registered.agent.id;
    expect((await post(`${agentPath(id)}/pause`, "carol")).status).toBe(403);
    expect((await post(`${agentPath(id)}/pause`, "alice", {}, id)).status).toBe(403);

    const terminal = await (
      await post("/api/agents", "alice", {
        cli: "claude-code",
        sessionId: "7777eeee-0000-4000-8000-000000000000",
        resumed: false,
        cwd: "/work/app",
      })
    ).json<AgentResponse>();
    const refused = await post(`${agentPath(terminal.agent.id)}/pause`, "alice");
    expect(refused.status).toBe(409);
    expect(await reason(refused)).toContain("runs in a terminal");
  });

  it("is not Gone when its wrapper ends the session or goes quiet, and ignores a stale heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { id } = await paused();

    expect((await post(`${agentPath(id)}/heartbeat`, "alice", { presence: "live" }, id)).status).toBe(200);
    expect((await agentNow(id))?.presence).toBe("paused");
    expect((await post(`${agentPath(id)}/end`, "alice", {}, id)).status).toBe(200);
    expect((await agentNow(id))?.presence).toBe("paused");

    vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
    await runDurableObjectAlarm(channelStub());
    expect((await agentNow(id))?.presence).toBe("paused");
    const types = (await events()).map((e) => e.type);
    expect(types).not.toContain("session.end");
  });

  it("revokes the Agent's token only once the Host confirms its process ended", async () => {
    const { laptop, id } = await paused();
    expect((await post(`${agentPath(id)}/heartbeat`, "alice", { presence: "idle" }, id)).status).toBe(200);
    laptop.send({ type: "host.paused", agent: id });
    await waitFor(async () =>
      (await post(`${agentPath(id)}/heartbeat`, "alice", { presence: "idle" }, id)).status === 401 ? true : undefined,
    );
  });

  it("brings the Agent back as Idle when the Host refuses to pause it", async () => {
    const { laptop, id } = await paused();
    laptop.send({ type: "host.control.failed", action: "pause", agent: id, by: "bob", reason: "not allowed here" });
    await waitFor(async () => ((await agentNow(id))?.presence === "idle" ? true : undefined));
    expect((await events()).find((e) => e.type === "agent.control.failed")).toMatchObject({
      actor: { kind: "person", person: "alice" },
      payload: { action: "pause", agent: id, owner: "alice", by: "bob", reason: "not allowed here" },
    });
  });

  it("holds Directives for a Paused Agent and hands them over when it registers again", async () => {
    const { laptop, id, sessionId } = await paused();
    laptop.send({ type: "host.paused", agent: id });

    const sent = await post("/api/directives", "alice", { to: id, text: "Carry on with #7." });
    expect(sent.status).toBe(201);
    expect((await sent.json<SendDirectiveResponse>()).ok).toBe(true);
    expect((await events()).find((e) => e.type === "directive.delivery")).toMatchObject({
      payload: { delivered: "queue", reason: "paused" },
    });

    expect((await post(`${agentPath(id)}/resume`, "bob")).status).toBe(200);
    const resumed = await post("/api/agents", "alice", {
      cli: "claude-code",
      sessionId,
      resumed: true,
      cwd: "/work/app",
      host: "laptop",
    });
    expect(resumed.status).toBe(200);
    const answer = await resumed.json<AgentResponse>();
    expect(answer.agent).toMatchObject({ id, presence: "live", person: "alice" });
    expect(answer.directives?.map((d) => d.text)).toEqual(["Carry on with #7."]);
  });

  it("resumes the same Agent only for a Resume its Host was asked for", async () => {
    const { laptop, id, sessionId } = await paused();
    const register = (host?: string) =>
      post("/api/agents", "alice", {
        cli: "claude-code",
        sessionId,
        resumed: true,
        cwd: "/work/app",
        ...(host === undefined ? {} : { host }),
      });

    // Neither a wrapper that never heard of the pause nor a Person's own terminal brings it back.
    const stale = await register("laptop");
    expect(stale.status).toBe(409);
    expect(await reason(stale)).toContain("Paused");
    expect((await register()).status).toBe(409);
    expect((await agentNow(id))?.presence).toBe("paused");

    expect((await post(`${agentPath(id)}/resume`, "carol")).status).toBe(403);
    const response = await post(`${agentPath(id)}/resume`, "bob");
    expect(response.status).toBe(200);
    const frame = await waitFor(
      () => laptop.frames.find((f) => f.type === "host.resume") as HostResumeMessage | undefined,
    );
    expect(frame).toEqual({ type: "host.resume", agent: id, by: "bob" });
    expect((await events()).find((e) => e.type === "agent.resume")).toMatchObject({
      actor: { kind: "person", person: "bob" },
      payload: { agent: id, owner: "alice" },
    });

    // Not from a terminal even now; from the Host once; not a second time.
    expect((await register()).status).toBe(409);
    expect((await register("laptop")).status).toBe(200);
    expect((await agentNow(id))?.presence).toBe("live");
    expect((await post(`${agentPath(id)}/resume`, "bob")).status).toBe(409);
  });

  it("stays Paused, and says why, when the Host cannot resume it", async () => {
    const { laptop, id, sessionId } = await paused();
    expect((await post(`${agentPath(id)}/resume`, "bob")).status).toBe(200);
    laptop.send({ type: "host.control.failed", action: "resume", agent: id, by: "bob", reason: "session not found" });
    await waitFor(async () =>
      (await events()).find((e) => e.type === "agent.control.failed") === undefined ? undefined : true,
    );
    expect((await agentNow(id))?.presence).toBe("paused");
    // The ticket went with the failure.
    const late = await post("/api/agents", "alice", {
      cli: "claude-code",
      sessionId,
      resumed: true,
      cwd: "/work/app",
      host: "laptop",
    });
    expect(late.status).toBe(409);
  });

  it("is not for an Agent that is not Paused, or whose Host is Offline", async () => {
    const laptop = await aliceHost();
    const { registered } = await spawnAndStart(laptop);
    const id = registered.agent.id;
    const notPaused = await post(`${agentPath(id)}/resume`, "bob");
    expect(notPaused.status).toBe(409);
    expect(await reason(notPaused)).toContain("not Paused");

    expect((await post(`${agentPath(id)}/pause`, "bob")).status).toBe(200);
    laptop.close();
    await waitFor(async () => ((await hosts()).hosts[0]?.live === false ? true : undefined));
    const offline = await post(`${agentPath(id)}/resume`, "bob");
    expect(offline.status).toBe(409);
    expect(await reason(offline)).toContain("Offline");
  });

  it("makes a stopped Paused Agent Gone, and lets its own Person end one whose Host never returns", async () => {
    const { laptop, id } = await paused();
    expect((await post(`${agentPath(id)}/stop`, "bob")).status).toBe(200);
    await waitFor(() => laptop.frames.find((f) => f.type === "host.stop"));
    expect((await agentNow(id))?.presence).toBe("gone");

    const second = await spawnAndStart(laptop);
    const other = second.registered.agent.id;
    expect((await post(`${agentPath(other)}/pause`, "alice")).status).toBe(200);
    laptop.close();
    await waitFor(async () => ((await hosts()).hosts[0]?.live === false ? true : undefined));
    expect((await post(`${agentPath(other)}/stop`, "bob")).status).toBe(409);
    expect((await post(`${agentPath(other)}/stop`, "alice")).status).toBe(200);
    expect((await agentNow(other))?.presence).toBe("gone");
  });

  it("does not count against the Channel's cap while Paused", async () => {
    const laptop = await aliceHost();
    const before = (await hosts()).running;
    const { registered } = await spawnAndStart(laptop);
    expect((await hosts()).running).toBe(before + 1);
    await post(`${agentPath(registered.agent.id)}/pause`, "bob");
    expect((await hosts()).running).toBe(before);
  });
});

describe("sharing a Host from the Dashboard (ADR 0028)", () => {
  const change = (allow: string[] = ["bob"], allowChannel = false) => ({
    allow,
    allowChannel,
    key: "a2V5",
    at: Date.now(),
    seq: 1,
    sig: "c2ln",
  });
  const answerWith = async (host: FakeHost, result: { ok: boolean; reason?: string }) => {
    const frame = await waitFor(() => host.frames.find((f) => f.type === "host.allow"));
    host.send({ type: "host.allow.result", id: frame.id, ...result });
    return frame;
  };

  it("passes the signed change to the Host untouched and answers once the Host says it applied it", async () => {
    const laptop = await aliceHost({});
    const asking = post("/api/hosts/laptop/allow", "alice", change());
    const frame = await answerWith(laptop, { ok: true });
    expect(frame).toMatchObject({
      type: "host.allow",
      allow: ["bob"],
      allowChannel: false,
      key: "a2V5",
      seq: 1,
      sig: "c2ln",
    });
    expect((await asking).status).toBe(200);
  });

  it("shows the Host's reason when it refuses, and never changes the Channel's copy itself", async () => {
    const laptop = await aliceHost({});
    const asking = post("/api/hosts/laptop/allow", "alice", change());
    await answerWith(laptop, { ok: false, reason: "key AAAA-BBBB is not trusted on this machine" });
    const response = await asking;
    expect(response.status).toBe(403);
    expect(await reason(response)).toContain("is not trusted on this machine");
    expect((await hosts()).hosts[0]).toMatchObject({ allow: [] });
  });

  it("is for the Host's own Person, and needs the Host running", async () => {
    const laptop = await aliceHost({});
    expect((await post("/api/hosts/laptop/allow", "bob", change())).status).toBe(404);
    expect((await post("/api/hosts/laptop/allow", "alice", { allow: ["bob"] })).status).toBe(400);
    laptop.close();
    await waitFor(async () => ((await hosts()).hosts[0]?.live === false ? true : undefined));
    const offline = await post("/api/hosts/laptop/allow", "alice", change());
    expect(offline.status).toBe(409);
    expect(await reason(offline)).toContain("Offline");
  });

  it("ignores an answer from a different Host", async () => {
    const laptop = await aliceHost({});
    const other = await FakeHost.registered("bob", "desk");
    await other.connect();
    const asking = post("/api/hosts/laptop/allow", "alice", change());
    const frame = await waitFor(() => laptop.frames.find((f) => f.type === "host.allow"));
    other.send({ type: "host.allow.result", id: frame.id, ok: true });
    laptop.send({ type: "host.allow.result", id: frame.id, ok: false, reason: "no" });
    expect((await asking).status).toBe(403);
  });
});
