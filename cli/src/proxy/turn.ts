// What the Proxy Capture learns about one model turn from the Messages API, and how
// it becomes a Proxy Event. The response is read as it streams (an SSE stream, or a
// JSON body when the request did not stream), from a copy of the bytes the agent CLI
// gets; nothing here can change what the CLI sees.

import { isAbsolute, relative } from "node:path";
import type { ProxyEvent, ProxyMode, ProxyTurn, ToolCall } from "../../../shared/src/index";
import {
  MAX_PROXY_MODEL_LENGTH,
  MAX_PROXY_REPLY_LENGTH,
  MAX_PROXY_TOOL_CALLS,
  RAW_PROXY_CAP_BYTES,
  truncate,
} from "../../../shared/src/index";
import { toolArg } from "../hooks/summarize";
import { maskSecrets } from "./mask";

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; json: string; input?: unknown };

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Reads one Messages API response, streamed or not, a chunk at a time. */
export class TurnReader {
  model = "";
  private usage: Usage = {};
  private readonly blocks: Block[] = [];
  private sseBuffer = "";
  private json = "";
  private jsonTooBig = false;
  private readonly decoder = new TextDecoder();

  constructor(private readonly streaming: boolean) {}

  /** The next decoded chunk of the response body. */
  push(chunk: Uint8Array): void {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.streaming) {
      // A non-streaming reply is one JSON object; keep it, within reason.
      if (this.json.length + text.length > 32 * 1024 * 1024) this.jsonTooBig = true;
      else this.json += text;
      return;
    }
    this.sseBuffer += text;
    for (;;) {
      const end = this.sseBuffer.search(/\r?\n\r?\n/);
      if (end === -1) break;
      const frame = this.sseBuffer.slice(0, end);
      this.sseBuffer = this.sseBuffer.slice(end).replace(/^\r?\n\r?\n/, "");
      this.frame(frame);
    }
  }

  /** The response ended. */
  end(): void {
    const rest = this.decoder.decode();
    if (!this.streaming) {
      if (!this.jsonTooBig) this.message(record(safeParse(this.json + rest)));
      return;
    }
    this.sseBuffer += rest;
    if (this.sseBuffer.trim()) this.frame(this.sseBuffer);
    this.sseBuffer = "";
  }

  /** Whether the response looked like a model turn at all. */
  get seen(): boolean {
    return this.model !== "";
  }

  get inputTokens(): number {
    return num(this.usage.input_tokens) ?? 0;
  }

  get outputTokens(): number {
    return num(this.usage.output_tokens) ?? 0;
  }

  get cacheReadTokens(): number {
    return num(this.usage.cache_read_input_tokens) ?? 0;
  }

  get cacheCreationTokens(): number {
    return num(this.usage.cache_creation_input_tokens) ?? 0;
  }

  get reply(): string {
    return this.blocks
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n\n")
      .trim();
  }

  get toolUses(): { name: string; input: Record<string, unknown> }[] {
    return this.blocks.flatMap((b) =>
      b.type === "tool_use" ? [{ name: b.name, input: record(b.input ?? safeParse(b.json)) }] : [],
    );
  }

  private frame(frame: string): void {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    const event = record(safeParse(data));
    switch (event.type) {
      case "message_start": {
        const message = record(event.message);
        if (typeof message.model === "string") this.model = message.model;
        this.addUsage(record(message.usage));
        break;
      }
      case "content_block_start": {
        const block = record(event.content_block);
        const index = num(event.index) ?? this.blocks.length;
        if (block.type === "text") this.blocks[index] = { type: "text", text: String(block.text ?? "") };
        if (block.type === "tool_use" || block.type === "server_tool_use") {
          const input = record(block.input);
          this.blocks[index] = {
            type: "tool_use",
            name: String(block.name ?? "tool"),
            json: "",
            ...(Object.keys(input).length > 0 ? { input } : {}),
          };
        }
        break;
      }
      case "content_block_delta": {
        const block = this.blocks[num(event.index) ?? -1];
        const delta = record(event.delta);
        if (block?.type === "text" && delta.type === "text_delta") block.text += String(delta.text ?? "");
        if (block?.type === "tool_use" && delta.type === "input_json_delta") {
          block.json += String(delta.partial_json ?? "");
          delete block.input;
        }
        break;
      }
      case "message_delta":
        this.addUsage(record(event.usage));
        break;
    }
  }

  private message(message: Record<string, unknown>): void {
    if (typeof message.model === "string") this.model = message.model;
    this.addUsage(record(message.usage));
    const content = Array.isArray(message.content) ? message.content : [];
    for (const raw of content) {
      const block = record(raw);
      if (block.type === "text") this.blocks.push({ type: "text", text: String(block.text ?? "") });
      if (block.type === "tool_use" || block.type === "server_tool_use") {
        this.blocks.push({ type: "tool_use", name: String(block.name ?? "tool"), json: "", input: block.input });
      }
    }
  }

  /** Streaming responses report usage twice: at the start, and final counts at the end. Later wins. */
  private addUsage(usage: Record<string, unknown>): void {
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ] as const) {
      const value = num(usage[key]);
      if (value !== undefined) this.usage[key] = value;
    }
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Collects up to `cap` bytes of a body, plus a margin so a secret cut at the cap is still found and masked. */
export class CappedBody {
  private readonly chunks: Buffer[] = [];
  private kept = 0;
  total = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Uint8Array): void {
    this.total += chunk.length;
    const room = this.cap + MASK_MARGIN_BYTES - this.kept;
    if (room <= 0) return;
    const part = Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.length, room));
    this.chunks.push(Buffer.from(part));
    this.kept += part.length;
  }

  get truncated(): boolean {
    return this.total > this.cap;
  }

  /** The kept bytes as text (with the margin; mask before cutting to the cap). */
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Bytes kept past the cap so masking sees a whole secret before the text is cut. */
const MASK_MARGIN_BYTES = 16 * 1024;

/** Cuts text to `cap` bytes of UTF-8, never inside a character. */
export function cutToBytes(text: string, cap: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= cap) return text;
  return bytes.subarray(0, cap).toString("utf8").replace(/�+$/, "");
}

export interface TurnInput {
  reader: TurnReader;
  request: CappedBody;
  response: CappedBody;
  /** Raw request and response bodies as text; only read in raw mode. */
  requestText: () => string;
  responseText: () => string;
}

export interface BuildOptions {
  mode: ProxyMode;
  mask: boolean;
  /** Tool call paths under this directory are shown relative to it. */
  root: string;
  /** Picks the Event's ID. */
  id: string;
  /** The most bytes of each body a Raw Proxy Event keeps. */
  capBytes?: number;
}

/** Builds the Proxy Event for one model turn, with detected secrets masked unless masking is off. */
export function buildProxyEvent(turn: TurnInput, options: BuildOptions): ProxyEvent {
  let masked = 0;
  const clean = (text: string): string => {
    if (!options.mask) return text;
    const result = maskSecrets(text);
    masked += result.count;
    return result.text;
  };
  const shortPath = (path: string): string => {
    const inside = isAbsolute(path) ? relative(options.root, path) : path;
    return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? path : inside;
  };
  const { reader } = turn;
  const toolCalls: ToolCall[] = reader.toolUses.slice(0, MAX_PROXY_TOOL_CALLS).map((use) => ({
    name: truncate(use.name, 100),
    arg: clean(toolArg(use.name, use.input, shortPath)),
  }));
  const base: Omit<ProxyTurn, "maskedSecrets"> = {
    model: truncate(reader.model, MAX_PROXY_MODEL_LENGTH),
    inputTokens: reader.inputTokens,
    outputTokens: reader.outputTokens,
    cacheReadTokens: reader.cacheReadTokens,
    cacheCreationTokens: reader.cacheCreationTokens,
    reply: truncate(clean(reader.reply), MAX_PROXY_REPLY_LENGTH),
    toolCalls,
  };
  if (options.mode === "digest") {
    return { id: options.id, type: "proxy.digest", payload: { ...base, maskedSecrets: masked } };
  }
  const cap = options.capBytes ?? RAW_PROXY_CAP_BYTES;
  const context = cutToBytes(clean(turn.requestText()), cap);
  const response = cutToBytes(clean(turn.responseText()), cap);
  return {
    id: options.id,
    type: "proxy.raw",
    payload: {
      ...base,
      context,
      response,
      capBytes: cap,
      truncated: { context: turn.request.truncated, response: turn.response.truncated },
      maskedSecrets: masked,
    },
  };
}
