# An Agent's state shows a thinking orb

Status: accepted on 2026-11-06. Adds to ADR 0023. Everything else in it stands.

## Context

Issue #169 asks the Dashboard to show what each Agent is doing with a thinking orb from `thinking-orbs` (MIT, React, a plain 2D canvas, pinned at 0.3.2). The package has nine animated states. The issue proposes a mapping that splits a running turn into reading (`searching`), writing an Update or a Brief page (`composing`) and starting up (`connecting`).

The Dashboard does not know those. An Agent's state is one of ADR 0023's: needs you, needs {person}, stale, running, idle, paused, gone (`lib/state.ts`, `stateOf`). It is read from the Agent's Presence and its Pending Approval. The only finer signal is the Context Reading's `activity`, the last tool name or text the wrapper saw when it sent its heartbeat. It is a sample, it can be up to one heartbeat old, and its tool names differ for each CLI. An orb that says "searching" from it would often be wrong, and keeping a table of every CLI's tool names would be a second state machine. A starting spawn is not an Agent until it registers, so no Agent row can show `connecting`.

## Decision

The orb shows the Agent's one state. Nothing else decides it.

| Agent state | Orb |
| --- | --- |
| Running (Presence Live) | `working` |
| Needs you, Needs {person} (a Pending Approval) | `listening` |
| Idle (at its prompt, waiting on its Person) | `breathing` |
| Stale, Paused, Gone | none |

- A Stale, Paused or Gone Agent runs nothing. A moving orb would say it does. These states keep only their glyph and word.
- The orb is extra. The glyph, the colour and the word stay, so the state never depends on motion, and the orb is `aria-hidden`.
- The orb is drawn in ink, the package's monochrome default. It never takes `--signal` or `--running`. A pulsing signal colour would break ADR 0023's rule that the signal never pulses.
- Sizes: 20px before the Agent's name in the Agents, Now and Host lists and on the phone rows, at the top right of a canvas node and after the word on the phone canvas list. 64px before the head of the Agent's page (20px on a phone, below 640 pixels, where 64 pushed the state word off the name's line), where its Children list also shows a 20px orb. The inspectors do not show one. A row with no orb keeps its 20px, so names stay in line.
- Theme: the package reads the nearest `dark` or `light` class. `lib/theme.ts` now marks the root with either one, so a Person who chose light on a dark system gets a light orb.
- With reduced motion the package shows one still frame. Offscreen or in a hidden tab it stops drawing. The Agents table already renders only the rows near the screen.
- The built Dashboard grows by 27 kB of script, about 10 kB gzipped: the package (25 kB) and the lines that place it. The package has no dependencies of its own.

If the Channel later records a real "what the Agent is doing" for each turn, `searching` and `composing` can map to it. That is a new decision.

## Verification

- `dashboard/test/orb.test.tsx`: each mapped state shows its orb in the Agents table, the orb changes as an approval opens and closes, and a Gone Agent shows none.
- `dashboard/scripts/shots.mjs`: the Agents, Now, Canvas and Hosts views show every mapped state. The Agent page is drawn for an Agent that needs you, an idle one and a running one, in light and dark at 1440 and 390 pixels wide and at 320.
