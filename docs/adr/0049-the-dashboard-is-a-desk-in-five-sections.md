# The Dashboard is a desk in five sections

Status: accepted on 2026-11-06. Supersedes ADR 0023's type, palette values, top bar, phone tab bar and page head, and ADR 0016's remaining layer of earlier token names. ADR 0023's rule that one colour means a Person is needed stands, as do its state vocabulary, its Running green (the 2026-10-16 amendment) and ADR 0047's thinking orb. Records the owner's approval of the Dashboard design "Desk" (v4). The full system is `dashboard/design.md`; this ADR records the decisions in it that code depends on.

## Context

The owner asked for a first-principles rebuild of the Dashboard with an editorial product tone: calm, typographic and product-grade, the terminal and developer look dialled down, dense where the data demands it and generous everywhere else. The Dashboard is now used by teams: each teammate runs their own Agents on a shared Channel, sees what every Agent is doing, steers it, and reads the shared knowledge (the Brief and the Memory Notes).

Three designs came before. v1, a "control room" (a rail, KPI tiles, a colour per state), read as a generic admin kit. v2, an "operator's log" (an editorial broadsheet), read as a document instead of a tool. v3, "Ringdown" (ADR 0023), fixed the colour problem with one signal colour, but kept a developer's voice: a grotesk and its mono everywhere, ids and the channel path in mono, nine views as keycaps in one bar, and a phone that hid five of them under More.

The lesson of v1 and v2 is that the tone must live in the type and the hierarchy, not in the layout: the shell stays a product (bars, tables, an inspector, a palette), and only the structure of each page and the knowledge the team keeps are set as reading.

## Decision

### The information architecture follows what a teammate opens the Dashboard to do

In order of how often:

1. Answer what needs them: a Pending Approval on their Agent, a Stale Claim, a pull request to review.
2. See what every Agent is doing, and on which Task.
3. Steer one Agent: a Directive, the keyboard, pause, stop, hand off.
4. Catch up on what happened.
5. Plan and take Tasks.
6. Read the shared knowledge: the Brief, the Memory Notes, the shared Skills.
7. Set up: Hosts and the Channel's settings.

So the Dashboard has five sections, not nine views: **Now** (1), **Agents** (2, 3, and 7's Hosts, since a Host is where Agents run), **Tasks** (5), **Activity** (4) and **Knowledge** (6). Agents holds three views, the table, the Canvas (the same Agents laid out by Host and lead) and the Hosts; Knowledge holds the Brief, Memory and Skills, and opens at the Brief. A section's views are tabs in a bar under the top bar, which also carries the trail inside an Agent or a Task. The Channel's settings stay in your menu.

The desk's top bar and the phone's tab bar hold the same five sections, so a phone reaches every view in at most two taps and there is no More menu. Every route people have bookmarked is kept (`#/canvas`, `#/hosts`, `#/brief`, `#/memory`, `#/skills` and the rest parse as before); only where the bars show them changes.

### Type: a reading serif for structure and knowledge, a grotesk for the product

- **Newsreader** (Production Type, SIL OFL 1.1, self-hosted from `@fontsource-variable/newsreader` with its optical-size axis): page titles, a page's section heads, an Agent's, Task's, note's or Event's name at the head of its page or inspector, the wordmark, and the reading text of the Brief and of Memory Notes at 17/1.6. Roman only.
- **Schibsted Grotesk** (Schibsted, a news publisher, SIL OFL 1.1, from `@fontsource-variable/schibsted-grotesk`): everything else, the product's voice. Its tabular figures also widen punctuation, so figures are tabular only where they line up in a column, and never on a clock time.
- **No third face is loaded.** Commands, paths, branches, hashes, ids where they are ids, and the terminal use the platform's own monospace (`ui-monospace` and its fallbacks). The channel path and Person names are no longer mono.

`@fontsource-variable/spline-sans` and `@fontsource-variable/spline-sans-mono` are removed.

### Colour: warm neutrals, the red pencil, and nothing else

Neutrals move from a cool navy tint (hue 250) to a barely warm grey (hue 85, chroma at most 0.012), so long reading does not glare and nothing reads as a terminal. The signal moves from magenta (hue 345) to a carmine red pencil (hue 25): `oklch(52% 0.2 25)` light, `oklch(72% 0.16 25)` dark. It still always and only means a Person is needed, and a new use that does not is a bug. Running stays green (hue 155). Every pair read as text is at least 4.5:1 in both themes; the values and the measured pairs are in `design.md`.

`tokens.css` has one layer of names, the roles; ADR 0016's and ADR 0023's earlier names (`page`, `panel`, `accent`, `state-*`, `verdict-*`, `cli-*`, the shadcn names) are gone, and Tailwind's own palette, faces, sizes, radii and shadows are reset, so a colour, face or size that is not a token cannot be written.

### The page

A page opens with its title in the display face at 30px (24 on a phone) and its facts on one quiet line under it; its sections are headed in the display face at 20px over a hairline. Inspectors and cards stay dense: their sections are headed in the grotesk at 15/600. Space is generous between regions (a 32px gutter and page top on a desk) and tight inside a table (38px rows, 30 compact).

## Consequences

- `dashboard/design.md` is rewritten as v4. `THIRD_PARTY_NOTICES.md` lists Newsreader and Schibsted Grotesk.
- The phone's More menu is gone; your menu (the login at the right of either bar) holds the Channel's settings, the theme and sign-out on every width.
- The router test asserts the new bars: five sections on the phone, and every view reachable as a section or one of its tabs.
- The Dashboard gains `biome check` in its own package, as the Worker and the CLI have.
