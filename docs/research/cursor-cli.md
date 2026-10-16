# Cursor CLI (`cursor-agent`) research

Sources: `cursor-agent --help` and subcommand help on this machine (2026.10.16-e3cb207), [Cursor hooks](https://cursor.com/docs/hooks), [CLI parameters](https://cursor.com/docs/cli/reference/parameters), [CLI configuration](https://cursor.com/docs/cli/reference/configuration).

## Binary and session

- Command on PATH: `cursor-agent` (help text says `agent`).
- Interactive agent: default invocation or `agent [prompt...]`.
- Headless: `--print` (`-p`) with `--output-format text|json|stream-json` (all tools, including shell).
- Session resume: `--resume [chatId]`, `--continue` (latest), `resume`, `ls`.
- New chat ID without UI: `create-chat` prints a UUID on stdout.
- Model: `--model <id>` (e.g. `composer-2.5`); `models` / `--list-models` list account models.
- API endpoint override: `-e` / `--endpoint` or `CURSOR_API_ENDPOINT` (default `https://api2.cursor.sh`).
- Auth: `CURSOR_API_KEY` or `login` / stored session; `status` / `whoami` show login email.
- Workspace: `--workspace`, `--trust` (trust workspace without prompting), `--approve-mcps`, `--force` / `--yolo`.

## Hooks

Config file (not `cli-config.json`):

| Scope | Path |
| --- | --- |
| Project | `.cursor/hooks.json` (scripts run from repo root; use `.cursor/hooks/...` paths) |
| User | `~/.cursor/hooks.json` |

Schema: `{ "version": 1, "hooks": { "<event>": [{ "command": "...", "type": "command", "timeout": N, "matcher": "..." }] } }`.

Agent events include `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `beforeShellExecution`, `afterShellExecution`, `beforeSubmitPrompt`, `stop`, and others. Each hook receives JSON on stdin with `hook_event_name`, `conversation_id`, `session_id`, `transcript_path`, `tool_name`, `tool_input`, `tool_output`, etc.

Outputs:

- `sessionStart`: `{ "env": {...}, "additional_context": "..." }` (fire-and-forget; context is injected).
- `beforeSubmitPrompt`: `{ "continue": true|false }` only (no `additional_context` in documented output).
- `stop`: optional `followup_message` for auto-continue loops.

Injected env in every hook: `CURSOR_PROJECT_DIR`, `CURSOR_VERSION`, `CLAUDE_PROJECT_DIR`; `CURSOR_USER_EMAIL` when logged in; `CURSOR_TRANSCRIPT_PATH` when transcripts are enabled.

There is no documented env var to point at an alternate `hooks.json` for one run. Per-session injection without touching `~/.cursor/hooks.json` is done by a temporary project `.cursor/hooks.json` (restored when the session ends) or `--plugin-dir` for plugin-bundled hooks.

## MCP

| Scope | Path |
| --- | --- |
| Project | `.cursor/mcp.json` |
| User | `~/.cursor/mcp.json` |

`mcp login|list|list-tools|enable|disable` subcommands. CLI flag `--approve-mcps` auto-approves servers for the session.

## CLI config (not hooks)

- Global: `~/.cursor/cli-config.json` (`CURSOR_CONFIG_DIR`, `XDG_CONFIG_HOME` on Linux).
- Project: `.cursor/cli.json` (permissions only).

Default model is stored under `model.modelId` in `cli-config.json`.

## Transcripts

Under `~/.cursor/projects/<encoded-path>/agent-transcripts/<chat-id>/<chat-id>.jsonl`. Hooks expose `transcript_path` when enabled.

## Gaps for Switchboard

- Proxy Capture: traffic uses Cursor's API at `api2.cursor.sh`; no public Responses/Messages schema documented for a local digest parser yet. `CURSOR_API_ENDPOINT` can aim the CLI at a proxy once a reader exists.
- Next-turn context after the first prompt: only `sessionStart` documents `additional_context`; `beforeSubmitPrompt` does not. Queue and Directives after turn one rely on `read_channel` or a Wake until verified otherwise.
- Interrupts mid-turn: not verified in this research; treat like Gemini CLI until tested.
