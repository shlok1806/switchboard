# A lead runs a queue of Agents, paced by its accounts' usage

Status: proposed on 2026-10-28 (#101). Extends ADRs 0011, 0018 and 0028.

## Context

#101 asks for an Orchestrator: one Agent that directs the others, queues work, runs a set number of Agents at a time and holds work when an account nears its usage limit. ADR 0018 already gives most of the authority. A Person can make one of their Agents a lead, which can start Agents on that Person's Hosts, send them Directives and stop them, all inside its own subtree and under `LEAD_AGENTS_LIVE_CAP`. What a lead cannot do yet is say "start this when there is room", learn when one of its Agents finishes without polling, or keep its team under the account limits that ADR 0011 already reads. The greenroom and bb runs that #101 cites did all three by hand, outside the Channel.

## Decision

### No new role

The Orchestrator is a lead. #101's role, its control verbs and its safety rules are ADR 0018's: the Person grants it, it acts only on its own subtree, it cannot widen its own permissions, and its Person has the final say. What follows adds a queue, notices and pacing to that role. It does not add new authority.

### The queue

- `queue_agent` (tool) and `POST /api/agents/queue` take what `agent_spawn` takes (Host, folder, CLI, model, brief), plus optional `after`: Agent IDs or queued entries that must finish first. The Channel stores the entry and records `agent.queued`.
- An entry starts when all of these hold: every entry in `after` has finished, the lead's subtree is under its concurrency limit, and the account the entry runs on is under its pacing threshold (below). Starting is an ordinary `agent.spawn` with the lead as actor, so every check of ADRs 0015, 0017, 0018 and 0028 still applies.
- An Agent has **finished** when it reports an outcome with `report_outcome` (succeeded or failed, with a one-line note) and its turn has ended, or when it goes Gone. `after` waits for success by default. An entry waiting on an Agent that failed stays held, with the reason, until the lead or its Person starts it, changes it or drops it.
- The concurrency limit is the lead's own (`max_live`, default 1). Its Person sets it, and the lead can only lower it. It is never above `LEAD_AGENTS_LIVE_CAP`.
- A held entry shows why it is held: waiting for an Agent to finish, at the limit, or over the account threshold until a reset time. The Dashboard shows the queue under the lead.

### Notices to the lead

When an Agent in its subtree finishes, fails, goes Gone or has an entry held, the Channel sends the lead an Update addressed to it (ADR 0026) that names the Agent and what happened. The Update wakes an idle lead. Like every Update it is information. These notices count toward the wake limit like any other wake, so a lead and its team cannot wake each other forever.

### Pacing by usage

- Each account's latest reading (ADR 0011) gives its session and week percentages and their reset times. The lead's Person sets two thresholds when granting the role: **hold** (default 85% of the session or week limit) and **pause** (default 95%).
- Over the hold threshold, no queued entry starts on that account until the reading drops below it or the reset time passes.
- Over the pause threshold, the Channel pauses the lead's subtree Agents on that account as ADR 0028 describes, and resumes them after the reset. ADR 0028 keeps Pause and Resume a Person's own act. Here the Person acts in advance, through the threshold they set, and the Events name that Person and the threshold, not the lead. A lead cannot change the thresholds.
- A reading older than its window, or no reading at all, counts as unknown. Unknown never pauses anything. It holds new entries only when the Person chose that when granting the role.
- When the queue lists more than one account or CLI, the next entry goes to the one with the most room left. This spreads work across accounts and providers without the lead guessing.

### Every action is on the Channel

`agent.queued`, `agent.queue.held`, `agent.queue.dropped`, `agent.outcome`, and the Pause and Resume that pacing causes, are Events like any other. A Person can see, reorder and drop any queued entry of their own lead's from the Dashboard, and stop or resume anything pacing paused.

## Consequences

- A lead can run a long build unattended: queue the work, let the Channel start it as room and usage allow, and wake on each result. None of this happens outside the Channel any more.
- Only queued entries and outcomes are new rows. Pacing reads the readings the Channel already keeps, so it adds no writes per heartbeat.
- Pacing is only as fresh as the latest usage reading. A burst between two readings can still pass the pause threshold. The thresholds leave room for that.
- Agents started in a terminal cannot be paused (ADR 0028), so pacing only holds new entries for them.
