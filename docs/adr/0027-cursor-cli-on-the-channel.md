# Cursor CLI on the Channel (`switchboard run cursor`)

Status: accepted on 2026-10-16.

## Context

Switchboard already wraps Claude Code, Codex and Gemini CLI with per-session hooks and MCP, without writing each CLI's global config (README). The owner runs Cursor's CLI (`cursor-agent`) and wants the same Channel integration: Hook Capture, Tool Capture, model and Account Label reporting, next-turn delivery, and Interrupt handling or an honest downgrade.

Research is in `docs/research/cursor-cli.md` (CLI help and Cursor docs).

## Decision

`switchboard run cursor` uses a **cursor** adapter (`cli/src/clis/cursor.ts`).

### Per-session injection (no global config)

- **Hooks:** For the session only, Switchboard merges its hook commands into the repo's `.cursor/hooks.json`, backing up and restoring the file on exit. Hooks read the wrapper socket from `SWITCHBOARD_HOOK_SOCKET` (same as Codex). The CLI is started with `--trust` and `--approve-mcps` so project hooks and the Switchboard MCP server run without prompts.
- **MCP:** Switchboard merges its server into `.cursor/mcp.json` for the session, restored on exit.
- **Not used:** `~/.cursor/hooks.json`, `~/.cursor/mcp.json`, and `~/.cursor/cli-config.json` are never written by the wrapper.

### Session ID and Agent ID

- New sessions: the wrapper runs `cursor-agent create-chat`, registers the Agent with that UUID, and passes `--resume <id>` to the CLI (`picked` retry like Claude Code when the short Agent ID collides).
- Resume: `--resume <uuid>` or `--continue` (discover from hooks).
- Agent ID: `cursor` short name, first four characters of the session UUID (same rule as Gemini CLI).

### Hook Capture

Cursor events are translated to Claude Code names the capture already understands: `sessionStart`, `beforeSubmitPrompt`, `preToolUse`, `postToolUse`, `beforeShellExecution`, `afterShellExecution`, `stop`, `sessionEnd`. Shell execution hooks feed the same shell-edit snapshot path as other CLIs.

### Next-turn delivery

- **sessionStart** answers with Cursor's `additional_context` (standing rule, Hand-off Brief, Queue, Directives framed for the model).
- **beforeSubmitPrompt** does not document `additional_context` in Cursor's hook output schema, so deliveries after the first turn rely on the **`read_channel` MCP tool** (and Wakes when interrupts are enabled later) until a hook is verified to carry context on every prompt.

### Interrupts and Directives

Not verified on the real CLI at ADR time. The adapter sets `interrupts: false`; the Relay delivers Interrupts and Directives as **Queue**, labelled `cli-cannot-interrupt`, as for Gemini CLI.

### Proxy Capture

**Missing.** The CLI supports `CURSOR_API_ENDPOINT` / `-e`, but Switchboard has no reader for Cursor's private API yet. `--proxy` is rejected for `run cursor` until one exists. Model at registration comes from `--model` or `model.modelId` in `cli-config.json` (ADR 0010).

### Account Label

From `--account-label`, `$SWITCHBOARD_ACCOUNT_LABEL`, or `cursor-agent status` (masked email).

### README support table (Cursor column)

| Row | Cursor |
| --- | --- |
| Hook Capture | sessionStart, pre/post tool and shell hooks, stop, sessionEnd |
| Files changed through the shell | yes (unverified on real CLI until E2E) |
| Switchboard MCP tools | yes |
| Proxy Capture | **missing** |
| Next-turn delivery | sessionStart `additional_context`; `read_channel` after first prompt |
| Interrupts and Directives | Queue, `cli-cannot-interrupt` |
| Idle wake | not yet (#63) |

### Dashboard

CLI label **Cursor**; identity token `--cli-cursor` in the design system (ADR 0016 / 0023), same monochrome rule as other CLIs.
