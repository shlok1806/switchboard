# M1-P3-S1 complete

- Fixed broadcast generation fencing first, including implicit generation zero (`worker/src/channel.ts:2903`).
- Added managed policy action/role matrix, fresh execution intersection and owner-consent decisions (`worker/src/policy.ts:92`).
- Added exact-resource Organization permits, <=2-second deadlines and revision cancellation (`worker/src/organization.ts:701`).
- Added synchronous local single-use consumption/invalidation and bounded 503 authority transport (`worker/src/policy-permits.ts:39`).
- Added SafeAgent type and allowlist constructor (`shared/src/m1.ts:72`, `worker/src/managed-projection.ts:5`).
- Added 12 cases across `worker/test/policy.test.ts` and `worker/test/managed-broadcast.test.ts`.
- Worker typecheck and lint passed; `git diff --check` passed.
- Vitest could not start: EROFS writing shared node_modules/.vite-temp; no tests executed.
- Linked routes remain closed (`worker/src/channel.ts:761`); route hooks, invalidation fanout/leases and connectors remain S2–S4.
- Agent private/Directive/handoff grants remain denied pending owner-bound vocabulary resolution; see Escalations in P3_IMPLEMENTATION_NOTES.md.
- No existing tests, CLI files, dependencies or configurations changed; no git writes, network access, deployment or commits.
