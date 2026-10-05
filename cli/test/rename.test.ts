// Naming the Agent `switchboard rename` acts on (ADR 0009), and the wrapper keeping
// the Channel's Nickname when it registers its Agent again.

import { describe, expect, it } from "vitest";
import type { Agent, AgentId, AgentResponse, RegisterAgentRequest } from "../../shared/src/index";
import { AgentLink } from "../src/agent-link";
import type { ChannelClient } from "../src/channel-client";
import { ChannelError } from "../src/channel-client";
import { matchAgents } from "../src/rename";

function agent(id: string, nickname?: string): Agent {
  return {
    id: id as AgentId,
    person: id.split("/")[0] ?? "",
    cli: "claude-code",
    ...(nickname === undefined ? {} : { nickname }),
    presence: "live",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: true,
    lastSeenAt: "2026-10-04T00:00:00Z",
    startedAt: "2026-10-04T00:00:00Z",
  };
}

describe("matchAgents", () => {
  const all = [agent("shlok/claude/7f3a", "scout-a"), agent("ana/claude/7f3a", "scout-b"), agent("shlok/codex/1b2c")];

  it("finds an Agent by its ID, its ID without the Person, or its Nickname in any case", () => {
    expect(matchAgents(all, "shlok/claude/7f3a").map((a) => a.id)).toEqual(["shlok/claude/7f3a"]);
    expect(matchAgents(all, "codex/1b2c").map((a) => a.id)).toEqual(["shlok/codex/1b2c"]);
    expect(matchAgents(all, " Scout-B ").map((a) => a.id)).toEqual(["ana/claude/7f3a"]);
  });

  it("returns every Agent a short ID could be, and none for an unknown name", () => {
    expect(matchAgents(all, "claude/7f3a")).toHaveLength(2);
    expect(matchAgents(all, "ranger")).toEqual([]);
  });
});

describe("AgentLink", () => {
  /** A Channel that answers registrations and heartbeats with its own idea of the Agent. */
  function channel(state: { agent: Agent; forget: boolean }, sent: RegisterAgentRequest[]): ChannelClient {
    return {
      register: async (request: RegisterAgentRequest): Promise<AgentResponse> => {
        sent.push(request);
        state.forget = false;
        return { ok: true, agent: state.agent, token: "t" };
      },
      heartbeat: async (): Promise<AgentResponse> => {
        if (state.forget) throw new ChannelError(401, "revoked");
        return { ok: true, agent: state.agent };
      },
    } as unknown as ChannelClient;
  }

  it("registers again with the Nickname the Channel last gave, not the one it started with", async () => {
    const sent: RegisterAgentRequest[] = [];
    const state = { agent: agent("shlok/claude/7f3a", "scout"), forget: false };
    const session = { cli: "claude-code" as const, sessionId: "7f3a-1", resumed: false, cwd: "/repo" };
    const link = new AgentLink(channel(state, sent), { ...session, nickname: "scout", account: "work" }, 10, () => {});
    await link.register();

    // Renamed on the Dashboard; the wrapper hears it on the stream.
    state.agent = agent("shlok/claude/7f3a", "scout-a");
    link.agentChanged(state.agent);
    // Its token is revoked: it registers again.
    state.forget = true;
    link.report("live");
    for (let i = 0; i < 50 && sent.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent.map((r) => [r.nickname, r.account, r.rejoin])).toEqual([
      ["scout", "work", undefined],
      ["scout-a", "work", true],
    ]);
  });
});
