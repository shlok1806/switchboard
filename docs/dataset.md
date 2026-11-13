# The Dataset, schema 1

`switchboard dataset sync` copies the owner's own Claude Code and Codex sessions on this machine into a local Dataset, redacted, each linked to how it turned out (ADR 0054). This page describes its files and records for whoever reads or trains on them. The types are in `cli/src/dataset/schema.ts`.

Nothing in the Dataset leaves the machine. Every string in it went through the redactor of ADR 0019 before it was written.

## Files

```
~/.switchboard/dataset/            ($SWITCHBOARD_DATASET_DIR)
  schema.json                      { "schema": 1, "docs": ... }
  sources.json                     whose sessions are kept; the owner edits it
  sessions/<cli>/<session>/
    session.json                   one Session record
    turns.jsonl                    its Turns, one a line, in order
    outcome.json                   its Outcome record
  outcomes.jsonl                   every Outcome, one a line
  redactions.json                  what redaction masked, by kind
  state.json, sync.lock, sync.log  the collector's own
  cache/github/                    gh's pull request lists, kept half an hour
```

`<cli>` is `claude-code` or `codex`. A session's three files are rewritten whole whenever any of its source files change. To join a session to its outcome, use the session ID: it is the directory name, `id` in `session.json`, `session` in each Turn and in the Outcome.

## sources.json

```json
{
  "schema": 1,
  "sources": [
    { "cli": "claude-code", "dir": "/Users/me/.claude", "accounts": ["c9278023-..."], "note": "me@example.com" },
    { "cli": "codex", "dir": "/Users/me/.codex", "accounts": ["6cbafcf0-..."], "note": "accounts its sessions name" }
  ],
  "keepUnattributed": true
}
```

The first sync writes it with the accounts logged in on this machine. A session is kept when the account it recorded is in any source of its CLI, or it recorded none and `keepUnattributed` is true. Taking an account off removes its sessions at the next sync.

## Session (`session.json`)

| Field | What it is |
| --- | --- |
| `schema` | `1` |
| `id`, `cli` | The CLI's session ID, and `claude-code` or `codex` |
| `account` | `{ id, source }`: the account the session recorded (null for none), and the CLI home it was read from |
| `title` | Claude Code's own title for the session, when it made one |
| `startedAt`, `endedAt` | The first and last timestamps in its files |
| `cwd`, `cwds` | Its first working directory, and every one it used |
| `gitBranches` | Every branch its entries name |
| `models` | Every model that answered in it, subagents' included |
| `parent` | For a Codex subagent thread, the session that started it |
| `threads` | `{ id, kind, agentType?, description?, workflowRun?, turns }` for `main`, each subagent and each workflow agent |
| `workflows` | `{ runId, name?, agents, journalEntries }` for each workflow run it started |
| `counts` | `turns`, `prompts` (typed by the Person), `assistantMessages`, `toolCalls`, `toolResults`, `corrections` |
| `correctionKinds` | Corrections by kind |
| `tokens` | `{ input, output, cacheCreation, cacheRead }`, from the model's own usage records, each message once |
| `redactions` | What redaction masked in this session, by kind |

## Turn (a line of `turns.jsonl`)

| Field | What it is |
| --- | --- |
| `schema`, `session` | `1`, and the session ID |
| `thread` | `main`, `sidechain` (subagent turns older Claude Code kept in the main file), `subagent:<agentId>`, `workflow:<runId>/<agentId>`, or `workflow:<runId>` for the run's journal |
| `n` | Its place in the file, from 0 |
| `at` | When it was written, when the CLI says |
| `role`, `kind` | `user`/`prompt` (what the Person typed), `user`/`context` (what the CLI or a hook put in the user's place), `assistant`/`message`, `tool`/`result`, `system`/`compaction`, `system`/`workflow` |
| `parts` | `text`, `thinking`, `tool_use` (`id`, `name`, `input` as JSON text), `tool_result` (`toolUseId`, `text`, `isError?`, `truncatedFrom?`), `image` (its bytes are not kept) |
| `model`, `tokens` | On an assistant message |
| `correction` | `{ kind, cue }` on a Correction |

A part longer than 64,000 characters is cut and says its length in `truncatedFrom`. Within a thread, a `tool`/`result` answers the `tool_use` parts of the message before it, matched by ID.

### Corrections

| `kind` | When | `cue` |
| --- | --- | --- |
| `rejected-tool` | The Person refused a tool call at its permission prompt | `cli:rejected` |
| `interrupted` | The Person stopped the turn | `cli:interrupted` |
| `redirect` | A typed prompt, after the model worked, that starts with no, stop, wait, don't, revert or actually, or says "not what I asked", "I said", "you should have", "why did you", "that's wrong" | `starts:<word>` or `says:<phrase>` |

The prompt is kept as it was said. `rejected-tool` and `interrupted` are exact; `redirect` is a candidate found by its rule.

## Outcome (`outcome.json`, a line of `outcomes.jsonl`)

| Field | What it is |
| --- | --- |
| `schema`, `session`, `cli` | As above |
| `linkedAt` | When it was linked |
| `repo` | `owner/name` on GitHub |
| `branches` | The branches the session's entries name |
| `commits` | `{ sha, branch?, message }`, from `git commit`'s output in its tool results |
| `prs` | `{ repo, number, url, via, state?, mergedAt?, closedAt?, mergeCommit?, revertedBy? }`; `via` lists `cli` (Claude Code's own record), `tool-output` (`gh pr create` printed it) and `channel` (the Task's pull request) |
| `switchboard` | `{ channel, agent, tasks }`: each Task its Agent claimed, with `claimedAt`, `releasedAt`, `stepsCompleted`, `pr` and `done` |
| `greenroom` | `{ runId, relation, name?, verdict?, outcome?, summary? }`; `relation` is `created` when the session's `machine_create` started it |
| `corrections` | How many Corrections the session has |
| `unlinked` | `{ what, why }` for every link that could not be made |

`state` is `open`, `merged` or `closed`; an Outcome with an open pull request or an unfinished Task is linked again by a sync six hours later.

## redactions.json

```json
{ "schema": 1, "sessions": 897, "sessionsWithRedactions": 235, "total": 11516,
  "kinds": { "a secret assignment": 9100, "an Anthropic key": 91, "an HTTP credential header": 1851, "...": 0 } }
```

Kinds are the redactor's own words for what it masked. Values are never recorded.
