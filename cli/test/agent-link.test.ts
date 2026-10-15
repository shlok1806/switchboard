// The AgentLink keeps one Agent registered for its session. These drive it against a
// Channel whose answers the test releases by hand, to put a heartbeat exactly where
// a real one can land: while the first registration is still on the wire.

import { describe, expect, it } from "vitest";
import type { Agent, AgentId, AgentResponse, RegisterAgentRequest } from "../../shared/src/index";
import { AgentLink } from "../src/agent-link";
import type { ChannelClient } from "../src/channel-client";
import { ChannelError } from "../src/channel-client";

const AGENT: Agent = {
  id: "shlok/claude/7f3a" as AgentId,
  person: "shlok",
  cli: "claude-code",
  presence: "live",
  proxyMode: "digest",
  secretMasking: true,
  canReceiveInterrupts: true,
  lastSeenAt: "2026-10-15T00:00:00Z",
  startedAt: "2026-10-15T00:00:00Z",
};

const SESSION = {
  cli: "claude-code" as const,
  sessionId: "7f3a0000-0000-4000-8000-000000000000",
  resumed: false,
  cwd: "/r",
};

/** A Channel that holds each registration's answer until the test releases it. */
function slowChannel() {
  const registers: RegisterAgentRequest[] = [];
  const heartbeats: string[] = [];
  const pending: (() => void)[] = [];
  const client = {
    register: (request: RegisterAgentRequest): Promise<AgentResponse> => {
      registers.push(request);
      return new Promise((resolve) => pending.push(() => resolve({ ok: true, agent: AGENT, token: "t" })));
    },
    heartbeat: async (_id: AgentId, presence: string): Promise<AgentResponse> => {
      heartbeats.push(presence);
      return { ok: true, agent: AGENT };
    },
  } as unknown as ChannelClient;
  return { client, registers, heartbeats, release: () => pending.shift()?.() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("AgentLink", () => {
  it("registers once when a usage reading or a Presence change comes while the registration is answered", async () => {
    const channel = slowChannel();
    const link = new AgentLink(channel.client, SESSION, 60_000, () => {});
    const registered = link.register();
    // Claude Code wrote its first usage before the Channel answered, and went idle.
    link.reportUsage({ account: "work", windows: [] } as never);
    link.report("idle");
    await settle();
    expect(channel.registers).toHaveLength(1);

    channel.release();
    await registered;
    await settle();
    // One start for the session; what came meanwhile goes as heartbeats of the Agent it registered.
    expect(channel.registers.map((r) => r.rejoin)).toEqual([undefined]);
    expect(channel.heartbeats).toEqual(["idle", "idle"]);
  });
});

describe("AgentLink.registerPicked", () => {
  /** A Channel where another of the Person's sessions holds the Agent IDs of `taken` session IDs. */
  function channel(taken: string[]) {
    const sessions: string[] = [];
    const client = {
      register: async (request: RegisterAgentRequest): Promise<AgentResponse> => {
        sessions.push(request.sessionId);
        if (taken.some((id) => id.slice(0, 4) === request.sessionId.slice(0, 4))) {
          throw new ChannelError(409, "Agent ID shlok/claude/7f3a already belongs to another of your sessions.");
        }
        return {
          ok: true,
          agent: { ...AGENT, id: `shlok/claude/${request.sessionId.slice(0, 4)}` as AgentId },
          token: "t",
        };
      },
    } as unknown as ChannelClient;
    return { client, sessions };
  }

  it("picks another session ID while the Agent ID is another session's, and registers with it", async () => {
    const { client, sessions } = channel([
      "7f3a1111-0000-4000-8000-000000000000",
      "7f3b1111-0000-4000-8000-000000000000",
    ]);
    const picks = ["7f3b0000-0000-4000-8000-000000000000", "0c1d0000-0000-4000-8000-000000000000"];
    const link = new AgentLink(client, SESSION, 60_000, () => {});
    const agent = await link.registerPicked(() => picks.shift() ?? "");
    expect(sessions).toEqual([
      SESSION.sessionId,
      "7f3b0000-0000-4000-8000-000000000000",
      "0c1d0000-0000-4000-8000-000000000000",
    ]);
    expect(agent.id).toBe("shlok/claude/0c1d");
    expect(link.sessionId).toBe("0c1d0000-0000-4000-8000-000000000000");
  });

  it("gives up after five session IDs, and never picks again for any other refusal", async () => {
    const all = channel(["7f3a"]);
    const always = new AgentLink(all.client, SESSION, 60_000, () => {});
    await expect(always.registerPicked(() => "7f3a9999-0000-4000-8000-000000000000")).rejects.toThrow(
      /already belongs/,
    );
    expect(all.sessions).toHaveLength(5);

    const refusing = {
      register: async (): Promise<AgentResponse> => {
        throw new ChannelError(403, "Not a collaborator");
      },
    } as unknown as ChannelClient;
    const picks: string[] = [];
    const link = new AgentLink(refusing, SESSION, 60_000, () => {});
    await expect(
      link.registerPicked(() => {
        picks.push("x");
        return "x";
      }),
    ).rejects.toThrow(/Not a collaborator/);
    expect(picks).toEqual([]);
    expect(link.sessionId).toBe(SESSION.sessionId);
  });
});
