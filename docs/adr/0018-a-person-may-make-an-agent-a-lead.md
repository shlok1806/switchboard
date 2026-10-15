# A Person may make one of their Agents a lead

Status: proposed on 2026-10-15. Supersedes ADR 0005 ("Agents inform each other; only People instruct"), which it keeps except for the exception below. Opens the gate ADR 0015 left closed for `agent_spawn` and `agent_stop`.

## Context

ADR 0005 gives instruction weight to one kind of message only: a Directive, which only a Person can send. Every Agent Token is refused on `POST /api/directives`, `POST /api/agents/spawn` and `POST /api/agents/:id/stop`. That rule closes the path where one confused or prompt-injected Agent steers another Person's setup, and it must keep closing it.

The owner wants one Agent to run a team: start Agents on their Hosts with a brief, steer them with Directives while they work, and stop them when they are done. The greenroom lead does this today by driving Terminal.app, outside the Channel, where nothing records what it did and nothing limits what it can reach. Hosts (ADR 0015) give it a way to start Agents with no window. What is missing is a way for a Person to say "this Agent may act for me over the Agents it starts", and a hard boundary around that.

## Decision

### A role is something a Person grants one of their own Agents

- A **role** is a named authority an Agent holds on the Channel. The first and only role is **lead**.
- Only the Agent's own Person grants or revokes it: `PUT /api/agents/:id/role` with `{ "role": "lead" }`, and `DELETE /api/agents/:id/role`, with a Person session. Another Person cannot, and no Agent can, for itself or for any other Agent. The Channel records `agent.role.granted` and `agent.role.revoked`, with the Person as actor.
- The role belongs to the Agent ID, so a resumed session keeps it (a resumed session is the same Agent). It lasts until its Person revokes it. A Gone Agent still holds it, but cannot use it: its Agent Token stopped working when it went Gone.
- An Agent holds at most one role. Roles are not inherited: an Agent a lead starts is a plain Agent until its Person grants it a role too.
- The Agent row gets `role` (null, or `lead`) and `parent` (the lead that started it, or null). Both are on the wire `Agent` and on the Dashboard.

### A lead acts only on its own subtree

- An Agent a lead starts has that lead as its **parent**. A lead's **subtree** is every Agent whose chain of parents reaches it. Since roles are not inherited, the subtree is one level deep unless the Person makes one of its Agents a lead as well. Then that Agent's own Agents are in both subtrees.
- With its Agent Token, a lead may:
  - **start** an Agent: `POST /api/agents/spawn`, through the `agent_spawn` tool. It runs on one of the lead's own Person's Hosts, belongs to that Person, and gets the lead as its parent. Every check of ADR 0015 still applies: the Host's folders, the Host's `--max-permission-mode`, and the per-Channel `HOST_AGENTS_LIVE_CAP`. The mode is also no looser than the lead's own (see Consequences).
  - **stop** an Agent in its subtree: `POST /api/agents/:id/stop`, through `agent_stop`.
  - **send a Directive** to an Agent in its subtree: `POST /api/directives`, through a new tool, `send_directive`.
- A lead's subtree is capped per Channel: `LEAD_AGENTS_LIVE_CAP` (default 5) limits the Agents in one lead's subtree that are not Gone, plus the spawns still starting in it, its own and those of the leads below it. A spawn over it answers 409 with the cap. Both caps apply to every spawn.
- A lead cannot reach anything outside its subtree. It cannot stop, or send a Directive to, its own Person's other Agents, another Person's Agents, its own parent, or itself. It cannot grant or revoke roles, register or remove Hosts, take over Claims, or answer or deny permission prompts (ADR 0013, ADR 0014). Each refusal says why.
- Without the role, an Agent Token is refused exactly as before, with a message saying its Person can grant the lead role.
- Revoking the role ends the lead's authority at once. Its subtree keeps running, and the parent links stay, so the history still shows who started what. The Person can stop those Agents, or grant the lead role again.

### What changes in ADR 0005

ADR 0005's rule becomes: only a Directive carries instruction weight, and a Directive comes from a Person, or from a lead that Person put over the receiving Agent. Everything else from an Agent is still information. Concretely:

- A lead's Directive is a `directive` Event with the lead as actor. Its delivery names both: "Directive from `shlok1806/claude/7f3a`, the lead `shlok1806` put over this Agent". A lead's brief for an Agent it starts is framed the same way.
- The standing rule every session gets now says that a Directive comes from a Person or from the lead its own Person put over it. Its own Person still has the final say, over any lead.
- Relay Deliveries, Updates and every other Event from Agents keep ADR 0005's information frame. A lead's Updates are information like any other Agent's.
- A lead's Directive does not reset the receiving Agent's Wake count, which only its Person's prompts and Directives reset. A lead and its Agents can still not wake each other forever.

### Every action is on the Channel

`agent.role.granted` and `agent.role.revoked` (actor: the Person), and the lead's `agent.spawn`, `agent.stop` and `directive` (actor: the lead) are Events like any other, in everyone's view of the Channel. `agent.spawn` names the parent the new Agent will have, and `agent.spawned` names its parent too.

### Where a Person grants it

- The Dashboard's Agent page shows the role and the parent, and offers "Make lead" and "Revoke lead" to that Agent's own Person only.
- The CLI: `switchboard role grant <agent> lead` and `switchboard role revoke <agent>`, with the Person's session.

## Consequences

- A Person who makes an Agent a lead lets a model start processes on their Hosts and steer other sessions with instruction weight. The boundary is the Person's own: their Hosts, the folders and permission mode they allowed each Host, the two caps, and the lead's own subtree. A prompt-injected lead can do no more than that Person allowed their Hosts, and every step it takes is an Event.
- A lead gives no Agent a looser permission mode than its own, within the Host's maximum. The Channel knows that mode for a lead a Host started, from its `agent.spawn`. It does not know the mode of a lead started in a terminal, so such a lead starts Agents in at most `default`. A lead cannot raise its own mode by starting a looser Agent and making it a lead: only the Person grants the role.
- Agents still cannot instruct each other across Persons, and an Agent cannot make itself a lead. ADR 0005's protection against a stray or injected Agent steering another Person's setup is unchanged.
- The greenroom lead can move onto Hosts: its Person makes it a lead, and it starts, steers and stops its team through the Channel instead of through Terminal.app.

## Verification

End to end against `wrangler dev` with a Host running under a headless parent:

- an Agent without the role is refused on spawn, stop and Directive, each with the reason;
- its Person grants it lead from the CLI, and it starts an Agent through `agent_spawn`, which registers with it as parent;
- it sends that Agent a Directive through `send_directive`, which arrives framed as from the lead, and stops it through `agent_stop`;
- it is refused on an Agent outside its subtree and over `LEAD_AGENTS_LIVE_CAP`;
- after the Person revokes the role, it is refused again;
- every step above is an Event on the Channel.
