// read_channel pages back past the Relay's Verdicts, which are most of a Channel's
// Events, until it has the Events an Agent asked for.

import { describe, expect, it } from "vitest";
import type { AgentId, ChannelEvent } from "../../shared/src/index";
import type { ChannelClient } from "../src/channel-client";
import { SwitchboardTools } from "../src/mcp-server";

const AGENT = "shlok/claude/7f3a" as AgentId;

function event(seq: number, type: "verdict" | "update"): ChannelEvent {
  return {
    id: `e${seq}`,
    seq,
    at: new Date(Date.UTC(2026, 9, 15, 0, 0, seq)).toISOString(),
    type,
    actor: type === "verdict" ? { kind: "relay" } : { kind: "person", person: "nate" },
    capture: null,
    payload:
      type === "verdict"
        ? { event: `e${seq - 1}`, agent: AGENT, at: "", delivered: "drop", overlap: [] }
        : { text: `Update ${seq}` },
  } as unknown as ChannelEvent;
}

describe("read_channel", () => {
  it("reads an older page when the newest is all Verdicts, and returns the latest Events asked for", async () => {
    // Seq 1-75 are Updates; 76-100 are Verdicts.
    const all = Array.from({ length: 100 }, (_, i) => event(i + 1, i < 75 ? "update" : "verdict"));
    const asked: string[] = [];
    const client = {
      useAgentToken() {},
      async request(path: string) {
        asked.push(path);
        if (path.startsWith("/api/events?")) {
          const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
          const tail = Number(query.get("tail"));
          const before = Number(query.get("before") ?? Number.MAX_SAFE_INTEGER);
          return { events: all.filter((e) => e.seq < before).slice(-tail), cursor: 0 };
        }
        if (path === "/api/agents") return { agents: [] };
        return {};
      },
    } as unknown as ChannelClient;
    const tools = new SwitchboardTools(client, async () => ({ id: AGENT, token: "t" }), { dir: "/w", repo: "o/r" });

    const { text, isError } = await tools.readChannel(5);
    expect(isError).toBe(false);
    expect(asked.filter((p) => p.startsWith("/api/events"))).toEqual([
      "/api/events?tail=25",
      "/api/events?tail=25&before=76",
    ]);
    for (const n of [71, 72, 73, 74, 75]) expect(text).toContain(`Update ${n}`);
    expect(text).not.toContain("Update 70");
  });
});
