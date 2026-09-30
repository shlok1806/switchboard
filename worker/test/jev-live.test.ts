// Opt-in: asks the real Jev once, through the Relay, about a breaking rename in a
// file the receiving Agent touches. Runs only when JEV_API_KEY is set, for example
// `JEV_API_KEY=$(security find-generic-password -a "$USER" -s switchboard-jev-api-key -w) npm test`.

import { env, reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, AgentResponse, ChannelEvent, HistoryResponse, VerdictOption } from "../../shared/src/index";
import { HttpJev, installJev } from "../src/relay/jev";
import { bearer, forgetTokens, remember, streamQuery, url } from "./client";

async function post(path: string, person: string, body: unknown): Promise<Response> {
  const headers = { Authorization: await bearer(person), "Content-Type": "application/json" };
  return exports.default.fetch(new Request(url(path), { method: "POST", headers, body: JSON.stringify(body) }));
}

async function stream(person: string, agent: AgentId): Promise<WebSocket | null> {
  const query = await streamQuery({ person, agent });
  return (await exports.default.fetch(new Request(url(`/api/stream?${query}`), { headers: { Upgrade: "websocket" } })))
    .webSocket;
}

afterEach(async () => {
  forgetTokens();
  installJev(null);
  await reset();
});

describe.skipIf(!env.JEV_API_KEY)("the real Jev", () => {
  it("gives a Verdict with a probability for each option", async () => {
    installJev(new HttpJev(env.JEV_API_KEY));
    const register = async (person: string, sessionId: string) =>
      remember(
        await (
          await post("/api/agents", person, { cli: "claude-code", sessionId, resumed: false, cwd: "/r" })
        ).json<AgentResponse>(),
      ).agent.id;
    const alice = await register("alice", "a1100000-0000-4000-8000-000000000000");
    const bob = await register("bob", "b0b00000-0000-4000-8000-000000000000");

    // Alice edits the file Bob then edits too: the Relay asks Jev.
    const socket = await stream("alice", alice);
    socket?.accept();
    socket?.send(
      JSON.stringify({
        type: "hook",
        agent: alice,
        events: [
          {
            id: crypto.randomUUID(),
            type: "file.edit",
            payload: { path: "web/api/client.ts", additions: 4, deletions: 1 },
          },
        ],
      }),
    );
    const bobSocket = await stream("bob", bob);
    bobSocket?.accept();
    const edit = crypto.randomUUID();
    await new Promise((resolve) => setTimeout(resolve, 100));
    bobSocket?.send(
      JSON.stringify({
        type: "hook",
        agent: bob,
        events: [{ id: edit, type: "file.edit", payload: { path: "web/api/client.ts", additions: 40, deletions: 30 } }],
      }),
    );

    const deadline = Date.now() + 15_000;
    let verdict: Extract<ChannelEvent, { type: "verdict" }>["payload"] | undefined;
    while (verdict === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const response = await exports.default.fetch(
        new Request(url("/api/events"), { headers: { Authorization: await bearer("t") } }),
      );
      const events = (await response.json<HistoryResponse>()).events;
      verdict = events.find(
        (e): e is Extract<ChannelEvent, { type: "verdict" }> => e.type === "verdict" && e.payload.event === edit,
      )?.payload;
    }
    socket?.close();
    bobSocket?.close();

    expect(verdict).toMatchObject({ agent: alice, source: "jev", overlap: { files: ["web/api/client.ts"] } });
    const p = verdict?.probabilities;
    if (!p) throw new Error("No probabilities");
    for (const option of ["drop", "queue", "interrupt"] as VerdictOption[]) {
      expect(p[option]).toBeGreaterThanOrEqual(0);
      expect(p[option]).toBeLessThanOrEqual(1);
    }
    expect(p.drop + p.queue + p.interrupt).toBeCloseTo(1, 1);
    console.log(`Jev on an overlapping edit: ${JSON.stringify(p)} in ${verdict?.latencyMs} ms`);
  }, 30_000);
});
