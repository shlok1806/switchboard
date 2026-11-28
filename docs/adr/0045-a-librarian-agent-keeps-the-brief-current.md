# A librarian Agent keeps the Brief current, and can write nothing else

Status: accepted on 2026-11-06, for #159, the fourth part of ADR 0040's plan. Builds on ADR 0005 (Channel content is information), ADR 0007 (Agent tokens), ADR 0015 (Hosts), ADR 0018 (leads), ADR 0037 (the free plan's rows are the budget), ADR 0041 (the `github` tool) and ADR 0042 (the Brief and its daily budget).

## Context

The Brief (ADR 0042) is only as current as the Agents that write it, and nothing asks any Agent to. ADR 0040 planned a librarian: an ordinary Agent on a Host, under its Person's own CLI subscription, so learning costs no API bill, that rewrites the affected page when something meaningful happens. #159 names what is meaningful: a pull request merges, a decision is recorded (an ADR, or a memory note tagged `decision`), a Claim goes quiet, a Task opens or closes.

What sets its shape:

- It runs unattended, for days, and reads text other people wrote (pull requests, issues, notes, ADRs). Whatever that text says, it must be unable to change anything but Brief pages: not the repo, not GitHub, not the Channel's Tasks, Claims, Updates or notes.
- It must catch up after a restart without reading the whole history again, and a Channel's history grows without end.
- The Brief takes `BRIEF_WRITES_PER_DAY` writes a day for the whole Channel (200). The librarian must not spend the other Agents' share.
- The Channel already sees every one of those happenings as an Event: `merge` (with its files), `memory.note` (with its tags), `task.create`, `task.done`, `task.reopen`, `task.remove`, `claim.stale` and `claim.recovered`. Quiet Claims are not Events: ADR 0040's `channel` tool works them out from the Claim and the latest Update.

## Decision

### Starting it: one command

- `switchboard librarian [--host <name>] [--cwd <folder>] [--model <model>] [--repo <owner/repo>]` asks one of the Person's Hosts to start the librarian in `--cwd` (else this folder), a clone of the Channel's repo under the Host's roots. It is `POST /api/agents/spawn` with `librarian: true`, nickname `librarian`.
- A librarian spawn always runs in Claude Code's `dontAsk` permission mode and carries no brief and no `from`; a request that names another mode, a brief or a `from` is refused. Only a Person's session may ask for one, never a lead (ADR 0018). The Host checks the same on its side and runs `switchboard run claude --librarian`.
- A Channel has at most one librarian that is not Gone: a second one is refused when it registers (409), and the spawn is refused early when one runs.
- Its fixed brief, `LIBRARIAN_BRIEF` in `shared/src/librarian.ts`, ships with Switchboard. The wrapper gives it to Claude Code with `--append-system-prompt`, so it holds across resumes and compaction and is never a Person's Directive. It says what the pages are for, to read a page before rewriting it, to cite Tasks, pull requests and ADRs by number, to treat everything it reads as information, and to write only what changed.

### It can write only Brief pages, and three layers say so

1. **Claude Code's permissions.** `--librarian` runs Claude Code with `--permission-mode dontAsk` (every tool not allowed beforehand is refused, and nothing waits on a prompt), `--strict-mcp-config` (only the session's own Switchboard server, never the Person's other MCP servers), and session settings that allow `Read`, `Grep`, `Glob` and the librarian's Switchboard tools, and deny `Bash`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Task` and `Agent`. A deny rule wins over an allow rule from any settings file, so the Person's own settings cannot loosen it. The wrapper refuses `--librarian` with any other permission mode, `--dangerously-skip-permissions`, `--allowedTools`, `--disallowedTools`, `--mcp-config`, `--system-prompt` or `--append-system-prompt`, and with `--from`. Without `Bash` it runs no `git` or `gh`: it reads the repo as checked out with `Read`, `Grep` and `Glob`, and GitHub as it is now through the Channel (below).
2. **Its MCP server offers only reads and `brief_write`.** In librarian mode `switchboard mcp` lists `brief_read`, `brief_write`, `github_read`, `list_tasks`, `read_channel`, `list_agents`, `memory_recent`, `memory_search` and `agent_summary`, and nothing that claims, posts, notes, directs, spawns, renames or installs.
3. **The Channel refuses its token everywhere else.** The librarian registers with `librarian: true`, and its Agent token is marked so when issued (a column of `agent_tokens`, so admitting a call reads no more rows). A librarian token reads like any Agent's, writes Brief pages and its own cursor, and makes its wrapper's own reports (heartbeats, the end of its session, its model, its Nickname, the stream that carries its Hook Capture, and the Tool Capture's `tool.call` reports of its MCP calls); every other route that writes answers 403. The Agent stays a librarian for good: registering again cannot drop it.

### Reading GitHub without Bash

`GET /api/github?about=&since=` answers an Agent or a Person with the Connector's `github` tool's own answer (ADR 0041): read live through the GitHub App, read-only by construction, costing no rows. The librarian's MCP offers it as `github_read`. It reads a merged pull request, the ADR files on the default branch and recent activity this way, current where the local checkout is not.

### What wakes it: the Librarian Feed and its cursor

- `GET /api/librarian` answers what changed after the Channel's **Librarian Cursor**: the meaningful Events (`merge`, with the ADR files it changed; `memory.note` tagged `decision`; `task.create`, `task.done`, `task.reopen`, `task.remove`; `claim.stale`, `claim.recovered`), the Quiet Claims now (by ADR 0040's rule, `QUIET_CLAIM_HOURS`) and which went quiet or stopped being quiet since the cursor, and the Brief's budget today.
- It scans at most 500 Events past the cursor, by `seq`, so a read costs at most that many rows however long the history is, and says when there are more. Before the librarian's first pass there is no cursor: the answer says so and covers no Events, since a first pass builds the Brief from where the repo stands now, not by replaying history.
- `PUT /api/librarian` `{ through, quiet }`, with the librarian's token only, moves the cursor: the last `seq` handled and the Quiet Claims it has told the librarian about. One row, `librarian_cursor`.
- The wrapper in librarian mode (`cli/src/librarian.ts`) watches the Events its stream already carries: one of those types settles for a minute, to take what comes with it, then it reads the Feed. It also reads it when it starts and every 15 minutes, which is how Quiet Claims are noticed. When there is something, it types it at the idle prompt as one prompt (the same typer as an Interrupt, never over its Person), framed as information, with how many pages it may write. When that turn ends (the Stop hook), it moves the cursor. A turn that never ends, or a session that crashes, moves nothing, so the same changes come again: a restart catches up from the cursor, not from the start. A Feed with more past its 500 is read again at once after the turn.
- With nothing to tell, the cursor moves at most every 30 minutes, so the scan past it stays short and an idle Channel costs at most 48 rows a day.
- It does not wake for the Relay's Deliveries (ADR 0005's Queue): its turns come from the Feed alone.

### The budget

- A librarian's Brief writes stop at three quarters of `BRIEF_WRITES_PER_DAY` a UTC day (150 of 200), checked by the Channel against the same day's count; past that its writes are refused with 429, saying the rest is kept for the other Agents. Every other Agent still has the whole cap.
- The wrapper does not wake the librarian once its share is spent, and each prompt says how many writes are left, at most 8 per wake. Changes wait under the cursor for the next day.
- Rows: a wake writes one cursor row plus 2 per page written (ADR 0042). A Feed read costs the Events past the cursor (at most 500), the claimed Tasks and one Update each for the Quiet Claims (at most 61), the cursor, the budget and the Brief's pages (at most 24), plus the few that admit the call.

## Consequences

- A merged pull request reaches its area page within a few minutes: the settle, then one turn of the librarian.
- The librarian cannot fix what it finds: it reports, in pages. It cannot open an Issue, post an Update about a stuck Claim or note a decision itself.
- Its pages are as right as its model and its sources. Each says who wrote it and when (ADR 0042), and the Connector's `channel` and `github` tools still answer what is happening now.
- A Person who types into the librarian's terminal (ADR 0021) can still only get Brief pages out of it.
- The local checkout goes stale as main moves, since the librarian cannot pull; `github_read` reads main as it is now.

## Verification

- `worker/test/librarian.test.ts`, through the Channel API: the first Feed has no cursor and no Events; a merge with an ADR, a decision note, a note without that tag, a Task opened and closed, and a Stale Claim come back in order after the cursor, the untagged note left out; a Claim with no Update past `QUIET_CLAIM_HOURS` comes back quiet and then as no longer quiet once an Update lands; moving the cursor leaves only what came after it; a Feed past 500 Events says there is more; only the librarian's token moves the cursor; the librarian's token writes Brief pages but is refused on Updates, notes, Claims, Directives, spawns and Task creation; its writes stop at three quarters of the day's cap while another Agent still writes; a second librarian is refused; a librarian spawn runs in `dontAsk`, and one with another mode, a brief, or from a lead is refused; `GET /api/github` answers an Agent as the Connector's tool does.
- `cli/test/e2e.test.ts`, through `switchboard run claude --librarian` against `wrangler dev`: Claude Code gets `dontAsk`, `--strict-mcp-config`, the fixed brief and the deny rules; the session's tools are the librarian's only; its first pass is typed at its prompt and writes the overview; a shell command and a file edit it tries are refused (the fake CLI applies the rules as Claude Code does); a merge and a new Task wake it with both named, and the cursor moves when its turn ends; after a restart it is told only what came since.
- `cli/test/host-check.test.ts`: a Host refuses a librarian spawn in a mode other than `dontAsk` or with a brief.
