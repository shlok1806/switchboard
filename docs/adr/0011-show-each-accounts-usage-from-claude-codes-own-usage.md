# Each Agent reports its account's usage, as Claude Code's own `/usage` says it

A Person running several Claude Code Agents across more than one Claude account wants to see, every time they look at the Dashboard, how close each account is to its limits, which Agents are spending it and how much each has used.

## Source of truth

The limits come from Claude Code itself. `claude -p "/usage"` prints the account's limits without a model call:

```
Current session: 80% used · resets Oct 7 at 1:59am (America/Chicago)
Current week (all models): 44% used · resets Oct 7 at 5:59am (America/Chicago)
Current week (Fable): 32% used · resets Oct 7 at 5:59am (America/Chicago)
```

The wrapper runs it with the wrapped session's own environment, so the same `CLAUDE_CONFIG_DIR` and login, with `--no-session-persistence`, no setting sources and no MCP servers, so it starts no hooks and leaves no session behind. It keeps the session line, the week line and every per-model week line it finds, each with its percent and its reset (as written, and as a time when it can read one). Any line may be missing, and an API key or a logged-out CLI has none; the parser keeps what is there and never fails the wrapper.

The account is the login `claude auth status` reports: its email address and its `subscriptionType` as the plan. Nothing else from it is sent: no organisation, no UUIDs, no tokens.

What the Agent's own session used comes from its transcript, which Claude Code writes per session (and per subagent): each model response's request ID, model and token usage. Each request counts once. The estimated cost uses API list prices; a subscription is not billed per token, so the cost only compares Agents.

## When

Once when the session starts, after every turn end the wrapper sees (the Stop hook), and every 5 minutes while the session lives, never more often than once a minute. A turn end inside the minute reads once the minute is up; a burst reads once. A read that fails is logged and waits for the next. A session that ends before its first read reads once on the way out. `SWITCHBOARD_USAGE=off` turns it off. Claude Code only: Codex and Gemini CLI have no `/usage`.

## On the wire

The reading rides on what the wrapper already sends: `usage` on `POST /api/agents` and on `POST /api/agents/:id/heartbeat`, sent once per new reading. The Agent keeps its latest as `usage` (with `reportedAt`). The Channel keeps each account's readings for a day, by email address, and serves them as `GET /api/accounts`, in the snapshot's `accounts`, and as an `account` stream message. A reading is not an Event: it changes too often to belong in the history, and the Relay has nothing to decide about it.

## The full email address

ADR 0009 masks the Account Label because everyone with Membership sees it. Usage is different: the owner asked to see which account, by its full address, on his own Channel, and the address is what tells two accounts' limits apart. So a usage reading carries the full email address and the Dashboard shows it. The Account Label stays masked; a Person who does not want their address on a Channel turns usage off with `SWITCHBOARD_USAGE=off`.

## Dashboard

An Accounts panel at the top of the Activity, Board and Agents views: one card per account with the full address, the plan, a meter for the session, the week and each model's week, each with its reset and a countdown, when it was read, a sparkline of the session percent over the current window, and the Agents running on it now with their nicknames, models, how long they have run, their requests, tokens and estimated cost, and their share of the account's Agents' usage. Every Agent shows its account's address, its own session's usage and the account's session and week meters. Meters are green under 70%, amber from 70% to 90% and red over 90%; a reading older than 15 minutes is dimmed and labelled stale.

## Compatibility

Every field is optional. An older wrapper sends no usage and its Agents show none; an older Worker ignores the field, and the Dashboard shows no Accounts panel when `GET /api/accounts` is missing.
