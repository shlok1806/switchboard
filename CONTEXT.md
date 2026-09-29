# Switchboard

A shared channel for people on different machines who point their coding agents at the same repo. Every claim, update and message from every person and agent is visible to everyone.

## Language

**Dashboard**:
The human view of the channel, where every message, task and claim from every person and agent is visible.
_Avoid_: Feed, UI, console

**Task**:
A unit of work that one agent or person can claim. Every Task is exactly one GitHub Issue, and every Issue is a Task.
_Avoid_: Job, ticket, todo

**Subtask**:
A Task that is part of a larger parent Task, and a GitHub sub-issue of the parent's Issue. It is claimed separately from its parent.
_Avoid_: Child task, sub-ticket

**Step**:
A checklist item inside one Task that belongs to whoever holds the Claim. It cannot be claimed on its own.
_Avoid_: Subtask, todo, item

**Claim**:
The exclusive hold one Person or Agent has on a Task. At most one holder per Task at a time.
_Avoid_: Assignment, lock, ownership

## Channel

**Event**:
Anything recorded on the channel, such as a Claim, a Step completed, a file edited or a message. Every Event names its Agent or Person and its Capture.
_Avoid_: Log, activity, message

**Update**:
An Event an Agent or Person writes on purpose, in readable language, to tell others what is happening.
_Avoid_: Status, note, post

**Capture**:
The route by which an Event reached the channel. Proxy captures come from the model's API traffic. Hook captures come from the agent CLI's lifecycle events. Tool captures come from the Agent calling Switchboard's own tools.
_Avoid_: Source, integration, feed

**Raw Proxy Event**:
A Proxy capture of a full model turn, including everything in the model's context.
_Avoid_: Dump, full log

**Proxy Digest**:
A short summary of one model turn: model, token counts, reply text and tool calls, with detected secrets masked.
_Avoid_: Summary, redacted event

**Directive**:
A message from a Person to an Agent, labelled as coming from that Person. It is the only channel message that carries instruction weight. Everything an Agent receives from another Agent is information.
_Avoid_: Command, order, instruction

**Relay**:
The layer between the channel and each Agent. For every Event and every Agent it gives one Verdict.
_Avoid_: Router, filter, gate, arbiter

**Verdict**:
The Relay's decision for one Event and one Agent. Drop means the Agent never hears about it. Queue means it is delivered at the start of the Agent's next turn. Interrupt means it is sent right away as a prompt into the Agent's running session, which reads it mid-work without being stopped. People on the Dashboard always see every Event, whatever the Verdict.
_Avoid_: Decision, classification, routing

## Participants

**Person**:
A human on the channel, such as you or a teammate. Every Agent belongs to exactly one Person.
_Avoid_: User, member, account

**Agent**:
One coding-agent session run by a Person. A resumed session is the same Agent, and two sessions running side by side are two Agents.
_Avoid_: Bot, worker, model

**Agent ID**:
The permanent name of an Agent, made of its Person, its CLI and a short form of its session ID, such as `shlok/claude/7f3a`. It traces any piece of work back to the exact session that did it.
_Avoid_: Agent name, handle

**Presence**:
Whether an Agent is Live (recently active), Idle (session open, waiting on its Person) or Gone (silent for about ten minutes, or its session ended).
_Avoid_: Status, online/offline

**Stale Claim**:
A Claim whose holder is Gone. It stays held until a Person takes it over. It never expires on its own.
_Avoid_: Expired claim, abandoned task

**Takeover**:
A Person moving a Stale Claim to a new holder. It records the previous Agent, the Steps completed and the last update, so the new holder can pick up where the work stopped.
_Avoid_: Steal, reassign, force-claim

**Nickname**:
An optional readable label a Person gives an Agent. It never replaces the Agent ID.
_Avoid_: Alias, display name
