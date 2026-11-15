# B1a complete — ready for manager runtime gate

- Done: declarative registry/facade migration of existing S1–S2c reads, constituent checks, permits and result-release checks (`worker/src/managed-channel.ts:159`, `:217`; `worker/src/channel.ts:895`, `:1182`). No new content family opened.
- Done: exact request/actor/resource receipt validation, durable singleton revision floor and internal invalidation preparation (`worker/src/policy-permits.ts:48`; `worker/src/channel.ts:863`; `worker/src/organization.ts:117`).
- Done: shared Person/Event allowlist projection and query decomposition preparation (`worker/src/managed-projection.ts:22`, `:46`; `worker/src/managed-channel.ts:84`).
- Done: five new B1a test files; registry, real relay/roster/Update handler coverage, denial matrices, revision/receipt/timeout/projection checks; inventory INV-4/INV-6 corrections and C21 exception documented.
- Observed: worker typecheck and lint pass. Vitest/full suites not run: coordinator sandbox instruction; manager runs the gates. Baseline comparison: all 138 baseline test-tree files unchanged.
- Not done in B1a: B1b route openings; B2/B3/B4. Invalidation retry/completion, socket leases and pending cancellation remain B4; no completed-revocation timing claim.
- Pending DD-1/DD-2: accounts; keyboard input; approval control; delegated private actions for agents; Langfuse GET/PUT; MCP costs stay closed. START remains manager-only; release mapping remains B2a.
- Incompatible existing expectations: none. D5 deferral expectation changes: none.
- Details and exact commands: `m1/p3/P3_IMPLEMENTATION_NOTES.md`, section B1a continuation.
