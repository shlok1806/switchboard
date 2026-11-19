# 0058 (draft): Commit registration permits together and bind control consent to verified Hosts

Status: draft, awaiting independent design review and resolution of the B3b dependency. Extends ADR 0057; does not authorize implementation.

## Context

Managed registration currently performs Person/Agent effects before consuming both permits (worker/src/channel.ts:2939, :2948, :3141, :3149). Host rows are advisory (worker/src/hosts.ts:28), while approval denial sends an Agent interrupt without a demonstrated machine-local ceiling (worker/src/channel.ts:2289). A supplied Host ID cannot establish ownership.

## Decision

Prepare without Channel effects, acquire START and applicable HAND permits together, then re-read state and consume both with all local registration mutations and audit in one synchronous transaction. Defer broadcasts until commit. Execution activation is a separate idempotent, recoverable Organization step, not a distributed atomic transaction. Unlinked behavior remains unchanged.

Organization resolves trusted Host enrollment and target binding, verifies native Host owner and active memberships through `decide`, and issues auditable, revocable, expiring exact-scope consent. Bind Host ID and target identity into the policy resource and permit serialization. Read/screen consent never authorizes control. Require fresh authority and machine-local limits at the actual control effect; deny while proof or enforcement is unavailable. Existing unverified consent does not authorize effects.

## Consequences

The narrow registration refactor requires transaction-safe buffered notifications and durable activation reconciliation. Control remains closed until B3b provides trusted enrollment and local enforcement. Revocation retains ADR 0057's bounded permit/fence model; no instantaneous distributed atomicity is asserted. No new service binding or central orchestrator is introduced.

## Alternatives considered

Trusting caller-supplied Host identity or advisory limits permits machine takeover. Rollback after broadcasts cannot undo delivered effects. Implementing the entire Host protocol in PCFIX expands the batch and requires a separate scope decision.
