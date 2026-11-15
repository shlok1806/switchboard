import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ChannelAuthorization } from "../src/organization";
import { bareChannel } from "./managed-helpers";

// Exercise the real Channel facade with a controllable authority. No identity or
// credential data is persisted: synthetic tokens are consumed only by this stub.
for (const family of ["memory", "skill-files"] as const) {
  const operation = family === "memory" ? "memory.read" : "skill-files.read";
  const action = family === "memory" ? "channel.history.read" : "channel.update.read";
  function fixture(authorize: (call: number, input: ChannelAuthorization) => Promise<boolean>) {
    const repo = "shlok1806/other";
    const organizationId = crypto.randomUUID();
    const workspace = `${organizationId}:${crypto.randomUUID()}`;
    const binding = { version: 1, generation: 1, workspace, operation: "binding", state: "linked" };
    const channel = bareChannel(binding);
    let calls = 0;
    let reads = 0;
    Object.assign(channel, {
      ctx: { id: env.CHANNEL.idFromName(repo) },
      env: {
        CHANNEL: env.CHANNEL,
        ORGANIZATION: {
          getByName: () => ({
            authorizeChannelRead: async (input: ChannelAuthorization) => {
              expect(input.action).toBe(action);
              expect(input.resource).toMatchObject({ organizationId, id: workspace, targetId: family, operation });
              const ok = await authorize(++calls, input);
              return ok ? { ok: true, value: {}, policyRevision: 1 } : { ok: false, status: 403, policyRevision: 1 };
            },
          }),
        },
      },
      agents: { list: () => [] },
      memory: {
        read: () => {
          reads++;
          return { ok: true, notes: [{ text: "private bytes" }] };
        },
      },
      skills: {
        readChunks: () => {
          reads++;
          return { ok: true, value: [{ digest: "a".repeat(64), index: 0, data: new Uint8Array([1]) }] };
        },
      },
    });
    const request = () =>
      channel.managedRequest(
        new Request(`https://switchboard.test/r/${repo}/api/${family === "memory" ? "memory" : "skill-files/read"}`, {
          method: family === "memory" ? "GET" : "POST",
          headers: { Authorization: "Bearer m1.synthetic-authority-stub" },
          ...(family === "skill-files"
            ? { body: JSON.stringify({ chunks: [{ digest: "a".repeat(64), index: 0 }] }) }
            : {}),
        }),
        repo,
      );
    return { channel, request, reads: () => reads, calls: () => calls, binding };
  }
  describe(`S2b ${family} authorization boundaries`, () => {
    it("does not read content before admission", async () => {
      const f = fixture(async () => false);
      const response = await f.request();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, reason: "resource_denied" });
      expect(f.reads()).toBe(0);
    });
    it("discards prepared content on release denial and does not cache admission", async () => {
      const f = fixture(async (call) => call === 1);
      expect((await f.request()).status).toBe(404);
      expect(f.reads()).toBe(1);
      expect((await f.request()).status).toBe(404);
      expect(f.reads()).toBe(1);
      expect(f.calls()).toBe(3);
    });
    it("redacts authority failure before admission and at release", async () => {
      for (const failAt of [1, 2]) {
        const f = fixture(async (call) => {
          if (call === failAt) throw new Error("private authority marker");
          return true;
        });
        const response = await f.request();
        expect(response.status).toBe(503);
        const body = await response.text();
        expect(body).not.toContain("private");
        expect(f.reads()).toBe(failAt - 1);
      }
    });
    it("bounds a hung authority at admission and release without exposing content", async () => {
      vi.useFakeTimers();
      try {
        for (const hangAt of [1, 2]) {
          const f = fixture(async (call) => (call === hangAt ? new Promise<boolean>(() => {}) : true));
          const pending = f.request();
          // Request-body parsing can yield before the release RPC starts.
          await vi.advanceTimersByTimeAsync(0);
          await vi.advanceTimersByTimeAsync(2000);
          const response = await pending;
          expect(response.status).toBe(503);
          expect(await response.json()).toEqual({ ok: false, reason: "authority_unavailable" });
          expect(f.reads()).toBe(hangAt - 1);
        }
      } finally {
        vi.useRealTimers();
      }
    });
    it("checks generation immediately after the authority await", async () => {
      const f = fixture(async () => {
        Object.assign(f.channel, { binding: { ...f.binding, generation: 2 } });
        return true;
      });
      expect((await f.request()).status).toBe(404);
      expect(f.reads()).toBe(0);
    });
  });
}
