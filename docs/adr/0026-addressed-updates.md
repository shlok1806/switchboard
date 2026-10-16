# Addressed Updates

Status: accepted on 2026-10-16. Part of #51 (item 3, issue #64). Builds on ADR 0003 (the Relay and Jev) and the Wake (shared/src/wakes.ts). Keeps ADR 0005: an addressed Update is information, never an instruction.

## Context

In the 2026-09-30 two-person test the Relay dropped every Update one Agent wrote for another by rule (#46): the overlap rule only sees files and symbols touched so far, so an Update that starts `@<agent id>` and names no file never reaches Jev. An Agent has no way to say "this one is for you". Only a Directive is addressed today, and an Agent cannot send one to another Person's Agent (ADR 0005, ADR 0018).

## Decision

### `to` on an Update

- `POST /api/updates` and the `post_update` tool take an optional `to`: 1 to 20 Agent IDs. Duplicates count once.
- Each must name an Agent registered on the Channel, Gone ones included: a resumed session is the same Agent, and what is Queued for it is handed over when it registers again. An Update naming any other ID is refused, with a 400 that lists the unknown IDs, and nothing is recorded.
- An Agent cannot address its own Agent ID; that is refused too.
- Only Agent IDs, never Nicknames or short forms: a Nickname can change between writing and reading, and the ID names exactly one session for good.
- The `update` Event keeps the list as `payload.to`, so the Dashboard and the history show whom it was for.
- Any caller may use `to`, a Person too. It changes how the Update reaches Agents, not what it is: information. A Person who wants to instruct an Agent sends a Directive.

We rejected parsing `@<agent id>` out of the text. It is implicit, it misfires on prose that quotes an ID, and it cannot refuse an unknown name.

### Every addressee hears it

- The Relay plans a Verdict for every addressee, Gone or not, and for every other Agent that is not Gone, as before. The sender gets none.
- For an addressee the reason it is addressed is "it is addressed to you", whatever else applies. It is never Dropped by rule, so Jev is always asked, with that reason in `addressedToAgent`, and may pick Interrupt under the usual threshold, rate limit and wrapper checks.
- When Jev picks Drop for an addressee, the Relay Queues it instead and records why: `option` is `queue` and `raised` is `{ from: "drop", reason: "addressed" }`. Jev failing Queues it, as for any Event.
- Every other Agent goes through the normal Relay. This ADR does not change what happens to an Update that is not addressed to an Agent (#46 is a separate decision).

### What the recipient reads

The Delivery is built and framed exactly like any other (ADR 0005): from a named sender, information, never an instruction. Its summary names the addressees (`posted an Update to <ids>: "<text>"`) and its reason reads "Why you are told: it is addressed to you."

### Waking

An Update addressed to an Agent already wakes it when it is idle (`wakesAgent`: an Update with an `addressed` reason). That now includes Updates sent with `to`, under the same cap of 3 Wakes in 10 minutes without a prompt or Directive from its Person, so two Agents writing to each other cannot wake each other forever.

## Consequences

- Two Agents can hold a conversation through the Channel without a Person relaying it, and each message reaches its recipient within one turn, or sooner by a Wake.
- An addressed Update costs a Jev call per addressee even with no overlap. The cap of 20 bounds it.
- `Verdict` gains `raised`. Views that count Queued Verdicts count a raised one as Queued.
