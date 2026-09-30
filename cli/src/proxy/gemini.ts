// Google's Gemini generateContent API (Gemini CLI). A turn is a POST to
// `...:generateContent` or `...:streamGenerateContent` (`?alt=sse` streams SSE;
// without it the stream is one JSON array). With an API key it goes to the Gemini
// API (`/v1beta/models/<model>:streamGenerateContent`); logged in with Google it
// goes to Code Assist (`/v1internal:streamGenerateContent`), which wraps each
// response as `{ response: {...} }`. Either way each chunk is a
// GenerateContentResponse: text and function calls in the first candidate's parts,
// token counts in `usageMetadata` (the last chunk's are the turn's).

import { GEMINI_TOOLS } from "../clis/gemini-tools";
import { type ApiFormat, BodyReader, num, record, type ToolUse, type TurnParser } from "./api";

/** A Gemini CLI tool call, summarised the way the Hook Capture summarises the same tool. */
function geminiTool(name: string, args: Record<string, unknown>): ToolUse {
  const tool = GEMINI_TOOLS[name];
  if (!tool) return { name, input: args };
  const input = { ...args };
  for (const [from, to] of Object.entries(tool.fields ?? {})) {
    if (input[to] === undefined && input[from] !== undefined) input[to] = input[from];
  }
  return { name, as: tool.name, input };
}

export class GeminiReader implements TurnParser {
  model = "";
  private usage: Record<string, unknown> = {};
  private text = "";
  private readonly calls: ToolUse[] = [];
  private chunks = 0;
  private readonly body: BodyReader;

  /** `path` names the model when the response does not (`/models/<model>:...`). */
  constructor(contentType: string, path: string) {
    this.body = new BodyReader((payload) => {
      for (const chunk of Array.isArray(payload) ? payload : [payload]) this.chunk(record(chunk));
    }, contentType);
    const fromPath = /\/models\/([^/:?]+):/.exec(path)?.[1];
    if (fromPath) this.model = decodeURIComponent(fromPath);
  }

  push(chunk: Uint8Array): void {
    this.body.push(chunk);
  }

  end(): void {
    this.body.end();
  }

  get seen(): boolean {
    return this.chunks > 0;
  }

  private get cached(): number {
    return num(this.usage.cachedContentTokenCount) ?? 0;
  }

  get inputTokens(): number {
    return Math.max(0, (num(this.usage.promptTokenCount) ?? 0) - this.cached);
  }

  get outputTokens(): number {
    return (num(this.usage.candidatesTokenCount) ?? 0) + (num(this.usage.thoughtsTokenCount) ?? 0);
  }

  get cacheReadTokens(): number {
    return this.cached;
  }

  get cacheCreationTokens(): number {
    return 0;
  }

  get reply(): string {
    return this.text.trim();
  }

  get toolUses(): ToolUse[] {
    return this.calls;
  }

  private chunk(raw: Record<string, unknown>): void {
    // Code Assist wraps the response.
    const response = typeof raw.response === "object" && raw.response !== null ? record(raw.response) : raw;
    const candidates = Array.isArray(response.candidates) ? response.candidates : undefined;
    const usage = typeof response.usageMetadata === "object" ? record(response.usageMetadata) : undefined;
    if (!candidates && !usage) return;
    this.chunks++;
    if (typeof response.modelVersion === "string" && response.modelVersion !== "") this.model = response.modelVersion;
    if (usage) this.usage = usage;
    const parts = record(record(candidates?.[0]).content).parts;
    for (const rawPart of Array.isArray(parts) ? parts : []) {
      const part = record(rawPart);
      // Thought summaries are not the reply.
      if (typeof part.text === "string" && part.thought !== true) this.text += part.text;
      if (typeof part.functionCall === "object" && part.functionCall !== null) {
        const call = record(part.functionCall);
        this.calls.push(geminiTool(String(call.name ?? "tool"), record(call.args)));
      }
    }
  }
}

export const geminiGenerateContent: ApiFormat = {
  name: "gemini",
  defaultUpstream: "https://generativelanguage.googleapis.com",
  isTurn: (method, path) => method === "POST" && /:(stream)?generateContent(\?|$)/i.test(path),
  reader: ({ contentType, path }) => new GeminiReader(contentType, path),
};
