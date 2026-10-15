# The Dashboard is a control room

Status: proposed on 2026-10-15. Supersedes ADR 0016 in part: its layout model, the role of tangerine, its type scale and typeface, and its list of `inspect.mjs` allowances. The rest of ADR 0016 stands: the token layers, one typeface, navy ink, flat surfaces separated by tone, state as shape and word, and the checked gate. Records Shlok's approval of the Dashboard redesign plan.

## Context

ADR 0016 gave the Dashboard one design system, adapted from a landing-page direction: a page head per view, a centred 46rem column, and one tangerine primary control per screen. Since then the Dashboard has become the place where a Person watches a fleet of Agents and answers what they need: prompts and approvals are first-class (ADR 0013, 0014), Stale Claims wait for a Person (ADR 0002), and the canvas and the live terminal are views of what the Channel already knows (ADR 0020, 0021).

An audit of the current views against those jobs found three problems this ADR answers:

- **Tangerine means two things.** It marks the screen's primary control, and it marks the things waiting on a Person (a prompt, an approval, a needs dot). A Person cannot tell at a glance whether a warm spot on the screen is a button or a request.
- **The layout is a document, not an instrument.** Each view opens with a page head and a narrow column, so a Person sees a few Agents at a time and leaves the list to look at one.
- **The type is set for reading, not scanning.** Rows are 15px in Albert Sans, whose figures do not line up in columns and whose 1 and l are close.

## Decision

The Dashboard is a control room: a persistent rail with live counts, a 48px toolbar, full-width content with an inspector on the right of any list or canvas, dense rows with tabular figures, one state vocabulary, and one warm colour that always means "a Person is needed". The rail, toolbar and inspector land in their own changes; this ADR fixes the system they are built on.

### Tangerine means a Person is needed

`--attention` (tangerine) marks a Person being needed, and nothing else: the Needs-you queue and its badge, a prompt or approval waiting, the needs glyph. `--attention-ink` is the same colour set as text, and `--attention-tint` its ground.

The primary control is solid ink (`--action` is navy in light, near-white in dark), so a button never reads as a request. A usage meter past its warning line also takes attention, since its account is about to stop the Agents on it, which a Person has to act on.

Uses of the old orange that meant something else are recoloured: a lost connection, a refused Claim and a failed mirror are `--stale` (red); the board's In review column is `--review` (blue); the Raw proxy badge and a symbol in a verdict are neutral; syntax colour uses `--link`.

### Colour roles

`dashboard/src/styles/tokens.css` keeps ADR 0016's layers and renames the grounds by their job:

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| `page` | #ffffff | #0e1118 | the ground |
| `panel` | #f4f5f7 | #141823 | the rail, inspector, toolbars, sections, striped rows |
| `inset` | #eceef1 | #1b2030 | a field in a panel, secondary buttons |
| `inset-2` | #e1e4e9 | #232a3c | a field in an inset, a selected row |
| `ink` to `ink-4` | navy, #1b2440 to #8d93a8 | #e7eaf1 to #697189 | text; `ink-4` never for text that must be read |
| `action` | = `ink` | #e7eaf1 | the primary control |
| `link`, `focus` | #2a56c6 | #8fb0f5 | links, focus rings, selection |
| `attention` | #e8891a | #f29a2e | a Person is needed |
| `attention-ink` | #9a5306 | #ffb860 | the same, as text |
| `live` | #157040 | #5fcf8f | running, done |
| `idle` | #8d93a8 | #6f788f | idle |
| `gone` | #b4b9c9 | #4a5268 | gone |
| `stale` | #c43a2f | #f38b84 | a Stale Claim, errored, a conflict |
| `review` | = `link` | = `link` | in review |
| `track` | #d3d7de | #2b3245 | the empty part of a meter |

Tints are the colour at about 14% over the ground. The agent CLI hues, the canvas roles and the terminal (dark in both themes) are in the same file.

ADR 0016's names (`canvas`, `hover-2`, `accent`, `green`, `orange`, `red`, the `state-*` and `verdict-*` names) stay as a labelled last layer pointing at v2 roles, so no view changes layout to adopt the new colours. Each goes as the view that uses it is rebuilt; nothing new uses them.

### State vocabulary

One state per Agent, each with a glyph, a colour and a word, read in this order: needs, stale, errored, running, idle, gone.

| State | Glyph | Colour |
| --- | --- | --- |
| needs | square | `attention` |
| stale | triangle | `stale` |
| errored | octagon | `stale` |
| running | circle | `live` |
| idle | circle | `idle` |
| gone | ring | `gone` |
| review | diamond | `review` |
| done | circle | `live` |
| queued | ring | `ink-3` |

A state never rides on colour alone; the glyph and the word carry it too. Every view, the Agents list, the canvas, the board and the rail's counts, reads an Agent's state from one selector, so the counts agree everywhere.

### Type

Geist (SIL OFL 1.1) replaces Albert Sans: it has tabular figures and a distinct 1, l and I, which an instrument of IDs, counts and times needs. Geist Mono stays for literal code only, always in a `<code>` or `<pre>`.

Six steps, weights 400, 500 and 600 only:

| Step | Size | Use |
| --- | --- | --- |
| `small` | 13px | meta, labels |
| `row` | 14px | rows, the default body size |
| `body` | 15px | prose |
| `lead` | 17px | the inspector title |
| `title` | 22px | a page title |
| `figure` | 30px, -0.02em | figures |

Text is 1.45 line height, the terminal 1.5. The body sets tabular figures everywhere. `display` stays as an alias of `figure` until its last use goes. `tailwind-merge` is told every step is a font size (ADR 0016's reason).

### Density

Rows are 40px (comfortable) or 32px (compact). The choice is a `data-density` attribute on the root, saved per browser, and `?density=compact` forces it for one visit. `--row` and `--cell-x` follow it.

### Shape, space and elevation

Controls have a 4px radius, panels and the terminal 6px. Elevation stays flat at rest; only what floats casts `shadow-float`. Lines stay banned on boxes; form fields keep theirs, and a `<table>` may stripe its rows with tone but never rule them. The shell's sizes are tokens: `--toolbar-h` 48px, `--rail-w` 232px, `--inspector-w` 352px.

### The gate

Every change to `dashboard/` passes `vitest`, `tsc -b`, biome, tasteskill's `lint.mjs` over `dashboard/src` with no FAIL, and `inspect.mjs` run headless on every view it touches, at 1440, 768 and 390, light and dark, with no FAIL.

`inspect.mjs` is written for landing pages, so the Dashboard passes it with these allowances, given with `--allow` and no others:

`no-hero, hero-words, headline-lines, focal-point, first-action, few-pictures, no-real-pictures, no-footage, still-page, empty-screens, icon-cards, card-rows, side-scroll, all-centred, body-size`

The first ten are about pictures, a hero and scroll motion, which an app screen does not have. `icon-cards` and `card-rows` read board columns and Agent rows as stock card grids; `side-scroll` is the board's sideways scroll on a phone; `all-centred` reads short centred empty states. `body-size` is the row size: `inspect.mjs` wants 16px running text, and an instrument sets its rows at 14. Every other rule holds, including contrast, small text, mono outside code, shadows, gradients, outlined boxes and eyebrows. ADR 0016 also allowed a status pill read as an eyebrow; that allowance is dropped, and the Task page now sets its title above its status.

## Consequences

- The tokens and type change without moving anything: every view keeps its layout, and screenshots differ only in colour and type. The rail, toolbar, inspector and phone tab bar, and the removal of the Stale banner, the accounts bar and the per-view page heads, follow on this system.
- A warm spot on any screen means a Person is needed. A new use of `attention` that does not mean that is a bug.
- `@fontsource-variable/geist` replaces `@fontsource-variable/albert-sans`, and `THIRD_PARTY_NOTICES.md` lists it.
- The favicon matches the mark: a navy square, with the tangerine dot of a call waiting.
