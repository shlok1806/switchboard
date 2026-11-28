# A local Dataset of the owner's own sessions, linked to how they turned out

Status: accepted on 2026-11-09, for the owner's request to "make sure switchboard tracks all prompts and output so we can train it on this". Builds on ADR 0019 (Transcript Reads and their redaction) and ADR 0037 (what stays on the machine). It does not change ADR 0019: the Channel still keeps no transcript.

## Context

Every session the owner runs is already on their disk. Claude Code writes `~/.claude/projects/<project>/<session>.jsonl`, with subagents under `<session>/subagents/`, workflow runs under `<session>/subagents/workflows/<runId>/` (a `journal.jsonl` and an `agent-*.jsonl` per agent, the script in `<session>/workflows/<runId>.json`), and long tool outputs under `<session>/tool-results/`. Codex writes rollouts under `~/.codex/sessions/`. The owner set Claude Code's `cleanupPeriodDays` to 3650, so these files are no longer deleted after 30 days.

Those files are not training data yet. A session alone says what was asked and done, not whether it worked. What makes it worth training on is the link to its outcome: the repo, branch and commit it worked on; the Switchboard Task and Claim it held and the pull request it opened; whether that pull request merged, was closed or was reverted; the Greenroom verdicts of the runs it started; and, most of all, the owner's corrections, the prompts where they rejected or redirected the work.

The owner decided two things:

- A local archive first. Nothing leaves the machine; uploading can come later and needs its own decision.
- Only the owner's own sessions. A teammate's (Kabir's, say) are added later, and only by that teammate's own opt-in on their own machine.

ADR 0019 says the Channel keeps none of a transcript, and CONTEXT.md's Transcript Read repeats it. That rule is about the shared Channel: anyone with access to the repo can read what the Channel holds. A Dataset on the owner's disk is not on the Channel, is read by no one else, and so does not touch that rule.

## Decision

### The Dataset is a local, redacted, versioned copy

- The **Dataset** is `~/.switchboard/dataset/` (or `$SWITCHBOARD_DATASET_DIR`), private to its owner (mode 0700 and 0600). It holds:
  - `sessions/<cli>/<session>/session.json`: one record per session;
  - `sessions/<cli>/<session>/turns.jsonl`: its Dataset Turns, every thread's, in order;
  - `sessions/<cli>/<session>/outcome.json`, and `outcomes.jsonl` with every session's in one file;
  - `redactions.json`: what redaction masked, by kind and count, never a value;
  - `sources.json`: whose sessions are kept (below);
  - `schema.json`, `state.json`, `sync.log` and `cache/`.
- Every record carries `schema: 1`. `docs/dataset.md` describes every field. A change that breaks a reader bumps the version, and the next sync writes every session again.
- A **Dataset Turn** is one message of one thread: what the Person typed (`prompt`), what the CLI or a hook put in the user's place (`context`), the model's reply with its text, thinking and tool calls (`message`), the tool results that answered it (`result`), a compaction, or a workflow journal entry. A thread is the main conversation, a subagent (`subagent:<agentId>`) or a workflow run's agent (`workflow:<runId>/<agentId>`), so a subagent's and a workflow's work stay linked to the session that started them. A Claude Code message written as several entries is one Turn, and its tokens are counted once.
- Tool inputs are kept as their JSON text, and each part is cut at 64,000 characters, saying how long it was. A tool output Claude Code saved to `tool-results/` is read from there.
- Nothing of the Dataset is sent anywhere. Uploading it, to any service, needs a new ADR.

### Redaction is always on

- Every string is redacted as it is read, before any record holds it, with the Transcript Read's redactor (ADR 0019): every format `maskSecrets` knows (API keys, tokens, private keys), env-style assignments (so `.env` values), and `Authorization`, API-key and cookie headers. It redacts around escape sequences as a Transcript Read does. No flag turns it off.
- `maskSecretsByKind` counts each mask by what it hid (`an Anthropic key`, `a secret assignment`, `an HTTP credential header`). Each session records its counts, and `redactions.json` sums them. The values are never recorded.
- Redaction finds the secrets it recognises, not every secret, as ADR 0019 says. The Dataset stays on the owner's disk partly for that reason.

### Only the owner's own sessions

- The collector reads local files only: the agent CLIs' own homes on this machine. It never reads a session through the Channel.
- `sources.json` lists each **Dataset Source**: a CLI's home (`~/.claude`, a `CLAUDE_CONFIG_DIR` such as `~/.claude-alt`, `~/.codex`) and the accounts whose sessions are kept. A Claude Code session names its account in its `session-owner` entry, and a Codex rollout in its `session_meta`. A session under an account no source lists is skipped and counted, and one already kept is removed when the owner takes its account off.
- The first sync writes `sources.json` with the accounts logged in on this machine: for each Claude Code home, the account in its `.claude.json`; for Codex, which keeps its login where Switchboard does not read, the accounts its own rollouts name. From then on the file is the owner's to edit.
- Older Claude Code wrote no account. Such a session is in the owner's own CLI home, so it is kept, unless the owner sets `keepUnattributed` to false.
- A teammate joins only by running the collector on their own machine. Nothing here collects anyone else's sessions, and pooling Datasets is a later decision.

### Outcomes are linked, and a gap says why

- `outcome.json` links each session to what can be found:
  - its repo, from the origin of its working directory (a removed worktree is looked up from the nearest folder above it), else what the CLI recorded; its branches from its `gitBranch` fields; its commits from `git commit`'s own output in its tool results;
  - its pull requests: Claude Code's own `pr-link` records, the URLs `gh pr create` printed, and the Channel's `task.review`; and for each, from `gh pr list`, whether it merged or closed, its merge commit, and a merged `Revert "<title>"` pull request that reverted it;
  - for a session that used Switchboard's tools or was told things by its wrapper, its Agent's Tasks on the Channel: the Agent ID is `agentIdFor(person, cli, session)`, and its own Events give each Task's Claim, release, Steps, pull request and finish;
  - the Greenroom runs it started (a `machine_create` that answered with the run ID) or named, with each run's verdict and outcome from `~/.greenroom/runs/<runId>/manifest.json`;
  - its corrections.
- Whatever cannot be linked is listed in `unlinked` with why: a working directory that is gone, a repo `gh` cannot list, a Channel that cannot be reached, a run with no record. A gap is never mistaken for "no outcome".
- Linking only reads: `git`, `gh` and the Channel's history as the owner. `gh`'s list of a repo's pull requests is cached for half an hour. `--offline` links from local files only.
- An outcome that can still change (an open pull request, a Task not finished) is linked again on a sync six hours later; `--relink` links every session again.

### Corrections are labelled, not rewritten

- A **Correction** is a Turn where the owner rejected or redirected the work: a tool call refused at its permission prompt (`rejected-tool`), a turn they stopped (`interrupted`), or a typed prompt, after the model worked, that starts with "no", "stop", "don't", "revert" or "actually", or says "not what I asked", "I said", "why did you" and the like (`redirect`). Each names its rule in `cue`, so a reader can weigh or re-derive it.
- The prompt is kept as it was said, redacted for secrets only. The rules find candidates; they are not a judgement.

### It runs on its own, and never in a session's way

- `switchboard dataset sync` copies the sessions that are new or changed since the last sync: a session is read again when any of its files (its transcript, a subagent's, a workflow's) changed size or time.
- It is idempotent: a session is written by replacing its files whole, from its sources alone, so the same sources give the same files. It is resumable: `state.json` is saved after each session, so a sync that stopped redoes only what it had not finished. One sync runs at a time (`sync.lock`; a lock whose process is gone is taken over).
- Every wrapped session starts one in the background, detached, with no terminal, when a turn ends (at most once in 10 minutes) and when the session ends. It never waits on it, and nothing it does can fail the session. It starts only once the owner set the Dataset up with a first `switchboard dataset sync`, and never with `SWITCHBOARD_DATASET=off`. A session run outside Switchboard is copied by the next sync any session or the owner starts.
- `switchboard dataset stats` counts sessions, threads, turns, prompts, tokens, outcomes linked and corrections found.

## Consequences

- The owner has a Dataset of every session on this machine, with subagents and workflows in place and each session linked to what came of it, without anything leaving the machine. The first sync of 897 sessions (3.8 GB of transcripts) took 70 seconds, and the next, with one session changed, 5.
- The Dataset holds code, prompts and tool output in full, as the session files do. Redaction removes recognisable secrets, not all. Before any upload, a further review of what the Dataset holds is part of that decision.
- An active session is copied whole each time it changes. A long session costs a few seconds of background work per sync, which the 10-minute spacing bounds.
- The account rule rests on what each CLI records. A Codex login is read from its rollouts, not its credentials, so a new Codex account is only kept once the owner adds it to `sources.json`.
- Outcome links are as good as their sources: a removed worktree with no checkout above it has no repo, and so no Channel and no pull request state; a revert is found only when it was a merged pull request titled as GitHub titles one.
- A Correction is a heuristic label. Tool refusals and interrupts are exact; typed redirects are candidates.

## Verification

- `cli/test/dataset.test.ts`: a Claude Code session with a subagent and a workflow run, and a Codex rollout, with a planted Anthropic API key, a `.env` value and an `Authorization` header: none of the three is anywhere in the Dataset, and `redactions.json` counts them by kind. A second sync writes nothing and leaves every file as it was; a changed session is written again; a sync whose state was lost and whose lock was left behind redoes the work to the same files; a second sync while one runs does nothing. A session under an account `sources.json` does not list is skipped, and one already kept leaves when its account is taken off. The outcome links the repo, branch, commit, pull request (merged and reverted, from a stubbed `gh`), the Channel's Task (from stubbed Events) and the Greenroom verdict; corrections are found and kept as said. The background sync starts only once the Dataset is set up, and at most once per 10 minutes of turns.
- `cli/test/e2e.test.ts`: a wrapped session, once its Dataset is set up, is copied by the background sync its wrapper starts when it ends, and its Stop and SessionEnd hooks still return at once.
- The first full sync of the owner's history, with `switchboard dataset stats`, and the greenroom session `8304f443-713d-41b9-8e05-322818d28244` in it with its subagents and workflow runs.
