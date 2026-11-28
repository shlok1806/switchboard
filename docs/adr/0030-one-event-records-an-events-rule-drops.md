# One Event records all of an Event's rule Drops

Status: accepted on 2026-10-28. Amends ADR 0003's Relay, whose header comment said every Verdict is an Event: a Drop by rule no longer is one of its own. Keeps ADR 0026: an addressed Update's Verdicts stay one Event each.

## Context

A Channel is one SQLite-backed Durable Object, and Cloudflare bills every row it writes, each index row too, against `rows_written`: the free plan allows 100,000 a day.

The Relay gives a Verdict for each relayed Event and each Agent that is not Gone, Idle and Paused ones included. When nothing overlaps and nothing is addressed to the Agent, it Drops without asking Jev (source `rule`), and until now it still appended a full `verdict` Event for that Agent. So the rows the Relay wrote grew with Events times Agents, and most were rule Drops, because most Events overlap nothing.

Measured in `worker/test/rows-read.test.ts`, with 4 other live Agents and no overlap:

- a `file.edit` wrote 20 rows: 17 to `events`, its own 5 and 3 for each of 4 Verdict Events (the row, the ID index and the AUTOINCREMENT counter), and 3 to `touched_files`;
- an Update wrote 19 rows, all to `events`: its own 7 and the same 12.

The Verdicts also crowd the Dashboard: its snapshot is the latest 1,000 Events, Verdicts included, so the busier a Channel, the fewer Events a Person sees.

## Decision

- All of one Event's rule Drops are one `verdict` Event, recorded once the Relay has planned the Event and before it asks Jev about the rest. Its payload names the Agents: `{ event, agents, at, option: "drop", delivered: "drop", source: "rule" }` (`RuleDrops` in `shared/src/domain.ts`). It carries the source Event's Task, as every Verdict Event does. An Event with no rule Drop has none.
- Every other Verdict stays an Event of its own: Jev's, a `fallback`, and an addressed Update's (ADR 0026). They are rare, they carry probabilities and the state sent to Jev, and a Delivery and a Wake name them by their Event's ID (`woke()` in `worker/src/wakes.ts`). A rule Drop delivered nothing, so nothing names it; a Wake that names a rule Drops Event counts nothing from it.
- It keeps the Event type `verdict`, so everything that already sets Verdict Events apart still does: the Relay never considers them, the CLI's `read_channel` reads past them, the Task history index leaves them out and an Agent's history never has them (their actor is `relay`). Nothing new is indexed.
- `verdictsOf` (`shared/src/domain.ts`) reads either shape as Verdicts, one per Agent. A rule Drop reads as it did when it was stored on its own: `option` and `delivered` "drop", `source` "rule", no overlap. The Dashboard reads its snapshot, history pages and the live stream through it, and the simulated Channel records rule Drops the same way, so every view still shows each Agent's "No overlap, so Jev was not asked." Verdicts stored before this ADR are one Agent's each and read as they are; nothing is migrated.

We rejected a new Event type for rule Drops: every reader that skips `verdict` Events would have to learn it, and one that did not, such as `read_channel`, would put the Relay's bookkeeping in front of Agents. We rejected keeping rule Drops out of the history, as counters or a table of their own: the Dashboard would need another read and another stream message to show whom an Event did not reach.

## Consequences

- With 4 other live Agents and no overlap, a `file.edit` writes 11 rows (8 to `events`) and an Update 10. The Relay's part is one Event, 3 rows, however many Agents it Drops. `rows-read.test.ts` holds the Channel to it.
- The Dashboard's 1,000 Events hold more of what People read.
- `EventPayloads["verdict"]` is `VerdictRecord`, `Verdict | RuleDrops`. Code that reads a Verdict Event's payload as one Agent's Verdict checks for `agents` first, or uses `verdictsOf`.
- A Channel's history holds both shapes from the day this ships.

## With ADR 0037, 2026-11-28

ADR 0037 shipped first: a `file.edit` and the Relay's rule Drops about it are Local Events, kept on the Agent's machine and not stored on the Channel. The two decisions fit together. All of a Local Event's rule Drops are one Local Event too, marked `local` like a single rule Drop was, so a `file.edit` stores nothing on the Channel however many Agents it Drops. A stored Event such as an Update stores itself and one rule Drops Event. `rows-read.test.ts` holds the Channel to both. ADR 0037 also removed the `AUTOINCREMENT` counter, so the row counts above are from before it.
