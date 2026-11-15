# B1q1 complete — implementation ready for manager gate

- Done: shared registered query executor/facade, bounded candidates/preparation, constituent and emitted-author release checks, revision-floor/deadline/full-binding fences (`worker/src/managed-query.ts:104`, `worker/src/managed-channel.ts:229`).
- Done: shipped stored history, Persons, roster and constrained GitHub reads migrated through registered plans (`worker/src/channel.ts:952`); QL-1, QL-2 and QL-3 applied.
- Done: common handler/denial table, real Organization/decide execution matrix, sparse/cap/exhaustion/non-progress/projection/release tests (`worker/test/managed-query-cases.ts:2`, `worker/test/managed-query-policy.test.ts:10`).
- Done: notes and H02/H03/H19/H33 inventory evidence updated (`m1/p3/P3_IMPLEMENTATION_NOTES.md`, `m1/p3/P3_ROUTE_INVENTORY.md:66`).
- Observed: Worker typecheck and lint exit 0; diff whitespace check exit 0; 138 baseline test files byte-identical; four adjusted P3 fixture files retain every assertion.
- Not run: Vitest, full suites and CLI e2e — coordinator assigns runtime gates to manager. No runtime pass claimed.
- Not done here: B1q2/B1q3, B2–B4, MCP/stream admission, local-holder transport, full summary/librarian READ; none started.
- Pending DD-1/DD-2 implementation (owner decisions already ruled): accounts, terminal input, approval control, delegated private-agent actions, Langfuse GET/PUT and MCP costs remain closed in this slice.
- Incompatible existing expectations: none. D5 deferral expectation changes: none; fixture-only metadata/deadline/LIMIT repairs are listed in notes.
- No new escalation, git writes, network, config/dependency/binding changes or deployment. Manager runtime/security gate still required.
