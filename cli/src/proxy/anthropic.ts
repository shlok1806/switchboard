// Anthropic's Messages API (Claude Code): turns are `POST /v1/messages`, not
// `count_tokens`. The parser is TurnReader (turn.ts), streamed when the response
// says `text/event-stream`.

import type { ApiFormat } from "./api";
import { TurnReader } from "./turn";

export const anthropicMessages: ApiFormat = {
  name: "anthropic-messages",
  defaultUpstream: "https://api.anthropic.com",
  isTurn: (method, path) => method === "POST" && /^\/v1\/messages(\?|$)/.test(path),
  reader: ({ contentType }) => new TurnReader(/text\/event-stream/i.test(contentType)),
};
