## Round 1

- PC-1 → RESOLVED: Evidence and root cause; Test plan. Owner approval remains 200 and its response assertions remain intact.
- PC-2 → RESOLVED: Approval and dispatch; Review disposition. PCFIX opens Channel authorization; B3b/B4 retains CLI local rechecks.
- PC-3 → RESOLVED: Trusted Host ownership and consent; Registration steps 4–5. Bounded Organization enrollment is created only by activation of the owner's verified, permit-checked handoff registration.
- PC-4 → RESOLVED: Registration steps 4–5. Pending, reconciling, active and failed states specify visibility, retries, authoritative cancellation and cleanup.
- PC-5 → RESOLVED: Approval and dispatch. `hostId` is included in the exact resource key.
- PC-6 → RESOLVED: Approval and dispatch. Agent Host is only a hint checked against Organization enrollment and target binding; matching Host is included in decision and permit.

The owner selected option 1, resolving the review's owner-decision block. Tests not run.

## Round 2

This section supersedes Round 1's activation-time enrollment and staged-write wording. R10–R15 select immutable prepared intent; no new owner decision is requested.

- RECHECK-1 PC-1 → RESOLVED: design “Approval and dispatch” requires outer input targetExecutionId/owner/hostId before prepare, not only a copied preliminary check; exact resourceKey includes hostId (existing closure/resource evidence: worker/src/channel.ts:1691–1706, :2275–2287; worker/src/policy-permits.ts:33–42).
- RECHECK-1 PC-2 → RESOLVED: “Trusted Host ownership and consent” specifies MANAGED_RECORD_CAP, 503 capacity failure, active-row queries and invalidation at execution end/revoke and unlink/rebind; lifecycle hook evidence worker/src/organization.ts:525–527, :701–720.
- RECHECK-1 PC-3 → RESOLVED with fixture-method rebuttal: “Test plan” and “WIP reuse” retain managed-agent-controls.test.ts:278 = 200 and managed-consent-control.test.ts:374 = true. Fixtures use actual verified owner handoff and TXN-2 completion. Reject direct SQL enrollment seeding as integration proof: R4/R11 permits only registration to write enrollment; existing arbitrary Host fixture is worker/test/managed-consent-control.test.ts:357.
- Original PC-1 → RESOLVED: “Evidence and root cause” and “Test plan” preserve owner-deny positive assertion and responses; no deferral.
- Original PC-2 → RESOLVED: “Approval and dispatch” opens owner-direct and consented control authorization now; local daemon ceiling remains B3b/B4.
- Original PC-3 → RESOLVED: “Protocol” steps 3–7 and “Trusted Host ownership” move enrollment exclusively to verified-handoff TXN-2 completion, never TXN-1 or activation alone. Separate Channel/Organization synchronous transactions are explicit; no distributed atomicity claim.
- Original PC-4 → RESOLVED: “PC-4 state machine and visibility” specifies bounded TTL, cancellation, ambiguous timeout, crashes, competing intents, replay, terminal states, non-refund and post-apply completion recovery. Pre-apply failures never mutate shared state.
- Original PC-5 → RESOLVED: “Approval and dispatch” binds Host into policy and exact resource key before prepare.
- Original PC-6 → RESOLVED: “Trusted Host ownership” and “Approval and dispatch” retain agent.host as hint only, requiring active Organization enrollment/owner/target match.
- PCFIX durable-staging blocker → RESOLVED by owner ruling: “Intent schema”, “Protocol”, “Live state wins” and state machine implement R10–R14. TXN-1 touches only immutable intent and atomic receipt bookkeeping; TXN-2 uses live queues/Tasks. No shadow rows or notification journal. Evidence for original blocker: worker/src/channel.ts:3147, :3317–3319, :656–657, :4805–4807; worker/src/hosts.ts:553–567. Request-local callback isolation is required only within TXN-2, not across activation.
- Sizing/WIP → RESOLVED: “Test plan and PCFIX sizing” and “WIP reuse” specify one focused implementation run, realistic larger line budget, retained receipt/serialization/extraction primitives, and discarded staged-write assumptions. No WIP runtime passing claim is adopted.

Only the four authorized documents changed. Tests not run, as instructed. No assertion/test/config/code changes. REBUILD_BASE remains 87b8813; no disproportionate architectural problem under the owner's selected intent protocol.
