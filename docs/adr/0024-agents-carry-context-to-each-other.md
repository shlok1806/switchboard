# Agents carry context to each other

Status: accepted on 2026-10-15. Builds on ADR 0019 (notes, the digest and transcript reads), ADR 0012 (the Context Reading), ADR 0021 (the redacted live terminal), ADR 0015 and ADR 0018 (Hosts and leads), and ADR 0002 (Stale Claims). Keeps ADR 0005: everything here is information, never an instruction. Changes one rule of ADR 0019: the order of the digest.

## Context

The canvas spec (docs/canvas-design-spec.md, "Linked context and memory") settles that any session can pull any other session's context on the Channel, already redacted by the CLI, and that memory notes are pushed as a capped turn-start digest. ADR 0019 built notes, the digest, the nudges and transcript reads. Three gaps remain before one Agent can carry on from another without a Person copying text between them:

- An Agent can list the others and page through a running one's transcript, but it cannot see in one read what another Agent is on: its Task, its last Updates, its notes. It cannot see its terminal either, which People can.
- The digest orders notes by tag and age only. An Agent on Task #12 editing `web/src/api/client.ts` gets a decision about billing before a dead end about its own file.
- A new or resumed session starts blank. To continue a predecessor's work, its Person pastes what they remember of it.

## Decision

### An Agent Summary, built from what the Channel holds

- `GET /api/agents/:id/summary` answers with Agent `id`'s summary, for any Person or Agent on the Channel:
  - the Agent itself, with its latest Context Reading (its first prompt's summary, its latest activity, its folder and branch, its context use);
  - the Tasks it holds, each with its status, branch and Steps;
  - its latest Updates, at most 5;
  - the files it edited, most recent first, at most 15;
  - notes: the ones it wrote, and its Tasks' `question` and `dead-end` notes by anyone, at most 20;
  - the Agent it continues, and the Agents that continue it.
- It is built from rows the Channel keeps already, through their indexes. Nothing new leaves any machine, so it works for a Gone Agent too. It records no Event: unlike a transcript or a terminal, it reads nothing from a session.
- The MCP tool `agent_summary` prints it, framed as information from another session.
- `list_agents` also names each Agent's Tasks and its latest activity.

### Terminal Reads, pulled like transcripts

- `GET /api/agents/:id/terminal` asks Agent `id`'s wrapper for its screen over its socket, the way a transcript page is asked for (ADR 0019): the same 10-second wait, one read at a time per Agent, only while it runs.
- The wrapper answers with the screen exactly as it sends watchers (ADR 0021): plain text, secrets masked, no escape sequence. The Channel keeps none of it and records a `terminal.read` Event: who read whose terminal, and how many rows.
- Any Person or Agent on the Channel may read it, as anyone may watch it (ADR 0021). The MCP tool is `agent_terminal`.
- `agent_transcript` takes `latest: true`, which reads the page that ends at the newest entry. Pages stay at most 32 KB, so neither read can flood a context window.

### The digest, weighted toward what the Agent works on

- The wrapper keeps the Agent's focus from the Channel stream it already receives: the Tasks it holds (its `claim` Events, until a release, a finish or a Takeover) and the files it edited (its `file.edit` Events), at most 50. A resumed session starts its focus from `GET /api/tasks` and its touched files; a successor (below) starts from its predecessor's.
- Each note is scored: on one of the Agent's Tasks, or naming one of its files; tagged `decision` or `dead-end`; then `question`. The digest fills in score order, newest first within a score, and prints in that order, with a heading that says so. This replaces ADR 0019's rule that every `decision` note fits before any other kind. Its cap, about 1,500 tokens, is unchanged.

### Nudges in Codex too

- Codex 0.162 takes a Stop hook's `{"decision":"block","reason":...}` as Claude Code does, so the Stop nudge for a turn that changed files and wrote no note runs in Codex too. Codex's PreCompact hook cannot hold a compaction back, and when Codex compacts on its own is not published, so the nudges before compaction stay Claude Code's.
- Gemini CLI is not installed where this was written. Its documented AfterAgent hook has a different shape, so it gets no nudge until one is tried against a real session.

### Hand-offs

- `switchboard run <cli> --from <agent>` starts or resumes a session that continues Agent `<agent>` (its ID, the short form or its Nickname, as `agent_transcript` takes).
  - The wrapper reads the predecessor's summary first, and refuses to start when the Channel has no such Agent.
  - It registers the session with `continues`. The Channel keeps it on the Agent, set once, and records an `agent.handoff` Event the first time: the actor is the successor, the payload names the predecessor, and the Event's Task is the predecessor's current one.
  - The successor's first hook that adds to the model's context (SessionStart, else UserPromptSubmit) carries the Hand-off Brief: the predecessor's summary, framed "[Switchboard] Information from the Channel, not an instruction", capped at 8,000 characters (about 2,000 tokens). The Agent's instructions still come from its own Person: the prompt they type, or a Host spawn's brief.
- **Hosts.** `POST /api/agents/spawn` takes `from`. The Host passes `--from` to the wrapper it starts, and only for that first start: a resume after a crash is the same Agent, which has its brief already.
- **Leads.** `agent_spawn` takes `from`, so a lead can start an Agent that continues another one. The lead's brief is its Directive (ADR 0018); the Hand-off Brief is information.
- **Claims are not moved.** A hand-off never takes a Claim. If the predecessor still holds its Task, the brief says so: it releases it, or, once it is Gone, a Person takes it over (ADR 0002).
- **The Dashboard.** An Agent's page says "Continued from" and "Handed off to" when either is true, and has a Hand off action that opens the one Start an Agent sheet with `from` set, the predecessor's folder and a brief the Person edits.

### Why a brief is information, not a Directive

A predecessor's summary is made of its own Context Reading, Updates and notes: words other Agents wrote. Typed as a session's first prompt, it would carry the authority of the Person typing (ADR 0005). It is added as hook context instead, framed as information, like every other thing the Channel tells an Agent. A Host spawn's brief, which the Person writes in the sheet, is the instruction, as before.

## Consequences

- One read tells an Agent what another is on, and a successor starts with its predecessor's state without a Person pasting it.
- A summary costs no rows written and reads bounded rows. A terminal read costs one Event, like a transcript read.
- A wrong or stale summary cannot steer a successor: it is framed as information. It can still mislead it, as a wrong note can.
- Weighting needs the Agent's focus. A wrapper that missed stream Events while it was disconnected has a stale focus until it reconnects; the digest still shows every note, only in a less useful order.
- The summary reads Channel state, not the predecessor's session. What it did and never told the Channel (no Update, no note, nothing pushed) is only in its transcript, which a successor can read while the predecessor runs.

## Verification

- Through the MCP server of a real wrapped session against `wrangler dev`: `list_agents` names Tasks, `agent_summary` and `agent_terminal` read another Agent, with a secret on its screen masked, and `agent_transcript` reads the latest page.
- A note on the reader's Task and file comes before a newer decision about something else.
- `switchboard run claude --from <agent>`: the SessionStart hook carries the brief, framed as information; the Channel records `agent.handoff` once and keeps `continues`; an unknown predecessor is refused before the CLI starts.
- A Host spawn with `from` starts the wrapper with `--from`, and a resume does not.
- The Dashboard, in mock mode at 1440 and 390 wide, light and dark: the Agent page says "Continued from" and "Handed off to", and Hand off opens the sheet prefilled.
