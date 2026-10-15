# The Dashboard has one signal colour

Status: accepted on 2026-10-15. Supersedes ADR 0016 in part: its palette, its typeface and type scale, its state colours, its CLI hues, its page layout and its list of `inspect.mjs` allowances. The rest of ADR 0016 stands: the token layers, flat surfaces separated by tone, state as shape and word, and the checked gate. Records Shlok's approval of the Dashboard design "Ringdown" (v3). The full system, with every component, is `dashboard/design.md`; this ADR records the decisions in it that code depends on.

## Context

ADR 0016 gave the Dashboard one design system adapted from a landing page: navy ink, a tangerine primary control, a page head per view and a centred column. Since then the Dashboard has become the place where a Person watches a fleet of Agents and answers what they need: prompts and approvals are first-class (ADR 0013, 0014), Stale Claims wait for a Person (ADR 0002), and the canvas and the live terminal are views of what the Channel already knows (ADR 0020, 0021).

Two earlier drafts of this ADR were rejected. A "control room" (a rail, KPI tiles, a status colour per state) read as a generic admin kit; an "operator's log" (an editorial broadsheet) read as a document. Both shared the real problem with ADR 0016: colour meant several things at once. Tangerine was the primary button and also a waiting prompt; green, orange, red and blue each meant a state; every CLI had a hue. A Person could not tell at a glance whether a coloured spot was a button, a state, a brand or a request.

## Decision

Switchboard is a board of lines: every Agent is a line, and the only colour on the board is the ring of a line that needs a Person. Everything a machine does is monochrome and dense; everything a Person must do is the one hot colour, a shape and a word.

### Colour

Cool neutrals tinted toward hue 250 to 258, and one chromatic colour, `--signal` at hue 345, which always and only means "a Person is needed". `dashboard/src/styles/tokens.css` defines them as CSS variables, light and dark:

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--paper` | oklch(98.5% 0.003 250) | oklch(18% 0.012 255) | the ground |
| `--paper-2` | oklch(96% 0.004 250) | oklch(21% 0.012 255) | command blocks, hover |
| `--paper-3` | oklch(93% 0.006 250) | oklch(25.5% 0.013 255) | the selected row |
| `--rule` | oklch(88.5% 0.006 250) | oklch(32% 0.012 255) | row rules, chip borders, meter tracks |
| `--rule-2` | oklch(78% 0.009 250) | oklch(41% 0.012 255) | section rules, inputs, secondary buttons |
| `--ink-4` | oklch(60% 0.013 255) | oklch(56% 0.012 255) | the gone glyph; never text that must be read |
| `--ink-3` | oklch(49% 0.015 255) | oklch(70% 0.012 255) | meta, secondary lines |
| `--ink-2` | oklch(37% 0.017 255) | oklch(81% 0.01 255) | body in a group, meter fill |
| `--ink` | oklch(21% 0.02 258) | oklch(94% 0.006 250) | names, the primary button, focus |
| `--signal` | oklch(54% 0.235 345) | oklch(74% 0.19 345) | a Person is needed |
| `--signal-fg` | = `--paper` | = `--paper` | text on the signal |
| `--term-bg` | oklch(18% 0.013 255) | oklch(13% 0.012 255) | the terminal |

The terminal is dark in both themes: `--term-bg-2` oklch(26% 0.012 255), `--term-fg` oklch(90% 0.006 250), `--term-dim` oklch(66% 0.01 250), `--term-signal` oklch(78% 0.17 345), `--term-rule` oklch(30% 0.012 255).

There is no red, green, amber or blue. An error is ink, and Deny is a secondary button. The signal is never a button and never pulses. A new use of `--signal` that does not mean "a Person is needed" is a bug.

ADR 0016's names (`page`, `panel`, `accent`, `green`, `orange`, `red`, the `state-*`, `verdict-*` and `cli-*` names) stay as a labelled last layer in `tokens.css` that points every one of them at a Ringdown neutral, or at `--signal` for the needs-a-Person states. Nothing new uses them, and each goes when the last view using it is rebuilt.

### Type

Spline Sans (SIL OFL 1.1) for everything that is not literal code, at 400, 500 and 600. Spline Sans Mono only for commands, paths, branches, hashes, ids where they are ids, the channel path, keyboard hints and the terminal, always in a `<code>`, `<kbd>`, `<pre>` or the terminal. The two are one superfamily, so a command inside a sentence reads as the same voice. Both are self-hosted from `@fontsource-variable/spline-sans` and `@fontsource-variable/spline-sans-mono`, so the Dashboard loads no font from a third party.

| Step | Size / line height | Use |
| --- | --- | --- |
| `label` | 12.5 / 1.4 | column heads, chips, keyboard hints |
| `small` | 13 / 1.45 | meta, secondary lines, the terminal |
| `row` | 14 / 1.45 | rows and body, the default |
| `title` | 15 / 1.4 | section titles, inspector names |
| `head` | 20 / 1.25, -0.01em | page heads |
| `figure` | 32 / 1.1 | the one figure on a context or usage panel |

No uppercase, no italic, tabular figures on the root. `tailwind-merge` is told every step is a font size.

### Scales

Space on a 4px base, which is Tailwind's own spacing step, so there are no space variables; the page gutter (`--gutter`) is 24, 16 on a phone. Radius `--r` 3px on controls, chips and command blocks, `--r-2` 6px on the terminal only; glyph discs and rings are round and nothing is a pill. Motion `--ease-out` cubic-bezier(.16, 1, .3, 1) and `--dur` 140ms, on colour and a 1px press only; data never animates in, and a changed row may tint to `--paper-2` and fade back over 600ms. Elevation is flat; one shadow exists for menus and the palette. An Agents row is at least `--row` tall: 36px, or 30px with `data-density="compact"` on the root (set by `?density=compact` or saved per browser).

### The shell

A 44px top bar on every screen, not sticky: the jack mark and "Switchboard", the channel path in mono, the views as keycaps with their counts (the current key pressed, solid ink), each Person's local time, and Search with its `⌘K` hint. The Agents key carries the needs-you count as a signal chip, the only coloured count. One helper, `needsYou`, gives that count everywhere it appears (the top bar, the Agents view, the canvas): a prompt on your own Agent or any Stale Claim; another Person's prompt is theirs. No rail, no sidebar, no avatars in the bar. Below 1180px the People strip is hidden, and below 900px the channel path.

Each view opens with a page head: one 20/600 line, then its facts in ink-3 on the same baseline, joined by middle dots. Never a row of KPI tiles. Lists put the selected row in a 352px inspector at the right.

One breakpoint, 640px. Below it the top bar becomes the wordmark, the channel and Search; the views move to a 56px tab bar fixed to the bottom; table rows stack into three lines and open their Agent; the inspector is not on the page; the People strip is hidden.

### One state vocabulary

One component, `State` with its `Glyph` (`dashboard/src/components/domain/state.tsx`), draws every state on every view, and one selector (`stateOf`) gives each Agent one state, read in this order: needs, stale, running, idle, gone. Shape says why, fill says whose, and the signal colour appears only on the states that need a Person.

| State | Glyph | Colour |
| --- | --- | --- |
| Needs you | filled square | signal |
| Needs {person} | hollow square | signal |
| Stale | filled triangle | signal |
| Review | filled diamond (hollow when someone else's) | signal |
| Running | filled disc | ink |
| Idle | ring | ink-3 |
| Gone | dotted ring | ink-4 |
| Done | check | ink |

The word sits beside the glyph in every table. A Task's own status (open, claimed, in review, done) is its own column, drawn with the same glyphs, and never mixed with an Agent's. A CLI is a word in the secondary line, never a colour chip.

### The gate

Every change to `dashboard/` passes `vitest`, `tsc -b`, tasteskill's `lint.mjs` over `dashboard/src` with no FAIL other than the exceptions below, and `inspect.mjs` run headless on every view it touches, at 1440, 768 and 390, light and dark, with no FAIL.

`inspect.mjs` is written for landing pages, so the Dashboard passes it with these allowances and no others:

`no-hero, hero-words, headline-lines, focal-point, first-action, few-pictures, no-real-pictures, no-footage, still-page, empty-screens, icon-cards, card-rows, side-scroll, all-centred, body-size, hairline, outlined-box, eyebrow`

The first ten are about pictures, a hero and scroll motion, which an app screen does not have. `icon-cards` and `card-rows` read board columns and rows as stock card grids; `side-scroll` is the board's sideways scroll on a phone; `all-centred` reads short centred empty states; `body-size` is the 14px row. `hairline` is the first lint exception below, measured in the browser. `outlined-box` is the canvas: design.md draws a Host frame and an Agent node as a 1px `--rule-2` outline on paper, because a node must read as one object on a dot grid without a shadow or a fill step. `eyebrow` reads an inspector's section head over its figure (Context window over 42%), the figure block design.md specifies. One warning stays and is accepted: `small-text` reads the 12.5px label step (column heads, chips, keyboard hints).

`lint.mjs` flags three patterns this system keeps on purpose:

- **Hairline rules.** A 1px `--rule` under each row, a `--rule-2` under each section head, and the rules that bound the top bar, the tab bar and the inspector. A board of lines is made of rules: they separate rows in a real table and regions of an instrument, where space alone would cost density.
- **The mono font for code.** Spline Sans Mono appears inside `<code>`, `<kbd>`, `<pre>` and the terminal only, as the system above sets it; it never carries prose, labels or figures.
- **The glyph rings.** The idle ring and the dotted gone ring are 1.5px strokes. They are the state vocabulary's shapes, not decorative outlines.

## Consequences

- A coloured spot on any screen means a Person is needed. Every other state is told apart by shape and word.
- The Activity and Tasks views lose the accounts bar; an account's pressure is in the Agents inspector and, later, in the Agents group rows.
- `@fontsource-variable/spline-sans` and `@fontsource-variable/spline-sans-mono` replace Geist and Geist Mono, and `THIRD_PARTY_NOTICES.md` lists them.
- The favicon is the jack mark in ink.
- design.md names views the Channel does not have yet (Now, Memory, Hosts). Until they exist the keys are Agents, Tasks, Canvas, Activity and Compare, and the needs-a-Person chip sits on Agents.
