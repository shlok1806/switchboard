// The Proxy Capture's local proxy in front of a fake Responses API (Codex) and a
// fake Gemini API. Observed the way the agent CLI sees it (the bytes it gets back,
// over HTTP and over a WebSocket) and the way the Channel sees it (the frames the
// wrapper sends).

import { createServer, type IncomingHttpHeaders, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, ProxyCaptureMessage, ProxyEvent } from "../../shared/src/index";
import type { ApiFormat } from "../src/proxy/api";
import { ProxyCapture } from "../src/proxy/capture";
import { geminiGenerateContent } from "../src/proxy/gemini";
import { openaiResponses } from "../src/proxy/openai-responses";
import { CODE_ASSIST_SSE, GEMINI_SSE, RESPONSES_JSON, RESPONSES_SSE, RESPONSES_TURN } from "./fixtures/api-shapes";
import { connect } from "./fixtures/ws-client.mjs";
import { acceptWebSockets, type WsConnection } from "./fixtures/ws-upstream";

const CHATGPT_TOKEN = "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlc2lnbmF0dXJl";
const GEMINI_KEY = "AIzaSyD-NEVERleaveTHElaptop0123456789";

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer };

let upstream: Server;
let upstreamUrl = "";
const seen: Seen[] = [];
const sockets: WsConnection[] = [];
let respond: (req: Seen, res: ServerResponse) => void;
let onSocket: (ws: WsConnection) => void = () => {};
let capture: ProxyCapture | null = null;
let frames: ProxyCaptureMessage[] = [];
const logs: string[] = [];

const AGENT: Agent = {
  id: "e2e/codex/abcd",
  person: "e2e",
  cli: "codex",
  presence: "live",
  proxyMode: "digest",
  secretMasking: true,
  canReceiveInterrupts: true,
  lastSeenAt: "",
  startedAt: "",
};

async function startCapture(api: ApiFormat, mode: "digest" | "raw" = "digest", base = upstreamUrl) {
  frames = [];
  capture = await ProxyCapture.start({
    upstream: base,
    api,
    mode,
    mask: true,
    root: "/repo",
    send: (frame) => {
      frames.push(JSON.parse(frame) as ProxyCaptureMessage);
      return true;
    },
    log: (line) => logs.push(line),
  });
  capture.setAgent({ ...AGENT, proxyMode: mode });
  return capture;
}

async function waitForFrames(n: number): Promise<ProxyEvent[]> {
  const deadline = Date.now() + 3000;
  while (frames.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return frames.map((f) => f.event);
}

function call(base: string, path: string, headers: Record<string, string>, body: string | Buffer) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request(new URL(path, base), { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

beforeEach(async () => {
  seen.length = 0;
  sockets.length = 0;
  logs.length = 0;
  onSocket = () => {};
  upstream = createServer((req, res) => {
    const body: Buffer[] = [];
    req.on("data", (c: Buffer) => body.push(c));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(body) };
      seen.push(entry);
      respond(entry, res);
    });
  });
  acceptWebSockets(upstream, (ws) => {
    sockets.push(ws);
    onSocket(ws);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await capture?.close();
  capture = null;
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

const DIGEST = {
  model: "gpt-6-sol",
  inputTokens: 221,
  outputTokens: 101,
  cacheReadTokens: 30208,
  cacheCreationTokens: 0,
  reply: "Running the tests. Key is sk-proj-****",
  toolCalls: [
    { name: "exec", arg: "npm test" },
    { name: "shell", arg: "export GITHUB_TOKEN=ghp_****" },
    { name: "apply_patch", arg: "src/app.ts" },
  ],
  maskedSecrets: 2,
};

describe("the Proxy Capture in front of the Responses API (Codex)", () => {
  /** Opens a WebSocket to the proxy the way Codex does, and collects what comes back. */
  async function openSocket(base: string) {
    const ws = await connect(`${base.replace(/^http/, "ws")}/responses`, {
      authorization: CHATGPT_TOKEN,
      "chatgpt-account-id": "acct_1",
    });
    return { ws, received: ws.messages };
  }

  it("tunnels a WebSocket turn unchanged, compressed, and sends its Proxy Digest", async () => {
    onSocket = (ws) => {
      ws.onMessage = (text) => {
        const message = JSON.parse(text) as { type: string; generate?: boolean };
        if (message.type !== "response.create") return;
        // A warm-up gets a short answer; a real turn gets every event, some split into fragments.
        const events =
          message.generate === false ? RESPONSES_TURN.slice(0, 1).concat(RESPONSES_TURN.slice(-1)) : RESPONSES_TURN;
        events.forEach((e, i) => void ws.send(JSON.stringify(e), i % 3 === 0 ? 3 : 1));
      };
    };
    const proxy = await startCapture(openaiResponses);
    const { ws, received } = await openSocket(proxy.url);

    const warmup = JSON.stringify({ type: "response.create", model: "gpt-6-sol", generate: false });
    await ws.send(warmup);
    await waitFor(() => received.length === 2);
    const turn = JSON.stringify({
      type: "response.create",
      model: "gpt-6-sol",
      input: [{ role: "user", content: "go" }],
    });
    await ws.send(turn);
    await waitFor(() => received.length === 2 + RESPONSES_TURN.length);

    // The CLI got exactly what the API sent, and the API exactly what the CLI sent, auth included.
    expect(received.slice(2)).toEqual(RESPONSES_TURN.map((e) => JSON.stringify(e)));
    const [upstreamSocket] = sockets;
    expect(upstreamSocket?.deflate).toBe(true);
    expect(upstreamSocket?.messages).toEqual([warmup, turn]);
    expect(upstreamSocket?.path).toBe("/responses");
    expect(upstreamSocket?.headers.authorization).toBe(CHATGPT_TOKEN);
    expect(upstreamSocket?.headers["chatgpt-account-id"]).toBe("acct_1");
    expect(upstreamSocket?.headers.host).toBe(new URL(upstreamUrl).host);

    // One Digest: the warm-up is not a turn.
    const events = await waitForFrames(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "proxy.digest", payload: DIGEST });
    expect(JSON.stringify(frames)).not.toContain("c2lnbmF0dXJl");
    ws.close();
  });

  it("reads a turn over a WebSocket without compression, and a raw one with its request", async () => {
    upstream.removeAllListeners("upgrade");
    acceptWebSockets(
      upstream,
      (ws) => {
        sockets.push(ws);
        ws.onMessage = () => {
          for (const e of RESPONSES_TURN) void ws.send(JSON.stringify(e));
        };
      },
      { deflate: false },
    );
    const proxy = await startCapture(openaiResponses, "raw");
    const { ws, received } = await openSocket(proxy.url);
    await ws.send(
      JSON.stringify({ type: "response.create", input: "OPENAI_API_KEY=sk-Tq8Zx3Lm9Vn2Bc7Kd4Hf1Js6Pw0Rt5Yg" }),
    );
    await waitFor(() => received.length === RESPONSES_TURN.length);
    expect(sockets[0]?.deflate).toBe(false);
    const [event] = await waitForFrames(1);
    if (event?.type !== "proxy.raw") throw new Error("expected a Raw Proxy Event");
    expect(event.payload).toMatchObject({ model: "gpt-6-sol", reply: DIGEST.reply });
    expect(event.payload.context).toContain('"type":"response.create"');
    expect(event.payload.context).not.toContain("Tq8Zx3Lm9Vn2Bc7Kd4Hf1Js6Pw0Rt5Yg");
    expect(event.payload.response).toContain('"type":"response.completed"');
    expect(event.payload.response).not.toContain("LEAKEDinREPLY");
    ws.close();
  });

  it("passes a refused upgrade through, so Codex falls back to HTTP", async () => {
    upstream.removeAllListeners("upgrade");
    upstream.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 426 Upgrade Required\r\ncontent-type: text/plain\r\ncontent-length: 4\r\n\r\nnope");
    });
    const proxy = await startCapture(openaiResponses);
    await expect(connect(`${proxy.url.replace(/^http/, "ws")}/responses`)).rejects.toThrow("WebSocket refused: 426");
  });

  it("passes an SSE turn through byte for byte, reading a zstd request in raw mode", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_1" });
      const bytes = Buffer.from(RESPONSES_SSE);
      for (let i = 0; i < bytes.length; i += 500) res.write(bytes.subarray(i, i + 500));
      res.end();
    };
    const proxy = await startCapture(openaiResponses, "raw");
    const json = JSON.stringify({
      model: "gpt-6-sol",
      stream: true,
      input: "token ghp_1234567890abcdefghijABCDEFGHIJ123456",
    });
    const body = zstdCompressSync(Buffer.from(json));
    const answer = await call(
      proxy.url,
      "/responses",
      { "content-type": "application/json", "content-encoding": "zstd", authorization: CHATGPT_TOKEN },
      body,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.toString("utf8")).toBe(RESPONSES_SSE);
    expect(answer.headers["x-request-id"]).toBe("req_1");
    // The API got the compressed bytes, as sent.
    expect(seen[0]?.body.equals(body)).toBe(true);
    expect(seen[0]?.headers.authorization).toBe(CHATGPT_TOKEN);

    const [event] = await waitForFrames(1);
    if (event?.type !== "proxy.raw") throw new Error("expected a Raw Proxy Event");
    expect(event.payload).toMatchObject({ model: "gpt-6-sol", toolCalls: DIGEST.toolCalls });
    expect(event.payload.context).toContain('"model":"gpt-6-sol"');
    expect(event.payload.context).toContain("ghp_****");
  });

  // The turn finishes only once its request is read: an upstream that answers before the
  // request body arrives, or before it is decoded, still leaves the body in the Event.
  for (const [encoding, compress] of [
    ["zstd", zstdCompressSync],
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
    ["identity", (b: Buffer) => b],
  ] as const) {
    it(`reads a ${encoding} request whole even when the API answers before it arrives`, async () => {
      const early = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(RESPONSES_SSE);
      });
      await new Promise<void>((resolve) => early.listen(0, "127.0.0.1", resolve));
      try {
        const proxy = await startCapture(
          openaiResponses,
          "raw",
          `http://127.0.0.1:${(early.address() as AddressInfo).port}`,
        );
        const body = compress(Buffer.from(JSON.stringify({ model: "gpt-6-sol", stream: true, input: "hi" })));
        await new Promise<void>((resolve, reject) => {
          const req = request(
            new URL("/responses", proxy.url),
            {
              method: "POST",
              headers: { "content-type": "application/json", "content-encoding": encoding },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve());
            },
          );
          req.on("error", reject);
          // The first bytes reach the API, which answers at once; the rest comes after the answer has.
          const half = Math.floor(body.length / 2);
          req.write(body.subarray(0, half));
          setTimeout(() => req.end(body.subarray(half)), 300);
        });
        const [event] = await waitForFrames(1);
        if (event?.type !== "proxy.raw") throw new Error("expected a Raw Proxy Event");
        expect(event.payload.context).toBe(JSON.stringify({ model: "gpt-6-sol", stream: true, input: "hi" }));
      } finally {
        early.closeAllConnections();
        await new Promise((resolve) => early.close(resolve));
      }
    });
  }

  it("keeps the upstream's path prefix (the ChatGPT backend's /backend-api/codex)", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(RESPONSES_JSON));
    };
    const proxy = await startCapture(openaiResponses, "digest", `${upstreamUrl}/backend-api/codex`);
    await call(proxy.url, "/responses", { "content-type": "application/json" }, "{}");
    expect(seen[0]?.url).toBe("/backend-api/codex/responses");
    const [event] = await waitForFrames(1);
    expect(event).toMatchObject({
      type: "proxy.digest",
      payload: { model: "gpt-5.5-codex", cacheCreationTokens: 150 },
    });
  });

  it("sends nothing for requests that are not turns, or turns the API refused", async () => {
    respond = (req, res) => {
      if (req.url.startsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"models":[]}');
        return;
      }
      res.writeHead(429, { "content-type": "application/json" });
      res.end('{"error":{"message":"usage limit"}}');
    };
    const proxy = await startCapture(openaiResponses);
    const models = await new Promise<number>((resolve) => {
      request(new URL("/models?client_version=0.159.1", proxy.url), (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }).end();
    });
    expect(models).toBe(200);
    const refused = await call(proxy.url, "/responses", {}, "{}");
    expect(refused.status).toBe(429);
    expect(refused.body.toString()).toContain("usage limit");
    await new Promise((r) => setTimeout(r, 100));
    expect(frames).toEqual([]);
  });
});

describe("the Proxy Capture in front of the Gemini API (Gemini CLI)", () => {
  it("passes a streamed turn through unchanged and sends its Digest", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(GEMINI_SSE);
    };
    const proxy = await startCapture(geminiGenerateContent);
    const path = "/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse";
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    const answer = await call(
      proxy.url,
      path,
      { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body,
    );
    expect(answer.body.toString("utf8")).toBe(GEMINI_SSE);
    expect(seen[0]).toMatchObject({ url: path });
    expect(seen[0]?.headers["x-goog-api-key"]).toBe(GEMINI_KEY);
    const [event] = await waitForFrames(1);
    expect(event).toMatchObject({
      type: "proxy.digest",
      payload: {
        model: "gemini-3-pro",
        inputTokens: 1304,
        outputTokens: 69,
        cacheReadTokens: 4096,
        reply: "Running the tests. Token: xoxb-****",
        toolCalls: [
          { name: "run_shell_command", arg: "npm test" },
          { name: "read_file", arg: "src/app.ts" },
        ],
        maskedSecrets: 1,
      },
    });
    expect(JSON.stringify(frames)).not.toContain("NEVERleave");
  });

  it("reads Code Assist's turns (Login with Google) at its own endpoint", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(CODE_ASSIST_SSE);
    };
    const proxy = await startCapture(geminiGenerateContent, "digest", upstreamUrl);
    await call(proxy.url, "/v1internal:streamGenerateContent?alt=sse", { authorization: "Bearer ya29.x" }, "{}");
    // Code Assist's other calls pass through without a turn.
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"currentTier":{"id":"free-tier"}}');
    };
    await call(proxy.url, "/v1internal:loadCodeAssist", {}, "{}");
    const events = await waitForFrames(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(frames).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "proxy.digest", payload: { model: "gemini-3-pro", toolCalls: [{}, {}] } });
  });
});

async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
