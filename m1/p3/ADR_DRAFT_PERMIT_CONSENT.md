# 0058 (draft): Commit registration permits together and bind control consent to verified Hosts

Status: draft, awaiting independent design review. Extends ADR 0057; does not authorize implementation.

## Context

Managed registration performs Person/Agent effects before consuming both permits (worker/src/channel.ts:2939, :2948, :3141, :3149). Host rows are advisory (worker/src/hosts.ts:28), and the approval resource omits Host ID (worker/src/channel.ts:2275; worker/src/policy-permits.ts:33). A supplied Host ID cannot establish ownership.

## Decision

Prepare without Channel effects, acquire START and applicable HAND permits together, then re-read state and consume them with local registration mutations in one synchronous transaction. Stage visibility and notifications until activation. Organization activation and enrollment are a separate idempotent step, correlated to the owner's verified handoff and both consumed permits; no distributed atomicity is claimed. A durable state machine reconciles ambiguous activation and fences cancellation before terminal cleanup. Unlinked behavior remains unchanged.

The existing Organization DO holds bounded Host enrollment records written only by that permit-checked registration activation. `decide` requires active membership and the enrolled Host owner for consent issuance. Bind Host ID and target into both policy resource and exact permit serialization. The owner may deny their own agent's approval; another Person requires matching, unexpired, unrevoked Host-owner `terminal_control` consent. Read/screen consent and admin status never authorize control. PCFIX opens approval authorization; B3b/B4 retains the machine-local enforcement boundary. Existing unverified Hosts and consents do not authorize effects.

## Consequences

The narrow registration refactor requires staged notifications and durable activation reconciliation. Revocation retains ADR 0057's bounded permit/fence model. No new service binding or central orchestrator is introduced.

## Alternatives considered

Trusting caller-supplied Host identity or advisory limits permits machine takeover. Rollback after broadcasts cannot undo delivered effects. Deferring approval authorization to B3b contradicts the owner ruling; implementing all of B3b in PCFIX expands scope.
