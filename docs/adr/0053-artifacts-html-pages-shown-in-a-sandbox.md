# Artifacts: HTML pages shared on the Channel and shown in a sandbox

Status: accepted on 2026-11-07, for the owner's direction that Switchboard "open HTML pages within Switchboard": when they share an HTML artifact with their agent, it opens there directly, the artifacts are kept in a folder of their own, and Persons share them through their coding agents. Builds on ADR 0005 (Channel content is information), ADR 0039 and 0050 (shared skills: versions, the owner rule, the secret check), ADR 0042 (the Brief: a daily cap, a few versions kept) and ADR 0049 (the Dashboard's Knowledge section).

## Context

Agents make HTML pages all the time: a report, a chart, a prototype, a small tool such as a receipt splitter. Today such a page lives as a file on one machine, and a teammate sees it only if someone copies it over chat. The Dashboard is already open in every Person's browser, so it can show the page; the Channel already carries what Agents make for each other.

An HTML page runs code. Shown in the Dashboard's own origin, a page an Agent published (confused, or prompt-injected by something it read) could read the Channel as whoever views it, type into a terminal they hold, or change their Hosts. So it must never run in the Channel's origin.

## Decision

### An Artifact is one HTML page, a name and its last few versions

- An **Artifact** is a single self-contained HTML page shared on the Channel under a name of lowercase letters, digits and dashes (at most 64), with a title (the page's `<title>` when the publisher gives none, at most 120 characters). Each publish is the name's next version; the last 5 are kept and the one that falls off is removed.
- A page is at most 8 MiB of UTF-8, so one request carries it whole, well under the Workers RPC limit. It is stored in chunks of 1 MiB, one a row, under SQLite's 2 MB value limit (`artifact_versions`, `artifact_chunks`). A Channel holds at most 200 artifacts and 1 GiB of kept versions, and takes at most `ARTIFACT_PUBLISHES_PER_DAY` publishes a UTC day (200 by default, counted in `artifact_budget`). Publishing the page and title the latest version already holds writes nothing and is not counted.
- A page is refused, on the laptop before it leaves and again on the Channel by the same code (`checkArtifact`, `shared/src/artifacts.ts`), when it holds a NUL, is too big, or holds a value that looks like a real credential (the skill check, ADR 0050), naming the kind and line, never the value.
- A name belongs to the Person who first published it, kept on every version so pruning never loses it: only that Person, or one of their Agents, publishes its next versions (ADR 0039's rule). Each version names the Person and, when one did it, the Agent and its Nickname then.
- Only the owner deletes a name, and only as a Person: `DELETE /api/artifacts/:name` (the viewer's **Delete** on the Dashboard, for its owner only, or `switchboard artifacts delete`) removes every kept version and its chunks and answers `{ ok: true, deleted, versions }`. An Agent token is refused (403), even the owner's own Agent's: deleting cannot be undone, and an Agent never acts as its Person (ADR 0034), so there is no MCP tool for it. Afterwards the name is free: whoever publishes it next owns it, from version 1. Both the Dashboard and the CLI say what goes and that it cannot be undone, and ask first; the CLI refuses without a terminal to ask on unless `--yes`.
- Nothing else is written: no Event. An Agent's `artifact_publish` is reported as its `tool.call` (a Local Event, ADR 0037), naming the artifact and version, never the page; the Dashboard re-reads its artifacts when one streams in.

### Who publishes, and no prompt

- Any Person (from the Dashboard or `switchboard artifacts publish`) or Agent on the Channel publishes and reads. Unlike a skill, an artifact is not loaded into any model's context as instructions: it is a page for people to look at, and an Agent that reads one is told it is information from whoever published it (ADR 0005). So publishing needs no permission prompt, and every CLI is offered the tools. The librarian is not: it writes Brief pages and nothing else (ADR 0045).

### The page runs in a sandbox, never in the Channel's origin

- `GET /api/artifacts/:name/page[?version=n]` serves the page as `text/html` with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors 'self'`, `X-Content-Type-Options: nosniff` and no referrer. The CSP `sandbox` puts the document in an opaque origin whether it is framed or opened in a tab of its own, so:
  - its scripts cannot read the session cookie (HttpOnly) or the Dashboard's storage, where Attach Keys live (ADR 0021);
  - a request it makes to the Channel carries `Origin: null`, which every write refuses, and the Channel sends no CORS headers, so it cannot read an answer either;
  - with no `allow-same-origin` and no `allow-top-navigation`, it cannot reach the Dashboard around it or navigate it away.
- The Dashboard frames the same URL in an `<iframe sandbox>` with the same flags, so both layers hold. Every page is revalidated against its digest (`ETag`, `304` when unchanged), never cached as `immutable`: a delete frees the name and the next publish starts again at version 1, so a name and version can come to mean a different page.
- What a page loads from elsewhere (a CDN script, a font) still loads: pages Agents make depend on it, and an opaque origin can do nothing on the Channel with it.

### Where they show up: the folder, on the Dashboard and on disk

- The Dashboard's Knowledge section gains **Artifacts** (`#/artifacts`), the folder: every artifact by its latest version, newest first, with its title, size, publisher and age, and an **Open HTML file** button that publishes a file from the Person's machine as them. An artifact opens at `#/artifacts/<name>[/<version>]` as a small browser: the page in its sandboxed frame filling the view, with its versions, Reload, Open in new tab and Download.
- The Agents' stdio MCP gains `artifacts_list`, `artifact_publish` (a path to an `.html` file, or the HTML itself, with a name and a title) and `artifact_read`. `artifact_publish` answers with the Dashboard link and, for an Agent at a Person's terminal, opens it in their default browser, so the page the Person asked for is in front of them; an Agent on a Host (ADR 0015) never opens a browser. `artifact_read` saves the page to `.switchboard/artifacts/<name>.html` in the Agent's checkout, the folder on disk, kept out of git like the Task worktrees (ADR 0006), so the Agent reads and edits it with its own tools and publishes it again from that path.
- `switchboard artifacts list | show | publish | open | pull | delete` does the same from the terminal, as the Person.

## Consequences

- Anything an Agent makes as a page reaches every Person on the Channel in one call, and its Person sees it at once.
- A page is as trustworthy as whoever published it. The sandbox keeps it from acting on the Channel, not from showing something misleading, such as a form asking for a password; the Dashboard says who published each page and that it runs sandboxed. Nothing reviews pages.
- A page can still reach the internet from the viewer's browser, so it can see the viewer's IP address when they open it, as any link they follow can.
- Five versions are kept, so an older version is gone for good once five newer ones are published. A page published by mistake is deleted by its owner, or fixed by a new version; a delete is for good too, and a page someone saved or downloaded stays with them.
- No one but its owner deletes an artifact, so one whose owner has left the Channel stays.
- Rows written per publish: one for the version, one per MiB of page, one for the day's count, plus the rows a pruned version frees. A list reads one row per kept version, at most 1,000.

## Verification

- Worker tests (`worker/test/artifacts.test.ts`): an Agent publishes and anyone lists, reads and loads the page byte for byte; the page's headers are the sandbox, `frame-ancestors 'self'` and `nosniff`, with neither `allow-same-origin` nor `allow-top-navigation`, and a download names its file; a 3 MB page of multi-byte text is chunked and read back whole; an unchanged publish writes nothing; only the last 5 versions are kept and an older one is refused, naming those kept; the owner rule for Persons and their Agents; the librarian is refused; the owner deletes as a Person, every version and chunk going, so a republish of the name starts at version 1 owned by whoever published it, while an Agent token (the owner's own Agent's too) and another Person are refused, deleting nothing, and no such artifact is a 404; a bad name, an empty page, a NUL, an oversized page and a planted token are refused, writing nothing, and a placeholder is not; the daily cap refuses past it.
- CLI tests and e2e (`cli/test/e2e.test.ts`, a real `wrangler dev`): a wrapped session publishes from a path, another Agent lists and reads it and gets the file under `.switchboard/artifacts/` byte-identical, an unchanged republish publishes nothing, a planted token is refused on the laptop, and the `tool.call` names the artifact but not its page; an Agent on a Host never opens a browser; `switchboard artifacts delete` says what goes and asks on a terminal (no deletes nothing, yes deletes), refuses without a terminal, and deletes with `--yes`.
- Dashboard tests (`dashboard/test/artifacts.test.tsx`) and screenshots: the folder lists artifacts with publisher and age, the viewer frames the page URL of the picked version with exactly the sandbox flags, versions switch, Open HTML file publishes and opens it and a secret is refused with its reason, a streamed `artifact_publish` re-reads the list, Delete shows only for the owner and asks in place, then deletes and goes back to the folder, a refusal shows in place, and the empty, old Worker and error states.
