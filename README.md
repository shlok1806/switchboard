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
switchboard run claude [--repo <owner>/<repo>] [--nickname <name>] [--account-label <label>] [--proxy raw|digest|off] [--no-mask] [...claude arguments]
switchboard run codex  [--repo <owner>/<repo>] [--nickname <name>] [--account-label <label>] [--proxy raw|digest|off] [--no-mask] [...codex arguments]
switchboard run gemini [--repo <owner>/<repo>] [--nickname <name>] [--account-label <label>] [--proxy raw|digest|off] [--no-mask] [...gemini arguments]
switchboard rename <agent> <nickname>|--clear [--repo <owner>/<repo>]
switchboard spawn [--host <name>] [--cwd <folder>] [--nickname <name>] [--model <id>] [--permission-mode <mode>] [--repo <owner>/<repo>] [brief...]
switchboard stop <agent> [--repo <owner>/<repo>]
switchboard host install|uninstall|run|status
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

### Nicknames and Account Labels

A Nickname is a readable name beside the Agent ID, unique on the Channel (ADR 0009).
`--nickname` sets one at start, and it can change while the Agent runs, with no
restart: the Agent calls its `rename` tool, any Person on the Channel runs `switchboard
rename <agent> <nickname>` (the Agent by its ID, its ID without the login such as
`claude/7f3a`, or its Nickname), or renames it on its Dashboard page. Everyone sees the
new name at once. Events keep the Agent ID, every view shows the current Nickname
beside it, and each rename is an `agent.rename` Event that reads old -> new. A name
another running Agent holds is refused; one held only by a Gone Agent is taken from it.
`--nickname` with a taken name starts the session without it and says so.

The Account Label says which login of its CLI the Agent runs under, shown beside it on
the Dashboard and in the `list_agents` tool. `--account-label` or
`SWITCHBOARD_ACCOUNT_LABEL` sets it (empty sends none). Otherwise the wrapper masks the
login's email address: `oauthAccount.emailAddress` in `.claude.json` under
`$CLAUDE_CONFIG_DIR` (or `~/.claude.json`) for Claude Code, the active account in
`~/.gemini/google_accounts.json` for Gemini CLI, so `shlokat2@illinois.edu` shows as
`sh…@illinois.edu`. Codex gets none unless you set it: its login sits next to its
tokens, which the wrapper never reads.

Beside it the Dashboard and `list_agents` show the model each Agent runs on, by a short
name ("Opus 5.5", "GPT-5 Codex") with the raw ID on hover (ADR 0010). It comes from the
model requests themselves, through the Proxy Capture, so it follows `/model` and the
CLI's own default; each change is an `agent.model` Event. Only the model ID and the
reasoning effort are read for it. Without the proxy the Agent shows what `--model` or
the CLI's config names, and does not follow a switch; with neither, no model is shown.

For Claude Code Agents the Dashboard also shows usage (ADR 0011): an Accounts panel with
one card per Claude account, by its full email address and plan, with the session, week
and per-model week limits from Claude Code's own `/usage`, their resets, and the Agents
running on it with their requests, tokens and estimated cost. The wrapper reads it at
the start, after every turn and every 5 minutes (at most once a minute), using the
session's own login. `SWITCHBOARD_USAGE=off` turns it off.

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

### Permission prompts and unattended Agents

An Agent stops whenever its CLI asks its Person to approve something: Codex's
approval dialog when a command needs to leave its sandbox (building and running a
daemon, `tart`, VMs), and Claude Code's permission prompt in its `default` mode. While
the prompt is open, the Agent card on the Dashboard shows **Waiting for approval**: the
tool, what it asks to run (the command or path, with detected secrets masked), the
CLI's reason, and since when (ADR 0013). The Channel API carries the same thing as the
Agent's `approval` in `GET /api/agents`, and the feed records an `approval.pending`
Event and an `approval.closed` Event. Answer the prompt at the Agent's terminal.

For a Claude Code Agent, its own Person can also **Deny** the prompt from the card,
with a message the Agent reads instead of running the command (ADR 0014). The Agent
reads "Denied by <you> from the Switchboard Channel." and your message, then moves on.
Nobody can approve a command from the Channel, and no other Person and no Agent can
deny one. The API call is `POST /api/agents/:id/approval/deny` with
`{ "id": "<the approval's id>", "message": "..." }`, with your own session. It works
while the Agent's wrapper is connected, once per prompt. Codex's prompts are answered
only at the terminal for now.

An Agent meant to run unattended needs a policy that never asks. `switchboard run`
passes every argument it does not own to the CLI unchanged, so the CLI's own flags work:

```sh
# Codex: never ask. Commands that need to leave the sandbox fail, and the model sees the failure.
switchboard run codex -a never -s workspace-write
# Codex: never ask, and no sandbox. Every command runs with your full rights.
switchboard run codex --dangerously-bypass-approvals-and-sandbox
# Claude Code: its auto mode, where a classifier approves or refuses each action instead of you.
switchboard run claude --permission-mode auto
# Claude Code: no permission checks at all.
switchboard run claude --dangerously-skip-permissions
```

Pick the narrowest policy the work allows. Without a sandbox and without prompts,
nothing stands between a bad command and your machine: not one the model gets wrong,
and not one a file, issue or web page talked it into. Switchboard's own MCP tools are
approved for the session either way.

### Hosts: Agents with no terminal

A Host is one of your machines that starts and stops Claude Code Agents for you, with
no window (ADR 0015). Install it once on the machine:

```sh
switchboard host install --root ~/code/my-repo --max-permission-mode acceptEdits
```

That registers the Host on the Channel (named after the machine, or `--name`) and
installs a LaunchAgent, `~/Library/LaunchAgents/dev.switchboard.host.plist`, that runs
`switchboard host run` at login as a background process and restarts it if it dies.
Agents start only in a `--root` folder or under one, and in at most the
`--max-permission-mode` (`plan`, `dontAsk`, `default`, `acceptEdits`, `auto`,
`bypassPermissions`, strictest first; `default` if you leave it out).

Then start an Agent from any terminal, or with **Start an Agent** on the Dashboard's Agents page:

```sh
switchboard spawn --cwd ~/code/my-repo --nickname builder "Fix the login redirect."
switchboard stop builder
```

The brief is the session's first prompt, labelled as your Directive. The Host runs
`switchboard run claude` in a pty of its own, so the Agent is on the Channel like any
other, and `GET /api/agents` names its `host`. Only you can start or stop Agents on your Hosts,
and Hosts on a Channel run at most `HOST_AGENTS_LIVE_CAP` Agents at once (20).

- A folder Claude Code has not trusted fails the spawn: the Host never answers the
  trust dialog for you. Run `claude` there once and accept it.
- An Agent whose CLI crashes is resumed in the same session, at most 3 times in 10
  minutes. Agents the Host runs are resumed after a reboot too.
- `switchboard host status` shows the Host, its Agents and its files under
  `~/.config/switchboard/host/`: each Agent's terminal output is in `logs/<agent>.log`.
- An Agent on a Host shows the Host's name on its row, and its page has a **Stop** button
  for its own Person.
- `switchboard host uninstall` unloads the LaunchAgent and removes the Host.

### Leads: an Agent that runs a team

You can make one of your Agents a lead (ADR 0017). It may then start Agents on your
Hosts with its `agent_spawn` tool, and steer and stop the Agents it starts with
`send_directive` and `agent_stop`. Grant and revoke it from a terminal, or with
**Make lead** on the Agent's page:

```sh
switchboard role grant planner lead
switchboard role revoke planner
```

- Only you grant your Agents a role. An Agent never can, for itself or another.
- A lead acts only on its subtree: the Agents it started, and theirs. It cannot stop or
  direct your other Agents, anyone else's, or itself.
- Its Agents run on your Hosts within their folders and `--max-permission-mode`, and one
  lead has at most `LEAD_AGENTS_LIVE_CAP` Agents running or starting (5).
- A lead's Directive and brief read as from the lead you put over that Agent. Your own
  word still wins, and a lead's Directive never lets an Agent be woken again.
- Every grant, revoke, spawn, Directive and stop is an Event on the Channel. An Agent's
  page shows its role and the lead that started it.

### Codex hooks and trust

Codex may run session hooks only after you trust them in its `/hooks` screen. The
hook command is the same in every session (the socket path comes from the
environment), so you trust it once. Codex itself asks you to review new hooks when it
starts. If no SessionStart hook arrives within a few seconds of your first prompt, the
wrapper treats the hooks as untrusted, and when Codex exits it prints (never while
Codex runs, where it would paint over Codex's screen):

> Codex did not run Switchboard's hooks in this session, so Queued Events reached
> this Agent through the read_channel tool. Open /hooks in Codex and trust the
> switchboard hooks (once; they stay trusted).

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

### Agent context

Each Agent card puts its context window first: current tokens, window size, percent, a meter and automatic compactions when the CLI reports them. Above 80% it warns in red. The Agents view includes a Context window column, plus its first prompt with a Show brief toggle, latest activity, runtime, model, working directory and branch. Briefs and activity always mask detected secrets before sharing. Missing CLI readings show as unavailable. Readings refresh with each heartbeat.

Codex also reports ChatGPT 5-hour and weekly limits from its session log to Accounts. Use `--account-label` to group sessions on the same Codex login; otherwise each unidentified session has a separate labelled card. `SWITCHBOARD_USAGE=off` disables account readings. Update the installed CLI and restart or resume existing wrappers to enable the new readings.
