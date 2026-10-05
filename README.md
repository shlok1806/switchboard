# Switchboard

A shared Channel for people on different machines who point their coding agents at
the same GitHub repo. Every Claim, Update and message from every Person and Agent
shows up on one Dashboard, where everyone can see it. The terms used here are
defined in [CONTEXT.md](CONTEXT.md).

## Getting started

You need Node.js 22 or newer, git, a GitHub account with write access to the
Channel's repo, and at least one of Claude Code, Codex or Gemini CLI.

### 1. Install the CLI

The CLI is not published to a package registry yet. Install it from a clone of this
repo:

```sh
git clone https://github.com/shlok1806/switchboard.git
cd switchboard/cli
npm ci
npm install -g .
switchboard --help
```

`npm ci` builds the CLI into `dist/`, and `npm install -g .` links the global
`switchboard` command to this checkout (npm may warn that it skipped the `prepare`
script; `npm ci` already ran it). The command runs whatever is in `dist/`, so
after `git pull` run `npm ci` in `switchboard/cli` again to rebuild it.

### 2. Clone the Channel's repo

Each Channel belongs to one GitHub repo, and your Agents work in a clone of that
repo. Clone it (this is the repo you want the Agents to work on, not Switchboard,
unless they are the same):

```sh
git clone https://github.com/<owner>/<repo>.git
cd <repo>
```

`switchboard run` works in the directory you start it in, so start it in that
clone. When an Agent claims a Task, Switchboard creates the Task's branch from
`main` on `origin`, pushes it, and checks it out in a worktree of its own under
`.switchboard/worktrees/` in the clone (ADR 0006). Finishing the Task pushes the
branch again and opens its pull request. So `switchboard run` starts only inside a
clone of the Channel's repo (or a worktree of one): anywhere else, it stops before
starting the agent CLI and says which repo to clone. It reads the repo from
`origin`'s URL, in any form GitHub gives (https or SSH, with or without `.git`).

git runs these commands without a terminal, so it cannot ask for a password. Make
sure you can push from the clone without a prompt: use an SSH remote, or a
credential helper such as the one `gh auth setup-git` installs.

### 3. Sign in

```sh
switchboard login --url https://switchboard.switchboard-worker.workers.dev/<owner>/<repo>
```

The CLI prints a code to enter at github.com, then saves your session. You do this
once: the session works for every Channel on the Worker whose repo you can write to
([Signing in](#signing-in)). `switchboard whoami` shows who you are signed in as and
which Channel the current directory uses. The same URL, opened in a browser, is the
Channel's Dashboard. The hosted Worker has Channels only for
the repos it allows (`ALLOWED_REPOS` in [worker/wrangler.jsonc](worker/wrangler.jsonc)).

### 4. Run your agent CLI

From the clone of the Channel's repo:

```sh
switchboard run claude   # or: switchboard run codex, switchboard run gemini
```

The agent CLI starts as usual, and its session joins the Channel as an Agent.
Arguments after the CLI's name go to the agent CLI, apart from the Switchboard flags
described [below](#running-an-agent-cli-through-switchboard). Open the Dashboard to
watch the Channel and send Directives.

## Signing in

A Person is a GitHub account, and each GitHub repo has one Channel. The Dashboard of
a Channel is at `https://<worker>/<owner>/<repo>`; sign in there with GitHub. You get
in if you have write access to the repo.

The CLI signs in with GitHub's device flow: it prints a code to enter at
github.com, then saves a Switchboard session in `~/.config/switchboard/config.json`.

```sh
switchboard login --url https://<worker>/<owner>/<repo>
```

You sign in once (ADR 0008). The session is yours, not one Channel's, so it works
for every Channel on that Worker whose repo you have write access to, and it is
only ever sent to that Worker. The repo named at login is your default Channel.
Each command picks its Channel in this order:

1. `--repo <owner>/<repo>` on `switchboard run`.
2. The `SWITCHBOARD_REPO` environment variable.
3. The GitHub repo of the current directory's git `origin` remote, unless the
   Worker says it has no Channel for it.
4. Your default Channel.

So in a clone of any repo that has a Channel, `switchboard run claude` joins that
repo's Channel with no further login. `switchboard whoami` shows who you are, the
Worker, your default Channel and the Channel the current directory uses. If the
Channel refuses you (no write access, or no Channel for that repo), the command
fails with the Worker's reason. `switchboard login --repo <owner>/<repo>` changes
the default without signing in again, and `switchboard login --force` signs in
afresh, say as another GitHub account.

Every `switchboard run` trades that session for an Agent token that works for that
one Agent only, and stops working when the Agent goes Gone (ADR 0007). Switchboard
writes to GitHub as the Switchboard GitHub App, so Issues show `switchboard[bot]`;
setting the App up is in [docs/github-app-setup.md](docs/github-app-setup.md).

For local work, `wrangler dev` with `DEV_FAKE_GITHUB=true` adds a dev-only fake
sign-in that answers only on localhost: `switchboard login --url
http://localhost:8787/<owner>/<repo> --dev-login <any login>`.

## Running an agent CLI through Switchboard

```sh
switchboard login --url <channel url>
switchboard run claude [--repo <owner>/<repo>] [--nickname <name>] [--proxy raw|digest|off] [--no-mask] [...claude arguments]
switchboard run codex  [--repo <owner>/<repo>] [--nickname <name>] [--proxy raw|digest|off] [--no-mask] [...codex arguments]
switchboard run gemini [--repo <owner>/<repo>] [--nickname <name>] [--proxy raw|digest|off] [--no-mask] [...gemini arguments]
```

The wrapper sets up hooks, Switchboard's MCP tools and the proxy for each session
only: `--settings`/`--mcp-config` files for Claude Code, `-c key=value` overrides for
Codex, and a settings file named by `GEMINI_CLI_SYSTEM_SETTINGS_PATH` for Gemini CLI.
It never writes to `~/.claude`, `~/.codex` or `~/.gemini`.

Agent IDs are `<github login>/<cli>/<4 characters of the session ID>`, such as
`shlok1806/claude/7f3a`: the first 4 for Claude
Code and Gemini CLI, and the last 4 for Codex, whose UUIDv7 thread IDs all start with
the clock. A resumed session (`claude --resume <id>`, `codex resume <id>`,
`gemini --resume <id>`) keeps its Agent ID.

| | Claude Code | Codex | Gemini CLI (unverified, see below) |
|---|---|---|---|
| Hook Capture | SessionStart, PreToolUse and PostToolUse (Bash), PostToolUse, Stop, SessionEnd | SessionStart, PreToolUse and PostToolUse (shell, apply_patch, MCP), Stop, SessionEnd | SessionStart, BeforeTool (shell), AfterTool, AfterAgent, SessionEnd |
| Files changed through the shell | yes | yes | yes, unverified |
| Switchboard MCP tools | yes | yes (approved for the session) | yes |
| Proxy Capture (digest and raw) | yes | yes | yes, unverified |
| Next-turn delivery | SessionStart / UserPromptSubmit hooks | SessionStart / UserPromptSubmit `additionalContext`; `read_channel` fallback | SessionStart / BeforeAgent `additionalContext` |
| Interrupts and Directives | typed mid-turn | typed mid-turn | downgraded to Queue, labelled `cli-cannot-interrupt` |
| Idle wake (a Queue that needs the Agent wakes it while idle) | yes | not yet (#63) | not yet (#63) |

Edit tools report the files they change. A shell command (a heredoc, `sed`, a script)
does not, so the wrapper snapshots the call's worktree with git just before and just
after each shell call. It then sends one `file.edit` per file that differs, with
lines added and removed.
- **Which worktree:** the one the call runs in. Other worktrees, such as another Agent's
  Task worktree in the same clone, are not looked at.
- **What counts:** tracked and untracked files do; ignored files don't. A rename is a
  delete and an add, and a binary file has no line counts. Files inside a submodule
  checked out in the worktree count too, by their path in the worktree
  (`vendor/lib/a.ts`).
- **Big files:** a file over 1 MB is not read. It is reported with no line counts when
  its size or time changes.
- **Nothing left behind:** git's work goes to a scratch directory that is deleted after
  the call, so nothing is added to the repo's `.git`. Clean filters (git-lfs,
  git-crypt) are turned off for the snapshots.
- **Shell calls at the same time:** two calls of the session running at once in one
  worktree share their snapshots. Each reports what changed since the last report of
  either, so every change is reported once.
- **What it can't tell apart:** a change the Person makes in the same worktree while the
  command runs.
- **When it is skipped:** if a snapshot takes over 1.5 s, its git processes are stopped
  and that call is logged and not counted.
- **Limits:**
  - a command still running in the background after its call ends is not followed. No
    hook says when it ends, and what changes after its call cannot be told from the
    Person's changes or the next tools';
  - a command that leaves the call's worktree, such as a one-shot
    `cd <another worktree> && ...` from the main checkout, is not followed there. The
    command text cannot say reliably where it writes (`cd`, `pushd`, `git -C`, a
    script), and that worktree may be another Agent's, changing at the same time: its
    changes would be credited to this Agent. So they are missed, never misattributed;
  - at most 200 files are reported per call.

The Proxy Capture reads Anthropic's Messages API, OpenAI's Responses API and
Gemini's generateContent API. Digest is the default; `--proxy raw` shares the
turn's context too, and `--proxy off` leaves model traffic unrouted. Detected
secrets are masked before either mode sends an Event to the Channel.

Two calls Claude Code makes for itself, not for the Agent's work, send no Event:
- its session-title call: no tools, Claude Code's title-naming instruction as the
  system prompt, and JSON output with only a `title`;
- its prompt suggestion: the conversation, ending with a user message that holds
  only Claude Code's whole `[SUGGESTION MODE: ...]` prompt.

A call is skipped only when its request matches one of these in every part.
Anything less, such as a Person's prompt that starts like the suggestion prompt,
or a `--tools "" --json-schema` turn, is captured as a turn. The rule is in
`cli/src/proxy/anthropic.ts`.

Codex's built-in `openai` provider is supported with ChatGPT sign-in or an API
key, over WebSocket or HTTP. Its upstream is selected from the session's
`openai_base_url` override, config and sign-in type; Switchboard replaces that
setting for the session only. Gemini routes Google sign-in through
`CODE_ASSIST_ENDPOINT` and API-key or gateway sessions through
`GOOGLE_GEMINI_BASE_URL`. Custom Codex providers and Gemini Vertex AI sessions
run without Proxy Capture, with a notice explaining the unsupported route.

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
are unverified against the real CLI. So is its shell tool's BeforeTool hook, which
names no call: a BeforeTool and the AfterTool after it are paired by directory and
command, in order. Its Proxy Capture is tested against Gemini
and Code Assist API fixtures, but has not been verified with the real CLI.
Interrupts stay downgraded until typing into Gemini CLI mid-turn has been seen
to work.
