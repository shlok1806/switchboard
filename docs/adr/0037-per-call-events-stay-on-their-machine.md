# Per-call Events stay on the machine that made them

Status: accepted on 2026-11-06, for the owner's direction to ship a hybrid, local-first Channel. Supersedes the part of ADR 0004 that keeps every Event in the hosted Channel. Keeps the rest of ADR 0004: the Channel, the Relay, Claims, Tasks and the shared state everyone must agree on stay in one hosted Durable Object. Builds on ADR 0015 (Hosts) and ADR 0024 (the Agent Summary).

## Context

The hosted Worker runs on Cloudflare's free plan. A Channel is one SQLite-backed Durable Object, and rows written are the meter that binds: 100,000 a day for the whole account, index rows included. Measured on `main` with `worker/test/rows-written.test.ts` (the hour the storage research describes: 360 tool calls, 60 file edits on 20 files, 30 turns, 390 model requests, 120 heartbeats, 4 other live Agents, no overlap), one actively coding Agent writes **7,190 rows an hour**. That is about 14 Agent-hours a day for every Channel on the Worker together, so two Persons with a few Agents each stop the Worker within hours.

Almost all of those rows are per-call records nobody looks up one by one: a `tool.call` per tool call, a `command` per shell command, a `turn.end` per turn, a `proxy.digest` per model request, a `file.edit` per edit and the Relay's rule Drops about each edit. People read them as history on the Dashboard. The Relay reads only the live `file.edit`, and the touched files it keeps from it. Every machine that makes them already holds a WebSocket to the Channel: the Agent's wrapper (`switchboard run`) and, on a machine that runs Agents for the Channel, its Host (ADR 0015).

## Decision

### What the Channel keeps, and what it does not

- **Local Events** are `tool.call`, `command`, `turn.end` and `file.edit` from the Hook Capture, `proxy.digest` and `proxy.raw` from the Proxy Capture, and the Relay's rule-Drop `verdict`s about them (`LOCAL_EVENT_TYPES`, `isLocalEvent` in `shared/src/history.ts`). The Channel does not store them. It still gives each one its ID, `seq`, time and Task, broadcasts it on the live stream as now, and hands each `file.edit` to the Relay as now.
- Everything else stays stored in the Channel, unchanged: Tasks, Claims and Steps, Updates, Directives and their deliveries, Memory Notes, Agents and their Presence, Hosts, Wakes, Jev's and fallback Verdicts, addressed Verdicts, pushes and merges, hand-offs, and the `tool.call`s of the Tool Capture (an Agent calling Switchboard's own tools, a few an hour).
- **Shared aggregates.** What the Channel derives from Local Events and other machines need stays in the Channel, written once per thing rather than once per Event: an Agent's touched files are one `touched_files` row per file per Agent, written when the Agent first edits that file. Edit counts and recency are kept in memory while the Durable Object lives; the Relay's overlap check needs only which files. The Agent row, its Context Reading and its Presence are unchanged, except that a Hook or Proxy message counts as the Agent's sign of life without a write while the row heard from it within two heartbeat intervals (or a tenth of the silence it is Gone after, if shorter): the row and its two indexes cost three rows a message, and a wrapper that heartbeats keeps it fresh anyway.
- **`seq`.** A Local Event still needs a place in the one order the Dashboard and stream cursors use. A Channel's `seq` becomes the time in microseconds, or one more than the last `seq` it gave, whichever is larger, for stored and Local Events alike. It still only grows, and it needs no stored counter. Older Events keep their small `seq`s.

### Each machine keeps its own Agents' Events

- The Channel acknowledges each Hook and Proxy message with the Events as it recorded them (`hook.ack` `events`, `proxy.ack` `event`). The wrapper writes them, and the rule-Drop Verdicts about them it hears on its stream, to the machine's **local store**: one SQLite file, `<config>/events.db` (Node's built-in `node:sqlite`, so the CLI gains no dependency), keyed by Channel and Agent. Every wrapper and the Host on the machine share it. It keeps 30 days.
- **Who answers for an Agent's history.** Its own wrapper while it is attached to the Channel. Otherwise its machine's Host: the Host that started it, or, for an Agent started in a terminal, the Host installed for the same Channel on the same machine, which the wrapper names when it registers (`historyHost`). An Agent with neither has no history once its session ends.
- **The Channel relays history reads.** It sends `history.request` (an Agent, a Task or the whole store, a `before` cursor and a limit) to the answering wrapper or Host over its socket, waits at most 3 seconds, and checks the answer: only Local Event types, only Agents of that socket's Person. It keeps none of it. It merges the answers with its stored Events by `seq`, newest first, then cuts the page to its limit.
- **Reads that go through it:** an Agent's history and the Channel's feed on the Dashboard (`GET /api/events?tail=`, with `agent=`, `task=` or neither), and the Agent Summary's latest activity and touched files (`agent_summary`). The feed and a Task's history ask every attached Host, and every attached wrapper whose machine has no attached Host. Transcript and Terminal Reads were already read from the session on its machine and do not change.
- **Not through it:** the stream's replay after a reconnect (`?after=`) returns stored Events only, and reads by Event ID (`?ids=`) return stored Events and the 5,000 Local Events the Channel recorded last, which it keeps in memory while the Durable Object lives (so a message sent again after a reconnect is recorded once and acknowledged as it was). A Dashboard that reconnects sees the Local Events it missed on its next load of a history page.

### A machine that is asleep

- A history read that cannot reach the machine is not an error. Its answer says which history is missing: `unavailable: [{ host, agents, reason }]`, the reason worded "offline: history unavailable until shlok1806/studio is back". The Dashboard shows that line where the Events would be, and `agent_summary` prints it.
- The feed names each offline Host that holds history of an Agent on the Channel. An Agent's page names its own.

### Moving over

- Two steps, each leaving `main` deployable. First the wrappers and Hosts keep the store and the Channel relays reads, merging what it still stores. Then the Channel stops storing Local Events. Rows already stored stay and keep answering, merged with what the machines answer, so nothing is migrated or lost.
- A wrapper or Host from before this ADR keeps working: it sends and receives what it did, and its Agents' Local Events are only live until it is updated.

## Consequences

- Rows written per Agent-hour fall to what the shared state costs: **430**, measured by `rows-written.test.ts` after the second step (360 for Presence heartbeats, 40 for the silence alarm, 30 for touched files), against 7,190 before. The test holds the Channel to 500, about 200 Agent-hours a day under the free plan.
- **A sleeping laptop's history is unreadable until it wakes.** Its Agents' tool calls, commands, turns, edits and model records are on that laptop only. Its Updates, Claims, Tasks, Directives, notes, touched files and Verdicts that reached anyone stay on the Channel for everyone. This is the cost ADR 0004 rejected for the whole Channel, taken only for the per-call records.
- A machine's disk and its retention decide how far back its history goes; a Person who wipes `<config>` loses their Agents' Local Events. The history is as private as that machine's user account.
- An Agent run in a terminal on a machine with no Host keeps its history readable only while it runs. `switchboard host install` keeps it readable after.
- A Dashboard page load waits up to 3 seconds for a slow machine. An offline one is known at once and costs nothing.
- The Channel's `seq` jumps once, from the small counter to microseconds. Anything that treats `seq` as a count of Events is wrong after this, and nothing in the code does.
- Hosts' answers are trusted for their own Person's Agents only, as a wrapper's Events are. A machine can hide or alter its own Agents' per-call history, which it always could by not sending it.

## Verification

- Worker tests: a history page merges stored Events with a Host's and a wrapper's answers, newest first, cut to its limit; an offline Host is named, not an error; an answer naming another Person's Agent is refused; the Agent Summary carries the store's activity.
- CLI tests: the wrapper writes acknowledged Events to the store and answers a history request from it; the Host answers for an Agent whose wrapper has exited.
- `rows-written.test.ts` before and after the second step.
