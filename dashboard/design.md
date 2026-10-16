# Design - Switchboard Dashboard (v3, "Ringdown")

The locked design system for the Dashboard. Every screen reads this file. It replaces v1
(the "control room", a Linear/shadcn clone) and v2 (the "operator's log", an editorial
broadsheet). Engineers implement it in React with CSS variables; the names below are the
variable names.

Hallmark: genre modern-minimal, adapted to operational UI. Macrostructure family: Workbench
for every app screen (one toolbar line, a dense primary surface, an inspector). Pre-emit
critique P5 H5 E4 S5 R5 V4. Slop test: see the report.

## The direction, in two sentences

Switchboard is a board of lines: every Agent is a line, and the only colour on the board is
the ring of a line that needs a Person. Everything a machine does is monochrome and dense,
set in one grotesk and its own mono; everything a human must do is the single hot colour,
a shape and a word.

The name: a ringdown circuit is a dedicated line that rings the far end the moment it is
picked up. An Ask is a ringdown.

## Tokens (OKLCH)

Colour. Cool neutrals tinted toward hue 250 so they sit with the near-navy ink. One
chromatic colour, `--signal`, hue 345, which always and only means "a Person is needed".

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--paper` | oklch(98.5% 0.003 250) | oklch(18% 0.012 255) | the ground |
| `--paper-2` | oklch(96% 0.004 250) | oklch(21% 0.012 255) | command blocks, hover, secondary button hover |
| `--paper-3` | oklch(93% 0.006 250) | oklch(25.5% 0.013 255) | the selected row, pressed secondary |
| `--rule` | oklch(88.5% 0.006 250) | oklch(32% 0.012 255) | row and section rules, meter track, chip borders |
| `--rule-2` | oklch(78% 0.009 250) | oklch(41% 0.012 255) | input and secondary-button borders, group rules |
| `--ink-4` | oklch(60% 0.013 255) | oklch(56% 0.012 255) | disabled, the Gone ring; never running text |
| `--ink-3` | oklch(49% 0.015 255) | oklch(70% 0.012 255) | meta, labels, column heads (6.0:1 light, 7.1:1 dark) |
| `--ink-2` | oklch(37% 0.017 255) | oklch(81% 0.01 255) | secondary text, meter fill, primary hover |
| `--ink` | oklch(21% 0.02 258) | oklch(94% 0.006 250) | text, the primary button, the pressed tab, the focus ring |
| `--signal` | oklch(54% 0.235 345) | oklch(74% 0.19 345) | a Person is needed: glyph, state word, the count on the Now tab, the prompt line in the terminal |
| `--signal-fg` | = `--paper` | = `--paper` | text on a signal fill |
| `--focus` | = `--ink` | = `--ink` | the 2px focus outline, offset 2px, never animated |
| `--term-bg` | oklch(18% 0.013 255) | oklch(13% 0.012 255) | the terminal is dark in both themes |
| `--term-fg` | oklch(90% 0.006 250) | same | terminal text |
| `--term-dim` | oklch(66% 0.01 250) | same | tool lines in the terminal |
| `--term-signal` | oklch(78% 0.17 345) | same | the pending prompt line in the terminal |
| `--term-rule` | oklch(30% 0.012 255) | same | the terminal's header and footer rules |
| `--term-bg-2` | oklch(26% 0.012 255) | same | the terminal header's hover and selected key |

Checked pairs (WCAG): ink on paper 17.0 / 16.5; ink-3 on paper 6.0 / 7.1; ink-3 on paper-3
5.1 / 5.5; signal on paper 5.3 / 7.5; paper on signal 5.3 / 7.5; paper on ink 17.0 / 16.5;
term-fg on term-bg 14.2; term-dim on term-bg 6.2; term-signal on term-bg 8.8. Nothing read
as text sits below 4.5:1. `--ink-4` is 3.8:1 and is never used for words that must be read.

There is no red, green, amber or blue. Links are ink with an underline on hover. Deny is a
secondary button, not a red one. Errors (an Agent whose turn errored, a failed check) are a
glyph and a word in ink.

Space. 4px base: `--s-1` 4, `--s-2` 8, `--s-3` 12, `--s-4` 16, `--s-5` 20, `--s-6` 24,
`--s-8` 32, `--s-10` 40, `--s-12` 48. Page gutter 24 (16 on a phone). Section gap 28.
Row height 36 (comfortable) with 8px vertical cell padding; a compact mode at 30 is allowed.

Radius. `--r` 3px on controls, chips, command blocks and glyph squares; `--r-2` 6px on the
terminal only. Discs and rings are round. Nothing is a pill.

Elevation. Flat. Surfaces are separated by tone (`--paper-2`, `--paper-3`) and 1px rules in
`--rule`. One shadow exists, `0 8px 24px oklch(20% 0.01 255 / 0.18)`, for menus, the
command palette and a dragged canvas node. Nothing glows.

Motion. `--ease-out: cubic-bezier(.16, 1, .3, 1)`, `--dur: 140ms`. Hover and press on
colour and a 1px translate only. Focus rings appear in 0ms. A row whose data changed may
tint to `--paper-2` and fade back over 600ms. Data never animates in; the terminal repaints
as frames arrive. `prefers-reduced-motion` leaves only the press. The signal never pulses.

## Type

Two families, the ceiling for an app:

- `--font-ui`: "Spline Sans", 400 / 500 / 600. Everything that is not literal code.
- `--font-code`: "Spline Sans Mono", 400. Only commands, paths, branches, commit hashes,
  Agent and Task ids where they are ids, the channel path, keyboard hints, and the terminal.
  Never for prose, labels or figures.

Spline Sans and Spline Sans Mono are one superfamily by one designer: the UI and the code
share skeletons, so a command inside a sentence reads as the same voice in a different
register. Both load from Google Fonts (`css2?family=Spline+Sans:wght@300..700&family=Spline+Sans+Mono:wght@300..700`).

Scale (px / line-height): 12.5 / 1.4 column heads, chips, keyboard hints; 13 / 1.45 meta,
secondary lines, the terminal, command blocks; 14 / 1.45 rows and body, the default;
15 / 1.4 section titles and inspector names; 20 / 1.25 page heads; 32 / 1.1 the one figure
on a context or usage panel. Nothing smaller than 11.5px (the kbd hint), nothing larger
than 32px. Weights: 400 body, 500 controls and column heads, 600 names, titles and the
state word. No uppercase, no letter-spacing except -0.01em on 20px heads. Tabular figures
on the root. Headings are always roman; italic appears nowhere.

## The state vocabulary

Colour means one thing, shape says why, fill says whose. The word is always beside the
glyph in a table; a canvas node may drop the word only below 60% zoom.

| State | Glyph | Colour | Meaning |
| --- | --- | --- | --- |
| Needs you | filled square, 10px | signal | a pending Ask, question or plan on your Agent |
| Needs {person} | hollow square, 1.5px border | signal | the same on someone else's Agent; you can watch, and type only if they lent the keyboard |
| Stale | filled triangle, 11x10 | signal | a Claim whose Agent went Gone; anyone may take it over |
| Review | filled diamond, 11px | signal | a PR open for your review and its checks passed; hollow when it is someone else's review |
| Running | filled disc | ink | presence Live |
| Idle | ring, 1.5px ink-3 | ink | presence Idle |
| Gone | dotted ring, ink-4 | ink | presence Gone, no Claim |
| Done | check, 2px ink | ink | a Step or Task finished |

One state per Agent, read in this order: needs, stale, running, idle, gone. A Task's own
status (open, claimed, review, done) is a separate column, never mixed with the Agent's.
CLI identity (claude, codex, gemini) is a word in the secondary line, never a colour chip.

## Components

Top bar (every screen, 44px, not sticky; below 640px it becomes the phone bar, see Phone). Left: the wordmark (a 16px jack
mark and "Switchboard" at 15/600), the channel path in mono (`shlok1806/app`), then the
views as keys: Now, Agents, Tasks, Canvas, Activity, Memory, Hosts. A key is 28px tall,
13/500, with its count in ink-3 after the word; the current key is pressed: solid ink with
paper text. The Now key carries the needs-a-Person count as a signal chip (signal fill,
paper text, 2px radius), the only place a count is coloured. Right: the People with their
local times (`shlok 10:02 · maya 15:02 · dev 19:32`; you in 600) and a Search key with a
`⌘K` hint. No sidebar, no workspace switcher, no avatars, no action button in the bar.

Page head. One line: a 20/600 sentence of state or the view's name, then the facts in ink-3
on the same baseline, separated by middle dots. Never a row of figure tiles.

Section head. 15/600 title, a meta run in ink-3, an optional link on the right, a 1px
`--rule-2` under the whole row.

Buttons. 30px tall (26 small), 13/500, radius 3, label never wraps, one verb each.
Primary: ink fill, paper text; hover ink-2; one per region. Secondary: 1px `--rule-2`
border, no fill; hover `--paper-2` with an ink-3 border. Tertiary: text only, hover
`--paper-2`. Press: translateY(1px). Disabled: opacity .5 and not-allowed. Loading: the
label stays, a 12px ring spins at its right (reduced motion: a static half ring).
A primary action may carry its key as a kbd hint (`a` Allow, `d` Deny, `t` Take the
keyboard). The signal colour is never a button.

Row (table). 1px `--rule` under each row, no vertical rules, no zebra. Hover `--paper-2`,
selected `--paper-3`, focus the 2px ink outline inset by 2px. Name 14/600, a secondary line
13 in ink-3. Group rows (per Person) carry the Person, local time, Host capacity and account
pressure in one 13px line over a `--rule-2`. Figures right-aligned and tabular. Cells
wrap; they are never truncated with an ellipsis.

Agents table. The column heads stay in view as the table scrolls. Each row ends in a menu
(Open, Directive, Rename, Stop); an item that opens a question or a dialog puts focus in
it, and Escape gives focus back to the menu's button. Compact rows (30px, one line, the
secondary line and the note hidden) are a view control in the toolbar ("Compact rows", a
pressed toggle beside Find, not a filter chip) and a palette command, kept per browser. The
selected Agent is in the address (`#/agents/select/<id>`), so it survives a reload and a
reconnect, and is scrolled into view when the address names it; an address naming an Agent
the Channel does not have becomes `#/agents`. Beside the inspector the table drops the Host
column, then the context meter (the figure stays), as its own width narrows: a container
query, not the window's width. Past 80 rows only the rows near the screen are rendered,
plus the row holding focus. Arrow keys between rows are a later slice; today Tab moves
through rows, Enter opens one and Space selects it.

Chips (filters). 26px, 12.5/500, 1px `--rule` border; the current one has an ink border
and ink text. Counts follow the word.

Inputs. 30px, 1px `--rule-2` border that never changes width, `--paper` fill, hover
`--paper-2`, focus the 2px ink outline at 1px offset. Label above in 13 ink-3. Placeholder
shows the shape of a value, never an instruction.

Command block. Mono 13 on `--paper-2`, radius 3, 6x10 padding, wraps anywhere.

Meter. 56x4 track in `--rule`, fill ink-2, the figure beside it in text. A high context
reading is a number, not a colour.

Terminal. Dark in both themes (`--term-bg`), radius 6, no window chrome. A 36px header
in the same dark: host and size on the left (`studio · 120x40`), then who is watching, who
holds the keyboard, and the one control: "Take the keyboard" (secondary, paper outline on
dark) or "Release the keyboard" when you hold it. The screen is mono 13 / 1.55, tool lines
in `--term-dim`, the pending prompt line in `--term-signal`, a 7x14 block cursor that does
not blink. A 13px footer in `--term-dim` states that keys are sent as you and that pasted
secrets are masked. On a phone the screen scrolls sideways inside its box.

Ask (the same component on Now, the Agent page, the inspector and a canvas node). Glyph +
"{agent} wants to run {tool}" at 14/600, the age in ink-3 on the right, the command block,
one plain sentence of what it does, a meta line (whose Agent, which Task), then the actions:
Allow once (primary, `a`), Deny (secondary, `d`), Open the terminal (tertiary). On someone
else's Agent: Watch (secondary) and Send a Directive (tertiary), and the sentence says who
can answer and what time it is for them.

Canvas. Hosts are frames: 1px `--rule-2` border, radius 3, the name and capacity in a label
sitting on the top rule over paper. Agents are 212x128 nodes: `--paper` fill, 1px `--rule-2`
border, the selected node a 2px ink border, a needs-you node a 2px signal border. Inside:
glyph + name + "lead" tag, the Task, the state word and age, the context meter, two
controls matching the Ask. Lead edges are 1.5px ink-3 lines with a filled head, drawn as
straight segments through the gutters. The ground is a 24px dot grid in `--rule`. A minimap
and zoom live at the bottom right; the selected node fills the inspector.

Inspector. 352px (320 on the canvas), separated by a 1px `--rule` on its left, 20px inner
gutter. Name 15/600 with glyph and state word, a one-line fact sentence, the actions, then
sections with section heads. A section head's title takes the free width (`flex:1 1 160px`) so
its meta and its link stay on the head's first line and the title wraps instead. A figure block
(the 42% of the context window) puts its meta on its own line under the figure. Below 640px the
inspector is not on the page; it opens as a bottom sheet from the row, full width over the side
sheet's veil and the tab bar, at most 85% of the screen tall. It is modal as the side sheet is:
it holds focus, which lands on the sheet itself, Escape, the veil and Close shut it, and focus
goes back to the row.

Side sheet. For a form that needs the page beside it (Start an Agent), never a centred
dialog: 400px from the right edge, a 1px `--rule-2` on its left, `--paper` fill, over a
veil of black at 25% (55% in dark) that dims the page without lightening it. A head (the
15/600 title, a 13 ink-3 sentence, Close at the right), a body that scrolls, and the actions
on a row under a 1px `--rule`, right-aligned, the primary last. It is modal: it holds focus,
Escape, the veil and Close shut it (none of them while an answer is awaited), and focus goes
back to what opened it. Opening focuses the field most starts need first. Below 640px it is a
bottom sheet over the same veil, full width, at most 90% of the screen tall, with the actions
above the home indicator. One sheet serves every place that opens it.

Phone. One breakpoint, 640px: every PAGE below it uses the phone pattern, which is also the
Phone board. The top bar is the wordmark, the channel and Search (no kbd hint); the views
move to a 56px bottom tab bar fixed to the bottom edge (Now with its signal chip, Agents,
Tasks, Activity, More; Canvas, Memory and Hosts live under More), every target at least
44px, the page gets 56px of bottom padding; the People strip is hidden. The page gutter is 16.
A table never sits in a horizontal scroll box: below 640px its rows stack (`table.stack`):
line one is the glyph, the state word and Since on the right; line two is the name with its
secondary line and Context on the right (the meter is dropped, the figure stays); line three
is the Task. Host and the actions key are dropped; the row itself opens the Agent. Group rows
stay as a line. The selected row keeps its paper-3 band. From 640 up the Agents table drops the
Host column and then the context meter by the width it has, not the window's (see Agents
table). The queue keeps its actions. Nothing scrolls sideways below 640px but a terminal's
screen, and `npm run shots` fails a phone picture where anything else does. The Tasks board
shows one column at a time under a row of column tabs (label and count, a 2px ink rule under
the current one; Claimed first while it holds a card), and drops the column's own head. The
canvas is its frames as lanes in a list: each lane's head as its frame names it, then two-line
rows (glyph, name, the state word and age on the right; the Task, or No Claim), an Agent set in
20px under the lead that started it with "started by" on its second line. Fit, Reset layout,
the zoom and the key go with the canvas; a row opens the inspector's sheet. The Tasks tab
carries the stale count beside its name: a signal triangle and the number.

States. Every view has four, and `npm run shots` checks each one over the simulated Channel
(`?mock=1&state=ready|loading|empty|error|read-error`, on a stopped clock): a ready view in
both themes at 1440 and 390, the others once light at 1440 and once dark at 390. Loading keeps the page head's title and draws the
view's own shape in `--rule` bars (rows for a table, cards for the board, boxes for the
canvas, the dark box for a terminal) under one slow opacity pulse that reduced motion stops;
it says "Loading Agents" to a screen reader, never on screen, through one status region that
stays on the page and changes its words. A view whose code is still on its way waits 150ms
before it draws a skeleton, so a fast load never flashes one. Empty keeps the page head and
puts, where the rows would start, a rule, a 15/600 line saying what is missing, one 14 ink-2
sentence on how it fills (running text, so not the muted ink), and exactly one action: the button that fills it (Start an Agent,
New Task, Post an Update), or, when only a terminal can, the command shown whole in mono with
Copy beside it. A filter or a search that matches nothing is empty too, and its action
clears it; it takes the place of what it empties (the Tasks board goes, not just its cards), so
the page says it once. Error is a page, not a toast: a 20/600 line saying what failed, a sentence on
what still works, the server's own reason in a `--paper-2` block when there is one, and its
actions (Try again first, then a way back). An address with no page says "No such page", an
unknown Agent or Task says so with a link back to its list (not an alert: nothing failed, so
focus goes to its title instead), and an unknown note or Event in
the inspector says so with Close. Nothing reads "Loading" or "Reading" forever: a read that
fails or finds nothing becomes one of these.

Palette. ⌘K anywhere, and `/` on a list (Memory's `/` goes to its Find). One input over
Commands, Agents, Tasks, Views and Theme, pinned 12% from the top so it never moves as the list
changes. A command that needs an argument shows a chevron and takes it in a second step:
Directive to, an Agent, then the text, sent with Enter; Stop, one of your Agents on a Host,
then Stop or Keep it running; Take over, a Stale Task, which you then hold; Watch, an Agent,
whose page opens. The steps so far sit as a trail of chips over the input, with "⌫ back" at
the right: Backspace in an empty input, or Escape, goes back one step, and Escape at the top
closes. Agents picked lately come first, under Recent, kept per browser. A live deployment
lists its other Channels as "Switch to owner/repo".

Focus and motion. Skip to the page is the first Tab stop. Opening another page puts focus on
the page itself, so the next Tab starts at its top; picking a row on the same page leaves
focus where it was. Every move is transform or opacity, and with reduced motion asked for,
CSS animation, transitions and smooth scrolling stop and script scrolls jump.

## What every screen must share

The top bar with the pressed key; the state vocabulary and the one meaning of `--signal`;
the Ask component; the row (rule, hover, selected, no truncation); the button voice and its
kbd hints; the page head sentence; Spline Sans and Spline Sans Mono and where each is
allowed; the dark terminal; the inspector. Screens differ only in which primary surface
they carry: a queue, a table, a terminal, a board.

## Not allowed anywhere

Gradients, glass, glow, shadows at rest, left-border accent cards, pills, emoji, icons as
the only label, uppercase labels, serif type, italic, any second chromatic colour, invented
figures, truncated cells, fake window chrome, sticky bars, entrance animation on data.
