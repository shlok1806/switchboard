# The canvas is a view of the Channel

Status: proposed on 2026-10-15. Builds step 5 of the canvas plan from `docs/canvas-design-spec.md`, the clean-room description of nodeterm, and takes its look from ADR 0016.

## Context

The spec turns the Dashboard into a canvas: Agents as nodes, edges for who started whom, frames for Tasks, controls on the nodes, and later a live terminal. Most of its calls depend on pieces that are not built: the host supervisor's queued and starting states, the live terminal and attaching, conflict edges from the Relay, context links, and "My fleet" across Channels. What the Channel already knows is enough for the first canvas: every Agent with its Person, Presence, model, context, pending permission prompt, role and parent (ADR 0018), and every Task with its Claim and branch (ADR 0006).

Its first call, which the spec leaves to the owner, decides everything else: in nodeterm the canvas creates sessions; in Switchboard Agents, Claims and Events already exist.

## Decision

### The canvas draws the Channel and creates nothing

- A new Dashboard view, **Canvas** (`#/canvas`), beside Activity, Board, Agents and Compare. It is the Channel canvas of the spec: every Agent on the Channel, every Person's.
- It draws only what the Channel already holds. Nothing on it is stored on the Channel, and no Event comes from it. Starting, stopping, renaming, Directives, roles and Takeover stay on the Agent and Task pages, which a node opens.
- **Nodes** are Agents: the CLI's colour square, the Nickname or Agent ID, a state dot with its shape (ADR 0016), the model, the latest activity line and a context meter.
- **Node state** reads, in this order: a pending permission prompt is "Needs you"; a Gone Agent holding a Claim is "Stale Claim"; then Live ("Running"), Idle and Gone. A Gone Agent with no Claim is drawn faded.
- **Frames** are Tasks: each Task an Agent holds is a frame around that Agent, labelled with the Issue number and title and its branch. A Task held by a Person, or by nobody, has no frame here; the Board shows it.
- **Edges** are "started by": a line from a lead to each Agent whose `parent` it is. Agents started by hand have no edge.
- **Lanes**: one per Person, the signed-in Person's first, then by name. In a lane a lead's Agents follow it, and an Agent with no Claim comes after those with one.

### Positions are view state in one browser

- Pan by dragging the ground or scrolling, zoom with ctrl or pinch and scroll, or with the zoom controls; fit brings every node into view. Dragging a node moves it and its frame.
- Where each node sits, and the camera, are kept in that browser's storage per Channel. They are not shared and not on the Channel (the spec's "saved per Person as view state"). Reset layout drops them.
- **Nothing moves on its own.** An Agent already drawn keeps its place when others join or leave, and the camera never moves for a new Agent. A new Agent takes its lane's next slot that no node already covers.

### Selecting a node

- Selecting a node shows the Agent's brief, its context window and its Task in a side panel, with the way to its Agent page. On a phone the panel is a sheet at the bottom.

### Not in this step

Each needs its own ADR or the pieces it depends on first: the live terminal and attach (spec Decided 4), queued, starting and expired placeholders (host supervisor), conflict edges between two Agents on one file, context links, memory notes as sticky notes, the feed and the Board as side panels, "My fleet" across Channels, free-form groups, undo, and arrange or align on a selection.

## Consequences

- The canvas can ship before the host supervisor and the terminal, and each later piece adds to it without changing what is already drawn.
- Because the canvas has no controls of its own yet, a Person acts in two clicks (select, open the page) rather than one. Controls on the node come once each has its own rule for who may use it there.
- Positions do not follow a Person between browsers. If that matters later, they become a per-Person setting on the Channel, still never shared.
