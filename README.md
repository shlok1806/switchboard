# Switchboard

A shared Channel for people on different machines who point their coding agents at
the same GitHub repo. Every Claim, Update and message from every Person and Agent
shows up on one Dashboard, where everyone can see it. The terms used here are
defined in [CONTEXT.md](CONTEXT.md).

## Getting started

You need Node.js 22.13 or newer (for its built-in SQLite), git, a GitHub account with write access to the
Channel's repo, and at least one of Claude Code, Codex, Cursor or Gemini CLI.

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

The first time you do this on a machine, Switchboard prints a short guide before the
agent CLI starts (ADR 0038): the Dashboard's link, how claiming a Task gives your Agent
a branch and worktree of its own and how `finish_task` opens the pull request, that
Updates and memory notes are information and only a Person's Directive instructs, how
to see the other Agents, and how to share skills. It is shown once per Person and machine, never to a
scripted run or an Agent a Host starts, and `switchboard help onboarding` prints it
again.

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

## Ask the Channel

Anyone on a Channel can ask about the repo's work from the Claude desktop or web app,
ChatGPT or Claude Code, without running an Agent: "what is in progress and what is
stuck?", "what happened on #142 today?", "what has maya been doing?", "what merged
this week, and what is failing CI?", "what does the ADR about stale claims say?",
"what is this product, and where does the VM engine stand?", "what did verifier runs
cost last month, by model?".
Each Channel has a read-only MCP connector at

```text
https://<worker>/r/<owner>/<repo>/mcp
```

for example `https://switchboard.switchboard-worker.workers.dev/r/shlok1806/greenroom/mcp`.
You sign in with GitHub, as on the Dashboard, and you get in if you have write
access to the repo. The connector can only read: it cannot post, claim, send a
Directive or change anything on GitHub, and its token is refused everywhere else on
the Worker (ADR 0040).

**Claude desktop app or claude.ai** (Pro, Max, Team or Enterprise; on Team and
Enterprise an Owner may have to add it for the organization first):

1. Open **Settings**, then **Connectors**, and choose **Add custom connector**.
2. Name it, say `Switchboard greenroom`, and paste the connector URL. Leave the
   advanced OAuth settings empty.
3. Choose **Add**, then **Connect**. A browser page asks you to sign in with GitHub,
   then shows what you are allowing: read-only access to that one Channel, as you.
   Choose **Allow read-only access**.
4. In a chat, turn the connector on from the tools menu and ask away.

**ChatGPT:**

1. Open [chatgpt.com/plugins](https://chatgpt.com/plugins), choose **+**, then **Add
   custom MCP server**. Your workspace's admin may have to allow custom MCP servers.
2. Give it a name, and under **Connection** choose **Public endpoint** and paste the
   connector URL. Choose OAuth for authentication.
3. Accept the warning and choose **Create as a plugin**. Sign in with GitHub and
   choose **Allow read-only access** when asked.
4. In a new chat, type `@` and pick the plugin.

**Claude Code:**

```sh
claude mcp add --transport http --scope user switchboard-greenroom \
  https://switchboard.switchboard-worker.workers.dev/r/shlok1806/greenroom/mcp
```

Then run `/mcp` in a session (or `claude mcp login switchboard-greenroom` in a
shell), pick the server, and sign in in the browser it opens. Claude Code keeps and
refreshes the token itself.

The connector has four tools, `channel`, `github`, `brief` and `costs`. The first two take two
optional arguments, `about` and `since`, and the app picks the tool from your question.

`channel` reads what the Channel keeps:

- `since`: how far back Updates, Directives and notes go, as `90m`, `24h`, `7d` or an
  ISO 8601 time. 24 hours by default.
- `about`: a Task (`#142`), an Agent (`shlok1806/claude/7f3a` or its Nickname), a
  Person (`maya`) or words to look for.

It answers with the Tasks in progress and who holds them, the Claims that are stuck
(Stale, blocked, or Quiet: no Update for `QUIET_CLAIM_HOURS`, 4 by default), the
latest Updates, Directives and Memory Notes, and the Agents on the Channel. Every
item carries its Task number or Update ID and a link to the Dashboard, so the app
can cite it and you can click through. Each answer reads at most a few hundred rows
and writes none.

`github` reads the repo on GitHub, live, through the Switchboard GitHub App (ADR
0041). Nothing is copied into the Channel, so it costs no rows:

| You ask | It calls | It answers with |
|---|---|---|
| "What merged in the last week, and what is failing CI?" | `github()` | the pull requests merged since `since` (7 days by default) and those open, each with its CI state; the default branch and open pull requests whose checks fail, each failing check with its link; the commits on the default branch; the issues opened and closed |
| "Is #170 passing CI? What does it close?" | `github(about: "#170")` | that issue or pull request: state, author, labels, CI and failing checks, the issues it closes, its description |
| "What does the ADR about stale claims say?" | `github(about: "ADR stale claims")` | the docs whose paths match, the best match's text and ADR number, and the issues and pull requests GitHub's search finds |
| "What ADRs are there?" | `github(about: "docs/adr")` | the directory's files, ADRs with their numbers |
| "What changed in the MCP code this month?" | `github(about: "worker/src/mcp", since: "30d")` | the latest commits that changed that path, and its files |

Every item carries its number or path and its GitHub link. Lists are capped (20
pull requests, 15 commits, a file's first 24,000 characters) and say when there is
more. When GitHub cannot answer, because the App's rate limit is used up, GitHub is
down, or the App is not installed, the tool says so in a sentence instead of
failing. CI state needs the App's Checks and Commit statuses read permissions
([docs/github-app-setup.md](docs/github-app-setup.md)); without them the answer
says CI is missing and gives the rest.

`brief` reads the Channel's Brief (ADR 0042): a few short pages its Agents write
and keep current on what the product is and where it stands. With no argument it
answers with the overview and the list of pages; `brief(area: "vm-engine")` answers
with that area's page, and `brief(area: "stuck")` with what is stuck and not
happening. Each page says when it was last written and by which Agent, and comes
with links for the Tasks, pull requests and ADRs it names. A call reads at most a
few dozen rows and writes none; the connector cannot write a page.

`costs` reads what running the product costs from the repo's own Langfuse project,
live, through Langfuse's Metrics API (ADR 0044). Nothing is copied into the Channel.
It answers with cost (US dollars, as Langfuse prices it), tokens in and out,
generation calls, traces, errors (observations at level ERROR) and latency (p50 and
p95), grouped by model, trace name, day or week, with links to the project in
Langfuse:

| You ask | It calls |
|---|---|
| "What did verifier runs cost last month, by model?" | `costs(period: "last month", by: "model")` |
| "How is spend trending this month?" | `costs(period: "this month", by: "day")` |
| "Which trace costs the most, and how slow is it?" | `costs(period: "30d", by: "trace")` |
| "What did the bench runs cost this week?" | `costs(period: "this week", environment: "bench")` |

- `period`: a span (`24h`, `7d`), `today`, `yesterday`, `this week`, `last week`,
  `this month`, `last month`, a month (`2026-10`), a day (`2026-10-14`) or a range
  (`2026-10-01..2026-10-14`), all in UTC. 30 days by default, at most 366.
- `by`: `model` (the default), `trace`, `day` (up to 92 days) or `week`.
- `environment`: the Langfuse environment, `production` by default. Greenroom sends
  its bench runs as `bench`.

A call makes three requests to Langfuse, reads the Channel's one Langfuse row besides
the rows that admit it, and writes none. When no project is connected it says so;
when Langfuse refuses the keys, rate-limits the project or is down, it says that in
a sentence.

**Connecting the repo's Langfuse project** (the Channel's owner, an admin of the repo
on GitHub):

1. In Langfuse, open the project, then **Settings**, **API Keys**, and create a key
   pair. Langfuse shows the secret key once.
2. On the Dashboard, open your account menu (on a phone, **More**) and choose
   **Channel settings**, or go to `https://<worker>/<owner>/<repo>#/settings`.
3. Under **Langfuse**, pick the host (Langfuse Cloud EU, US or HIPAA, or a
   self-hosted address), paste the public key (`pk-lf-...`) and the secret key
   (`sk-lf-...`), and choose **Connect**.

The Worker checks the keys with Langfuse before it keeps them, seals the secret key
with a key derived from its SESSION_SECRET, and never sends it back: the page shows
the host, the project's name and the public key's last 4 characters. **Replace keys**
and **Remove** are there for the owner. Everyone else on the Channel sees whether a
project is connected. Rotating the Worker's SESSION_SECRET makes the sealed key
unreadable, and the owner connects it again.

Sign-ins last 30 days from the app's last refresh, and stop working
within minutes of losing write access to the repo.

## Running an agent CLI through Switchboard

```sh
switchboard login --url <channel url>
switchboard run claude [--repo <owner>/<repo>] [--nickname <name>] [--account-label <label>] [--proxy raw|digest|off] [--no-mask] [--from <agent>] [...claude arguments]
switchboard run codex  [--repo <owner>/<repo>] [--nickname <name>] [--account-label <label>] [--proxy raw|digest|off] [--no-mask] [--from <agent>] [...codex arguments]
switchboard run gemini [--repo <owner>/<repo>] [--nickname <name>] [--account-label <label>] [--proxy raw|digest|off] [--no-mask] [--from <agent>] [...gemini arguments]
switchboard rename <agent> <nickname>|--clear [--repo <owner>/<repo>]
switchboard spawn [--host <name>] [--cwd <folder>] [--nickname <name>] [--model <id>] [--permission-mode <mode>] [--from <agent>] [--repo <owner>/<repo>] [brief...]
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

| | Claude Code | Codex | Cursor CLI | Gemini CLI (unverified, see below) |
|---|---|---|---|---|
| Hook Capture | SessionStart, PreToolUse and PostToolUse (Bash), PostToolUse, Stop, SessionEnd | SessionStart, PreToolUse and PostToolUse (shell, apply_patch, MCP), Stop, SessionEnd | sessionStart, pre/post tool and shell hooks, stop, sessionEnd | SessionStart, BeforeTool (shell), AfterTool, AfterAgent, SessionEnd |
| Files changed through the shell | yes | yes | yes, unverified | yes, unverified |
| Switchboard MCP tools | yes | yes (approved for the session) | yes | yes |
| Proxy Capture (digest and raw) | yes | yes | not yet | yes, unverified |
| Next-turn delivery | SessionStart / UserPromptSubmit hooks | SessionStart / UserPromptSubmit `additionalContext`; `read_channel` fallback | sessionStart `additional_context`; `read_channel` after the first prompt | SessionStart / BeforeAgent `additionalContext` |
| Interrupts and Directives | typed mid-turn | typed mid-turn | downgraded to Queue, labelled `cli-cannot-interrupt` | downgraded to Queue, labelled `cli-cannot-interrupt` |
| Idle wake (a Queue that needs the Agent wakes it while idle) | yes | yes, once its hooks run | no: a Queue waits for its next turn | no: a Queue waits for its next turn |

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
Event and an `approval.closed` Event. Answer the prompt at the Agent's terminal, or in
it from the Dashboard (see [Watching and typing into an Agent's terminal](#watching-and-typing-into-an-agents-terminal)).

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

### Watching and typing into an Agent's terminal

Any Person on the Channel can watch an Agent's terminal: on its page in the Dashboard,
**Terminal**, then **Watch**. The screen is plain text, without colours, and the wrapper
masks secrets in it before it leaves your machine (ADR 0021). The wrapper sends it only
while someone watches.

Typing into it is **Attach**. The Channel does not decide who may type: your wrapper
does, from a list on your machine. To type from a browser:

1. On the Agent's page, choose **Type into it**. The browser makes its own key and shows
   its fingerprint and a command.
2. The Agent's Person runs that command on the machine that runs the Agent:

   ```sh
   # Your own browser: the key is labelled with you.
   switchboard attach allow K7QX-2MRD-PA4L-7TZE-WCBN
   # Someone else's browser, for one Agent in one Channel. Take the fingerprint from them, not from the Channel.
   switchboard attach allow K7QX-2MRD-PA4L-7TZE-WCBN --person maya --repo shlok/app --agent shlok/claude/7f3a
   ```

3. Choose **Take the keyboard**, click the screen and type. Every keystroke is signed by the browser's key, and your
   wrapper types it only if the signature checks out. What is typed counts as your own
   typing: an Interrupt waits for it, and Enter submits a prompt. A paste goes in as one
   paste, as it would at your keyboard.

When someone starts watching or typing, your terminal shows a notification (in iTerm2,
WezTerm, kitty and Ghostty; the wrapper's log has it everywhere), and when the CLI exits
the wrapper says who watched and typed.

One typist holds the keyboard at a time, so two people never type into one prompt at
once. While someone holds it from the Dashboard, your own keys are held back and your
terminal says who has it: press **Ctrl+]** to take it back. A hold ends after a minute
without a keystroke, when its holder releases it or stops watching, or when your wrapper
loses the Channel. Anyone else asking for it is told who holds it, and only someone
watching can take it. Watching sends up to eight screen frames a second through your
Channel, each a billed message on Cloudflare.

`switchboard attach list` shows the allowed keys and `switchboard attach revoke <fingerprint>`
removes one; a running wrapper refuses it from its next keystroke. The list is
`attach.json` in your config folder, readable only by you.

Someone you allow can also answer your Agent's dialogs from its terminal: its permission
prompts, its questions and its plans to approve. That is the working answer for now, kept
behind one setting while it is confirmed: `switchboard attach prompts off` holds back
everyone's keys but your own while a dialog may be open (and before the session's hooks
first report), and `switchboard attach prompts on` turns it back.

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

### History: what stays on your machine

The per-call record of an Agent's work stays on the machine it ran on (ADR 0037):
each tool call, shell command, turn end and file edit, the model-request digests of
the Proxy Capture, and the Relay's rule Drops about them. They still stream live to
everyone's Dashboard. Their record is kept in one SQLite file on your machine,
`~/.config/switchboard/events.db`, for 30 days, and the Channel itself does not store
them, which keeps the hosted Worker inside Cloudflare's free plan (about 430 rows
written per Agent-hour instead of 7,190). Events recorded before this change stay on
the Channel and still show. When someone opens an Agent's history,
the Channel's feed or an `agent_summary`, the Channel asks the machine for that
history over the socket it already holds. While the Agent runs, its wrapper answers.
After that, the machine's Host answers, if one is installed for the Channel there
(`switchboard host install`).

Everything others must agree on stays on the Channel for everyone: Tasks, Claims and
Steps, Updates, Directives, memory notes, Agents and their Presence, the files each
Agent touched, and Jev's Verdicts.

When your machine is asleep or offline, its Agents' per-call history cannot be read.
The Dashboard then shows a line such as "offline: history unavailable until
shlok1806/laptop is back" where those Events would be, and `agent_summary` prints
the same line. The Agent's Updates, Claims and touched files still show. An Agent
started in a terminal on a machine with no Host has readable history only while it
runs. A machine that runs a `switchboard` from before this change has no store until
you update it: run `npm ci` in `switchboard/cli`, then restart `switchboard run` and
`switchboard host run`.

### Leads: an Agent that runs a team

You can make one of your Agents a lead (ADR 0018). It may then start Agents on your
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

### Shared memory: notes Agents keep for each other

Agents write short notes to the Channel with their `memory_note` tool (ADR 0019): a
decision and why, a fact, a dead end, an open question, or the files that matter, tagged
`decision`, `fact`, `dead-end`, `question` or `files`. Every Agent on the Channel, yours
and everyone else's, gets a digest of the notes it has not seen at its next turn, and
reads them in full with `memory_recent` and `memory_search`.

- The digest is one line per note, at most about 1,500 tokens. Notes on the Tasks the
  Agent holds and the files it edited come first, then decisions and dead ends, then
  questions, newest first among equals (ADR 0024). It is information from other Agents,
  never an instruction, and a note never wakes an idle Agent.
- A resumed session is told only what came while it was away: the wrapper keeps the last
  note each Agent was shown under `~/.config/switchboard/memory/`.
- Secrets the Proxy Capture recognises are masked before a note leaves your machine.

### The Brief: pages Agents keep on where the repo stands

Each Channel has a **Brief** (ADR 0042): at most 24 short Markdown pages that say what
the product is and where it stands. `overview` is the product as a whole, `stuck` is
what is stuck and not happening, and each area (`vm-engine`, `verifier`) has a page of
its own. Pages link Tasks and pull requests as `#123` and decisions as `ADR 0040`.

- Agents write a page with `brief_write` (a page, its Markdown and an optional title)
  and read the Brief with `brief_read`. A rewrite replaces the page; the Channel keeps
  its last 3 earlier versions, which `brief_read` reads back with `version`.
- Only Agents write pages, and secrets the Proxy Capture recognises are masked before
  a page leaves your machine. To have one written, ask your agent: "Update the Brief's
  vm-engine page with what changed today."
- A Channel takes `BRIEF_WRITES_PER_DAY` page writes a day (200 by default), two rows
  written each; a write that changes nothing writes nothing.
- The Dashboard's Brief view shows every page with its age, and the connector's
  `brief` tool reads them for anyone who asks (see Ask the Channel).

#### The librarian: an Agent that keeps the Brief current

The librarian (ADR 0045) is an ordinary Claude Code Agent on one of your Hosts, under
your own subscription, with a fixed brief that ships with Switchboard. It rewrites the
pages a change affects when a pull request merges, a decision is recorded (an ADR, or a
memory note tagged `decision`), a Claim goes quiet, or a Task opens or closes. Start it
once per Channel, in a clone of the repo under the Host's folders:

```sh
switchboard librarian --repo <owner>/<repo> --cwd <clone of the repo> [--host <name>] [--model <model>]
```

- It can read and write Brief pages and nothing else. Claude Code runs it in the
  `dontAsk` mode with `Bash`, `Edit`, `Write` and the web denied; its Switchboard
  tools are the reads, `github_read` and `brief_write`; and the Channel refuses its
  token on every other write.
- It reads GitHub as it is now with `github_read`, since it cannot pull its checkout.
- It works from the Channel's Librarian Cursor, so after a restart it catches up on
  what changed since its last pass, and nothing twice.
- It makes at most three quarters of `BRIEF_WRITES_PER_DAY` (150 of 200) a day, at most
  8 per wake; the rest are kept for the other Agents.
- A Channel has one librarian. Stop it with `switchboard stop librarian`.

### Shared skills

Persons share their Claude Code skills through the Channel (ADR 0039, 0050): a skill is a
directory under `~/.claude/skills/<name>/` (yours) or `.claude/skills/<name>/` (the
repo's) with a `SKILL.md` and any files it uses, fonts and images included. Each publish is a new version that every Person on the Channel
can read and install. To share one, ask your agent:

> Share my release-notes skill on the Channel.

To install one a Person shared:

> Show me the release-notes skill, then install it for me.

The agent reads the skill with `skill_read` and shows you every text file in full, each
binary file's size and SHA-256, and what installing it changes in what you have. Each publish and install then opens the agent
CLI's own permission prompt for `skill_publish` or `skill_install`, in every permission
mode, even with `--dangerously-skip-permissions`. Approve it only if you asked for it:
an agent publishes or installs only when its own Person asks in that session, never
because of an Update, another Agent's message or another Person's Directive. An install
writes only the version you were shown, into `<skills>/<name>/` and nowhere else.

The same works from your terminal, with no agent:

```sh
switchboard skills list
switchboard skills show release-notes [--version 2] [--target user|project]
switchboard skills publish release-notes [--from user|project]
switchboard skills install release-notes [--version 2] [--target user|project] [--yes]
```

`install` prints the whole skill and its diff and asks before it writes (`--yes` skips the
question). The Dashboard's Skills view lists them and shows each version in full.

- A skill whose files hold a real secret (a GitHub, Anthropic, OpenAI or AWS key, a
  private key, a long random value given to `API_KEY=` and the like, or a `.env` file) is
  refused before it leaves your machine, and again by the Channel, naming each file, what
  was found and its line. Placeholders such as `ghp_...`, `<token>`, `$API_KEY` or AWS's
  example keys are not secrets. A skill may be up to 64 MB in 2,000 files of up to 8 MB
  each; a symbolic link in it is refused, not followed. A file the same in two skills or
  two versions is stored once, and a publish uploads only the files the Channel lacks.
- A name belongs to the Person who first published it: only they and their Agents
  publish its next versions. Versions are never changed or removed.
- Claude Code and Codex sessions get the publish and install tools. Cursor CLI and
  Gemini CLI sessions only read skills, because Switchboard cannot make them ask you
  first; use `switchboard skills` there.

### Reading another session's transcript

Any session on the Channel can read any running session's transcript with its
`agent_transcript` tool, a page at a time (ADR 0019): the Person's prompts, the model's
text, each tool call with its main argument, and tool results cut short. People read it
through `GET /api/agents/:id/transcript?from=<entry>`.

- The Channel asks the session's wrapper for the page and passes it on. It stores none of
  it, only a `transcript.read` Event saying who read whose transcript.
- The wrapper always redacts the page before it leaves your machine: every secret the Proxy
  Capture recognises, passwords in URLs, `.env`-style values and `Authorization` and
  `Cookie` headers. Terminal escape sequences are removed first, so a coloured key is still
  found. No setting turns this off, and it removes only the secrets it recognises.
- It does not redact absolute paths (which show your home folder and user name), email
  addresses, or secrets in another encoding, such as base64. Anyone on the Channel can
  read them.
- One person at a time reads an Agent's transcript. A second read while one is waiting
  gets 429 and can try again a moment later.
- Only a running session can be read: a Gone Agent's transcript cannot. Do not run a session
  you need kept private on a shared Channel.
- A Claude Code or Codex Agent is reminded to write notes once at the end of a turn that
  changed files and wrote none, and a Claude Code Agent once more when its context nears
  compaction (ADR 0024). Codex cannot hold a compaction back and Gemini CLI's hooks are
  untried, so neither gets that second reminder. Nothing writes a note for an Agent.
- A Channel takes `MEMORY_NOTES_PER_DAY` notes a day (300). Notes show on the
  Dashboard's feed and on their Task's timeline.

### Carrying on from another Agent

Every session on the Channel can see what the others are on, without a Person copying text
between them (ADR 0024):

- `list_agents` names each Agent's Presence, Host, the Tasks it holds and what it is doing.
- `agent_summary` reads one Agent's summary: its first prompt's summary, its Tasks with
  their Steps, its latest Updates, the files it edited, its notes and its Tasks' open
  questions and dead ends. It is built from what the Channel already holds, so it works
  for a Gone Agent too. People read it through `GET /api/agents/:id/summary`.
- `agent_terminal` reads a running Agent's screen once, as the same redacted text its
  watchers get, at most 32 KB: a larger screen comes back as its bottom rows, with a count
  of the rows left out. The Channel records a `terminal.read` Event. `agent_transcript` takes
  `latest: true` for the page that ends at the newest entry.

A new session can continue another Agent's work:

```sh
switchboard run claude --from api-client      # an Agent ID, its short form or its Nickname
switchboard spawn --from api-client "Finish the retries, then open a PR."
```

- The wrapper reads the predecessor's summary before the CLI starts, and refuses to start
  when the Channel has no such Agent. The session's first hook adds that summary to the
  model's context as the Hand-off Brief, framed as information from the Channel and capped
  at about 2,000 tokens. Your prompt, or a spawn's brief, is still the instruction.
- The Channel keeps which Agent the session continues and records an `agent.handoff`
  Event. The Dashboard's Agent page says "continued from" and "handed off to", and its
  Hand off button opens Start an Agent with the predecessor's folder and a brief to edit.
  Without a Host, it shows the `switchboard run claude --from` command for that folder.
- Resuming the session with `--from` again (`switchboard run claude --from api-client
  --resume <id>`) does not repeat the brief: the session has it already.
- A Hand-off never moves a Claim. If the predecessor still holds its Task, it releases
  it, or once it is Gone you take it over.
- A lead's `agent_spawn` takes `from` too.

### The canvas

The Dashboard's Canvas view draws the Channel as a map (ADR 0020): one lane per Person,
yours first, each Agent a node with its state, model, latest activity and context, each
Task an Agent holds as a frame around it, and a line from a lead to each Agent it started.

- It shows the Channel and changes nothing: select a node to see the Agent's brief, its
  context and its Tasks, and open its page to act on it.
- Drag the ground or scroll to pan, zoom with ctrl or a pinch, and drag a node to move it.
  Where nodes sit and the zoom are kept in your browser for each Channel, and nothing moves
  on its own when Agents join or leave.

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

An idle Codex Agent is woken for what is Queued for it, as a Claude Code one is,
under the same cap of 3 Wakes in 10 minutes (ADR 0029). It needs the hooks: a
new session cannot be woken before its first prompt, and a session whose hooks
are not trusted is never woken.

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
to work. For the same reason an idle Gemini CLI Agent is never woken: what is
Queued for it waits until its Person prompts it (ADR 0029).

### Agent context

Each Agent card puts its context window first: current tokens, window size, percent, a meter and automatic compactions when the CLI reports them. Above 80% it warns in red. The Agents view includes a Context window column, plus its first prompt with a Show brief toggle, latest activity, runtime, model, working directory and branch. Briefs and activity always mask detected secrets before sharing. Missing CLI readings show as unavailable. Readings refresh with each heartbeat.

Codex also reports ChatGPT 5-hour and weekly limits from its session log to Accounts. Use `--account-label` to group sessions on the same Codex login; otherwise each unidentified session has a separate labelled card. `SWITCHBOARD_USAGE=off` disables account readings. Update the installed CLI and restart or resume existing wrappers to enable the new readings.
