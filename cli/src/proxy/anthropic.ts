// Anthropic's Messages API (Claude Code): turns are `POST /v1/messages`, not
// `count_tokens`. The parser is TurnReader (turn.ts), streamed when the response
// says `text/event-stream`.
//
// Claude Code also calls the model for itself, and those calls are not the
// Agent's turns (#58). Hiding one of the Agent's turns would be worse than
// showing one of these, so a call is skipped only when every part of its request
// is what Claude Code 2.1.286 sends for it, never by its reply:
//
// - The session title: no tools (none, or an empty list), Claude Code's own
//   title-naming instruction in the system prompt (every turn for the Agent's
//   work carries the main agent prompt instead, even with `--tools ""`), and
//   JSON output whose schema has only a `title` property.
// - The prompt suggestion: a fork of the conversation whose last message is a
//   user message holding Claude Code's suggestion prompt, whole (its fixed first
//   and last lines), and nothing else but system reminders.
//
// A Person who types or pastes something like either is still captured, unless
// they reproduce the whole request. A newer Claude Code that words these
// differently has its calls captured again, which is the safe way to be wrong.

import { type ApiFormat, record } from "./api";
import { TurnReader } from "./turn";

/** How Claude Code's title instruction starts. */
const TITLE_INSTRUCTION = "You are naming a coding session so the user can pick it out of a long list of sessions.";
/** The first and last lines of Claude Code's prompt-suggestion prompt. */
const SUGGESTION_FIRST = "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\n";
const SUGGESTION_LAST = "Reply with ONLY the suggestion, no quotes or explanation.";

/** A message's content as blocks, whether it is a string or blocks. */
function blocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.map(record) : [];
}

function textOf(block: Record<string, unknown>): string | null {
  return block.type === "text" && typeof block.text === "string" ? block.text : null;
}

function isSessionTitle(request: Record<string, unknown>): boolean {
  const tools = request.tools;
  if (!(tools === undefined || (Array.isArray(tools) && tools.length === 0))) return false;
  const system = blocks(request.system).map(textOf);
  if (!system.some((text) => text?.startsWith(TITLE_INSTRUCTION))) return false;
  const format = record(record(request.output_config).format ?? request.output_format);
  const properties = Object.keys(record(record(format.schema).properties));
  return format.type === "json_schema" && properties.length === 1 && properties[0] === "title";
}

function isPromptSuggestion(request: Record<string, unknown>): boolean {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const last = record(messages.at(-1));
  if (last.role !== "user") return false;
  const texts = blocks(last.content).map(textOf);
  // Text only (a tool result means a turn that went on), and apart from system reminders, only the prompt.
  if (texts.some((text) => text === null)) return false;
  const own = texts.filter((text): text is string => text !== null && !text.startsWith("<system-reminder>"));
  if (own.length !== 1) return false;
  const prompt = own[0] ?? "";
  return prompt.startsWith(SUGGESTION_FIRST) && prompt.trimEnd().endsWith(SUGGESTION_LAST);
}

function background(request: Record<string, unknown>): string | null {
  if (isSessionTitle(request)) return "Claude Code's session-title call";
  if (isPromptSuggestion(request)) return "Claude Code's prompt suggestion";
  return null;
}

export const anthropicMessages: ApiFormat = {
  name: "anthropic-messages",
  defaultUpstream: "https://api.anthropic.com",
  isTurn: (method, path) => method === "POST" && /^\/v1\/messages(\?|$)/.test(path),
  reader: ({ contentType }) => new TurnReader(/text\/event-stream/i.test(contentType)),
  background,
};
