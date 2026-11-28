# A search matches any of its words, those matching more first

## Status

Accepted, 2026-11-06.

## Context

The connector's `channel` tool (ADR 0040) and `memory_search` (ADR 0019) both required every word of a search. A Person's Claude asked the connector with `about: "linux windows ios iphone ipad cross-platform"`, meaning "any of these", and got nothing back, although single words of it were on the Channel. A model asking on someone's behalf lists the words that might be there; it does not know which ones are.

## Decision

- A search matches an Update, Directive, Task or note that has any of its words.
- Those that have more of the words come first. Notes keep FTS5's rank, which already does that; Updates, Directives and Tasks are ordered by how many of the words they have, newest first among equals.
- The words of the question itself ("what", "the", "about", ...) are dropped before searching, unless they are all there is, because with any-word matching they would match everything. The github tool (ADR 0041) uses the same list, plus its own words for files.

## Consequences

- A search no longer narrows by adding words: `webhook charge` finds every note about webhooks, the one about charges first. To narrow, use fewer and rarer words, a Task number or a tag.
- Rows read do not change for Updates, Directives and Tasks: the same window is read and filtered. A notes search can match more index rows than before, still under one LIMIT; `worker/test/rows-read.test.ts` keeps its budget.
