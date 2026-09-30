// The Proxy Capture's parsers for the OpenAI Responses API (Codex) and Gemini's
// generateContent (Gemini CLI): each reads a turn in any of the shapes its API
// sends (streamed, unstreamed, over a WebSocket) into the same Proxy Digest the
// Anthropic parser gives, with secrets masked. Also the WebSocket reader, and how
// each CLI's real upstream is worked out.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHATGPT_CODEX_BASE,
  codexArgOverrides,
  codexProxyRoute,
  OPENAI_API_BASE,
  readCodexConfig,
  withoutBaseUrlOverride,
} from "../src/clis/codex-route";
import { CODE_ASSIST_DEFAULT, GEMINI_API_DEFAULT, geminiAuth, geminiProxyRoute } from "../src/clis/gemini-route";
import type { TurnParser } from "../src/proxy/api";
import { GeminiReader, geminiGenerateContent } from "../src/proxy/gemini";
import { openaiResponses, ResponsesReader } from "../src/proxy/openai-responses";
import { buildProxyEvent, CappedBody } from "../src/proxy/turn";
import { agreedDeflate, MessageReader } from "../src/proxy/websocket";
import {
  CODE_ASSIST_SSE,
  GEMINI_ARRAY,
  GEMINI_ERROR,
  GEMINI_JSON,
  GEMINI_SSE,
  RESPONSES_ERROR,
  RESPONSES_FAILED,
  RESPONSES_JSON,
  RESPONSES_SSE,
  RESPONSES_TURN,
} from "./fixtures/api-shapes";

/** Feeds a body to a parser in small, uneven chunks, as a network would. */
function feed(parser: TurnParser, body: string, size = 37): TurnParser {
  const bytes = Buffer.from(body, "utf8");
  for (let i = 0; i < bytes.length; i += size) parser.push(bytes.subarray(i, i + size));
  parser.end();
  return parser;
}

function digest(reader: TurnParser, mask = true, raw?: { request: string; response: string }) {
  const request = new CappedBody(256 * 1024);
  const response = new CappedBody(256 * 1024);
  if (raw) {
    request.push(Buffer.from(raw.request));
    response.push(Buffer.from(raw.response));
  }
  return buildProxyEvent(
    { reader, request, response, requestText: () => request.text(), responseText: () => response.text() },
    { mode: raw ? "raw" : "digest", mask, root: "/repo", id: "00000000-0000-4000-8000-000000000000" },
  );
}

describe("the Responses API parser (Codex)", () => {
  const EXPECTED = {
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

  it("reads a turn over the WebSocket, one event per message", () => {
    const reader = new ResponsesReader();
    for (const event of RESPONSES_TURN) {
      expect(reader.done).toBe(false);
      reader.event(event);
    }
    expect(reader.done).toBe(true);
    expect(digest(reader).payload).toEqual(EXPECTED);
  });

  it("reads the same turn streamed as SSE, however the bytes are split", () => {
    for (const size of [1, 7, 64, 100_000]) {
      const reader = feed(new ResponsesReader("text/event-stream"), RESPONSES_SSE, size);
      expect(digest(reader).payload).toEqual(EXPECTED);
    }
  });

  it("reads an SSE stream sent without its content type", () => {
    expect(digest(feed(new ResponsesReader(""), RESPONSES_SSE)).payload).toEqual(EXPECTED);
  });

  it("reads an unstreamed JSON reply: tool calls, text, web search, cache writes", () => {
    const reader = feed(new ResponsesReader("application/json"), JSON.stringify(RESPONSES_JSON));
    expect(digest(reader).payload).toEqual({
      model: "gpt-5.5-codex",
      inputTokens: 50,
      outputTokens: 42,
      cacheReadTokens: 1000,
      cacheCreationTokens: 150,
      reply: "All clean. DB_PASSWORD=****",
      toolCalls: [
        { name: "exec_command", arg: "git status" },
        { name: "web_search", arg: "vitest 4 docs" },
      ],
      maskedSecrets: 1,
    });
  });

  it("reads a failed turn as a turn with no reply, and an error as no turn at all", () => {
    const failed = new ResponsesReader();
    for (const event of RESPONSES_FAILED) failed.event(event);
    expect(failed.done).toBe(true);
    expect(failed.seen).toBe(true);
    expect(digest(failed).payload).toMatchObject({ model: "gpt-6-sol", reply: "", toolCalls: [] });

    const error = new ResponsesReader();
    error.event(RESPONSES_ERROR);
    expect(error.done).toBe(true);
    expect(error.seen).toBe(false);
  });

  it("leaves text alone with masking off", () => {
    const reader = new ResponsesReader();
    for (const event of RESPONSES_TURN) reader.event(event);
    const payload = digest(reader, false).payload;
    expect(payload.reply).toContain("sk-proj-LEAKEDinREPLY0123456789abcdef");
    expect(payload.maskedSecrets).toBe(0);
  });

  it("masks both bodies of a Raw Proxy Event", () => {
    const reader = new ResponsesReader();
    for (const event of RESPONSES_TURN) reader.event(event);
    const request = JSON.stringify({
      type: "response.create",
      input: [{ role: "user", content: "AKIAIOSFODNN7EXAMPLE" }],
    });
    const event = digest(reader, true, { request, response: RESPONSES_SSE });
    if (event.type !== "proxy.raw") throw new Error("expected a Raw Proxy Event");
    expect(event.payload.context).toContain("AKIA****");
    expect(event.payload.context).not.toContain("IOSFODNN7EXAMPLE");
    expect(event.payload.response).not.toContain("LEAKEDinREPLY");
    expect(event.payload.response).not.toContain("1234567890abcdefghij");
  });

  it("knows Codex's turns: POST /responses, and response.create on its WebSocket unless it only warms up", () => {
    expect(openaiResponses.isTurn("POST", "/responses")).toBe(true);
    expect(openaiResponses.isTurn("POST", "/responses?x=1")).toBe(true);
    expect(openaiResponses.isTurn("GET", "/models?client_version=0.159.1")).toBe(false);
    expect(openaiResponses.isTurn("POST", "/responses/compact")).toBe(false);
    expect(openaiResponses.websocket?.isTurnSocket("/responses")).toBe(true);
    expect(openaiResponses.websocket?.startsTurn({ type: "response.create", model: "gpt-6-sol" })).toBe(true);
    expect(openaiResponses.websocket?.startsTurn({ type: "response.create", generate: false })).toBe(false);
    expect(openaiResponses.websocket?.startsTurn({ type: "response.cancel" })).toBe(false);
  });
});

describe("the Gemini generateContent parser (Gemini CLI)", () => {
  const EXPECTED = {
    model: "gemini-3-pro",
    inputTokens: 1304,
    outputTokens: 69,
    cacheReadTokens: 4096,
    cacheCreationTokens: 0,
    reply: "Running the tests. Token: xoxb-****",
    toolCalls: [
      { name: "run_shell_command", arg: "npm test" },
      { name: "read_file", arg: "src/app.ts" },
    ],
    maskedSecrets: 1,
  };
  const PATH = "/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse";

  it("reads a streamed turn (alt=sse), leaving thoughts out of the reply", () => {
    for (const size of [1, 13, 100_000]) {
      const reader = feed(new GeminiReader("text/event-stream", PATH), GEMINI_SSE, size);
      expect(digest(reader).payload).toEqual(EXPECTED);
    }
  });

  it("reads the stream sent as one JSON array (no alt=sse)", () => {
    const reader = feed(new GeminiReader("application/json", PATH.replace("?alt=sse", "")), GEMINI_ARRAY);
    expect(digest(reader).payload).toEqual(EXPECTED);
  });

  it("reads Code Assist's wrapped chunks (Login with Google)", () => {
    const reader = feed(
      new GeminiReader("text/event-stream", "/v1internal:streamGenerateContent?alt=sse"),
      CODE_ASSIST_SSE,
    );
    expect(digest(reader).payload).toEqual(EXPECTED);
  });

  it("reads an unstreamed reply, taking the model from the path", () => {
    const reader = feed(
      new GeminiReader("application/json; charset=UTF-8", "/v1beta/models/gemini-3-flash:generateContent"),
      JSON.stringify(GEMINI_JSON),
    );
    expect(digest(reader).payload).toEqual({
      model: "gemini-3-flash",
      inputTokens: 300,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reply: "Wrote it.",
      toolCalls: [{ name: "write_file", arg: "src/new.ts" }],
      maskedSecrets: 0,
    });
  });

  it("reads an error body as no turn", () => {
    const reader = feed(new GeminiReader("application/json", PATH), JSON.stringify(GEMINI_ERROR));
    expect(reader.seen).toBe(false);
  });

  it("masks both bodies of a Raw Proxy Event", () => {
    const reader = feed(new GeminiReader("text/event-stream", PATH), GEMINI_SSE);
    const request = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "API_KEY=abcdef123456" }] }] });
    const event = digest(reader, true, { request, response: GEMINI_SSE });
    if (event.type !== "proxy.raw") throw new Error("expected a Raw Proxy Event");
    expect(event.payload.context).toContain("API_KEY=****");
    expect(event.payload.response).not.toContain("AbCdEfGhIjKl");
  });

  it("knows Gemini's turns", () => {
    expect(geminiGenerateContent.isTurn("POST", PATH)).toBe(true);
    expect(geminiGenerateContent.isTurn("POST", "/v1internal:streamGenerateContent?alt=sse")).toBe(true);
    expect(geminiGenerateContent.isTurn("POST", "/v1internal:generateContent")).toBe(true);
    expect(geminiGenerateContent.isTurn("POST", "/v1internal:countTokens")).toBe(false);
    expect(geminiGenerateContent.isTurn("POST", "/v1internal:loadCodeAssist")).toBe(false);
  });
});

/** WebSocket frames the way a client sends them (masked) or a server does (not). */
function wsFrame(payload: Buffer, opts: { opcode?: number; fin?: boolean; rsv1?: boolean; mask?: boolean } = {}) {
  const { opcode = 1, fin = true, rsv1 = false, mask = true } = opts;
  const head = [(fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode];
  const len = payload.length;
  if (len < 126) head.push((mask ? 0x80 : 0) | len);
  else head.push((mask ? 0x80 : 0) | 126, len >> 8, len & 0xff);
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(payload.map((b, i) => b ^ (key[i % 4] ?? 0)));
  return Buffer.concat([Buffer.from(head), key, body]);
}

describe("the WebSocket message reader", () => {
  async function read(bytes: Buffer, deflate: boolean, size = 5): Promise<string[]> {
    const messages: string[] = [];
    const errors: string[] = [];
    const reader = new MessageReader(
      deflate,
      (m) => messages.push(m),
      (e) => errors.push(e),
    );
    for (let i = 0; i < bytes.length; i += size) reader.push(bytes.subarray(i, i + size));
    await reader.settled();
    expect(errors).toEqual([]);
    return messages;
  }

  it("reads masked and unmasked text frames split anywhere, skipping pings and binary", async () => {
    const bytes = Buffer.concat([
      wsFrame(Buffer.from("hello")),
      wsFrame(Buffer.from("ping"), { opcode: 0x9 }),
      wsFrame(Buffer.from([1, 2, 3]), { opcode: 0x2, mask: false }),
      wsFrame(Buffer.from("x".repeat(300)), { mask: false }),
    ]);
    expect(await read(bytes, false, 3)).toEqual(["hello", "x".repeat(300)]);
  });

  it("joins fragmented messages", async () => {
    const bytes = Buffer.concat([
      wsFrame(Buffer.from('{"a":'), { fin: false }),
      wsFrame(Buffer.from("pong"), { opcode: 0xa }),
      wsFrame(Buffer.from("1}"), { opcode: 0 }),
    ]);
    expect(await read(bytes, false)).toEqual(['{"a":1}']);
  });

  it("inflates permessage-deflate messages, keeping the window between them", async () => {
    const deflate = zlib.createDeflateRaw();
    const compress = (text: string) =>
      new Promise<Buffer>((resolve) => {
        const out: Buffer[] = [];
        const onData = (c: Buffer) => out.push(c);
        deflate.on("data", onData);
        deflate.write(text);
        deflate.flush(zlib.constants.Z_SYNC_FLUSH, () => {
          deflate.off("data", onData);
          const all = Buffer.concat(out);
          resolve(all.subarray(0, all.length - 4));
        });
      });
    const first = await compress(JSON.stringify(RESPONSES_TURN[0]));
    // The second refers back to the first's bytes.
    const second = await compress(JSON.stringify(RESPONSES_TURN[1]));
    const half = Math.floor(second.length / 2);
    const bytes = Buffer.concat([
      wsFrame(first, { rsv1: true, mask: false }),
      wsFrame(second.subarray(0, half), { rsv1: true, fin: false, mask: false }),
      wsFrame(second.subarray(half), { opcode: 0, mask: false }),
      wsFrame(Buffer.from("plain"), { mask: false }),
    ]);
    expect(await read(bytes, true, 11)).toEqual([
      JSON.stringify(RESPONSES_TURN[0]),
      JSON.stringify(RESPONSES_TURN[1]),
      "plain",
    ]);
  });

  it("gives up on a compressed message it was not told about, once", async () => {
    const errors: string[] = [];
    const reader = new MessageReader(
      false,
      () => {},
      (e) => errors.push(e),
    );
    reader.push(wsFrame(Buffer.from([1, 2, 3]), { rsv1: true }));
    reader.push(wsFrame(Buffer.from([1, 2, 3]), { rsv1: true }));
    expect(errors).toHaveLength(1);
  });

  it("knows when permessage-deflate was agreed", () => {
    expect(agreedDeflate("permessage-deflate")).toBe(true);
    expect(agreedDeflate("permessage-deflate; server_no_context_takeover")).toBe(true);
    expect(agreedDeflate(undefined)).toBe(false);
    expect(agreedDeflate("x-webkit-deflate-frame")).toBe(false);
  });
});

describe("Codex's real upstream", () => {
  let home = "";
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "sb-codex-route-"));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const write = async (config: string, auth?: Record<string, unknown>) => {
    await writeFile(join(home, "config.toml"), config);
    if (auth) await writeFile(join(home, "auth.json"), JSON.stringify(auth));
    else await rm(join(home, "auth.json"), { force: true });
  };

  it("is the ChatGPT backend when logged in with ChatGPT, the OpenAI API with a key", async () => {
    await write('model = "gpt-6-sol"\n', { auth_mode: "chatgpt", tokens: { access_token: "never read" } });
    expect(await codexProxyRoute(home, [])).toMatchObject({ upstream: CHATGPT_CODEX_BASE, setting: "openai_base_url" });
    await write("", { auth_mode: "apikey", OPENAI_API_KEY: "never read" });
    expect(await codexProxyRoute(home, [])).toMatchObject({ upstream: OPENAI_API_BASE });
    await write("");
    expect(await codexProxyRoute(home, [])).toHaveProperty("unsupported");
  });

  it("follows openai_base_url from the config, its profile, or the Person's -c", async () => {
    await write(
      [
        'openai_base_url = "https://top.example/v1" # comment',
        'profile = "work"',
        "[profiles.work]",
        "openai_base_url = 'https://work.example/v1'",
        "[profiles.home]",
        'model = "x"',
        "[model_providers.custom]",
        'base_url = "https://ignored.example"',
      ].join("\n"),
      { auth_mode: "chatgpt" },
    );
    expect(await codexProxyRoute(home, [])).toMatchObject({ upstream: "https://work.example/v1" });
    expect(await codexProxyRoute(home, ["-p", "home"])).toMatchObject({ upstream: "https://top.example/v1" });
    expect(await codexProxyRoute(home, ["-c", 'openai_base_url="http://127.0.0.1:9/v1"'])).toMatchObject({
      upstream: "http://127.0.0.1:9/v1",
    });
  });

  it("does not read other model providers or local models", async () => {
    await write('model_provider = "ollama"\n', { auth_mode: "chatgpt" });
    expect(await codexProxyRoute(home, [])).toHaveProperty("unsupported");
    await write("", { auth_mode: "chatgpt" });
    expect(await codexProxyRoute(home, ["-c", "model_provider=azure"])).toHaveProperty("unsupported");
    expect(await codexProxyRoute(home, ["--oss"])).toHaveProperty("unsupported");
  });

  it("reads only the keys it needs", () => {
    const config = readCodexConfig(
      'profiles.a.model_provider = "x"\napi_key = "no"\n[profiles."b c"]\nprofile = "z"\n',
    );
    expect(Object.fromEntries(config)).toEqual({ a: { model_provider: "x" }, "b c": { profile: "z" } });
    expect(
      codexArgOverrides(["-c", "profile=a", "--config=openai_base_url=u", "-c", "model=m", "--", "-c", "x=y"]),
    ).toEqual({
      overrides: { profile: "a", openai_base_url: "u" },
    });
  });

  it("takes the Person's own base URL out of the arguments, since the proxy stands in for it", () => {
    expect(
      withoutBaseUrlOverride(["-c", "openai_base_url=u", "-m", "x", "--config=openai_base_url=v", "resume"]),
    ).toEqual(["-m", "x", "resume"]);
  });
});

describe("Gemini CLI's real upstream", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "sb-gemini-route-"));
    await mkdir(join(dir, "home", ".gemini"), { recursive: true });
    await mkdir(join(dir, "work", ".gemini"), { recursive: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const ctx = (env: Record<string, string>) => ({
    cwd: join(dir, "work"),
    env: { GEMINI_CLI_HOME: join(dir, "home"), ...env },
  });

  it("is Code Assist with Login with Google, the Gemini API with a key", async () => {
    await writeFile(
      join(dir, "home", ".gemini", "settings.json"),
      JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }),
    );
    const google = await geminiAuth(ctx({}), {});
    expect(google).toEqual({ type: "oauth-personal", fromSettings: true });
    expect(geminiProxyRoute(google, {})).toMatchObject({
      upstream: CODE_ASSIST_DEFAULT,
      setting: "CODE_ASSIST_ENDPOINT",
    });
    expect(geminiProxyRoute(google, { CODE_ASSIST_ENDPOINT: "http://x" })).toMatchObject({ upstream: "http://x" });

    // The workspace wins over the user, the system over both.
    await writeFile(
      join(dir, "work", ".gemini", "settings.json"),
      JSON.stringify({ selectedAuthType: "gemini-api-key" }),
    );
    const key = await geminiAuth(ctx({}), {});
    expect(geminiProxyRoute(key, {})).toMatchObject({
      upstream: GEMINI_API_DEFAULT,
      setting: "GOOGLE_GEMINI_BASE_URL",
    });
    const vertex = await geminiAuth(ctx({}), { security: { auth: { selectedType: "vertex-ai" } } });
    expect(geminiProxyRoute(vertex, {})).toHaveProperty("unsupported");
  });

  it("reads the environment the way Gemini CLI does when no settings name one", async () => {
    await rm(join(dir, "home", ".gemini", "settings.json"), { force: true });
    await rm(join(dir, "work", ".gemini", "settings.json"), { force: true });
    const env = { GEMINI_API_KEY: "never-read", GOOGLE_GEMINI_BASE_URL: "http://gw" };
    const auth = await geminiAuth(ctx(env), {});
    expect(auth).toEqual({ type: "gateway", fromSettings: false });
    expect(geminiProxyRoute(auth, env)).toMatchObject({ upstream: "http://gw" });
    expect(await geminiAuth(ctx({}), {})).toEqual({ type: undefined, fromSettings: false });
  });
});
