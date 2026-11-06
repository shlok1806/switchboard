# A librarian spawn never ends as a plain Agent

Status: accepted on 2026-11-06. Adds to ADR 0045. Everything else in it stands.

## Context

The first librarian started in production ran as a plain Agent. The spawn reached the Channel 31 seconds after the release that has the librarian was deployed. The `agent.spawn` Event it recorded has no `librarian`, so the Host started `switchboard run claude` without `--librarian`. Claude Code then ran in `dontAsk` with only the Person's own permissions, the full Switchboard toolset and no brief, and nothing typed its first pass.

The code path itself is correct. An end-to-end run of the real `switchboard librarian` command, through the Worker and a real Host against `wrangler dev`, starts a working librarian. Production now refuses a malformed `librarian` field, so it runs that code.

The real problem is that an older part, whether a Channel or a Host, drops the field without saying so. The result is an Agent named `librarian` that may run every tool `dontAsk` allows it. ADR 0045's end-to-end test ran `run claude --librarian` directly, so it never went through the command, the Channel or the Host.

## Decision

- **The Channel.** It remembers which spawns are the librarian's, in a `librarian` column of `host_spawns`. When an Agent that is not a librarian registers in answer to one, the spawn fails, saying the Host's switchboard is older than the librarian, and the Channel asks the Host to stop that Agent.
- **The command.** `switchboard librarian` checks the Agent it gets back. If it is not a librarian, which is what a Channel older than the librarian answers, the command asks for that Agent to be stopped and fails, saying the Channel does not know the librarian yet.
- **The wrapper's idle tracking.** Hooks from a subagent (with `agent_id` in their input) no longer change whether the session is idle at its prompt. A background subagent's tool calls while the session waits are not a turn of the session, and no `Stop` would ever end them. Without this, a session would never be woken again.

## Verification

- `cli/test/e2e.test.ts`, "switchboard host": runs `switchboard librarian --host --cwd --model`, the real command, through the Worker to a real Host. It checks:
  - the `agent.spawn` Event says `librarian`
  - `agents.json` keeps it
  - the Agent is a librarian
  - Claude Code got `dontAsk`, `--strict-mcp-config`, the fixed brief and the deny rules
  - the first pass is typed at the prompt by itself
- `worker/test/librarian.test.ts`: a Host whose wrapper registers a plain Agent for a librarian spawn fails the spawn, and the Host is sent `host.stop` for that Agent.
- `cli/test/interrupts.test.ts`: a subagent's hooks leave the session at its prompt; the main thread's do not.
