# Each Agent shows the model it runs on, as its requests ask for it

A Person running several Agents wants to see which model each one runs on, next to its Account Label (ADR 0009). The model can change mid-session (`/model` in Claude Code), and an agent CLI picks a default nobody typed, so a flag or a config file is not enough.

The source of truth is the model the agent CLI actually asks for. The Proxy Capture already reads every model request; it now also keeps the request's `model` field and its reasoning effort when the request names one (`output_config.effort` for the Messages API, `reasoning.effort` for the Responses API). Gemini CLI names the model in the request path, which the Proxy Capture already reads. Nothing else is taken from a request for this: no prompts, no tokens, no tool lists.

Claude Code's subagents can run on another model than the session. Only its main thread offers the tool that starts subagents (`Agent`, once `Task`), so once a request offering it has been seen, requests without it do not count. Codex and Gemini CLI requests all count.

The wrapper reports a model once it has been the latest for 2 seconds, so a burst of turns reports once, with `POST /api/agents/:id/model` (`{ model, effort, via: "proxy" }`) using the Agent's own token; its own Person may call it too. The Agent gets optional `model` and `effort` fields. Each change is an `agent.model` Event, `{ from?, to?, effort? }`, actor the Agent, Capture `proxy` when the Proxy Capture saw it; the Relay ignores it. A report that fails is tried again at the next turn.

Before the first request, and for sessions without the Proxy Capture (`--proxy off`, a Codex custom provider, Gemini on Vertex AI), the wrapper sends at registration what the CLI is told to start on: its `--model`/`-m` argument, else its config default (`ANTHROPIC_MODEL` or `model` in Claude Code's settings files; `model` and `model_reasoning_effort` at the top of Codex's `config.toml`, or `-c` overrides; `GEMINI_MODEL` or `model.name` in Gemini CLI's settings). Without the proxy it does not follow a mid-session switch. When nothing names a model, none is shown: a CLI's built-in default is never guessed. Registering again within a session sends the model the Channel last had, so a switch the proxy saw is kept.

The Dashboard and the `list_agents` tool show a short name, such as "Opus 5.5", "GPT-5 Codex" or "Gemini 3 Pro", with the raw ID on hover (in the tool, beside it). An ID the Dashboard does not know shows as it is.

Every new field is optional: a wrapper from before this ADR registers without a model, and its Agents show none.
