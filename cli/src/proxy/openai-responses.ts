// OpenAI's Responses API (Codex). Codex sends a turn to `<base>/responses`: the
// OpenAI API (`https://api.openai.com/v1`) with an API key, or the ChatGPT backend
// (`https://chatgpt.com/backend-api/codex`) when logged in with ChatGPT; both speak
// this format. A turn runs over a WebSocket at `/responses` (Codex's default; the
// client sends `response.create`, the server answers with one event per message),
// or as `POST /responses` answered with an SSE stream or, unstreamed, one JSON
// response object. The events are the same either way.

import { patchFiles, SHELL_TOOLS, shellCommand } from "../clis/codex-tools";
import {
  type ApiFormat,
  BodyReader,
  type EventParser,
  num,
  type RequestedModel,
  record,
  safeParse,
  type ToolUse,
  text,
} from "./api";

/** The events that end a turn. */
const LAST_EVENTS = new Set(["response.completed", "response.failed", "response.incomplete", "error"]);

/** What one Responses API tool call item reads as. */
function toolUse(item: Record<string, unknown>): ToolUse | null {
  switch (item.type) {
    case "function_call":
    case "custom_tool_call": {
      const name = String(item.name ?? "tool");
      const raw = item.type === "function_call" ? item.arguments : item.input;
      const parsed = typeof raw === "string" ? safeParse(raw) : raw;
      const input = typeof parsed === "object" && parsed !== null ? record(parsed) : { input: String(raw ?? "") };
      return codexTool(name, input);
    }
    case "local_shell_call":
      return codexTool("local_shell", record(item.action));
    case "web_search_call": {
      const action = record(item.action);
      return { name: "web_search", as: "WebSearch", input: { query: String(action.query ?? "") } };
    }
    default:
      return null;
  }
}

/**
 * Codex's code mode runs one `exec` tool whose input is a script calling Codex's
 * tools (`tools.exec_command({cmd: "npm test"})`). The first command or patch in
 * it is what it does.
 */
function codeModeTool(script: string): ToolUse | null {
  if (script.includes("*** Begin Patch")) return codexTool("apply_patch", { input: script });
  const cmd = /tools\.exec_command\(\s*\{[^}]*?\b"?cmd"?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/.exec(
    script,
  )?.[1];
  if (cmd === undefined) return null;
  const command = cmd.startsWith('"') ? String(safeParse(cmd) ?? cmd.slice(1, -1)) : cmd.slice(1, -1);
  return { name: "exec", as: "Bash", input: { command } };
}

/** Codex's own tools, summarised the way the Hook Capture summarises the same work. */
function codexTool(name: string, input: Record<string, unknown>): ToolUse {
  if (name === "exec" && typeof input.input === "string") {
    const inner = codeModeTool(input.input);
    if (inner) return { ...inner, name };
  }
  if (SHELL_TOOLS.has(name) || name === "shell_command") {
    const command = shellCommand(input);
    return command === undefined ? { name, input } : { name, as: "Bash", input: { command } };
  }
  if (name === "apply_patch") {
    const patch = [input.input, input.patch, input.command].find((v) => typeof v === "string");
    const files = typeof patch === "string" ? patchFiles(patch) : [];
    const [first] = files;
    if (first) {
      const more = files.length > 1 ? ` (+${files.length - 1} more)` : "";
      return {
        name,
        as: files.length === 1 && first.kind === "Add" ? "Write" : "Edit",
        input: { file_path: `${first.path}${more}` },
      };
    }
  }
  if (name === "view_image" && typeof input.path === "string") {
    return { name, as: "Read", input: { file_path: input.path } };
  }
  return { name, input };
}

/** Reads one Responses API turn: its events one at a time, or its response body. */
export class ResponsesReader implements EventParser {
  model = "";
  private usage: Record<string, unknown> = {};
  /** Finished output items, by output index. */
  private readonly items: Record<string, unknown>[] = [];
  private finished = false;
  private readonly body: BodyReader;

  constructor(contentType = "") {
    this.body = new BodyReader((payload) => {
      const value = record(payload);
      // An unstreamed reply is the response object itself.
      if (value.object === "response" || (value.type === undefined && Array.isArray(value.output))) {
        this.response(value);
        this.finished = true;
      } else {
        this.event(value);
      }
    }, contentType);
  }

  push(chunk: Uint8Array): void {
    this.body.push(chunk);
  }

  end(): void {
    this.body.end();
  }

  event(event: Record<string, unknown>): void {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "response.output_item.done") {
      const item = record(event.item);
      const index = num(event.output_index) ?? this.items.length;
      this.items[index] = item;
    } else if (type.startsWith("response.") && typeof event.response === "object") {
      // response.created, in_progress, completed, failed, incomplete.
      const response = record(event.response);
      if (typeof response.model === "string" && response.model !== "") this.model = response.model;
      if (typeof response.usage === "object" && response.usage !== null) this.usage = record(response.usage);
      // A completed response lists its output too; it fills in any item whose own event was missed.
      if (Array.isArray(response.output)) {
        response.output.forEach((item, index) => {
          if (this.items[index] === undefined) this.items[index] = record(item);
        });
      }
    }
    if (LAST_EVENTS.has(type)) this.finished = true;
  }

  get done(): boolean {
    return this.finished;
  }

  get seen(): boolean {
    return this.model !== "";
  }

  private get cached(): number {
    return num(record(this.usage.input_tokens_details).cached_tokens) ?? 0;
  }

  private get cacheWrite(): number {
    return num(record(this.usage.input_tokens_details).cache_write_tokens) ?? 0;
  }

  get inputTokens(): number {
    return Math.max(0, (num(this.usage.input_tokens) ?? 0) - this.cached - this.cacheWrite);
  }

  get outputTokens(): number {
    return num(this.usage.output_tokens) ?? 0;
  }

  get cacheReadTokens(): number {
    return this.cached;
  }

  get cacheCreationTokens(): number {
    return this.cacheWrite;
  }

  get reply(): string {
    return this.present()
      .filter((item) => item.type === "message")
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .map(record)
      .flatMap((part) => (part.type === "output_text" && typeof part.text === "string" ? [part.text] : []))
      .join("\n\n")
      .trim();
  }

  get toolUses(): ToolUse[] {
    return this.present().flatMap((item) => toolUse(item) ?? []);
  }

  private present(): Record<string, unknown>[] {
    return this.items.filter((item): item is Record<string, unknown> => item !== undefined);
  }

  private response(response: Record<string, unknown>): void {
    this.event({ type: "response.completed", response });
  }
}

/** The model a Responses API request (or `response.create` message) asks for, and `reasoning.effort`. */
function requested(request: Record<string, unknown>): RequestedModel {
  const model = text(request.model);
  const effort = text(record(request.reasoning).effort);
  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
}

export const openaiResponses: ApiFormat = {
  name: "openai-responses",
  defaultUpstream: "https://api.openai.com/v1",
  isTurn: (method, path) => method === "POST" && /^\/responses\/?(\?|$)/.test(path),
  reader: ({ contentType }) => new ResponsesReader(contentType),
  requested,
  websocket: {
    isTurnSocket: (path) => /^\/responses\/?(\?|$)/.test(path),
    // `generate: false` only warms the connection up; the model does not answer it.
    startsTurn: (message) => message.type === "response.create" && message.generate !== false,
    reader: () => new ResponsesReader(),
  },
};
