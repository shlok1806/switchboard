# 0058 (draft): Commit registration permits together and bind control consent to verified Hosts

Status: draft, awaiting independent design review. Extends ADR 0057; does not authorize implementation.

## Context

Managed registration performs Person/Agent effects before consuming both permits (worker/src/channel.ts:2939, :2948, :3141, :3149). Host rows are advisory (worker/src/hosts.ts:28), and the approval resource omits Host ID (worker/src/channel.ts:2275; worker/src/policy-permits.ts:33). A supplied Host ID cannot establish ownership.

## Decision

Use the owner's prepared durable intent (R10–R15), not staged shared writes. After non-mutating preparation and external Task synchronization, TXN-1 validates and consumes BOTH START and verified-owner HAND permits atomically and writes ONLY a bounded immutable registration intent and receipt bookkeeping. No Person, Agent, association, roster, presence, queue, Claim, Relay, Directive, Task, Event, spawn/waiter, broadcast, registration audit or enrollment effect occurs. Required idempotency key binds the fixed payload; TTL is at most 30 seconds, capped by authority expiry, with one live intent per agent and Host and bounded terminal retention.

Organization activation follows TXN-1 and is correlated to the authenticated bound Channel's exact intent and consumed receipts. It issues no usable Channel association, enrollment or credential. Confirmed activation is followed by a fresh `decide` check and short exact-resource apply permit. TXN-2 rereads binding/generation, revision, live intent, consumption ownership and existing predicates, consumes apply permission and executes the existing synchronous registration algorithm. Live queue/Task state at TXN-2 wins; preparation snapshots never restore or drain shared data. SQL effects and synchronous presence/claim recovery remain inside the transaction; sends, Relay scheduling, watch scheduling and Host waiter resolution happen only after commit with the existing generation fence. Rollback restores SQL and transaction-local in-memory state and discards callbacks.

Activation failure/timeout/denial, recheck denial, expiry or cancellation never applies shared state; consumed permits are not refunded and a new attempt requires a new handoff. `prepared → activated → applied → completed` is the success path; pre-apply failures enter `cancelling → cancelled/expired/failed`, with no shared registration visibility. Ambiguous activation is reconciled only to cancel/end, not to optimistic apply. Same-key retries attach; changed payload or competing agent/Host intent conflicts. Crash recovery before apply repeats fresh checks within TTL or cancels. After apply it retries completion, never registration.

Enrollment belongs only to TXN-2 verified-handoff registration completion. Channel's synchronous apply commits its proof; the authenticated completion RPC writes Organization enrollment in Organization's own synchronous transaction. This is not cross-DO atomicity. Until acknowledged, an applied registration has no usable enrollment or credential. A completion failure after apply is reconciled idempotently or ends authority; it is not described as a pre-apply zero-effect failure. No activation-only or generic enrollment writer exists. Unlinked registration keeps its existing synchronous skip and behavior.

The existing Organization DO holds bounded Host enrollment records written only by that permit-backed TXN-2 completion. Enforce MANAGED_RECORD_CAP and invalidate on execution end/revoke, unlink/rebind and ownership invalidation; policy uses only active rows. `decide` requires active membership and the enrolled Host owner for consent issuance. Bind Host ID and target into both policy resource and exact permit serialization. The owner may deny their own agent's approval; another Person requires matching, unexpired, unrevoked Host-owner `terminal_control` consent. Read/screen consent and admin status never authorize control. PCFIX opens approval authorization; B3b/B4 retains the machine-local enforcement boundary. Existing unverified Hosts and consents do not authorize effects.

## Consequences

The narrow registration refactor requires immutable intents, correlated consumption proof and durable lifecycle reconciliation, with request-local post-commit callbacks only. Shared staging is rejected: registration drains queues (worker/src/channel.ts:3317–3319), changes Tasks via presence (worker/src/channel.ts:656–657), invokes Relay on append (worker/src/channel.ts:4807) and resolves Host waiters (worker/src/hosts.ts:565–567). A hidden Agent flag cannot isolate them. Revocation retains ADR 0057's bounded permit/fence model. No new service binding or central orchestrator is introduced.

## Alternatives considered

Trusting caller-supplied Host identity or advisory limits permits machine takeover. Rollback after broadcasts cannot undo delivered effects. Deferring approval authorization to B3b contradicts the owner ruling; implementing all of B3b in PCFIX expands scope.

The detailed schema, state visibility, test matrix and WIP reuse/discard plan are in P3_PERMIT_CONSENT_REDESIGN.md. Both required positive assertions remain unchanged. Tests: not run.
