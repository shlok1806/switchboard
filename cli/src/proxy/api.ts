// The model APIs the Proxy Capture can read, one parser per API format. Each format
// says which requests are model turns and reads a copy of one turn's response into
// the same Proxy Digest fields: model, token counts, reply text and tool calls.
// Nothing here can change what the agent CLI sees; the proxy forwards the bytes
// first and hands a copy to the parser.

/** What a turn request says about its model (ADR 0010). */
export interface RequestedModel {
  model?: string;
  effort?: string;
  main?: boolean;
}

/** A string field, when it is a non-empty string. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The model APIs the Proxy Capture reads. */
export type ApiName = "anthropic-messages" | "openai-responses" | "gemini";

/** One tool call the model made. */
export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
  /**
   * The Claude Code tool this call is summarised as (`Bash`, `Edit`, `Read`), when
   * the model's own tool does the same thing, so its argument reads the same way
   * as the Hook Capture's. The call keeps its own name.
   */
  as?: string;
}

/** Reads one model turn's response, a chunk at a time. */
export interface TurnParser {
  /** The next decoded chunk of the response body. */
  push(chunk: Uint8Array): void;
  /** The response ended. */
  end(): void;
  /** Whether the response looked like a model turn at all. */
  readonly seen: boolean;
  readonly model: string;
  /** Input tokens that were neither read from nor written to the prompt cache. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly reply: string;
  readonly toolUses: ToolUse[];
}

/** A turn read from JSON messages, one per event (the Responses API's WebSocket mode). */
export interface EventParser extends TurnParser {
  /** The next event. */
  event(event: Record<string, unknown>): void;
  /** Whether the turn's last event has arrived. */
  readonly done: boolean;
}

export interface ResponseInfo {
  /** The request's path and query, as the agent CLI sent it to the proxy. */
  path: string;
  /** The response's Content-Type, or "". */
  contentType: string;
}

export interface ApiFormat {
  name: ApiName;
  /** Where the traffic goes when the agent CLI names no base URL of its own. */
  defaultUpstream: string;
  /** Whether a request is a model turn. */
  isTurn(method: string | undefined, path: string): boolean;
  /** A parser for one model turn's response. */
  reader(response: ResponseInfo): TurnParser;
  /**
   * Whether a turn request is a call the agent CLI makes for itself rather than for
   * the Agent's work (naming the session, suggesting the Person's next prompt): a
   * short description of it, or null for one of the Agent's turns. Told from the
   * request, never the reply. Such calls produce no Event.
   */
  background?(request: Record<string, unknown>): string | null;
  /**
   * The model a turn request asks for, and its reasoning effort when it names one
   * (ADR 0010). `main` says whether the request is from the session's main thread,
   * when the request can tell (a subagent's turns may run on another model). Only
   * these strings are ever kept from the request.
   */
  requested?(request: Record<string, unknown>): RequestedModel;
  /**
   * For APIs that also run turns over a WebSocket: which upgrade paths carry turns,
   * whether a client message starts one, and a parser for its events.
   */
  websocket?: {
    isTurnSocket(path: string): boolean;
    startsTurn(message: Record<string, unknown>): boolean;
    reader(): EventParser;
  };
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The most bytes of a non-streaming JSON reply a parser keeps. */
const MAX_JSON_BYTES = 32 * 1024 * 1024;

/**
 * Splits a response body into its JSON payloads: each `data:` of an SSE stream as
 * it completes, or the whole body at the end when it is plain JSON. The body's
 * first bytes decide, since not every upstream labels its stream.
 */
export class BodyReader {
  private readonly decoder = new TextDecoder();
  private kind: "unknown" | "sse" | "json" = "unknown";
  private text = "";
  private tooBig = false;

  constructor(
    private readonly onPayload: (payload: unknown) => void,
    contentType = "",
  ) {
    if (/text\/event-stream/i.test(contentType)) this.kind = "sse";
  }

  push(chunk: Uint8Array): void {
    this.add(this.decoder.decode(chunk, { stream: true }));
  }

  end(): void {
    this.add(this.decoder.decode());
    if (this.kind === "json" || this.kind === "unknown") {
      if (!this.tooBig) this.onPayload(safeParse(this.text));
    } else if (this.text.trim()) {
      this.frame(this.text);
    }
    this.text = "";
  }

  private add(text: string): void {
    if (text === "") return;
    if (this.kind === "unknown") {
      const start = (this.text + text).trimStart();
      if (start === "") {
        this.text += text;
        return;
      }
      this.kind = start.startsWith("{") || start.startsWith("[") ? "json" : "sse";
    }
    if (this.kind === "json") {
      if (this.text.length + text.length > MAX_JSON_BYTES) this.tooBig = true;
      else this.text += text;
      return;
    }
    this.text += text;
    for (;;) {
      const end = this.text.search(/\r?\n\r?\n/);
      if (end === -1) break;
      const frame = this.text.slice(0, end);
      this.text = this.text.slice(end).replace(/^\r?\n\r?\n/, "");
      this.frame(frame);
    }
  }

  private frame(frame: string): void {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return;
    this.onPayload(safeParse(data));
  }
}
