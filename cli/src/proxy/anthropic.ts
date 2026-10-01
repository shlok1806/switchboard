// Anthropic's Messages API (Claude Code): turns are `POST /v1/messages`, not
// `count_tokens`. The parser is TurnReader (turn.ts), streamed when the response
// says `text/event-stream`.
//
// Claude Code also calls the model for itself, and those calls are not the
// Agent's turns (#58). Two kinds are told apart by what Claude Code puts in the
// request, as 2.1.286 builds it, never by the reply:
//
// - Its tool-free helper (the session title, and others like it): a request with
//   no tools that asks for JSON output with a schema (`output_config.format`, or
//   the older `output_format`, of type `json_schema`). Claude Code sends its tools
//   with every request for the Agent's work, so a real turn always has some.
// - The prompt suggestion: a fork of the conversation, with the same tools, whose
//   last message is a user message starting with Claude Code's fixed prompt,
//   "[SUGGESTION MODE: ...".

import { type ApiFormat, record } from "./api";
import { TurnReader } from "./turn";

/** How Claude Code's prompt-suggestion prompt starts. */
const SUGGESTION_MODE = "[SUGGESTION MODE:";

/** The text blocks of one message, whether its content is a string or blocks. */
function texts(message: Record<string, unknown>): string[] {
  const { content } = message;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const { type, text } = record(block);
    return type === "text" && typeof text === "string" ? [text] : [];
  });
}

function background(request: Record<string, unknown>): string | null {
  const tools = request.tools;
  const format = record(record(request.output_config).format ?? request.output_format);
  if ((!Array.isArray(tools) || tools.length === 0) && format.type === "json_schema") {
    return "Claude Code's tool-free helper call (a session title, say)";
  }
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const last = record(messages.at(-1));
  if (last.role === "user" && texts(last).some((text) => text.trimStart().startsWith(SUGGESTION_MODE))) {
    return "Claude Code's prompt suggestion";
  }
  return null;
}

export const anthropicMessages: ApiFormat = {
  name: "anthropic-messages",
  defaultUpstream: "https://api.anthropic.com",
  isTurn: (method, path) => method === "POST" && /^\/v1\/messages(\?|$)/.test(path),
  reader: ({ contentType }) => new TurnReader(/text\/event-stream/i.test(contentType)),
  background,
};
