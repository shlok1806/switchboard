// The Proxy Capture's local proxy against a fake Anthropic API. Observed the way
// the agent CLI sees it (the bytes it gets back) and the way the Channel sees it
// (the frames the wrapper sends on its WebSocket).

import { createServer, type IncomingHttpHeaders, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, ProxyCaptureMessage, ProxyEvent } from "../../shared/src/index";
import { RAW_PROXY_CAP_BYTES } from "../../shared/src/index";
import { ProxyCapture } from "../src/proxy/capture";

const API_KEY = "sk-ant-api03-REALKEYshouldNEVERleave0123456789abcdef";
const OAUTH = "Bearer sk-ant-oat01-ALSOsecretOAuthToken0123456789abcdef";

function sse(events: Record<string, unknown>[]): string[] {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

/** A streamed model turn: text, then a Bash tool call split across deltas. */
const TURN = sse([
  {
    type: "message_start",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      usage: { input_tokens: 12, cache_read_input_tokens: 3000, cache_creation_input_tokens: 150, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Running the tests. " } },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Key is sk-ant-api03-LEAKEDinREPLY0123456789" },
  },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command": "npm' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' test"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t2", name: "Read", input: {} } },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: "/repo/src/app.ts" }) },
  },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
  { type: "message_stop" },
]);

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer };

let upstream: Server;
let upstreamUrl = "";
const seen: Seen[] = [];
/** How the fake API answers the next request. */
let respond: (req: Seen, res: import("node:http").ServerResponse) => void | Promise<void>;
let capture: ProxyCapture | null = null;
let frames: ProxyCaptureMessage[] = [];
const logs: string[] = [];

const AGENT: Agent = {
  id: "e2e/claude/abcd",
  person: "e2e",
  cli: "claude-code",
  presence: "live",
  proxyMode: "digest",
  secretMasking: true,
  canReceiveInterrupts: true,
  lastSeenAt: "",
  startedAt: "",
};

async function startCapture(options: { mode?: "digest" | "raw"; mask?: boolean; upstream?: string } = {}) {
  frames = [];
  capture = await ProxyCapture.start({
    upstream: options.upstream ?? upstreamUrl,
    mode: options.mode ?? "digest",
    mask: options.mask ?? true,
    root: "/repo",
    send: (frame) => {
      frames.push(JSON.parse(frame) as ProxyCaptureMessage);
      return true;
    },
    log: (line) => logs.push(line),
  });
  capture.setAgent({ ...AGENT, proxyMode: options.mode ?? "digest" });
  return capture;
}

type Answer = { status: number; headers: IncomingHttpHeaders; chunks: Buffer[]; body: Buffer };

/** A request the way the agent CLI makes one, reading the raw bytes it gets back. */
function call(
  base: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    onChunk?: (c: Buffer) => void;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base), { method: init.method ?? "POST", headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        init.onChunk?.(chunk);
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, chunks, body: Buffer.concat(chunks) }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

const MODEL_HEADERS = {
  "content-type": "application/json",
  "x-api-key": API_KEY,
  authorization: OAUTH,
  "anthropic-version": "2023-06-01",
};

async function waitForFrames(n: number): Promise<ProxyEvent[]> {
  const deadline = Date.now() + 3000;
  while (frames.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return frames.map((f) => f.event);
}

beforeEach(async () => {
  seen.length = 0;
  logs.length = 0;
  respond = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_1" });
    for (const chunk of TURN) res.write(chunk);
    res.end();
  };
  upstream = createServer((req, res) => {
    const body: Buffer[] = [];
    req.on("data", (c: Buffer) => body.push(c));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(body) };
      seen.push(entry);
      void respond(entry, res);
    });
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

describe("the Proxy Capture's local proxy", () => {
  it("passes a streaming SSE turn through byte for byte, as it arrives", async () => {
    // The fake API holds the stream open after the first event until the CLI has seen it.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    respond = async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_1" });
      res.write(TURN[0]);
      await released;
      for (const chunk of TURN.slice(1)) res.write(chunk);
      res.end();
    };
    const proxy = await startCapture();
    const body = JSON.stringify({
      model: "claude-opus-5-5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const answer = await call(proxy.url, "/v1/messages?beta=true", {
      headers: MODEL_HEADERS,
      body,
      onChunk: () => release(),
    });

    // Byte-identical to what the API sent, and not held back: the stream only
    // finished because the first event reached the CLI while the API waited.
    expect(answer.status).toBe(200);
    expect(answer.body.toString("utf8")).toBe(TURN.join(""));
    expect(answer.headers["content-type"]).toBe("text/event-stream");
    expect(answer.headers["request-id"]).toBe("req_1");

    // The request reached the API unchanged: path, query, body and every header, auth included.
    const [req] = seen;
    expect(req?.url).toBe("/v1/messages?beta=true");
    expect(req?.body.toString("utf8")).toBe(body);
    expect(req?.headers["x-api-key"]).toBe(API_KEY);
    expect(req?.headers.authorization).toBe(OAUTH);
    expect(req?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("builds a Proxy Digest per model turn: model, token counts, reply and tool calls, secrets masked", async () => {
    const proxy = await startCapture();
    await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body: '{"stream":true}' });
    const [event] = await waitForFrames(1);
    expect(frames[0]).toMatchObject({ type: "proxy", agent: AGENT.id });
    expect(event).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      type: "proxy.digest",
      payload: {
        model: "claude-opus-5-5",
        inputTokens: 12,
        outputTokens: 42,
        cacheReadTokens: 3000,
        cacheCreationTokens: 150,
        reply: "Running the tests. Key is sk-ant-****",
        toolCalls: [
          { name: "Bash", arg: "npm test" },
          { name: "Read", arg: "src/app.ts" },
        ],
        maskedSecrets: 1,
      },
    });
  });

  it("reads a turn that did not stream, and a gzipped one, while passing the bytes through untouched", async () => {
    const message = {
      id: "msg_2",
      model: "claude-haiku-5",
      content: [
        { type: "text", text: "Done." },
        { type: "tool_use", id: "t", name: "Grep", input: { pattern: "TODO" } },
      ],
      usage: { input_tokens: 5, output_tokens: 7 },
    };
    const gzipped = gzipSync(JSON.stringify(message));
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipped);
    };
    const proxy = await startCapture();
    const answer = await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body: "{}" });
    expect(answer.body.equals(gzipped)).toBe(true);
    const [event] = await waitForFrames(1);
    expect(event?.payload).toMatchObject({
      model: "claude-haiku-5",
      inputTokens: 5,
      outputTokens: 7,
      reply: "Done.",
      toolCalls: [{ name: "Grep", arg: "TODO" }],
    });
  });

  it("sends a Raw Proxy Event in raw mode, each body cut to the cap and the cut noted", async () => {
    const proxy = await startCapture({ mode: "raw" });
    const big = "x".repeat(RAW_PROXY_CAP_BYTES + 5000);
    const body = JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: `export OPENAI_API_KEY=sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8 ${big}` }],
    });
    const answer = await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body });
    expect(answer.body.toString("utf8")).toBe(TURN.join(""));
    expect(seen[0]?.body.toString("utf8")).toBe(body);

    const [event] = await waitForFrames(1);
    if (event?.type !== "proxy.raw") throw new Error(`expected a Raw Proxy Event, got ${event?.type}`);
    const p = event.payload;
    expect(p.capBytes).toBe(RAW_PROXY_CAP_BYTES);
    expect(Buffer.byteLength(p.context)).toBe(RAW_PROXY_CAP_BYTES);
    expect(p.truncated).toEqual({ context: true, response: false });
    expect(
      p.context.startsWith('{"stream":true,"messages":[{"role":"user","content":"export OPENAI_API_KEY=sk-proj-****'),
    ).toBe(true);
    expect(p.response.split("\n")).toEqual(
      TURN.join("").replace("sk-ant-api03-LEAKEDinREPLY0123456789", "sk-ant-****").split("\n"),
    );
    expect(p.maskedSecrets).toBe(3);
    // The digest fields are there in raw mode too.
    expect(p.toolCalls.map((c) => c.name)).toEqual(["Bash", "Read"]);
  });

  it("masks Switchboard's own session and Agent token in tool results and replies, in either mode", async () => {
    // Shaped the way worker/src/session.ts mints them.
    const session = `v1.${Buffer.from(JSON.stringify({ kind: "session", sub: "e2e", exp: 1792592000 })).toString(
      "base64url",
    )}.${Buffer.alloc(32, 1).toString("base64url")}`;
    const agentToken = `sba_${Buffer.alloc(32, 2).toString("base64url")}`;
    // The Agent read its Person's config and its own token in an earlier tool call...
    const body = JSON.stringify({
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t0",
              content: `${JSON.stringify({ url: "https://sb.example", session, person: "e2e" })}\n${agentToken}`,
            },
          ],
        },
      ],
    });
    // ...and repeats them in its reply and in its next tool call.
    respond = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of sse([
        { type: "message_start", message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Your session is ${session}` } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: `curl -H "x: ${agentToken}"` }) },
        },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ]))
        res.write(chunk);
      res.end();
    };

    for (const mode of ["digest", "raw"] as const) {
      const proxy = await startCapture({ mode });
      await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body });
      const [event] = await waitForFrames(1);
      const sent = JSON.stringify(frames);
      expect(sent).not.toContain(session.split(".")[2]);
      expect(sent).not.toContain(agentToken);
      expect(event?.payload.reply).toBe("Your session is v1.****");
      expect(event?.payload.toolCalls).toEqual([{ name: "Bash", arg: 'curl -H "x: sba_****"' }]);
      if (event?.type === "proxy.raw") {
        expect(event.payload.context).toContain('\\"session\\":\\"v1.****\\"');
        expect(event.payload.context).toContain("\\nsba_****");
        // Reply and tool call, plus both tokens in the context and both in the response.
        expect(event.payload.maskedSecrets).toBe(6);
      } else {
        expect(event?.type).toBe("proxy.digest");
        expect(event?.payload.maskedSecrets).toBe(2);
      }
      await capture?.close();
      capture = null;
    }
  });

  it("never captures auth headers, in either mode", async () => {
    for (const mode of ["digest", "raw"] as const) {
      const proxy = await startCapture({ mode });
      await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body: '{"stream":true}' });
      await waitForFrames(1);
      const sent = JSON.stringify(frames);
      expect(sent).not.toContain("REALKEY");
      expect(sent).not.toContain("ALSOsecret");
      expect(sent).not.toMatch(/x-api-key|authorization/i);
      await capture?.close();
      capture = null;
    }
  });

  it("switches Proxy mode mid-session when the Agent's Person changes it", async () => {
    const proxy = await startCapture();
    await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body: "{}" });
    proxy.agentChanged({ ...AGENT, proxyMode: "raw" });
    await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body: "{}" });
    // Another Agent's change is not ours.
    proxy.agentChanged({ ...AGENT, id: "e2e/claude/ffff", proxyMode: "digest" });
    await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body: "{}" });
    const events = await waitForFrames(3);
    expect(events.map((e) => e.type)).toEqual(["proxy.digest", "proxy.raw", "proxy.raw"]);
  });

  it("sends secrets as they are when masking is off", async () => {
    const proxy = await startCapture({ mask: false });
    await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body: "{}" });
    const [event] = await waitForFrames(1);
    expect(event?.payload.reply).toContain("sk-ant-api03-LEAKEDinREPLY0123456789");
    expect(event?.payload.maskedSecrets).toBe(0);
  });

  it("passes other calls and API errors through without capturing them", async () => {
    respond = (req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"data":[]}');
        return;
      }
      res.writeHead(529, { "content-type": "application/json", "retry-after": "3" });
      res.end('{"type":"error","error":{"type":"overloaded_error"}}');
    };
    const proxy = await startCapture();
    const models = await call(proxy.url, "/v1/models", { method: "GET", headers: MODEL_HEADERS });
    expect(models).toMatchObject({ status: 200 });
    expect(models.body.toString()).toBe('{"data":[]}');
    const overloaded = await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body: "{}" });
    expect(overloaded.status).toBe(529);
    expect(overloaded.headers["retry-after"]).toBe("3");
    expect(overloaded.body.toString()).toBe('{"type":"error","error":{"type":"overloaded_error"}}');
    await new Promise((r) => setTimeout(r, 100));
    expect(frames).toEqual([]);
  });

  it("keeps a path prefix on the upstream, and answers 502 when the upstream cannot be reached", async () => {
    const proxy = await startCapture({ upstream: `${upstreamUrl}/gateway/anthropic` });
    await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body: "{}" });
    expect(seen[0]?.url).toBe("/gateway/anthropic/v1/messages");
    await capture?.close();

    const dead = await startCapture({ upstream: "http://127.0.0.1:1" });
    const answer = await call(dead.url, "/v1/messages", { headers: MODEL_HEADERS, body: "{}" });
    expect(answer.status).toBe(502);
    expect(JSON.parse(answer.body.toString())).toMatchObject({ type: "error", error: { type: "api_error" } });
  });

  it("holds Events until the Agent is registered, and sends them again until the Channel acknowledges", async () => {
    frames = [];
    const sent: string[] = [];
    capture = await ProxyCapture.start({
      upstream: upstreamUrl,
      mode: "digest",
      mask: true,
      root: "/repo",
      send: (frame) => {
        sent.push(frame);
        return true;
      },
      log: () => {},
    });
    await call(capture.url, "/v1/messages", { headers: MODEL_HEADERS, body: "{}" });
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toEqual([]);
    capture.setAgent(AGENT);
    expect(sent).toHaveLength(1);
    capture.connected();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    const { event } = JSON.parse(sent[0] ?? "{}") as ProxyCaptureMessage;
    capture.reply({ type: "proxy.ack", id: event.id });
    capture.connected();
    expect(sent).toHaveLength(2);
  });
});

describe("Claude Code's calls for itself (#58)", () => {
  /** Claude Code's tools, as every request for the Agent's work carries them (cut down). */
  const TOOLS = [{ name: "Bash", input_schema: { type: "object" } }];
  /** The turn the Agent's request answers: one short text reply. */
  const reply = (text: string) =>
    sse([
      { type: "message_start", message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 3 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);
  const conversation = [
    { role: "user", content: "pick an open issue and fix it" },
    { role: "assistant", content: [{ type: "text", text: "Fixed #12. Want me to finish it?" }] },
  ];
  // Claude Code 2.1.286 sends these as below: the title from its tool-free helper
  // (no tools, JSON output with a schema), the suggestion as a fork of the
  // conversation whose last user message is its fixed "[SUGGESTION MODE: ...]" prompt.
  const TITLE_SCHEMA = {
    type: "json_schema",
    schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  };
  const backgroundCalls = {
    "the session title (output_config)": {
      request: {
        model: "claude-haiku-5",
        stream: true,
        tools: [],
        system: [{ type: "text", text: "Generate a concise title for this session." }],
        messages: [{ role: "user", content: "<session>\npick an open issue and fix it\n</session>" }],
        output_config: { format: TITLE_SCHEMA },
      },
      reply: '{"title":"Open issue selection"}',
    },
    "the session title (output_format, no tools field)": {
      request: {
        model: "claude-haiku-5",
        stream: true,
        messages: [{ role: "user", content: "<session>\nhi\n</session>" }],
        output_format: TITLE_SCHEMA,
      },
      reply: '{"title":"Greeting"}',
    },
    "a prompt suggestion": {
      request: {
        model: "claude-opus-5-5",
        stream: true,
        tools: TOOLS,
        messages: [
          ...conversation,
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\nFIRST: Look at the user's recent messages.",
              },
            ],
          },
        ],
      },
      reply: "yes finish it",
    },
  };

  for (const mode of ["digest", "raw"] as const) {
    for (const [name, call_] of Object.entries(backgroundCalls)) {
      it(`sends no Event for ${name} (${mode} mode), and passes it through unchanged`, async () => {
        respond = (_req, res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const chunk of reply(call_.reply)) res.write(chunk);
          res.end();
        };
        const proxy = await startCapture({ mode });
        const body = JSON.stringify(call_.request);
        const answer = await call(proxy.url, "/v1/messages?beta=true", { headers: MODEL_HEADERS, body });
        expect(answer.body.toString("utf8")).toBe(reply(call_.reply).join(""));
        expect(seen.at(-1)?.body.toString("utf8")).toBe(body);
        // A real turn after it is captured, so the first one was seen and skipped.
        respond = (_req, res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const chunk of reply("Done.")) res.write(chunk);
          res.end();
        };
        const turn = { model: "claude-opus-5-5", stream: true, tools: TOOLS, messages: conversation };
        await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body: JSON.stringify(turn) });
        const events = await waitForFrames(1);
        await new Promise((r) => setTimeout(r, 100));
        expect(frames.map((f) => f.event.payload.reply)).toEqual(["Done."]);
        expect(events).toHaveLength(1);
        expect(logs.join("\n")).toContain("not captured: Claude Code's");
      });
    }

    it(`captures the Agent's real turns, however short (${mode} mode)`, async () => {
      const turns = [
        // One word, with tools, as every Claude Code turn for the Agent's work.
        { stream: true, tools: TOOLS, messages: [{ role: "user", content: "hi" }] },
        // The marker earlier in the conversation, not as its last message.
        {
          stream: true,
          tools: TOOLS,
          messages: [
            { role: "user", content: "[SUGGESTION MODE: an old prompt pasted by the Person]" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "go" },
          ],
        },
        // JSON output, but with tools: not the tool-free helper.
        {
          stream: true,
          tools: TOOLS,
          messages: [{ role: "user", content: "x" }],
          output_config: { format: TITLE_SCHEMA },
        },
        // A request the proxy cannot read is a turn, as before.
        "not json",
      ];
      respond = (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of reply("ok")) res.write(chunk);
        res.end();
      };
      const proxy = await startCapture({ mode });
      for (const turn of turns) {
        const body = typeof turn === "string" ? turn : JSON.stringify(turn);
        await call(proxy.url, "/v1/messages", { headers: MODEL_HEADERS, body });
      }
      expect(await waitForFrames(turns.length)).toHaveLength(turns.length);
    });
  }
});
