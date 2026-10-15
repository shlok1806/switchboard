# Canvas Dashboard design spec

Status: draft for discussion. Nothing here is decided; each call below that changes the
model needs its own ADR before it is built.

The Dashboard is becoming a canvas: Agents as nodes, edges for who started whom and who
reads whom, frames for Tasks and their worktrees, controls on the nodes themselves, a
live terminal, and the feed and the Board as side panels. nodeterm is the closest
existing product to that shape. This document describes how nodeterm behaves, then
decides, feature by feature, what Switchboard keeps, adapts or drops.

The terms are the ones in [CONTEXT.md](../CONTEXT.md). Three planned pieces are not in
CONTEXT.md yet, and this spec uses working names for them:

- **Host supervisor**: a long-lived process on a Person's machine that starts, stops and
  queues that Person's Agents on request, instead of the Person running
  `switchboard run` by hand.
- **Lead**: an Agent a Person has given the right to direct and start other Agents, as
  sketched in issue #101 (the Orchestrator role).
- **Memory note**: a piece of shared memory that outlives the session that wrote it and
  that other sessions can read.

## Clean room

nodeterm is licensed BUSL-1.1. This spec is the only bridge between it and Switchboard:
whoever builds the canvas works from this document and from Switchboard's own code, not
from nodeterm's.

- Sources read: nodeterm's README, its `docs/` and `site/` folders and the screenshots in
  `docs/assets`, from a shallow clone of `github.com/shlok1806/nodeterm` that was never
  built or run; and the canvas-control and linked-context guide nodeterm installs for the
  agents it hosts.
- Not read: nodeterm's source code, styles or assets beyond looking at screenshots. No
  code, CSS, image or long passage is copied here. Everything below is a description of
  behaviour, in our own words.
- The app was not launched. Behaviour that only shows when the app runs (animations,
  exact spacing, colours) is out of scope, and Switchboard's look comes from its own
  design system.

---

## Part 1: how nodeterm behaves

### The model in one paragraph

A project is a directory. Each project has one canvas and one kanban board, two views of
the same set of sessions. Every terminal and agent session lives in a tmux session on the
machine that hosts the project, so it survives the app quitting and, for agents, a
machine restart (the agent CLI is resumed). The canvas is the source of truth for what
exists: a node is created, it gets a session, and closing the node ends the session.
Agents running inside nodes can drive the same canvas through a command-line tool, so an
agent can open other agents, wire them together and read their work.

### Node kinds

| Kind | What it is | What the user sees |
| --- | --- | --- |
| Terminal | A real shell in a pseudo-terminal, backed by tmux. | A window with a title bar, a status dot and the live terminal. It can be named automatically from its output. |
| Agent | A terminal whose command is an agent CLI (Claude Code, Codex, Gemini, Copilot, opencode, Grok or a custom one). | The terminal plus a status badge driven by the CLI's hooks, not by reading the screen: running, needs you (a permission prompt or a question), done. A context meter, subagent cards with their own transcripts, and the account it runs under. On a permission prompt the badge offers approve and deny buttons that answer the hook directly. |
| Sticky note | Markdown text. | A small coloured card. When linked to an agent, the agent can read it as context. Agents can write into notes too, so a note can act as a live status board. |
| Image, video | A media file shown in place. | The file in a frame. Placing it is final: nothing runs, nothing waits. |
| Web viewer | A page from a URL, a local HTML file or inline HTML. | A read-only page in a frame. |
| Browser | A navigable browser the agent that opened it can drive (navigate, read, click, type, scroll, screenshot). | A browser frame. Driving it is off by default per project and only the user can switch it on. The agent can only read cookies, never write them, and each read is logged before it happens. |
| Editor, diff | A code editor and a diff view. | Not part of this spec's scope. |

Every node has a title, a colour (a palette, including one colour per agent CLI) and can
be renamed by the user or by an agent.

### The canvas

- **Pan and zoom**: an infinite dotted plane with a zoom readout. Nodes are dragged and
  resized freely.
- **Placement**: a node opened by the user lands where they right-clicked. A node opened
  by an agent lands near the agent that opened it. Nodes opened inside a frame fill the
  frame's grid slots in order.
- **Grid**: snapping to a grid is a per-machine setting with a configurable grid size, and
  so are the default width and height of new nodes.
- **Arrange and align**: a selection of sibling nodes (all at the top level, or all inside
  one frame) can be laid out as a grid, a row or a column, or aligned on an edge or a
  centre line. Arranging the children of a frame shrinks the frame to fit. These actions
  need measured node sizes, so they only work on the project that is on screen.
- **The view is the user's**: nothing an agent does moves the camera, switches the
  project or takes keyboard focus. An agent working in a project the user is not looking
  at still opens nodes there; they are saved and wait.
- **Persistence**: the canvas is saved per project, and sessions outlive it through tmux.
  Undo and redo cover canvas edits.

### Edges

There are two kinds of edge, and both are drawn from one node to another:

- **Opened-by**: every node an agent opens is joined to the agent that opened it. This is
  also how nodeterm knows whom to tell when that node stops (station notices, below).
- **Context link**: a link between two nodes that lets each read the other's
  conversation, summary or terminal output on demand. Agents an agent opens, and the
  stations it waits on, are linked automatically; `link` exists for nodes it did not
  open. A link only grants reading. Nothing is pushed into the linked session.

A dependency wait (below) is drawn as an edge too: dashed while the dependent waits, solid
once it has started.

### Groups and worktree frames

- A **group** is a labelled, coloured frame around sibling nodes or other groups. Nodes
  can be moved into and out of frames, and a frame can be dissolved, promoting its
  children to its parent.
- A **worktree frame** is a group bound to a git worktree on its own branch. Terminals
  and agents opened inside it run in that worktree. Creating one names the branch and
  optionally a base, which can be a git ref or another frame's branch (so a second wave
  of work can branch off the first by identity). A branch that already exists is refused.
  Releasing a frame either unbinds it and keeps the directory, or removes the directory
  after the user confirms.
- A **team** is a frame holding one agent per role (at most eight), laid out in a grid,
  each with its own brief and model, all linked to the agent that spawned them.

### Lifecycle states

An agent node is not simply running or stopped. Opening one can create it now and start
it later, and nodeterm names each in-between state. The user sees these as labels on the
node and in the list the agents read.

| State | What causes it | What the user sees | How it ends |
| --- | --- | --- | --- |
| Armed on turn end (`--after`) | Opened to start only after named agents finish a turn. | A node that has not started, roped to each upstream with a dashed edge, labelled with whom it waits for. | Every upstream ends a turn without an error. Then it starts itself and the edges turn solid. |
| Armed on success (`--after-success`) | Opened to start only after named agents report success. | Waiting for success, naming who it still needs. | Every upstream reported success and its turn ended. A failure report blocks it instead (below). |
| Armed on a pull request (`--after-pr`) | Opened to start once named pull requests have passing checks at their current head, or are merged. | Waiting, with the pull requests named. A new push restarts the wait. | The condition holds, from the board's own GitHub sync. A closed request or failing checks keep it waiting. |
| Blocked by failure | An upstream it waits for on success reported failure, or was closed without reporting. | Blocked, naming the station and its note. | Only a fresh success report, or the user starting it by hand. |
| Queued | Created, but its launch has not been delivered: its project is off screen, its worktree's setup script is still running, or it waits on one of the above. | A node with a run-now button. | The wait ends, the user views the project, or run-now. |
| Starting | A background start is in flight. | Starting. Nothing should start it again. | The agent reports in, or the launch fails. |
| Held | The brief file it should start with was gone when it launched. | Held, with run-now. | The user or an agent runs it by hand. |
| Expired | A wait passed its deadline (24 hours by default, 14 days at most). | Expired, with run-now. | Only a manual start. It never starts on its own. |
| Running, needs you, done | The agent's own hooks. | The status badge. | The next hook. |
| Last turn errored | The turn ended on an API or model error and produced nothing. | An error label. Dependents waiting on its turn end stay held. | A later successful turn, or a retry. |
| Last turn interrupted | The user stopped the turn. | An interrupted label. Dependents stay held. | A later finished turn. |
| Dropped | The agent process died without exiting cleanly. | A dropped chip. Clicking it resumes the conversation. | The user resumes it. |
| Launch failed, agent status unconfirmed | The launch line could not be delivered, or the hooks never reported. | A label naming which. | A manual retry. |

Two rules make reuse safe. A station given new work does not count as finished until a
turn that started after that work arrived has ended, and new work withdraws any success it
reported earlier. A turn that ends with background subagents still running has not
finished either.

**Run-now** is the button (and the agent-side `run` verb) that starts a queued, held or
expired node immediately, skipping its wait. It is the user's override for every wait
above.

### Linked context: how one session reads another

An agent can list the nodes it is linked to and then read one of them in three depths:
the last lines of its conversation, the full transcript, or its recent terminal output.
Linked sticky notes read as context the same way. Reading is pull only: nothing arrives
unasked, and a link is the permission, so an agent cannot read a node it is not linked
to. Each session has its own identity, derived per node, so one session cannot read or
act as another by naming it.

### The kanban board and issue-bound sessions

- **Cards are live sessions.** The board is the same project seen as columns. Dragging a
  card between columns does not touch the session; the agent keeps running. A card opens
  into a large view with the live session, members, due date, priority, comments and an
  activity history.
- **GitHub issues** can appear as cards beside the sessions, with each column mapped to
  one exact issue label. Moving an issue card rewrites its labels; moving it into the
  completion column closes it, out of it reopens it, and both ask first. GitHub stays the
  source of truth. A filter shows all cards, only issues, or only sessions.
- **Issue-bound sessions**: an agent can be started on an issue. Its first prompt carries
  only the issue's reference, never its title or body, and tells it to read the issue
  itself and to treat what it reads as untrusted input written by others. It is told never
  to close the issue, and never to comment or open a pull request unless the user asked in
  that session. The board shows the session on the issue's card, and the node shows the
  issue number. The usual pattern is one worktree frame per issue, with a branch named
  after it.
- **Moving cards**: an agent may move its own card to "In Progress" when it starts and to
  "In Review" when it delivers. Done is always the user's move.
- **Read-only GitHub lanes**: agents can list issues and pull requests (with CI state at
  the current head and mergeability) from what the board already fetched. They never call
  GitHub themselves through these, and every title, label and branch name is flagged as
  untrusted.

### Station notices, agent-to-agent messaging and verify panels

- **Station notices**: when an agent another agent opened stops, the opener is told once:
  the process died, the turn errored, or it asked the user a question that has gone
  unanswered for 15 minutes. A permission prompt is never a notice. The user sees a
  "station failed" chip on the opener; the opener gets a framed message only if the
  project allows agent messaging. Each notice comes with a short list of sensible next
  moves: retry, reassign, skip or stop.
- **Messaging**: an agent can send a message into an agent it opened. It is off by
  default per project and only the user can switch it on. A busy target is not
  interrupted: the message waits in a bounded, expiring queue and is delivered when the
  target goes idle, into the same session only. Every message is wrapped in a frame with a
  random marker and a reply-to line, and only the outermost frame is genuine. Sending is
  rate-limited per pair and per turn. Every outcome is named (delivered, queued, rate
  limited, target gone and so on) with whether a retry can help.
- **People can message agents too**: a comment on the board that mentions a session
  arrives in the same frame, marked as from a person, with no node to reply to.
- **Outcome reports**: an agent reports how its task went, succeeded or failed with a
  one-line note. It must be honest: stopping is not success. The note shows on its card
  and on whatever waits on it.
- **Verify panels**: a review panel over one node's work: one reviewer agent per lens
  (correctness, security, tests by default), each waiting on the target and linked to it,
  and a judge waiting on the reviewers that merges their findings into one verdict.
  Reviewers are told not to change files.

### Safety around control

- Closing nodes and typing into them ask the user in one dialog per call; a denial is
  final.
- Settings an agent may ask to change are an allowlist, and every change is confirmed by
  the user every time. Permission modes, accounts, credentials and identity can never be
  changed by an agent.
- Every create verb takes a request ID so a retry after a lost reply returns the first
  reply instead of opening a second node.
- Presence for teams: live cursors, a facepile, who is focused in each node, and several
  people attached to one terminal at once, each keystroke attributed. There are no roles
  and no locks.

---

## Part 2: mapping onto Switchboard

### What Switchboard is, for this mapping

- A **Channel** is one GitHub repo, shared by every Person with write access. The
  Dashboard is a hosted web page on the Worker (ADR 0004, 0007), not an app on the
  machine where the Agents run.
- An **Agent** is one agent-CLI session run by one Person through the wrapper, with an
  Agent ID, an optional Nickname, Presence (Live, Idle, Gone), a model, a Context
  Reading and a Usage Reading.
- A **Task** is a GitHub Issue. A **Claim** is the one holder of a Task, and claiming
  creates the Task's branch and worktree (ADR 0006). Stale Claims never expire (ADR 0002).
- **Updates** inform. **Directives** instruct, and only a Person sends them (ADR 0005).
  The **Relay** decides per Event and per Agent whether it is dropped, queued or sent as
  an Interrupt, and a **Wake** starts an idle Agent's turn for what waits for it.
- Agent tokens act only for their own Agent (ADR 0007).

Three differences drive most calls below:

1. **The canvas is a view, not the source of truth.** In nodeterm the canvas creates the
   sessions. In Switchboard, Agents, Claims and Events already exist; the canvas draws
   them. Positions are view state.
2. **The machines are elsewhere.** A web page on the Worker cannot open a shell on a
   Person's laptop. Anything that starts or types into a session goes through that
   Person's wrapper or host supervisor, and only for that Person.
3. **Information never becomes instruction.** nodeterm lets a linked agent read another's
   full transcript. ADR 0005 forbids raw text from one Agent's context reaching another.

### Scope: two canvases, one model

The brief names two audiences: one Person's fleet, which only they see, and the
Channel, which everyone on it sees. Both are the same canvas over the same Agents,
filtered:

- **Channel canvas**: every Agent with a Claim or an Update on the Channel, every
  Person's. Controls on another Person's Agent are limited to what any Person may already
  do (rename, a Directive, a Takeover of a Stale Claim).
- **My fleet**: all of my own Agents across Channels, including ones not on any Channel
  Task, with every control. Nobody else sees this view.

Which of a Person's Agents appear on the Channel canvas, and whether a "hidden" Agent
sends Events at all, is a model decision for an ADR, not a canvas detail.

### Feature calls

**Keep** means build it with the same behaviour. **Adapt** means build the idea in
Switchboard's model. **Drop** means do not build it.

#### Node kinds

| Feature | Call | Why |
| --- | --- | --- |
| Agent node | Adapt | The node is an Agent: Agent ID, Nickname, Presence, model, Account Label, context meter and the Task it holds, from data the Dashboard already has (ADR 0009 to 0012). |
| Status badge from hooks (running, needs you, done) | Keep | The wrapper already sees the same hooks; "needs you" is the pending permission prompt proposed in PR #107 (ADR 0013). |
| Approve and deny on the node | Adapt | Only the Agent's own Person, as proposed in PR #109 (ADR 0014), never another Person or a lead. |
| Plain terminal node | Drop | Nothing in Switchboard runs a bare shell, and a hosted page opening shells on laptops is remote code execution by design. |
| Live terminal of an Agent | Adapt | A read-only mirror of the Agent's terminal, streamed by its wrapper, shown in the node or a side panel. Masked like the brief (ADR 0012) before it leaves the laptop. |
| Typing into the live terminal | Adapt | Only the Agent's own Person, and it counts as that Person typing. Call it "attach" or "take the keyboard", not Takeover, which already means moving a Stale Claim. |
| Sticky note | Adapt | Becomes the Memory note: shared memory with an author, visible on the canvas, readable by linked Agents through a tool. Agent-written notes are information, framed like any other Agent output. |
| Subagent cards | Keep | The Proxy Capture already tells the main thread from subagents (ADR 0010); showing them as small child cards is cheap and useful. |
| Image and video nodes | Drop | Nothing on a Channel produces media worth a node; a link in an Update is enough. |
| Web viewer node | Drop | A pull request or preview opens in its own tab; embedding arbitrary pages in a hosted Dashboard adds risk for little gain. |
| Agent-driven browser node | Drop | Agents bring their own browser tools; the Dashboard driving pages for them would make it an attack surface. |
| Editor and diff nodes | Drop | GitHub's pull request view already does this for every Task. |
| Colour per agent CLI | Keep | A fast way to tell Claude, Codex and Gemini Agents apart, using Switchboard's own palette. |

#### The canvas

| Feature | Call | Why |
| --- | --- | --- |
| Pan and zoom | Keep | It is the point of the canvas. |
| Free dragging and resizing | Keep | A Person arranges their own view. |
| Placement | Adapt | Nodes appear from Events, not right-clicks, so a new Agent lands by rule: next to the Agent or lead that started it, otherwise in its Task's frame, otherwise in its Person's lane. |
| Saved positions | Adapt | Saved per Person as view state, not shared. A shared layout would need nodeterm's ordered canvas sync for no gain, since the Channel's state is the Events. |
| Grid snapping, default node size | Keep | Per-Person preferences, stored in the browser. |
| Arrange and align | Keep | Same behaviour on a selection; plus one "lay out by Task" action, since Switchboard knows the structure. |
| Never move the camera for an Agent | Keep | A Person watching one Agent must not be pulled away when another starts. |
| Undo and redo | Adapt | Only for view changes. Controls (stop, Directive, Takeover) are Events and are not undone. |

#### Edges

| Feature | Call | Why |
| --- | --- | --- |
| Opened-by edge | Adapt | Becomes "started by": recorded when the host supervisor starts an Agent for a Person or a lead, as a field on the Agent at registration. Agents started by hand have no parent and no edge. |
| Context link | Adapt | Becomes a read subscription: the linked Agent's Updates and structured Events reach this Agent with a Queue Verdict, and a tool returns its recent Updates and Memory notes. Never its transcript (ADR 0005). People still see everything on the Dashboard. |
| Link created automatically for started Agents | Keep | The parent almost always needs its children's Updates; it should not have to ask. |
| Dependency edge, dashed then solid | Keep | A clear picture of what waits on what, for queued starts below. |
| Edge between two Agents on one file | Adapt | New for Switchboard: the Relay already detects two Agents touching one file; draw it as a temporary conflict edge. |

#### Groups and frames

| Feature | Call | Why |
| --- | --- | --- |
| Worktree-bound frame | Adapt | A Task frame: one per claimed Task, labelled with the Issue and its branch, holding the Agent with the Claim. ADR 0006 already makes a Task one branch and one worktree, so the frame needs no binding step of its own. |
| Creating a worktree from the canvas | Drop | Claiming a Task creates it. A second path would make branches that no Task owns (issue #45). |
| Branch a frame off another frame's branch | Drop | Switchboard branches every Task from `main`; stacked work is a Subtask decision, not a canvas one. |
| Subtask frames inside a parent | Adapt | Subtasks nest inside their parent Task's frame, from GitHub's sub-issues. |
| Free-form groups | Adapt | View-only, per Person, for arranging; they carry no meaning on the Channel. |
| Person and host lanes | Adapt | New: one lane per Person (and per host for my fleet), so a Person sees whose and where each Agent is. |
| Team frame (spawn-team) | Adapt | A lead starting several Agents on Subtasks of one Task fills that Task's frame; there is no separate team object. |

#### Lifecycle states

These states belong to the host supervisor, which does not exist yet; the canvas only
shows them. Until it exists, an Agent is only Live, Idle or Gone.

| Feature | Call | Why |
| --- | --- | --- |
| Wait on another Agent's turn end (`--after`) | Adapt | Turn ends are too fine for work across machines; wait on a Task instead: start when another Task's pull request is open, or its Claim is released. |
| Wait on success (`--after-success`) | Adapt | Success is `finish_task` opening the Task's pull request, which the Channel already records; there is no separate report to trust. |
| Blocked by failure | Keep | A Task released without a pull request, or an Agent gone with a Stale Claim, blocks what waits on it until a Person decides. |
| Wait on a pull request (`--after-pr`) | Keep | The GitHub App's webhook already delivers checks and merges to the Channel, so no polling is needed. |
| Task blockers from GitHub | Keep | ADR 0001 gives GitHub ownership of blockers; a Task whose Issue is blocked shows the same waiting state with no extra configuration. |
| Queued | Adapt | A start request held by a host supervisor: waiting on a dependency, a concurrency limit, an account's usage threshold (issue #101) or a host that is offline. The node names which. |
| Starting | Keep | Between the supervisor accepting a start and the Agent registering. |
| Held (brief file missing) | Drop | The brief is stored on the Channel with the start request, so it cannot go missing. |
| Expired | Keep | Every wait has a deadline; an expired start never runs on its own. |
| Dropped | Adapt | Already Presence Gone. The node shows Gone and its Stale Claim; resuming is the Person's, on their machine or through their supervisor. |
| Last turn errored | Keep | The wrapper sits on the model traffic and the Stop hook, so it can tell an errored turn; it should show on the node and notify the starter. |
| Interrupted | Keep | A Person stopping a turn is worth showing so a waiting start is not mistaken for stuck. |
| Run-now | Adapt | A control on a queued start, for the starting Person, or a lead within its limits. It never skips a Person's own Claim rules. |
| Request IDs on start | Keep | A lead or a page retrying a start must not start two Agents. |

#### Linked context and memory

| Feature | Call | Why |
| --- | --- | --- |
| Read another session's summary, transcript or terminal | Drop for Agents, keep for People | ADR 0005: Agents get structured facts and Updates, never raw context. People can open any Agent's live terminal and Proxy Events on the Dashboard as today. |
| Pull, not push | Keep | Matches the Queue Verdict: linked material waits for the next turn and wakes no one. |
| Linked sticky notes as context | Adapt | Memory notes linked to an Agent, or to its Task, are offered at the start of its turns. |
| Memory across sessions | Adapt | New: a Memory note belongs to a Channel or to a Person's fleet, so a resumed or new Agent reads what an earlier one learned. Notes from Agents stay information; notes from People may be marked as standing Directives. |

#### Board and issue-bound sessions

| Feature | Call | Why |
| --- | --- | --- |
| The board as a second view | Keep | It is the existing Board view, moved into a side panel beside the canvas. |
| Cards are sessions | Adapt | Cards are Tasks; the Agent holding the Claim shows on the card, live. A Task outlives its Agents. |
| Columns mapped to labels | Adapt | Columns come from the Task's status, which Switchboard owns and mirrors as `status:*` labels (ADR 0001); no custom columns. |
| Drag a card between columns | Drop | Status follows Claims, Updates and pull requests; a drag that disagreed with the Claim would be a lie. |
| Due date, priority, members, card comments | Drop | GitHub owns labels and the Issue's discussion; Switchboard adds nothing there. |
| Agents moving their own cards | Drop | `claim`, Updates and `finish_task` already move the Task. |
| Start an Agent on an Issue | Keep | This is a Claim made at start: the supervisor starts an Agent that claims the Task. |
| Prompt carries only the reference, Issue text is untrusted | Keep | Issue bodies are written by anyone with access; the same frame should wrap them. |
| Never close the Issue, never post unasked | Adapt | Switchboard closes Issues through `finish_task` and writes as the App (ADR 0007), so the rule becomes: Agents never write to GitHub outside Switchboard's tools. |
| Done is the human's move | Adapt | Merging the pull request is the human's move; the Task closes from that. |
| Read-only issue and pull request lists for Agents | Keep | The Channel already holds them; a tool can list them with CI state, and every title is untrusted. |

#### Notices, messaging and review

| Feature | Call | Why |
| --- | --- | --- |
| Station notices to the starter | Keep | When an Agent a lead or supervisor started goes Gone, errors or waits on its Person, the starter gets an Event with a Queue Verdict, which Wakes it if idle. |
| Question unanswered for 15 minutes | Adapt | Shown to the owning Person first, on the node and in the feed; the lead hears only after the wait, because it cannot answer for the Person. |
| Notice choices (retry, reassign, skip, stop) | Keep | A lead needs the same short menu, as controls on the node and as tools. |
| Agent-to-agent messages | Adapt | Addressed Updates (issue #64): information, framed as such, with the Relay deciding the Verdict. Rate limits already exist as the Wake limit. |
| Messaging switch off by default | Adapt | Not needed as a switch: ADR 0005 already makes Agent messages harmless as instructions. |
| Messages from a lead with instruction weight | Adapt | Only if issue #101 decides a lead may send Directives; then they carry the Person's name as granter and the Person can always override. |
| People messaging an Agent from the board | Keep | That is a Directive, sent from the node or the card. |
| Outcome reports | Adapt | Becomes an Update with an outcome when a Task is finished or released, so the canvas and any waiting start read it. |
| Verify panel | Adapt | A lead (or a Person) starts reviewer Agents on a Task's pull request, each read-only, and a judge whose verdict is an Update on the Task. Later, after the supervisor. |

#### Safety and presence

| Feature | Call | Why |
| --- | --- | --- |
| Per-node identity | Keep | Already the Agent token (ADR 0007); the canvas adds nothing an Agent token can do for another Agent. |
| Confirm before stop and before typing | Keep | Stopping an Agent loses its uncommitted work; ask, and record the stop as an Event. |
| Settings allowlist for agents | Adapt | A lead's powers are a list a Person grants per Channel; nothing on it lets it widen itself. |
| Live cursors and facepile | Drop | The Channel's feed already shows who is doing what; cursors are a lot of state for a little warmth. |
| Who is watching a terminal | Keep | When a Person attaches to an Agent's terminal, everyone sees who is attached. |
| Several people typing into one terminal | Drop | Only the owning Person types; others send Directives. |
| Several projects in tabs | Adapt | Becomes the Channel switcher; my fleet spans Channels. |
| Dictation, notch, phone app, command palette | Drop | Outside the Dashboard's job for now. |

### What the user sees on the Switchboard canvas

| Agent state | Node |
| --- | --- |
| Live, working | Status dot and "running", the latest activity line, the context meter, its Task's frame around it. |
| Live, needs its Person | "Needs you", with approve and deny for its own Person only. Other People see the label and no buttons. |
| Idle | Dimmed dot and "idle", with what is Queued for it and when it will be Woken. |
| Gone with a Claim | "Gone", the Stale Claim on its frame and a Takeover control for People. |
| Gone without a Claim | Faded, folded into its Person's lane after a while. |
| Start queued | A placeholder node naming what it waits for, a dashed edge to each dependency, run-now for whoever may use it. |
| Starting | A placeholder with a spinner, until the Agent registers. |
| Wait expired or blocked | The placeholder says which and why; only a manual start runs it. |
| Last turn errored | An error label and a notice on its starter. |
| Two Agents on one file | A temporary conflict edge between them, from the Relay. |

### Questions for ADRs

1. Whether a Person's hidden Agents send Events to any Channel, and who can see them.
2. The host supervisor: its API, how a hosted page reaches it (through the wrapper's
   existing socket to the Worker, never an open port), and what a start request holds.
3. The lead role (issue #101): which controls it gets, whether its messages carry
   instruction weight, and how a Person revokes it.
4. Memory notes: where they live, who may write them, and how notes from People differ
   from notes from Agents.
5. The live terminal: what the wrapper streams, how it is masked, and how typing from the
   Dashboard is authenticated as the owning Person.
6. Whether context links change Relay Verdicts, or only add a read tool.
