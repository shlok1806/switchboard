# Hosts start and stop Agents with no window

Status: proposed on 2026-10-15, for the owner's direction "remotely start and stop agents from any worker and nothing shows up on the mac". Agent spawn authority (the "lead") is left to the roles ADR that supersedes ADR 0005.

## Context

Today an Agent exists only while a Person runs `switchboard run <cli>` in a terminal. Getting several Agents running means opening several terminals. The greenroom lead did this by driving Terminal.app with osascript, and those windows took focus and caught the Person's keystrokes. The owner wants Agents started and stopped from the Channel: from the Dashboard, from the API, and later by a lead Agent. They want them run on the Person's own Mac with nothing appearing on screen and nothing typed into anything the Person uses.

What the code already allows:

- `runCli` (cli/src/run.ts) runs one Agent per process, and only its pty wiring touches the terminal. With a stdin that is not a TTY it skips raw mode, uses 80x24, and writes the CLI's output to stdout. Nothing else changes. So `switchboard run claude` can run unchanged inside a pty that a supervisor owns.
- Directives, Interrupts and Wakes reach the session through `InterruptTyper`, which only needs the pty. With no Person typing, the typer never reports `person-typing`, so typed input waits only for `session-not-ready` or `dialog-open`. That is the "agent input, never person-typing" path the owner asked for.
- Registering an Agent takes the Person's session (`POST /api/agents`) and returns an Agent Token. The MCP server acts only with that token.
- The Channel has no notion of a machine.

## Decision

### A Host is a Person's machine, registered on the Channel

- A **Host** is one machine that one Person lets the Channel start Agents on. It is named `<person>/<name>`, for example `shlok1806/studio`, where the name defaults to the machine's short hostname. It belongs to exactly one Person, and a Person may have several Hosts.
- `switchboard host install [--name N] [--root DIR]... [--max-permission-mode M]` registers the Host with the Channel (`POST /api/hosts`, Person session) and writes a launchd LaunchAgent, `~/Library/LaunchAgents/dev.switchboard.host.plist`. The LaunchAgent runs `node <cli>/switchboard.js host run` with `RunAtLoad`, `KeepAlive` and `ProcessType: Background`. It records `PATH` and the config directory at install time, because launchd gives a job an almost empty environment. `switchboard host uninstall` removes both. `switchboard host status` reports what the Host runs.
- `switchboard host run` is the supervisor. It is a plain Node process with no window, no Dock icon and no Terminal. launchd starts it at login and restarts it if it dies, so it survives reboots. It can also run without launchd, which is how the e2e tests run it.
- The Host uses its Person's CLI login, the same `config.json` that `switchboard run` reads, and the same credential (ADR 0008). It is the Person's own machine and the same user account. It adds no new kind of credential and never receives an Agent Token except those of the Agents it runs.
- The Host opens the Channel's WebSocket as its Person with `?host=<name>`. The Channel tags the socket with the Host, and the Host is Live while that socket is attached. A Host whose socket closes is Offline, and the Channel stops routing to it.

### Start and stop are Channel operations

- **`POST /api/agents/spawn`** `{ host?, cli, cwd, nickname?, model?, brief?, permissionMode? }`, with a Person session:
  - It runs only on one of that Person's own Hosts: the one named, or else their most recently seen Live Host. It answers 409 when that Host is not attached.
  - `cli` is `claude-code` first. Codex and Gemini CLI come later, behind the same request.
  - It records `agent.spawn` (the request, by that Person, on that Host) and sends it to the Host over its socket.
  - The Host answers once the Agent has registered. The Channel then records `agent.spawned` with the request and the new Agent ID, or `agent.spawn.failed` with the reason.
- **`POST /api/agents/:id/stop`**, with a Person session, only for an Agent that Person owns and that a Host runs. It records `agent.stop` and sends it to that Host. The Agent goes Gone the usual way, when its wrapper ends the session.
- **A per-Channel cap** limits the Live Agents that Hosts run (`HOST_AGENTS_LIVE_CAP`, default 20). A spawn over the cap answers 409 with the cap.
- **The Agent row gets a `host` column**: which Host runs it, or none for an Agent started in a terminal. The Host passes `SWITCHBOARD_HOST` to the wrapper, which reports it when it registers. The Dashboard shows the Host on the Agent and offers Stop only for those Agents.
- **The MCP tools `agent_spawn` and `agent_stop`** call the same routes with the Agent Token. Until the roles ADR grants an Agent that authority, the Channel refuses both for every Agent Token, with a message saying a Person must grant it (ADR 0005: only People instruct). The tools ship now so the roles ADR only has to open the gate.
- **The Dashboard** gets "Start an Agent" on the Agents view (Host, folder, nickname, model, brief) and Stop on an Agent a Host runs, both only for that Person's own Hosts and Agents.
- **`switchboard spawn` and `switchboard stop <agent>`** call the same routes with the Person session, for scripts and for a Person at a terminal.

### What the Host runs

- For a spawn, the Host runs `switchboard run claude --nickname N [--model M] [--permission-mode P] [-- "<brief>"]` in a node-pty it owns (200x50), in `cwd`.
  - `cwd` must sit under one of the Host's `--root` folders. The wrapper's own check, a plain clone of the Channel's repo, still applies.
  - The brief is the session's first prompt. It counts as the requesting Person's words, labelled as from them, the way a Directive is.
- **Environment.**
  - Every spawn gets `ENABLE_TOOL_SEARCH`. Without it, Claude Code turns tool search off for a base URL that is not first-party, which the wrapper's proxy is, and loads every MCP schema in full. The fix PR checks that the proxy forwards `tool_reference` blocks before choosing `true` or `auto`.
  - The nested-session markers Claude Code sets for its own children are removed. These include `CLAUDE_CODE_CHILD_SESSION`, which turns transcript saving off and so makes the Agent impossible to resume. The fix PR lists the rest from a nested session's environment.
  - `CLAUDE_CODE_AUTO_COMPACT_WINDOW` passes through from the request or from the Host's environment.
  - The first two are fixed in `switchboard run claude` itself, in their own PRs, so terminal Agents get them too. The Host relies on that fix.
- **The permission mode** is at most the Host's `--max-permission-mode` (default `default`). A request for a looser mode is refused, not lowered. In `default` mode a prompt waits for its Person. They see it on the Channel (ADR 0013) and can deny it there (ADR 0014), or approve it later at the Host's log view (a later step).
- **Logs.** Each Agent's raw pty output is appended to `<config>/host/logs/<agent>.log`, capped at 20 MB with one rotation. The Host's own log is `<config>/host/host.log`.
- **Restarts and resumes.** The Host records every Agent it runs in `<config>/host/agents.json`: session ID, cwd, nickname, model and mode, never the brief.
  - When a wrapper exits without a stop request (a crash), the Host resumes the session with `--resume <session-id>`, at most 3 times in 10 minutes.
  - When the Host itself starts after a reboot or a crash, it resumes every Agent it was running.
  - A resumed session is the same Agent: its Agent ID comes from the session ID.
- **Stop.** The Host sends SIGTERM to the wrapper, which forwards it to the CLI and ends the session on the Channel. After 10 s it sends SIGKILL.
- **No startup dialog is answered for the Person.**
  - A folder Claude Code has not trusted shows its trust dialog. The Host reports that spawn as failed ("the folder is not trusted: run claude there once") instead of typing an answer.
  - Hosts never write `~/.claude.json` or any CLI's settings.

### Every action is on the Channel

`agent.spawn`, `agent.spawned`, `agent.spawn.failed` and `agent.stop` are Events with the acting Person or Agent as actor. Hosts are listed at `GET /api/hosts`. Host Events (`host.online`, `host.offline`) are recorded only when Presence changes, so a flapping connection does not flood the Channel.

## Consequences

- A Person's session can now start processes on their own machine, through the Channel. Someone holding a stolen session, or the Worker itself, can do what that Person's Agents can do, in the folders that Person listed and at most in the permission mode they allowed at install. That is the reason for `--root` and `--max-permission-mode`, and for a default of `default`.
- Installing the LaunchAgent makes macOS show its "Background Items Added" notification once. That is the only thing that appears, and only at install, which the Person does themselves. Nothing appears when an Agent is started or stopped.
- An Agent that a Host runs has no terminal anyone sees. Its pending prompts reach its Person on the Channel. Answering a prompt with an approval, and a live terminal view with takeover, come in later steps.
- A Person's session lasts 30 days. A Host whose session has expired cannot start Agents and says so in its log and on the Channel (`host.offline` with the reason) until the Person logs in again.
- Agents cannot start or stop Agents until the roles ADR grants that. The greenroom lead needs that ADR before it moves onto Hosts.

## Verification

End to end on the owner's Mac, with `switchboard host run` under a headless parent:
- start a real Claude Code Agent from the Dashboard and from `POST /api/agents/spawn`;
- send it a Directive, see it take a turn and post to the Channel;
- stop it.

Compare the CGWindowList window list and `ps` before and after: no new window, no Terminal, no WezTerm. A unit test covers the LaunchAgent plist. Installing it into the owner's launchd is left to the owner.
