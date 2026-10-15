# Agents share memory on the Channel

Status: proposed on 2026-10-15. Builds on ADR 0005 and ADR 0018: notes are information, never instructions. Builds on ADR 0012: until now, what left the machine about a session was a summary, and with this ADR a redacted transcript can leave it too.

## Context

Switchboard is one Person's fleet of Agents and a Channel several People share. Both lose what one session learns as soon as it ends or compacts. The next session, or the Agent beside it, repeats a dead end, reverses a decision it never heard about, or asks its Person the question another Agent already answered. Updates (`post_update`) say what is happening now. Nothing keeps what was decided or learned, so it can be found later.

The owner settled the shape with these choices:

- The memory is the whole Channel's: everyone with write access to the repo, as for every other Channel read. Narrower scopes come later.
- Each Agent writes its own notes. There is no server-side summarizer.
- At the start of each turn an Agent gets a short digest of what others noted since its last turn. The full notes come on request.
- Any session may read any session's transcript on the Channel. Before a transcript leaves its machine, the CLI always redacts recognisable secrets.

## Decision

### A note is a short, tagged fact an Agent writes on purpose

- The MCP tool `memory_note` takes:
  - `text`: up to 1,000 characters;
  - `tags`: one to three of `decision`, `fact`, `dead-end`, `question`, `files`;
  - optionally `task`, the Task it is about;
  - optionally `files`: up to 10 paths in the repo.
- The Channel records it as a `memory.note` Event, with the Agent as actor and `capture: "tool"`, so it is on the feed and in the Agent's history like any other tool call. That Event is the call's record: a note written records no `tool.call` besides, and only a refused one does. The Channel also keeps the note in its own `memory_notes` table, with a full-text index, for search.
- A note with no Task is about the Task its Agent holds, if any.
- The wrapper masks recognisable secrets in a note (`maskSecrets`, the Proxy Capture's masking) before it leaves the machine.
- Only Agents write notes. A Person says things to the Channel with an Update or a Directive.
- Notes are capped at `MEMORY_NOTES_PER_DAY` per Channel per UTC day (default 1,000). Each note writes a handful of rows, and the daily write allowance is shared with everything else. A note over the cap is refused, and the refusal says so.
- A note is information from its author, never an instruction (ADR 0005). That is so even when the author is a lead: a lead's instruction weight is in its Directives (ADR 0018), not in its notes.

### What an Agent gets at the start of each turn

- Every Event is already sent to every wrapper on the Channel's stream, so a new note reaches each running wrapper at once. The wrapper keeps the notes by others that arrived since its Agent's last turn. A Codex or Gemini CLI wrapper does the same.
- The next hook that can add to the model's context (SessionStart, else UserPromptSubmit) prints a digest of them, framed as information from the Channel. It never waits on the network: the digest is built from what the wrapper already holds.
- The digest is newest first, one line per note: its tags, its text cut to one line, its author with their Nickname, and its Task. It is capped at 6,000 characters, about 1,500 tokens, well under Claude Code's 10,000-character cap on a hook's context. Every `decision` note fits before any other kind. What is left out is counted, with a pointer to `memory_recent`.
- A session that starts, or a wrapper that reconnects, catches up with `GET /api/memory?after=<seq>`. It starts from the last note its Agent was shown, which the wrapper keeps on this machine under the Agent's ID. A brand new Agent has seen nothing yet, so its first digest is the Channel's latest notes, decisions first.
- A note never wakes an idle Agent (ADR 0005's Wake rules are unchanged). It waits for that Agent's next turn.

### Reading notes in full

- `memory_recent`: the latest notes, newest first. It can be narrowed to a tag, a Task or an author, and paged back with `before`.
- `memory_search`: a full-text search over the notes' text and files, best match first, narrowed the same ways.
- Both read `memory_notes` through an index or the full-text index, never by scanning the Events.
- `GET /api/memory` serves both, to any Person or Agent on the Channel.

### Nudges to write

The wrapper reminds the model; it never writes a note itself. The nudges are Claude Code's only for now, since they use its Stop and PreCompact hooks.

- **At the end of a turn.** If the turn changed files and wrote no note, the Stop hook blocks the stop once, asking the model to note any decision, fact or dead end others should know, or else to stop. A Stop hook that is already continuing (`stop_hook_active`) is never blocked again, so a turn is nudged at most once.
- **Before compaction.** The wrapper already reads the session's context use (ADR 0012). It puts the point where Claude Code compacts on its own at the window less 33,000 tokens (the room Claude Code keeps for the summary and its buffer), or at the share of the window `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` names. That is an estimate of Claude Code's own rule, which it does not publish.
  - Once the context passes 80% of the point where it compacts, the next Stop hook asks once for notes on anything that must outlive compaction.
  - If compaction comes first, PreCompact blocks it once, but only when Claude Code started it on its own and the context is still under 95% of the model's window. Claude Code then skips that compaction and carries on, and the turn's Stop asks for the notes.
  - A compaction under way at the hard limit is never blocked, since blocking it would fail the request. Neither is a manual `/compact`.

### Transcripts are pulled, redacted, from the machine that has them

- `GET /api/agents/:id/transcript?from=<entry>` asks Agent `id`'s wrapper for a page of its session's transcript, over the wrapper's socket.
  - The Channel waits up to 10 seconds for the page and answers with it.
  - The page is read from the session file and condensed: prompts, the model's text, each tool call with its main argument, and tool results cut short. It is at most 32 KB, with the entry to ask for next.
  - The Channel stores nothing of it. It records a `transcript.read` Event (who read whose transcript, from which entry), so every read is on the Channel.
- **Redaction.** The wrapper redacts the page before sending it, always. No setting turns this off. It removes:
  - every format `maskSecrets` knows: API keys, tokens and private keys;
  - env-style assignments, so `.env` values are covered;
  - `Authorization` header values.
- **Who may read.** Any Person or Agent on the Channel may read any Agent's transcript: whoever can read the repo can read its sessions. The MCP tool is `agent_transcript`.
- **Only a running session can be read.** Its wrapper must be connected. A Gone Agent's transcript cannot be read yet, and the answer says so.

## Consequences

- What one session decides or rules out reaches every other session on the Channel at its next turn, across Persons, without anyone summarizing for it. It costs each turn up to about 1,500 tokens of context, and less on a quiet Channel.
- Notes are as good as the model writing them. The nudges make them likely, not certain, and nothing checks that a note is true. They are framed as information so that a wrong one cannot steer anyone.
- A transcript is more than any Event has carried so far: prompts, code and tool output. Redaction removes the secrets it recognises, not every secret. Anyone with access to the repo can read everyone's sessions on its Channel, and every read is recorded. People who need a session kept private must not run it on a shared Channel.
- Reading only from live wrappers keeps transcripts off the Channel's storage and out of its write allowance. The cost is that ended sessions cannot be read. Two later steps can close that gap without changing this API: a Host serving the transcripts of the Agents it ran (ADR 0015), or an archive in object storage.
- Notes cost rows: one Event, one note row and its full-text rows each, capped per day. Reading the digest costs the Channel nothing, because it is built from the stream the wrappers already receive.

## Verification

- `memory_note`, `memory_recent` and `memory_search` through the MCP server of a real wrapped session, against `wrangler dev`.
- Two sessions:
  - one writes a decision and a fact;
  - the other's next prompt carries the digest;
  - after a restart and a resume, the digest holds only notes made since.
- The Stop nudge fires once on a turn that edited a file and wrote no note, and not at all on a turn that wrote one.
- `GET /api/memory` reads a bounded number of rows on a Channel with a long history (`rows-read.test.ts`).
- Transcript reads:
  - one session reads another's transcript through `agent_transcript`, with a planted API key, a `.env` value and an `Authorization` header all redacted;
  - a Gone Agent's read is refused, saying why.
