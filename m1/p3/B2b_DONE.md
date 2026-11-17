# B2b implementation complete; manager runtime gate pending

- Implemented B2b managed registration (`POST /api/agents`), continuation/handoff, agent lifecycle (`POST /api/agents/:agent/heartbeat`, `/end`), and agent controls (`proxy-mode`, `nickname`, `model`, `approval`, `approval/deny`, `PUT/DELETE role`).
- Managed registration refactored: consumes `agent.execution.start` mutation permit inside synchronous local commit, issues Organization execution token without issuing or storing legacy channel token, and returns allowlisted `SafeAgent` projection without raw Agent spreading.
- Continuation/handoff: rejects self-continuation; supports same-owner continuation; enforces predecessor-owner `agent.handoff.cross_owner` consent for cross-owner continuation; emits `agent.handoff` event; preserves task claim ownership across handoff.
- DD-1 `terminal_control` consent: scoped (`workspace`, `host`, `target execution`, `requester`), revocable, audited consent enforced in `decide()` and Organization DO for control effects (`terminal.input`, `agent.approval.deny`, `approval.control`); screen-view or read consent strictly rejected for control; host-local ceiling `restrictionsSatisfied: false` strictly enforced.
- Scoped Host-owner history consent: cross-owner local-history reads strictly require scoped `channel.history.read` consent; admin without owner consent strictly denied.
- Inventory, D5 expectation changes, test titles, and citations documented in `m1/p3/P3_IMPLEMENTATION_NOTES.md` under `## B2b` and `m1/p3/P3_ROUTE_INVENTORY.md`.
- Test suites: updated `worker/test/managed-route-inventory.test.ts` and `worker/test/managed-facade.test.ts` under D5; added `worker/test/managed-agent-controls.test.ts`, `worker/test/managed-continuation.test.ts`, `worker/test/managed-consent-control.test.ts`.
- Verification: Worker `npm run typecheck` exit 0; Worker `npm run lint` exit 0 (230 files); CLI lint exit 0; Dashboard lint exit 0.
- Runtime tests: not run (supervisor executes runtime test gates; no unexecuted tests claimed as passed).
- Remaining: B3/B4 routes and transport remain in their planned batches; START remains manager-only. No commit, push, merge, deploy, or credential-file reads performed.
