<!-- Hallmark · redesign (full rebuild, owner-confirmed) · genre: editorial product · theme: custom "Desk"
     pre-emit critique: P5 H4 E4 S5 R5 V4 · contrast: every text pair at least 4.5:1, both themes -->

# Design - Switchboard Dashboard (v4, "Desk")

Recorded in ADR 0049, which supersedes ADR 0023's type, palette values, bars and page head.
Every value below is a token in `src/styles/tokens.css`; nothing in `src/` names a raw colour,
a font or a type size, and Tailwind's own palette, faces, sizes, radii and shadows are reset
so they cannot be written.

## First principles

The Dashboard is used by a team: the founder and teammates, each running their own Agents on
one shared Channel. What a teammate opens it to do, most often first:

1. **Answer what needs them.** A Pending Approval on their Agent, a Stale Claim, a pull request
   to review. Seconds matter: an Agent is blocked until a Person answers.
2. **See what every Agent is doing**, and on which Task, whoever runs it.
3. **Steer one Agent**: send a Directive, take the keyboard, pause, stop, hand off.
4. **Catch up** on what happened while they were away.
5. **Plan and take Tasks.**
6. **Read the shared knowledge**: the Brief, the Memory Notes, the shared Skills. This is the
   team's knowledge graph, and it is read, not scanned.
7. **Set up**: Hosts, and the Channel's settings.

So the Dashboard is five sections, not nine views, in that order:

| Section | Jobs | Views (tabs in the section bar) | Route it opens at |
| --- | --- | --- | --- |
| Now | 1 | Now | `#/` |
| Agents | 2, 3, 7 | Agents, Canvas, Hosts | `#/agents` |
| Tasks | 5 | Tasks | `#/tasks` |
| Activity | 4 | Activity | `#/feed` |
| Knowledge | 6 | Brief, Memory, Skills | `#/brief` |

Hosts live under Agents because a Host is where Agents run; the Canvas is the same Agents laid
out by Host and lead. The Channel's settings, the theme and sign-out are in your menu (the login
at the right of either bar). The desk's top bar and the phone's tab bar carry the same five, so
every view is at most two taps away on a phone and there is no More menu. Every route people
have bookmarked still parses (`#/canvas`, `#/hosts`, `#/memory/<id>` and the rest); only the
bars that show them changed.

## The direction

An editor's desk. What needs a Person is marked in one red pencil; the work the Agents do is
set in a calm grotesk, dense where it is data; the structure of each page and the knowledge the
team keeps are set in a reading serif. The tone lives in the type and the hierarchy, never in
the layout: the shell stays a product (bars, tables, an inspector, a palette). v1's colour per
state and v2's broadsheet layout are the two ways this goes wrong.

Refused, by name: the dark developer tool (mono everywhere, green on black), the KPI-card
dashboard (a row of figure tiles as the first thing on a page), and the paper-and-italic
"considered" page (a serif headline with an italic accent word). Headings here are roman, and
the one accent is a meaning, not a decoration.

## Tokens (OKLCH)

Neutrals are a barely warm grey (hue 85, chroma at most 0.012) so long reading does not glare.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| `--paper` | 99% 0.002 85 | 17.5% 0.006 85 | the ground |
| `--paper-2` | 96.6% 0.004 85 | 20.5% 0.006 85 | hover, command blocks, a raised band |
| `--paper-3` | 93.6% 0.006 85 | 24.5% 0.007 85 | the selected row, a pressed control, the current tab |
| `--rule` | 90% 0.006 85 | 31% 0.007 85 | row rules, chip borders, meter tracks |
| `--rule-2` | 80% 0.008 85 | 40% 0.008 85 | section rules, field and secondary-button borders |
| `--ink-4` | 62% 0.01 85 | 56% 0.008 85 | the Gone ring, disabled; never words that must be read |
| `--ink-3` | 50% 0.012 85 | 70% 0.008 85 | meta, labels, column heads |
| `--ink-2` | 38% 0.012 85 | 82% 0.006 85 | secondary text, reading prose, the meter fill |
| `--ink` | 22% 0.012 85 | 94% 0.004 85 | names, headings, the primary button, focus |
| `--signal` | 52% 0.2 25 | 72% 0.16 25 | a Person is needed. Nothing else, ever |
| `--running` | 50% 0.13 155 | 76% 0.14 155 | an Agent taking a turn now; a glyph, never a fill or text alone |
| `--veil` | 15% 0.01 85 / 0.28 | 5% 0.01 85 / 0.6 | behind a sheet |
| `--term-bg` | 18% 0.006 85 | 13.5% 0.006 85 | the terminal, dark in both themes |
| `--term-fg`, `--term-dim`, `--term-signal` | 90%, 66%, 76% 0.14 25 | same | the terminal's text |

Contrast, measured (WCAG 2 ratio, sRGB from OKLCH):

| Pair | Light | Dark |
| --- | --- | --- |
| ink on paper | 16.83 | 15.91 |
| ink-2 on paper | 9.73 | 10.86 |
| ink-3 on paper / paper-2 / paper-3 | 5.83 / 5.44 / 4.97 | 7.10 / 6.70 / 6.07 |
| signal on paper / paper-3 | 5.94 / 5.07 | 7.13 / 6.10 |
| paper on signal (the count chip) | 5.94 | 7.13 |
| running on paper / paper-3 (non-text, 3:1 needed) | 5.43 / 4.63 | 9.35 |
| ink-4 on paper (non-text only) | 3.54 | 4.08 |
| term-fg / term-dim / term-signal on term-bg | 14.19 / 6.15 / 8.40 | higher |
| rule-2 on paper (a field's border, decorative) | 1.82 | 2.06 |

A field's border is not its only cue: a label sits above every field, and focus is the 2px ink
outline.

## Type

Two faces, both self-hosted from `@fontsource-variable`, both SIL OFL 1.1.

- **Newsreader** (`--font-display`, with its optical-size axis on): page titles, a page's
  section heads, an Agent's, Task's, note's or Event's name at the head of its page or
  inspector, the wordmark, dialog titles, and the reading text of the Brief and Memory Notes.
  It is the voice of structure and of what the team knows.
- **Schibsted Grotesk** (`--font-body`): everything else. A news publisher's grotesk, plain
  and sturdy at 13 and 14, which is where the product lives.
- **No third face.** Commands, paths, branches, hashes and the terminal use the platform's own
  monospace (`--font-code`: `ui-monospace` and fallbacks). Names of People and the Channel are
  words, not code, and are not mono.

The scale has nine steps, each a token (`text-label` and so on):

| Step | Size / line | Face | Use |
| --- | --- | --- | --- |
| label | 12.5 / 1.4 | body 500 | chips, tab labels, column heads, kbd hints |
| small | 13 / 1.5 | body | meta, buttons, field labels, secondary lines |
| row | 14 / 1.5 | body | the default: rows, controls, running text in the product |
| title | 15 / 1.4 | body 600 | an inspector's or card's section head |
| read | 17 / 1.6 | display | the Brief's and Memory's reading text, at most 68ch |
| section | 20 / 1.3 | display 500 | a page's section heads, an inspector's name, empty and error lines |
| head | 30 / 1.15, -0.012em | display 500 | a page's title |
| head-phone | 24 / 1.2, -0.01em | display 500 | a page's title below 640px |
| figure | 32 / 1.1 | body 600 | one figure that is the point (the context window, a sign-in code) |

Weights: 400 body, 500 controls and display heads, 600 names and grotesk titles. No uppercase,
no letter-spacing but the two head steps. Headings are always roman and italic appears
nowhere: emphasis, even in Markdown an Agent wrote, is weight. Figures are tabular only where
they line up in a column (counts, Context, Since); Schibsted's tabular figures widen commas and
colons, so a clock time or a sentence never uses them. A display line wraps inside long words
(`overflow-wrap: anywhere`) so a long Agent or Task name never pushes a page sideways.

## Space, radius, elevation, layout

- Space is Tailwind's 4px step. The page's own rhythm is named: `--gutter` 32 (24 below 1024,
  16 below 640), `--page-top` 32 (24, 20), `--section-gap` 40 (32 on a phone).
- Generous between regions, tight inside data: a table row is `--row` 38px (30 compact), an
  inspector's sections are 28px apart, a page's are 40.
- Radius: `--r` 4px on controls, chips, fields and command blocks; `--r-2` 6px on the terminal
  and a sheet's top. Nothing is a pill but the count chip's ends, and no container is rounded
  beyond 6.
- Elevation is flat. One shadow, `--shadow-float`, for what floats (menus, the palette, a
  dragged node). Nothing has a shadow at rest.
- Layout: the top bar is `--topbar-h` 52; the phone's tab bar `--tabbar-h` 60 plus the safe
  area; the inspector is `--inspector-w` 368; reading is capped at `--measure` 68ch.

## Motion

Colour and opacity changes at `--dur` 140ms on `--ease-out`, and a 1px press on buttons and
chips. A new row fades its band once over `--dur-slow` 600ms. Loading pulses opacity slowly.
The thinking orb (ADR 0047) is the one thing that moves on its own. The signal never pulses and
nothing enters with a slide. With reduced motion, animation, transitions and smooth scrolling
stop, the orb is a still frame, and script scrolls jump.

## The state vocabulary

Colour means one thing, shape says why, fill says whose. The word is always beside the glyph,
so every state reads without colour (and in Windows High Contrast).

| State | Glyph | Colour | Meaning |
| --- | --- | --- | --- |
| Needs you | filled square | signal | a pending Ask, question or plan on your Agent |
| Needs {Person} | hollow square | signal | the same on a teammate's Agent; you watch, and type only if they lent the keyboard |
| Stale | filled triangle | signal | a Claim whose Agent went Gone; anyone may take it over |
| Review | filled diamond | signal | a PR open for your review with its checks passed; hollow when it is someone else's |
| Running | filled disc | running | presence Live, taking a turn |
| Idle | ring | ink-3 | presence Idle |
| Gone | dotted ring | ink-4 | presence Gone, no Claim |
| Done | check | ink | a Step or Task finished |

One state per Agent, read in this order: needs, stale, running, idle, gone. A Task's own status
is a separate column, never mixed with the Agent's. The CLI (claude, codex, gemini) is a word
in the secondary line, never a colour. The thinking orb sits beside the glyph and the word and
never replaces them: running is `working`, needs is `listening`, idle is `breathing`; stale,
paused and gone show none. It is in ink, decorative (`aria-hidden`), 20px before a name in a
row and 64px before the head of an Agent's page (20 on a phone).

## The shell

**Top bar** (52px, desk). The wordmark (the mark and "Switchboard" in the display face at 20),
the Channel in ink-3, then the five sections as text tabs: the current one is ink with a 2px
ink rule on the bar's bottom edge, the others ink-3, hover ink. Each tab carries its fact: Now
the needs-a-Person count as the one coloured count (signal fill, paper text), Tasks the open
count and the stale triangle, Agents the count, Activity a count of new Interrupts. Right: the
People (teammates and their local time, hidden below 1180), Search with `⌘K`, and your menu.
The bar gives way as the desk narrows: the People, then the Channel (below 900), then the word
"Switchboard" (its mark stays), then the `⌘K` hint.

**Section bar.** Under the top bar when a section has more than one view: its views as tabs
(the current one on `--paper-3`), and inside an Agent or a Task the trail back to it (Agents /
`id`, Tasks / #n title). A section with one view and no trail draws nothing.

**Phone** (below 640). A 52px bar with the mark, the Channel, Search and your menu; the same
five sections in a tab bar fixed to the bottom, each a target of at least 44px, sized to its
word so "Knowledge" fits at 320. The current tab has a 2px ink rule on its top edge.

**Your menu.** Your login opens it on every width: who you are, your local time, the Channel's
settings, the theme (System, Light, Dark) and Sign out.

## Components

Every interactive component has its eight states: default, hover, focus-visible, active,
disabled, loading, error, success. Focus is always the 2px `--focus` outline at a 2px offset
(inset inside a row or a tab strip). Disabled is opacity 0.5 and takes no pointer.

| Component | Default | Hover | Active | Loading | Error | Success |
| --- | --- | --- | --- | --- | --- | --- |
| Button, primary | ink fill, paper text | ink-2 fill | 1px down | label stays, a ring spins beside it | the reason under it, in ink with a triangle | the label says what happened ("Sent") |
| Button, secondary | 1px rule-2 border | paper-2, ink-3 border | paper-3, 1px down | same | same | same |
| Button, ghost | text only | paper-2 | 1px down | same | same | same |
| Chip (filter) | 26px, 1px rule border, ink-2 | ink-3 border, ink | 1px down; pressed: ink border and ink | - | - | - |
| Field | 1px rule-2 border, paper | paper-2 | - | - | border ink, the reason under it | - |
| Row | rule under it | paper-2 | selected: paper-3 | skeleton bars | the error page | a fresh row's band fades once |
| Tab (section, column) | ink-3 | ink | current: ink and its rule, or paper-3 | - | - | - |

Buttons are 30px (28 small, 26 extra small; at least 44 on a phone), 13/500, radius 4, one verb,
a label that never wraps. One primary per region. The signal is never a button.

**Page head.** The title in the display face at 30 (24 on a phone), the facts on one quiet line
under it in ink-3 joined by middle dots, the page's actions at the right (under it on a phone).
Never a row of figure tiles.

**Section head.** On a page: the display face at 20 over a 1px `--rule-2`, a meta run in ink-3,
an optional link at the right. In an inspector or card: the grotesk at 15/600, so dense panes
stay dense.

**Row (table).** A 1px `--rule` under each row, no vertical rules, no zebra. Name 14/600, a
secondary line 13 in ink-3. Group rows (per Person) carry the Person, their local time and their
Agents in one 13px line over a `--rule-2`. Figures right-aligned and tabular. Cells wrap; they
are never truncated. Column heads stay in view as the table scrolls. Below 640 the rows stack
into three lines and the row opens the Agent.

**Inspector.** 368px beside the list with a 1px `--rule` on its left and a 24px inner gutter:
the name in the display face at 20 with its glyph and state word, a fact sentence, the actions,
then its sections. Below 1024 the list keeps the width and a row opens the inspector as a
bottom sheet instead (at most 85% tall), modal: it holds focus, Escape, the veil and Close shut
it, and focus goes back to the row.

**Side sheet.** For a form that needs the page beside it (Start an Agent): 400px from the right
over the veil; a bottom sheet below 640. Actions on a row under a rule, the primary last.

**Ask.** Glyph and "{Agent} wants to run {tool}" at 14/600, the age at the right, the command
block, one sentence of what it does, whose Agent and which Task, then the actions: Allow once
(primary, `a`), Deny (`d`), Open the terminal. On a teammate's Agent the sentence says who can
answer and what time it is for them.

**Command block.** Platform mono at 0.875em on `--paper-2`, radius 4, wraps anywhere.

**Meter.** A 56x4 track in `--rule`, the fill ink-2, the figure beside it. A high reading is a
number, never a colour.

**Terminal.** Dark in both themes, radius 6, no window chrome. Host and size, who watches and
who holds the keyboard in its head, with "Take the keyboard" or "Release the keyboard". The
screen in platform mono, tool lines in `--term-dim`, the pending prompt in `--term-signal`, a
block cursor that does not blink. On a phone the screen scrolls sideways inside its box, the
one thing that may.

**Reading (Brief, Memory Notes).** The display face at 17/1.6 in ink-2, at most 68ch, Markdown
headings in the display face (level one) or the grotesk at 15/600, code in a `--paper-2` block.
The Brief has its sections as a list on the left from 1024 up.

**Canvas.** Hosts are frames with a 1px `--rule-2` border and their name on the top rule;
Agents are nodes on `--paper` with a 1px `--rule-2` border, 2px ink when selected and 2px signal
when a Person is needed. Lead edges are ink-3 lines. Below 640 the canvas is its frames as
lanes in a list.

**Palette.** ⌘K anywhere, `/` on a list. One input over Commands, Agents, Tasks, Views and
Theme, pinned 12% from the top; commands that need an argument take it in a second step, with
the steps so far as a trail of chips. It floats on `--shadow-float`.

## States

Every view has four, and `npm run shots` checks each over the simulated Channel
(`?mock=1&state=ready|loading|empty|error|read-error`):

- **Loading** keeps the page head's title and draws the view's own shape in `--rule` bars
  under one slow opacity pulse; a screen reader hears "Loading Agents" through one status
  region. A view whose code is on its way waits 150ms before drawing a skeleton.
- **Empty** keeps the page head and says, in the display face at 20, what is missing, one
  sentence on how it fills, and exactly one action. A filter that matches nothing is empty too,
  and its action clears the filter. Empty never invents a figure.
- **Error** is a page, not a toast: what failed (display, 30), what still works, the server's
  own reason in a `--paper-2` block, then Try again and a way back.
- **Unknown** (an address with no page, an Agent or Task the Channel does not have) says so with
  a link back; focus goes to its title.

## Not allowed anywhere

Gradients, glass, glow, shadows at rest, left-border accent cards, pills for status, emoji,
icons as the only label, uppercase labels, italic, a third face, a second chromatic accent,
colour without a word, invented figures, truncated cells, fake window chrome, entrance
animation on data, a raw colour or a font name outside `tokens.css`.
