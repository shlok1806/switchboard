// Model turns in the shapes the real APIs send, for the Proxy Capture's parsers.
// The Responses API shapes follow a turn recorded from codex-cli 0.159.1 against
// the ChatGPT backend (ids, encrypted reasoning and metadata cut short); the
// Gemini shapes follow the generateContent reference and Gemini CLI 0.62.0's
// Code Assist client.

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// OpenAI Responses API (Codex)

/** One Codex turn: a commentary message, a code-mode `exec` call, a shell call and an apply_patch. */
export const RESPONSES_TURN: Json[] = [
  {
    type: "response.created",
    response: { id: "resp_1", object: "response", status: "in_progress", model: "gpt-6-sol", output: [], usage: null },
    sequence_number: 0,
  },
  {
    type: "response.in_progress",
    response: { id: "resp_1", object: "response", status: "in_progress", model: "gpt-6-sol", output: [], usage: null },
    sequence_number: 1,
  },
  {
    type: "codex.rate_limits",
    plan_type: "plus",
    rate_limits: { allowed: true, primary: { used_percent: 14, window_minutes: 300 } },
  },
  {
    type: "response.output_item.added",
    item: { id: "rs_1", type: "reasoning", content: [] },
    output_index: 0,
    sequence_number: 2,
  },
  {
    type: "response.output_item.done",
    item: { id: "rs_1", type: "reasoning", content: [], encrypted_content: "gAAAAABqvTSM" },
    output_index: 0,
    sequence_number: 3,
  },
  {
    type: "response.output_item.added",
    item: { id: "msg_1", type: "message", status: "in_progress", content: [], role: "assistant" },
    output_index: 1,
    sequence_number: 4,
  },
  {
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 1,
    delta: "Running the tests. ",
    sequence_number: 5,
  },
  {
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 1,
    delta: "Key is sk-proj-LEAKEDinREPLY0123456789abcdef",
    sequence_number: 6,
  },
  {
    type: "response.output_item.done",
    item: {
      id: "msg_1",
      type: "message",
      status: "completed",
      content: [
        {
          type: "output_text",
          annotations: [],
          logprobs: [],
          text: "Running the tests. Key is sk-proj-LEAKEDinREPLY0123456789abcdef",
        },
      ],
      phase: "commentary",
      role: "assistant",
    },
    output_index: 1,
    sequence_number: 7,
  },
  {
    type: "response.output_item.added",
    item: { id: "ctc_1", type: "custom_tool_call", status: "in_progress", call_id: "call_1", input: "", name: "exec" },
    output_index: 2,
    sequence_number: 8,
  },
  {
    type: "response.custom_tool_call_input.delta",
    item_id: "ctc_1",
    output_index: 2,
    delta: "const r = ",
    sequence_number: 9,
  },
  {
    type: "response.output_item.done",
    item: {
      id: "ctc_1",
      type: "custom_tool_call",
      status: "completed",
      call_id: "call_1",
      input: 'const r = await tools.exec_command({cmd:"npm test",workdir:"/repo"}); text(r.output);\n',
      name: "exec",
    },
    output_index: 2,
    sequence_number: 10,
  },
  {
    type: "response.output_item.done",
    item: {
      id: "fc_1",
      type: "function_call",
      status: "completed",
      call_id: "call_2",
      name: "shell",
      arguments: JSON.stringify({
        command: ["bash", "-lc", "export GITHUB_TOKEN=ghp_1234567890abcdefghijABCDEFGHIJ123456"],
      }),
    },
    output_index: 3,
    sequence_number: 11,
  },
  {
    type: "response.output_item.done",
    item: {
      id: "ctc_2",
      type: "custom_tool_call",
      status: "completed",
      call_id: "call_3",
      name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: /repo/src/app.ts\n@@\n-old\n+new\n*** End Patch",
    },
    output_index: 4,
    sequence_number: 12,
  },
  {
    type: "responsesapi.websocket_timing",
    timing_metrics: { timing_scope: "logical_turn", response_id: "resp_1", total_turn_time_s: 2.7 },
  },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      object: "response",
      status: "completed",
      model: "gpt-6-sol",
      output: [],
      usage: {
        input_tokens: 30429,
        input_tokens_details: { cache_write_tokens: 0, cached_tokens: 30208 },
        output_tokens: 101,
        output_tokens_details: { reasoning_tokens: 20 },
        total_tokens: 30530,
      },
    },
    sequence_number: 13,
  },
];

/** The same turn as `POST /responses` answers it with `stream: true`. */
export const RESPONSES_SSE = RESPONSES_TURN.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** An unstreamed reply: the response object itself. */
export const RESPONSES_JSON: Json = {
  id: "resp_2",
  object: "response",
  status: "completed",
  model: "gpt-5.5-codex",
  output: [
    {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "git status", workdir: "/repo" }),
    },
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "All clean. DB_PASSWORD=hunter2hunter2", annotations: [] }],
    },
    { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "vitest 4 docs" } },
  ],
  usage: {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 150 },
    output_tokens: 42,
    total_tokens: 1242,
  },
};

/** A turn the API gave up on. */
export const RESPONSES_FAILED: Json[] = [
  {
    type: "response.created",
    response: { id: "resp_3", object: "response", status: "in_progress", model: "gpt-6-sol", output: [] },
  },
  {
    type: "response.failed",
    response: {
      id: "resp_3",
      object: "response",
      status: "failed",
      model: "gpt-6-sol",
      error: { code: "server_error", message: "The server had an error" },
      output: [],
      usage: null,
    },
  },
];

/** An error before any response: no model, not a turn. */
export const RESPONSES_ERROR: Json = {
  type: "error",
  status: 429,
  error: { type: "usage_limit_reached", message: "The usage limit has been reached" },
};

// ---------------------------------------------------------------------------
// Gemini generateContent (Gemini CLI)

/** A streamed turn from the Gemini API: a thought, text, then two function calls. */
export const GEMINI_CHUNKS: Json[] = [
  {
    candidates: [{ content: { role: "model", parts: [{ text: "Planning the fix", thought: true }] }, index: 0 }],
    usageMetadata: { promptTokenCount: 5400, totalTokenCount: 5400 },
    modelVersion: "gemini-3-pro",
    responseId: "r1",
  },
  {
    candidates: [{ content: { role: "model", parts: [{ text: "Running the tests. " }] }, index: 0 }],
    modelVersion: "gemini-3-pro",
  },
  {
    candidates: [
      {
        content: { role: "model", parts: [{ text: "Token: xoxb-123456789012-1234567890123-AbCdEfGhIjKl" }] },
        index: 0,
      },
    ],
    modelVersion: "gemini-3-pro",
  },
  {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { functionCall: { name: "run_shell_command", args: { command: "npm test", description: "Run tests" } } },
            { functionCall: { name: "read_file", args: { absolute_path: "/repo/src/app.ts" } } },
          ],
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 5400,
      cachedContentTokenCount: 4096,
      candidatesTokenCount: 57,
      thoughtsTokenCount: 12,
      totalTokenCount: 5469,
    },
    modelVersion: "gemini-3-pro",
  },
];

/** The streamed turn as `:streamGenerateContent?alt=sse` sends it. */
export const GEMINI_SSE = GEMINI_CHUNKS.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");

/** The same turn without `alt=sse`: one JSON array. */
export const GEMINI_ARRAY = JSON.stringify(GEMINI_CHUNKS);

/** Code Assist (Login with Google) wraps each chunk. */
export const CODE_ASSIST_SSE = GEMINI_CHUNKS.map(
  (c) => `data: ${JSON.stringify({ response: c, traceId: "t1" })}\n\n`,
).join("");

/** An unstreamed `:generateContent` reply, from a model that names itself only in the path. */
export const GEMINI_JSON: Json = {
  candidates: [
    {
      content: {
        role: "model",
        parts: [
          { text: "Wrote it." },
          { functionCall: { name: "write_file", args: { file_path: "/repo/src/new.ts", content: "x" } } },
        ],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 20, totalTokenCount: 320 },
};

/** An API error: not a turn. */
export const GEMINI_ERROR: Json = {
  error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" },
};
