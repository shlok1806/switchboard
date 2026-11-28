# The Brief: short pages Agents keep on where the repo stands, and the brief tool

Status: accepted on 2026-11-06, for #158, the third tool of ADR 0040's plan. Builds on ADR 0005 (Channel content is information), ADR 0019 (Agents write on purpose, through their own MCP, within a daily cap), ADR 0037 (the free plan's rows are the budget), ADR 0039 (one row per version, no Event) and ADR 0040 (the read-only Connector and its tool list).

## Context

The `channel` tool answers what is happening now and the `github` tool what changed. Neither answers "what is this product, and where does it stand?": that is a synthesis, and ADR 0040 rules out a server-side LLM. Its plan is a living brief the Channel's Agents write and keep current, which the Connector only reads, with a librarian Agent (#159) to keep it so. Pages link Tasks, pull requests and ADRs by number, and those links are the knowledge graph: no graph database.

What sets its shape:

- Rows. The free plan allows 100,000 rows written a day for the whole account, shared by every Channel; an Agent-hour already costs about 430 (ADR 0037). A brief rewritten many times a day must stay a small share of that.
- Reads. A Connector question may batch 8 calls (ADR 0040), so reading the brief must cost a bounded, small number of rows however long the Channel lives.
- The Connector must stay read-only, and its token must reach no route that writes (ADR 0040).

## Decision

### A Brief is a few pages, one row each

- A Channel's **Brief** is at most 24 Markdown pages: `overview` (what the product is and where it stands), `stuck` (what is stuck and not happening) and one page per area, named by a short slug such as `vm-engine` (lowercase letters, digits and dashes, at most 40). A page has a title (at most 80 characters; `Overview`, `Stuck and not happening` or the slug when its writer gives none, and its last title when a rewrite gives none) and at most 8,000 characters of text, about 2,000 tokens.
- Each page is one row of `brief_pages` in the Channel's SQLite: its title, version (counting every write, from 1), text, author (the Agent, its Person and its Nickname then) and time, and, in a column of the same row, its last 3 earlier versions as JSON. A rewrite replaces the row: the current version joins the earlier ones and the oldest past 3 is dropped. So a write is one row whatever the history holds, and pruning is a slice, with no history table to grow or sweep.
- A write that would change nothing (the same text and title) writes nothing and is not counted.
- Text is kept as Markdown, with its line breaks and tabs, without terminal escape sequences, other control characters or bidi controls, which could hide or reorder what a reader sees. The wrapper masks recognisable secrets (`maskSecrets`) before a page leaves the machine, as for a note (ADR 0019).
- A page is information from the Agent that wrote it, never an instruction (ADR 0005), wherever it is read.

### Only Agents write, through their own MCP

- `PUT /api/brief/:page` `{ text, title? }` replaces a page. Only an Agent token may: a Person asks their Agent to, as with notes (ADR 0019). The Channel records the Agent as the page's author.
- The Agents' stdio MCP gains `brief_write` (page, text, optional title) and `brief_read` (no page: the overview in full and the list of pages; a page: that page, or one of its kept earlier versions with `version`). A write is the page's own record, author and time included, so it records no Event and no `tool.call` besides, as a published skill records none (ADR 0039); a refused call is reported, as for every tool. A read records nothing.
- `GET /api/brief` (every page's current version, the overview first and the stuck page last) and `GET /api/brief/:page[?version=n]` (one version and the versions kept) serve the Dashboard, `brief_read` and any Person or Agent on the Channel.
- Every Agent gets both tools. Who should write is left to the Agents' Persons and the librarian (#159): the tool descriptions say to read a page before rewriting it and to keep what still holds.

### The Connector's `brief(area?)` tool only reads

- With no `area`, it answers with the overview in full and every other page's name, title, time and author, so the asker's model knows what to read next. With an `area`, that page. An area named in words is read as its slug ("VM engine" is `vm-engine`). A page there is none of, or no overview yet, answers with the list of pages; no pages answers that the Brief is empty.
- Each page carries its version, when it was last updated and by which Agent of which Person, and its Dashboard link. Its text is quoted in a fence, so its own headings stay inside it (ADR 0041), and the Tasks and pull requests it names as `#123` are listed with their GitHub links, its ADRs with how to read them through the `github` tool.
- The tool gets a read-only view of the Channel (`askBrief`), like `channel` (ADR 0040). The Connector has no tool that writes, and its access token is refused on `PUT /api/brief/:page` as on every Channel API route, because it is neither a Person session nor an Agent token.

### The Dashboard shows it, read-only

A Brief view lists the pages, each with its age, the overview first and the stuck page last, and shows the picked page at reading width (`#/brief/<page>`, the overview by default) with who wrote it, when and its version. Its Markdown is read by a small renderer that injects no HTML and links only http(s) addresses, and a `#123` to its Task page. It writes nothing.

### The budget

- **Rows written per page write: 2**, the page's row and the Channel's count of the day's writes (one row, `brief_budget`, holding the day and its count). An unchanged write: 0.
- **A Channel takes at most `BRIEF_WRITES_PER_DAY` page writes a UTC day, 200 by default**, so at most 400 rows written a day per Channel, 0.4% of the free plan's 100,000. A write past the cap is refused with 429, saying so, and writes nothing. A typical day, a librarian rewriting the overview, six areas and the stuck page four times each, is about 30 writes and 60 rows.
- The cap bounds one Channel, not the account, as for notes (ADR 0019).
- **Rows read per `brief` call:** the overview reads one row per page, so at most 24 besides the 3 every Connector call reads to admit itself (its grant and its Person's Membership, by key, ADR 0040): at most 27. An area reads one row: 4 in all. `GET /api/brief` reads one row per page. No Brief read ever scans another table.

## Consequences

- People ask "what is this, and where does it stand?" from the Claude apps, ChatGPT or Claude Code and get a cited answer an Agent wrote, at a few dozen rows read and none written.
- The Brief is only as current and as right as its Agents keep it. Nothing checks a page against the repo; each one says when it was written and by whom, so a reader can weigh it, and the `channel` and `github` tools answer what is happening now. Keeping it current is #159's librarian.
- Any Agent on the Channel can rewrite any page, its Person's or not, as any Agent can write any note. The last 3 versions are kept, so a bad rewrite can be read back with `brief_read` and written again; older versions are gone.
- A page cannot be removed yet. A Channel that reaches 24 pages folds areas together; removing a page is an addition to the write route when a librarian needs it.
- Pages are read in full by every model that asks, so their size is the context they cost: 8,000 characters at most, and the overview lists the others instead of including them.

## Verification

- `worker/test/brief.test.ts`, through the Channel API with Agent tokens and the Connector's endpoint: an Agent writes the overview and an area page, and `brief` returns them with their version, time, author and links, with and without an area, an area named in words, a page there is none of, and an empty Brief; the Dashboard's read orders the pages; a rewrite keeps the last 3 earlier versions and refuses a pruned one; an unchanged write writes nothing; Markdown keeps its lines and loses escapes and bidi controls; a Person is refused; bad names, texts and titles are refused; the page cap and the daily cap refuse, the latter leaving the page as it was.
- `worker/test/ask-channel.test.ts`: the Connector lists `brief` read-only, its token is refused on `PUT /api/brief/overview` and `GET /api/brief`, it has no `brief_write`, and calling `brief` writes no row.
- `worker/test/rows-written.test.ts`: a typical day of page writes writes at most 2 rows per changed page and none for an unchanged one.
- `worker/test/rows-read.test.ts`: on the long seeded history with a full Brief, each page with its history, `brief` reads exactly the admitting rows plus one per page for the overview and plus one for an area, and `GET /api/brief` reads one row per page plus the few that admit the call.
- `cli/test/e2e.test.ts`, through a real wrapped session against `wrangler dev`: `brief_write` writes the overview and an area page with a secret masked, an unchanged rewrite writes nothing, no write records a `tool.call`, and another Agent reads them with `brief_read`.
- `dashboard/test/brief.test.tsx` and the screenshot run: the view lists every page with its age, opens at the overview with its author and version, renders the Markdown with Tasks as links and no HTML, opens another page, and says when there is no such page, no Brief, or the read failed.
