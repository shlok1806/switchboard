import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentId } from "../../shared/src/index";
import { ChannelClient } from "../src/channel-client";
import { SwitchboardTools } from "../src/mcp-server";
import { authenticateNative, principalSelection, readRedemptionCode, redeemExecution } from "../src/principal-config";

const sockets = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock("../src/channel-socket", () => ({
  openSocket: sockets.open,
  closeSocket: sockets.close,
  dropSocket: vi.fn(),
  WebSocket: { OPEN: 1 },
}));
const org = "11111111-1111-4111-8111-111111111111";
const principalId = `${org}:22222222-2222-4222-8222-222222222222`;
const workspaceId = `${org}:33333333-3333-4333-8333-333333333333`;
const executionId = `${org}:44444444-4444-4444-8444-444444444444`;
const freshExecutionId = `${org}:66666666-6666-4666-8666-666666666666`;
const credential = `m1.${org}.55555555-5555-4555-8555-555555555555.${"a".repeat(43)}`;
const origin = "https://switchboard.test";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  sockets.open.mockReset();
  sockets.close.mockReset();
});
describe("managed execution CLI", () => {
  it("redeems as the bound Person retries expired codes within a fixed bound and keeps secrets out of URLs and output", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: "CODE_EXPIRED" } }, { status: 410 }))
      .mockResolvedValueOnce(
        Response.json({ value: { execution: { id: freshExecutionId, principalId, workspaceId }, secret: credential } }),
      );
    vi.stubGlobal("fetch", fetcher);
    const log = vi.spyOn(console, "error");
    const options = {
      origin,
      selection: principalSelection(principalId, workspaceId),
      executionId,
      authenticate: vi.fn(async () => "fresh-native-person"),
      readCode: vi.fn(async () => "planted-code"),
      refreshExecution: vi.fn(async () => freshExecutionId),
    };
    expect((await redeemExecution(options)).credential).toBe(credential);
    expect(options.authenticate).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).not.toContain("planted-code");
      expect(url).not.toContain(credential);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fresh-native-person");
      expect(init?.redirect).toBe("error");
    }
    expect(log).not.toHaveBeenCalled();
    fetcher
      .mockReset()
      .mockImplementation(async () => Response.json({ error: { code: "CODE_EXPIRED" } }, { status: 410 }));
    await expect(redeemExecution(options)).rejects.toThrow("fresh code");
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher
      .mockReset()
      .mockResolvedValue(Response.json({ error: { code: "CODE_USED", reason: credential } }, { status: 409 }));
    await expect(redeemExecution(options)).rejects.toThrow("Execution redemption denied.");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses scoped bearer HTTP denies managed streaming and preserves legacy registration and streaming", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    const client = new ChannelClient({ url: origin, repo: "owner/repo", credential });
    await client.request("/api/agents");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(`Bearer ${credential}`);
    expect(fetcher.mock.calls[0]?.[0]).not.toContain(credential);
    expect(() =>
      client.follow(
        () => {},
        () => {},
      ),
    ).toThrow("closed until P3");
    fetcher.mockImplementation(async () => Response.json({ reason: credential }, { status: 403 }));
    await expect(client.request("/api/agents")).rejects.toThrow("Managed request denied.");
    const legacy = new ChannelClient({ url: origin, repo: "owner/repo", credential: "legacy-person" });
    const idleStream = legacy.follow(
      () => {},
      () => {},
    );
    idleStream.close();
    expect(sockets.open).not.toHaveBeenCalled();
    fetcher.mockImplementation(async () => Response.json({ ok: true, token: "legacy-agent" }));
    await legacy.register({ cli: "codex", sessionId: "12345678", resumed: false, cwd: "/repo" });
    await legacy.request("/api/agents");
    vi.useFakeTimers();
    sockets.open.mockReturnValue({ addEventListener: vi.fn(), readyState: 1, send: vi.fn() });
    const stream = legacy.follow(
      () => {},
      () => {},
    );
    expect(sockets.open.mock.calls[0]?.[0]).toContain("token=legacy-agent");
    legacy.useAgentToken(credential);
    await vi.runOnlyPendingTimersAsync();
    expect(sockets.open).toHaveBeenCalledTimes(1);
    expect(sockets.close).toHaveBeenCalledTimes(1);
    stream.close();
    expect(new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBe("Bearer legacy-agent");
  });
  it("uses scoped bearer headers and redacted failures in the stdio tool layer", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ reason: credential }, { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new ChannelClient({ url: origin, repo: "owner/repo", credential: "" });
    const tools = new SwitchboardTools(client, async () => ({ id: "alice/codex/9012" as AgentId, token: credential }), {
      dir: "/repo",
      repo: "owner/repo",
      url: origin,
    });
    const result = await tools.listAgents();
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Managed request denied.");
    expect(fetcher.mock.calls.length).toBeGreaterThan(0);
    for (const [url, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${credential}`);
      expect(url).not.toContain(credential);
      expect(String(init?.body ?? "")).not.toContain(credential);
    }
    expect(JSON.stringify(errors.mock.calls)).not.toContain(credential);
  });
  it("rejects legacy fallback after explicit managed registration intent", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, token: "legacy-agent" }));
    vi.stubGlobal("fetch", fetcher);
    const client = new ChannelClient({ url: origin, repo: "owner/repo", credential: "native-person" });
    await expect(
      client.register({
        cli: "codex",
        sessionId: "12345678",
        resumed: false,
        cwd: "/repo",
        managed: { principalId, workspaceId },
      }),
    ).rejects.toThrow("Managed registration denied.");
    await expect(client.request("/api/agents")).rejects.toThrow("Managed credential required.");
    expect(() =>
      client.follow(
        () => {},
        () => {},
      ),
    ).toThrow("closed until P3");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sockets.open).not.toHaveBeenCalled();
  });
  it("authenticates through the native device flow without a legacy session or Channel join", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          deviceCode: "native-device-state",
          userCode: "SIGNIN",
          verificationUri: "https://github.test/device",
          interval: 1,
          expiresIn: 60,
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, destination: "native", session: "native-session-marker" }));
    vi.stubGlobal("fetch", fetcher);
    const say = vi.fn();
    const pending = authenticateNative(origin, say);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe("native-session-marker");
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      `${origin}/auth/device/code?destination=native`,
      `${origin}/auth/device/token`,
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      deviceCode: "native-device-state",
      destination: "native",
    });
    expect(JSON.stringify(say.mock.calls)).not.toContain("native-session-marker");
  });
  it("reads redemption codes without echo and restores terminal input", async () => {
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
    const output = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pending = readRedemptionCode();
    input.emit("data", Buffer.from("planted-redemption-code\r"));
    expect(await pending).toBe("planted-redemption-code");
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.pause).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(output.mock.calls)).not.toContain("planted-redemption-code");
    expect(input.listenerCount("data")).toBe(0);
  });
});
