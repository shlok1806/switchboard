hi cutie

## Running an agent CLI through Switchboard

```sh
switchboard login --url <channel url> --secret <join secret> --name <your name>
switchboard run claude [--nickname <name>] [--proxy raw|digest|off] [--no-mask] [...claude arguments]
switchboard run codex  [--nickname <name>] [...codex arguments]
switchboard run gemini [--nickname <name>] [...gemini arguments]
```

The wrapper sets up hooks, Switchboard's MCP tools and the proxy for each session
only: `--settings`/`--mcp-config` files for Claude Code, `-c key=value` overrides for
Codex, and a settings file named by `GEMINI_CLI_SYSTEM_SETTINGS_PATH` for Gemini CLI.
It never writes to `~/.claude`, `~/.codex` or `~/.gemini`.

Agent IDs are `<person>/<cli>/<4 characters of the session ID>`: the first 4 for Claude
Code and Gemini CLI, and the last 4 for Codex, whose UUIDv7 thread IDs all start with
the clock. A resumed session (`claude --resume <id>`, `codex resume <id>`,
`gemini --resume <id>`) keeps its Agent ID.

| | Claude Code | Codex | Gemini CLI (unverified, see below) |
|---|---|---|---|
| Hook Capture | SessionStart, PostToolUse, Stop, SessionEnd | SessionStart, PostToolUse (shell, apply_patch, MCP), Stop, SessionEnd | SessionStart, AfterTool, AfterAgent, SessionEnd |
| Switchboard MCP tools | yes | yes (approved for the session) | yes |
| Proxy Capture | raw or digest | not supported, `--proxy off` | not supported, `--proxy off` |
| Next-turn delivery | SessionStart / UserPromptSubmit hooks | SessionStart / UserPromptSubmit `additionalContext`; `read_channel` fallback | SessionStart / BeforeAgent `additionalContext` |
| Interrupts and Directives | typed mid-turn | typed mid-turn | downgraded to Queue, labelled `cli-cannot-interrupt` |

The Proxy Capture only understands Anthropic's Messages API, so `run codex` and
`run gemini` refuse `--proxy raw|digest`.

### Codex hooks and trust

Codex may run session hooks only after you trust them in its `/hooks` screen. The
hook command is the same in every session (the socket path comes from the
environment), so you trust it once. If no SessionStart hook arrives within a few
seconds of your first prompt, the wrapper prints:

> Codex has not run Switchboard's hooks yet. Open /hooks in Codex and trust the
> switchboard hooks (once; they stay trusted). Until then, Queued Events reach this
> Agent through the read_channel tool.

Until the hooks run, the wrapper:

- finds the session from the file Codex writes under `$CODEX_HOME/sessions`;
- hands the standing rule, Queued Events and Directives to the Agent at its next
  `read_channel` call;
- holds Interrupts for the Queue (`session-not-ready`), because without hooks it
  cannot tell whether a dialog is open.

codex-cli 0.159.1 ran the `-c` hooks without asking. Switchboard never uses
`--dangerously-bypass-hook-trust` and never writes trust entries.

Codex's sandbox confines the commands the model runs. Hooks and MCP servers are
started by Codex itself, outside the sandbox. If a hook still cannot reach the
wrapper's socket, it exits 0 without output and the session carries on without
that event.

### Gemini CLI

Gemini CLI was not installed on the machine this was built on. Its adapter follows
Gemini CLI's hook documentation and is tested only against a stand-in: hook names,
the `additionalContext` output, `GEMINI_CLI_SYSTEM_SETTINGS_PATH` and `hooksConfig`
are unverified against the real CLI. Interrupts stay downgraded until typing into
Gemini CLI mid-turn has been seen to work.
