# Package 3 implementation notes

## Changes (file:line)

## Tests added

## Commands run

## Deviations

## Escalations

## S1

### Changes (file:line + symbol)

- FIRST implemented P1R-3: `worker/src/channel.ts:2903` (`broadcast`) compares every socket's binding tag to the loaded generation, with missing tag exactly `binding:0`; stale sockets receive nothing. `worker/src/channel.ts:2400` (`socketIdentityTags`) accepts already-read tags, so broadcast still performs one `getTags` call per socket. No await, storage access, JSON parsing or tagging was added to the legacy path. Generation-zero tag creation remains unchanged at `worker/src/channel.ts:2395` (`socketTags`).
- `worker/src/policy.ts:27` (`POLICY_ACTIONS`) enumerates every contract action; `worker/src/policy.ts:43` (`PolicyContext`) adds trusted managed facts, owner consent and narrowing restrictions. `worker/src/policy.ts:92` (`decide`) rejects unknown actions/resource fields, parent mismatches, inactive memberships and unavailable authority; uses explicit role action sets for managed shared content and permits only scoped admin exceptions. Managed executions recompute the grant/ceilings/current sponsor/constraints intersection and validate revision, parent IDs and credential expiry. Private actions require target ownership or exact owner-issued Person/Workspace/target/action/unexpired consent, after membership checks. Viewers cannot send Directives or perform handoffs. Restrictions can only deny.
- `worker/src/principals.ts:71` (`effectiveActions`) remains a facts/intersection helper, not a new decision endpoint. Added finite expiry/time checks, active execution-owner enrollment and explicit unknown-sponsor denial (`worker/src/principals.ts:85`, `worker/src/principals.ts:94`, `worker/src/principals.ts:102`).
- `shared/src/m1.ts:62` (`PolicyResource`) adds exact Channel/target/owner/operation identifiers. `shared/src/m1.ts:72` (`SafeAgent`) defines the eight-field shared allowlist. `worker/src/managed-projection.ts:5` (`safeAgent`) constructs only those fields, without spreading Agent or identity objects. Caller must authorize and verify enrollment before projecting.
- `worker/src/organization.ts:90` adds the Organization-only `mutation_permits` table. `worker/src/organization.ts:701` (`issueMutationPermit`) resolves execution credentials, then rereads mutable facts synchronously and calls `decide` with managed policy enabled. Requires exact Channel/target/operation/request and the most recent completed binding for that Channel; pending transitions deny. Binding journals store the pre-transition generation, so issuance compares journal generation + 1, matching `worker/src/channel.ts:844` and `worker/src/organization.ts:1491` (transition/finalization protocol). Indexed primary-key storage records random permit IDs, actor/action/exact resource/revision/generation and absolute deadline <= issuance + 2,000 ms, capped by credential/grant expiry. Issuance audit is in the same transaction (`worker/src/organization.ts:831`); it records permission issuance, not a claimed Channel outcome.
- `worker/src/organization.ts:97` (`save`) cancels all permits from prior revisions in the authority transaction, including membership/grant/credential revocation or demotion. `worker/src/organization.ts:919` (`cleanup`) reclaims expired authority permits in batches of 100. `worker/src/policy-permits.ts:39` (`LocalMutationPermits`) provides managed-only local installation, durable single-use consumption, exact actor/resource/action/request/generation/revision checks, finite deadlines, exact-expiry and backward-before-issuance denial, and invalidation. Installation cannot replace a consumed permit. Local state reread, consume, write, audit and outbox MUST share one caller-owned synchronous transaction; S2 attaches these hooks after synchronization. No credentials/digests/redemption codes are present in the local permit representation (`worker/src/policy-permits.ts:3`).
- `worker/src/policy-permits.ts:80` (`AuthorityUnavailable`) and `worker/src/policy-permits.ts:87` (`authorityRequest`) bound reads/permit issuance to at most 2,000 ms and map exceptions/timeouts to a redacted status-503 error. Timed-out RPCs can still finish remotely: callers must never install or commit late results. This helper does not wrap external side effects or claim to cancel remote transactions.
- Linked routes remain closed through unchanged `worker/src/channel.ts:761` (`managedClosed`). No managed projection/permit initialization was added to Channel construction or legacy hot paths. HTTP/RPC admission and actual mutation hooks belong to S2; invalidation delivery and leases belong to S3; connectors belong to S4 (`m1/p3/P3_PLAN.md:49`).

### Tests added

`worker/test/policy.test.ts` adds these `it()` cases:

- "denies unknown actors actions parents inactive memberships and unavailable authority"
- "intersects grants ceilings execution constraints and current sponsor authority"
- "Bob cannot grant what Bob lacks"
- "sponsor demotion removes authority"
- "org admin has no private rights"
- "uses explicit role actions for all contract operations and scopes admin exceptions to metadata"
- "denies stale missing and restricted execution facts despite a previously verified action list"
- "constructs shared agents by allowlist"
- "consumes exact-resource permits once and rejects expiry generation revision and request mismatch"
- "issues permits only for a current exact binding and cancels outstanding permits on authority change"
- "bounds unavailable authority to 503"

`worker/test/managed-broadcast.test.ts` adds "drops stale generations and treats untagged sockets as generation zero". It invokes the production broadcast method with controlled sockets, including a Host, and checks both managed and generation-zero behavior without constructing a Channel or changing tags.

### Commands run and actual results

All verification commands used `PATH=/home/box/.local/node22/bin:$PATH`.

- Worker `npm run typecheck` (also invoked as `npm run typecheck --prefix worker`): exit 0 on each completed invocation, including final production/test changes. Typechecks include the new files; this is not test execution.
- Worker `npm run lint`: initially exit 1 for new-file formatting/import order, then exit 1 for an untyped `let context`; corrected both. Final invocation exit 0, 168 files checked.
- Targeted `npx biome check --write` on changed files from Worker: final exit 0. An earlier invocation from repo root failed on nested Biome root configuration, with no fixes applied; reran from Worker, without modifying configuration. Intermediate Worker formatting invocation fixed formatting but exited 1 for the subsequently corrected `let context` annotation.
- Worker `npx vitest run test/policy.test.ts test/managed-broadcast.test.ts`: exit 1 BEFORE test execution. Vite could not write `worker/node_modules/.vite-temp/vitest.config.ts.timestamp-….mjs` (EROFS; node_modules is a shared symlink outside this writable worktree). No tests passed or failed: none executed. Did not alter symlinks, configuration, dependencies, test timeouts or sandbox permissions. Manager must run both files in a writable test environment.
- Read-only `git diff --check`: exit 0. Read-only status/diff and source inspection were used; no write-producing git command was run.
- Full Worker/CLI/Dashboard/e2e suites: not run, manager-owned gates. CLI checks: not run, no CLI files changed.

### Deviations / carry-forward decisions

- Managed behavior explicitly opts into `PolicyContext.managedPolicy`; existing P1/P2 native contexts retain their narrower policy behavior (`worker/src/policy.ts:57`, `worker/src/policy.ts:154`, `worker/src/policy.ts:223`). This preserves existing P2 policy tests/behavior while linked routes stay closed. S2's managed facade MUST set it and provide fresh authority facts; a verified action list alone is insufficient for managed decisions. No managed route is opened by S1.
- Exact permit targets and operation names are supplied by trusted internal callers, never inferred from a Workspace-wide bearer allowance (`worker/src/organization.ts:721`). Local permit APIs are foundations only; no commit path uses them until S2. Authority revision cancellation is implemented; Channel push cancellation/durable invalidation fanout is explicitly S3, not claimed complete here (`m1/p3/P3_PLAN.md:53`).
- P2R-1 remains for S2: `identityCatalog` was not edited (`worker/src/organization.ts:522`). P2R-2 stays manager-only for execution start: `worker/src/principals.ts:21` (`MANAGER_ACTIONS`) and `worker/src/policy.ts:213` retain that default. No contributor execution issuance was added.

### Escalations / limitations

- The existing grant vocabulary limits agents to contributor actions (`worker/src/principals.ts:31`, `worker/src/organization.ts:271`). The proposal requires explicit grants even for agents' private/Directive/handoff actions (`m1/M1_ARCHITECTURE_PROPOSAL.md:84`), but P2 cannot represent those grants/owner consents. S1 retains safe DENY for those execution actions instead of silently widening delegability or inferring control from screen consent. S2 must resolve owner-bound grants/consent before exposing these agent paths; human owner/consent policy facts are supported now (`worker/src/policy.ts:195`). No Person impersonation or terminal-control action was added.
- Clock validation covers nonfinite values, expiry and a local clock before issuance (`worker/src/policy-permits.ts:58`); it does not establish cross-object clock synchronization or a measured delivery/revocation bound. S3/manager runtime tests remain required by `docs/adr/0057-one-policy-function-guards-managed-workspaces.md:15`.
- Runtime security assertions remain unverified because the new tests could not start (EROFS described above). No existing tests were edited.
