// Leads (ADR 0018), driven through the Channel API the way a Person, a lead's MCP tools,
// a Host and its wrappers use it. What is checked is what they observe: the answers,
// the Host's socket getting only what a lead may ask, the Agents' role and parent, the
// Directives the targets read, and the Events on the Channel.

import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentId,
  AgentResponse,
  AgentsResponse,
  ErrorResponse,
  HostStopMessage,
  SendDirectiveResponse,
  SpawnAgentResponse,
} from "../../shared/src/index";
import { agentPath, directivesNotice, rolePath } from "../../shared/src/index";
import { call, cleanUp, events, FakeHost, post, spawnAndStart, waitFor, wrapperRegisters } from "./hosts-harness";

afterEach(cleanUp);

const grant = (person: string, id: AgentId, as?: AgentId, role: unknown = "lead") =>
  call(rolePath(id), person, { method: "PUT", body: { role } }, as);

const revoke = (person: string, id: AgentId) => call(rolePath(id), person, { method: "DELETE" });

/** One of `person`'s Agents, started in a terminal and made a lead. */
async function aLead(person: string): Promise<AgentId> {
  const { agent } = await wrapperRegisters(person);
  expect((await grant(person, agent.id)).status).toBe(200);
  return agent.id;
}

/** `lead` starts an Agent on `host` through its token, the way `agent_spawn` does, and its wrapper registers. */
async function leadSpawns(host: FakeHost, lead: AgentId, body: Record<string, unknown> = {}) {
  const spawning = post("/api/agents/spawn", host.person, { cli: "claude-code", cwd: "/work/app", ...body }, lead);
  const spawn = await host.nextSpawn();
  const registered = await wrapperRegisters(host.person, host.name, spawn.spawn);
  const response = await spawning;
  expect(response.status).toBe(201);
  return { spawn, agent: (await response.json<SpawnAgentResponse>()).agent ?? registered.agent };
}

const direct = (person: string, to: AgentId, text: string, as?: AgentId) =>
  post("/api/directives", person, { to, text }, as);

async function reason(response: Response): Promise<string> {
  return (await response.json<ErrorResponse>()).reason;
}

describe("granting the lead role", () => {
  it("is for the Agent's own Person only, recorded, and kept until they revoke it", async () => {
    const { agent } = await wrapperRegisters("shlok");
    const id = agent.id;

    const byOther = await grant("nate", id);
    expect(byOther.status).toBe(403);
    expect(await reason(byOther)).toContain("Only its own Person");
    const byItself = await grant("shlok", id, id);
    expect(byItself.status).toBe(403);
    expect((await grant("shlok", id, undefined, "admin")).status).toBe(400);

    const granted = await grant("shlok", id);
    expect(granted.status).toBe(200);
    expect((await granted.json<AgentResponse>()).agent.role).toBe("lead");
    // Granting again changes nothing and records nothing.
    expect((await grant("shlok", id)).status).toBe(200);

    const revoked = await revoke("shlok", id);
    expect((await revoked.json<AgentResponse>()).agent.role).toBeUndefined();

    const roleEvents = (await events()).filter((e) => e.type.startsWith("agent.role."));
    expect(roleEvents.map((e) => [e.type, e.actor, e.payload])).toEqual([
      ["agent.role.granted", { kind: "person", person: "shlok" }, { agent: id, role: "lead" }],
      ["agent.role.revoked", { kind: "person", person: "shlok" }, { agent: id, role: "lead" }],
    ]);
  });

  it("survives the session resuming: a resumed session is the same Agent", async () => {
    const session = { cli: "claude-code", sessionId: "7f3a0000-0000-4000-8000-000000000000", cwd: "/work/app" };
    const { agent } = await (await post("/api/agents", "shlok", { ...session, resumed: false })).json<AgentResponse>();
    expect((await grant("shlok", agent.id)).status).toBe(200);
    await post(`${agentPath(agent.id)}/end`, "shlok", {});
    const resumed = await (await post("/api/agents", "shlok", { ...session, resumed: true })).json<AgentResponse>();
    expect(resumed.agent).toMatchObject({ id: agent.id, role: "lead" });
  });
});

describe("an Agent that is not a lead", () => {
  it("is refused on spawn, stop and Directive, and nothing reaches the Host or the target", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    const { registered } = await spawnAndStart(studio);
    const target = registered.agent.id;
    const { agent } = await wrapperRegisters("shlok");
    const before = (await events()).length;

    const spawn = await post("/api/agents/spawn", "shlok", { cli: "claude-code", cwd: "/work/app" }, agent.id);
    expect(spawn.status).toBe(403);
    expect(await reason(spawn)).toContain(`${agent.id} is not a lead`);
    const stop = await post(`${agentPath(target)}/stop`, "shlok", {}, agent.id);
    expect(stop.status).toBe(403);
    expect(await reason(stop)).toContain("switchboard role grant");
    const directive = await direct("shlok", target, "Delete your branch.", agent.id);
    expect(directive.status).toBe(403);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(studio.spawns()).toHaveLength(1);
    expect(studio.frames.some((f) => f.type === "host.stop")).toBe(false);
    expect(
      (await events()).slice(before).filter((e) => ["agent.spawn", "agent.stop", "directive"].includes(e.type)),
    ).toEqual([]);
  });

  it("still cannot list, register or remove Hosts once it is a lead", async () => {
    const lead = await aLead("shlok");
    expect((await post("/api/hosts", "shlok", { name: "studio", roots: ["/w"] }, lead)).status).toBe(403);
    expect((await call("/api/hosts", "shlok", {}, lead)).status).toBe(403);
    // Nor grant a role, even to an Agent it started.
    const { agent } = await wrapperRegisters("shlok");
    expect((await grant("shlok", agent.id, lead)).status).toBe(403);
  });
});

describe("a lead", () => {
  it("starts an Agent on its Person's Host, which belongs to that Person and has the lead as its parent", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    const lead = await aLead("shlok");

    const { spawn, agent } = await leadSpawns(studio, lead, { brief: "Fix the login redirect." });
    expect(spawn).toMatchObject({ by: "shlok", lead, brief: "Fix the login redirect." });
    expect(agent).toMatchObject({ person: "shlok", host: "shlok/studio", parent: lead });
    expect(agent.role).toBeUndefined();

    const all = await events();
    expect(all.find((e) => e.type === "agent.spawn")).toMatchObject({
      actor: { kind: "agent", agentId: lead },
      payload: { host: "shlok/studio", parent: lead },
    });
    expect(all.find((e) => e.type === "agent.spawned")).toMatchObject({
      actor: { kind: "agent", agentId: agent.id },
      payload: { agent: agent.id, parent: lead },
    });
  });

  it("runs on its own Person's Hosts only, within what each Host allows", async () => {
    const theirs = await FakeHost.registered("nate", "box");
    await theirs.connect();
    const lead = await aLead("shlok");
    const none = await post("/api/agents/spawn", "shlok", { cli: "claude-code", cwd: "/work/app", host: "box" }, lead);
    expect(none.status).toBe(404);

    const studio = await FakeHost.registered("shlok", "studio", ["/work"], "acceptEdits");
    await studio.connect();
    const outside = await post("/api/agents/spawn", "shlok", { cli: "claude-code", cwd: "/etc" }, lead);
    expect(outside.status).toBe(403);
    const looser = await post(
      "/api/agents/spawn",
      "shlok",
      { cli: "claude-code", cwd: "/work/app", permissionMode: "bypassPermissions" },
      lead,
    );
    expect(looser.status).toBe(403);
    expect(theirs.spawns()).toEqual([]);
  });

  it("stops and directs only its own subtree, which reaches through a lead it started", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    const lead = await aLead("shlok");
    const { registered } = await spawnAndStart(studio);
    const theirs = registered.agent.id;
    const { agent: child } = await leadSpawns(studio, lead);
    expect((await grant("shlok", child.id)).status).toBe(200);
    const { agent: grandchild } = await leadSpawns(studio, child.id);

    for (const outside of [theirs, lead]) {
      const stop = await post(`${agentPath(outside)}/stop`, "shlok", {}, lead);
      expect(stop.status).toBe(403);
      expect(await reason(stop)).toContain("only Agents in its own subtree");
      expect((await direct("shlok", outside, "Stop.", lead)).status).toBe(403);
    }
    // The child lead reaches its own Agent, but not its parent.
    expect((await direct("shlok", lead, "Stop.", child.id)).status).toBe(403);

    const sent = await direct("shlok", grandchild.id, "Rebase on main, then open the PR.", lead);
    expect(sent.status).toBe(201);
    const { event } = await sent.json<SendDirectiveResponse>();
    expect(event).toMatchObject({ type: "directive", actor: { kind: "agent", agentId: lead } });
    // The grandchild's wrapper is not connected, so the Directive waits for its next turn.
    const beat = await post(`${agentPath(grandchild.id)}/heartbeat`, "shlok", { presence: "live" });
    const [delivered] = (await beat.json<AgentResponse>()).directives ?? [];
    expect(delivered).toMatchObject({ id: event.id, from: "shlok", lead, to: grandchild.id });
    expect(directivesNotice([delivered as NonNullable<typeof delivered>])).toContain(
      `Directive from ${lead}, the lead shlok put over this Agent`,
    );

    const stopped = await post(`${agentPath(child.id)}/stop`, "shlok", {}, lead);
    expect(stopped.status).toBe(200);
    const stop = await waitFor(() => studio.frames.find((f) => f.type === "host.stop") as HostStopMessage | undefined);
    expect(stop).toEqual({ type: "host.stop", agent: child.id });
    expect((await events()).find((e) => e.type === "agent.stop")).toMatchObject({
      actor: { kind: "agent", agentId: lead },
      payload: { agent: child.id, host: "shlok/studio" },
    });
  });

  it("is capped per Channel, counting the Agents in its subtree that are not Gone and its spawns still starting", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    const lead = await aLead("shlok");
    await leadSpawns(studio, lead);
    // The second is still starting when the third is asked for.
    const second = post("/api/agents/spawn", "shlok", { cli: "claude-code", cwd: "/work/app" }, lead);
    await studio.nextSpawn();
    const third = await post("/api/agents/spawn", "shlok", { cli: "claude-code", cwd: "/work/app" }, lead);
    expect(third.status).toBe(409);
    expect(await reason(third)).toContain("LEAD_AGENTS_LIVE_CAP");
    expect((await second).status).toBe(202);
    // The Person is not held to the lead's cap, only to the Channel's.
    expect((await spawnAndStart(studio)).response.status).toBe(201);
  });

  it("is refused again once its Person revokes the role, while its Agents keep running and their parent", async () => {
    const studio = await FakeHost.registered("shlok", "studio");
    await studio.connect();
    const lead = await aLead("shlok");
    const { agent: child } = await leadSpawns(studio, lead);
    expect((await revoke("shlok", lead)).status).toBe(200);

    expect((await direct("shlok", child.id, "Keep going.", lead)).status).toBe(403);
    expect((await post(`${agentPath(child.id)}/stop`, "shlok", {}, lead)).status).toBe(403);
    expect((await post("/api/agents/spawn", "shlok", { cli: "claude-code", cwd: "/work/app" }, lead)).status).toBe(403);
    const { agents } = await (await call("/api/agents", "shlok")).json<AgentsResponse>();
    expect(agents.find((a) => a.id === child.id)).toMatchObject({ presence: "live", parent: lead });
  });
});
