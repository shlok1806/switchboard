# Cross-Person Host control, Paused Agents and a current roster

Status: accepted on 2026-10-16. Extends ADRs 0002, 0015, 0017, 0018, 0021 and 0024. Numbered 0028 because 0025 to 0027 went to branches in flight.

## Decision

### Who may use a Host

A Host remains owned by one Person. By default only that Person can start, stop, pause and resume Agents on it. The owner may open it to others in two ways, and both end in the machine's own `host.json`:

- `switchboard host install --allow <login>` (repeatable) names Persons, and `--allow-channel` permits every Person with write access to the Channel. A plain `switchboard host install` with neither flag keeps whatever the Host already allows (so reinstalling never wipes a list made from the Dashboard). Naming either flag replaces the list.
- The Dashboard (below), for an owner who would rather click than type.

Every Host request carries the requesting Person (`by`). The Host checks that Person against its own file, then its roots, permission mode and Agent cap, as in ADR 0017. The Channel keeps a copy of the allow-list (`allow`, `allowChannel` on the Host) only to refuse early with a reason and to fill the Host picker. A stolen session or the Worker can widen the copy and nothing else: the Host still refuses. Under `--allow-channel` the Host trusts the Channel's word that `by` has write access, as it does for every Person the Channel lets in.

Who may act on which Agent: the Agent's own Person always, and any Person the Agent's Host allows. A lead (ADR 0018) stays limited to its own Person's Hosts and its subtree, may spawn and stop only, and cannot name another Person's Host; an allow-list gives a Person authority, not an Agent token. Pause and Resume are a Person's alone.

The Agent created on someone else's Host belongs to the Host owner, whose CLI login runs it, in the owner's folders and within the owner's mode limit. Its first brief names the requesting Person.

### Sharing from the Dashboard

The owner's Hosts page shows each of their Hosts with "Who can use this Mac": the Persons on the Channel with a toggle each, and "Everyone on this Channel". A toggle sends `POST /api/hosts/:name/allow` with the new list, signed by the browser's attach key (the key ADR 0021 uses for the terminal). The signature covers the Channel's repo, the Host name, a timestamp, a sequence number and the list. The Channel verifies nothing and relays it to the Host's socket (`host.allow`) and waits for the answer.

The Host applies it only when all of these hold, against its own files:

- the key's fingerprint is on `attach.json` for the Host's own Person, with no Agent scope and a repo scope (if any) that matches;
- the signature verifies, the change is at most five minutes old, and its sequence number is higher than any it applied for that key since it started;
- the list is well formed.

It then writes `host.json` and republishes its limits to the Channel (`POST /api/hosts`), so the Channel's copy is whatever this machine now allows, and answers. A refusal comes back to the Dashboard with a reason. When the browser's key is not trusted yet, the reason is the exact command: `switchboard attach allow <fingerprint>` (no `--person`, so the key is the owner's), run on the Host's machine. The Host must be running to answer, so an Offline Host cannot be shared from the Dashboard. A stolen session cannot widen a Host this way, since it holds no trusted private key. An attacker who captures one signed change can replay it only inside the five-minute window and only until the Host sees a higher sequence number from that key; after a Host restart the window is all that is left.

`switchboard host install` with no flags stays the only CLI step to make a machine a Host. The owner's browser key is trusted once with `switchboard attach allow <fingerprint>`.

### Events

Every control request is an Event with the requesting Person as actor and the owner named: `agent.spawn`, `agent.stop`, `agent.pause` and `agent.resume` carry `owner`. A Host that refuses or cannot do a stop, pause or resume answers with `agent.control.failed` (actor: the Host's Person, with `by`, `action` and `reason`). The Host owner's Dashboard, Agent page and Feed show these ("Asked laptop to pause alice/claude/ab12 (alice's Agent)", with bob as the actor). The Host's own log names `by` for each request too.

### Pause and Resume

Pause ends the wrapper and CLI process, but keeps the session ID, Agent ID, role, parent, Claims and Host record. Presence becomes `paused`, a fourth Presence beside Live, Idle and Gone.

- The Channel marks the Agent Paused before the frame reaches the Host, so the wrapper ending its session as it is stopped does not make it Gone. A Paused Agent ignores its wrapper's heartbeat and end of session, and the silence check skips it. It holds its Claims, which stay fresh, and does not count against the Channel's Host cap.
- The Host writes `paused` into `agents.json` before it ends the process, then confirms with `host.paused`. The Channel revokes the Agent token and closes the wrapper's sockets then. A Host restart skips Paused entries and never resumes them by itself. It repeats the confirmation when it reattaches.
- If the Host refuses (its own allow-list is narrower, or it does not run the Agent), the Channel records `agent.control.failed` and the Agent is Idle again; its wrapper never stopped.
- Resume asks the Host to relaunch with `--resume <session-id>` after the local folder, mode and Agent-cap checks pass again. Resume leaves a short-lived ticket on the Channel: a Paused Agent may register again only while one stands and only from its own Host, once. A stale wrapper, or a terminal trying to run the same session, is refused with a message to resume from the Dashboard. A resume the Host cannot carry out (the CLI exits before registering, say) leaves the Agent Paused with the reason recorded.
- Directives to a Paused Agent are held with the reason `paused` and handed over when it registers again. The Relay downgrades Interrupts to Queue for the same reason and keeps its Verdicts for the next turn. No Wake is attempted, since no process exists.
- Stopping a Paused Agent makes it Gone at once (there is no process to end its session) and the Host forgets its entry. If its Host is Offline, only the Agent's own Person may end it, on the Channel alone, so Claims are not held for ever by a machine that never returns. A Host that is Offline cannot take any other control request.

An Agent started in a terminal has no supervisor that can reliably pause it and later relaunch its session. Stop and Pause through Host control are refused for it, with a reason to use its own terminal. This keeps a stolen Channel session from killing an arbitrary terminal process. Attach remains the explicit route for remote keyboard control.

### Roster (shipped in 75d5827)

`GET /api/agents` is the current roster: Live, Idle and Paused Agents, plus Gone Agents that still hold Claims. `?include=gone` returns the full history. A Gone Agent with a Stale Claim remains until a Person releases or takes over its Claim. Claims never expire on their own (ADR 0002).

## Consequences

Cross-Person control grants access to processes on another Person's machine, within the limits that Person installed there. The local file is the authority; the Channel copy only improves discoverability and errors, and the Dashboard toggles are one more way to write the file, gated by a key the owner trusted at the machine. The owner sees who requested each action. Pausing frees CLI resources without losing work, but a resumed CLI still has to accept its saved session; a missing or corrupt session yields a visible failure and a still-Paused Agent rather than a different Agent.

Known limits: the Dashboard cannot share an Offline Host; the allow-list is the same for all four actions (there is no "may start but not stop"); a captured signed change can be replayed within five minutes until a higher sequence number is seen.
