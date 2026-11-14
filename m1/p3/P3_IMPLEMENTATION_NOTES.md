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

### S1 fix 1

- Read the complete failing gate log, `/home/box/engineering-workspace/engineering-ops/projects/switchboard-m1/p3_logs/S1/06_worker_test.log`. `summary.tsv` lists this as the only failed gate. Manager results: 1 failed, 536 passed, 2 skipped tests; the sole failure was the new permit issuance/cancellation case at `worker/test/policy.test.ts:357` (previously line 356). No existing-test or CLI e2e failure was reported in these logs.
- Root cause: the new test's Workspace demotion request omitted `expectedRevision` (`worker/test/policy.test.ts:343`). Organization correctly requires it for `workspace.member` and returns `revision_required` before changing authority (`worker/src/organization.ts:1026`); this was a fixture error, not a production authorization failure.
- Fix: supply the issued permit's authoritative revision (`worker/test/policy.test.ts:347`). Strengthened the successful-demotion assertion to require the returned active viewer membership (`worker/test/policy.test.ts:357`). Retained both security assertions: subsequent permit issuance denies and outstanding authority permits are empty (`worker/test/policy.test.ts:358`). No production code, pre-existing tests, timeouts, tool configuration or legacy hot paths changed.
- Verification with Node 22 PATH: Worker `npm run typecheck` exit 0; Worker `npm run lint` exit 0 (168 files); `git diff --check` exit 0. Worker `npx vitest run test/policy.test.ts test/managed-broadcast.test.ts` exit 1 during config loading: EROFS writing generated Vite config under shared `worker/node_modules/.vite-temp`. No tests executed in this attempt; runtime fix remains for manager verification. Full suites and CLI e2e not run locally. No configuration or filesystem workaround was applied.

## S2

### S2a (gated now)

The coordinator re-slice supersedes the earlier S2 STOP/incomplete declarations. This section replaces those stale declarations and describes the final S2a diff; S2b remains separate. S2a is complete for manager review/runtime gating, not a claim of passing runtime tests. All pre-existing tests, including `worker/test/managed-registration.test.ts`, remain unchanged (read-only `git diff --name-only -- worker/test` returns no tracked test changes).

### Changes (file:line + symbol)

- `worker/src/channel.ts:1180` (`requireLegacyAccess`) denies bare content/control RPCs using the already-loaded binding before subsystem access. `managedClosed` (`worker/src/channel.ts:781`) treats pending/unknown states as managed/closed; the legacy path is a synchronous branch. Existing stream/MCP fences remain closed. `worker/src/index.ts:245` exports `CHANNEL_ROUTE_MATCHERS`, now used by dispatch itself, and `worker/src/index.ts:295` routes recognized managed credentials to the facade with the Worker post-dispatch generation fence. Generation-zero untagged socket semantics remain as in S1 (`worker/src/channel.ts:3419`, `broadcast`).
- `worker/src/auth.ts:116` (`readCredential`) and `worker/src/auth.ts:163` (`recognizableNativeSession`) implement D2: failed ordinary legacy credentials get the baseline failure without another awaited signature check. Native Persons retain P1's `v1` envelope, so the synchronous native-session payload hint is also needed alongside `m1.` execution tokens. Recognition is routing only; managed authentication verifies signature, issuer, expiry and directory association (`worker/src/channel.ts:794`, `managedRequest`). No positive authorization cache is introduced.
- `worker/src/managed-channel.ts:11` (`managedReadRoute`) admits Tasks, Relay settings, private transcript/screen/touched-files, SafeAgent roster/summary, and skills/artifacts/Brief list/detail/version reads. `managedRead` (`worker/src/managed-channel.ts:80`) makes fresh bounded admission and response-release decisions and checks binding; denial is 404, authority errors are redacted 503, responses are no-store. `worker/src/channel.ts:794` (`managedRequest`) binds the named DO and route, reauthenticates native credentials, checks per-execution roster eligibility and constructs SafeAgent by allowlist. The safe summary omits activity/note/file constituents. Private paths pin the enrolled target execution; raw file paths require transcript permission. Artifact HTML uses sandbox CSP/nosniff/no-referrer/no-store (`worker/src/channel.ts:878`).
- `worker/src/managed-channel.ts:103` (`managedWriteRoute`) admits Updates, Person Directives, claim/release/step/branch/finish/takeover and owner-only artifact DELETE. `worker/src/channel.ts:962` (`#managedWrite`) resolves trusted actors, reauthenticates before permit issuance, bounds native login verification and checks binding after body parsing. It installs exact-resource permits and consumes them in `transactionSync` with the write and redacted local outcome. Capacity is reserved before append/Relay/broadcast or external PR creation. Credentials, credential hashes and redemption codes are not persisted in Channel. DELETE retains the existing synchronous artifact-owner predicate; managers cannot override it.
- `worker/src/claims.ts:83` (`ClaimMutation`), `worker/src/branches.ts:52` (`BranchMutation`), and `worker/src/stale-claims.ts:122` (`takeover`) add optional managed hooks after sync, followed by local state reread and synchronous commit. Legacy callers supply no hook and gain no await/RPC/storage/JSON work. Finish authorizes an external intent, records the external outcome even when subsequent authorization fails, reacquires a permit and checks holder/branch before the review commit (`worker/src/branches.ts:99`, `finish`). Claim ownership predicates and existing Task/GitHub algorithms remain in place.
- `worker/src/managed-budgets.ts:19` (`ManagedUpdateBudgets`) persists execution 30/minute burst 10 and Channel 300/minute burst 50 buckets; backward clocks do not mint tokens and failed admission does not partially debit. `#managedWrite` returns 429 with Retry-After before Update append/Relay. Managed schemas are initialized only within managed operations.
- `worker/src/managed-retention.ts:6` (`appendManagedOutcome`) implements D4: both outcome tables expire at 24 hours, prune on write and have a hard 1,024-row cap; exhaustion denies instead of dropping unexpired evidence. `worker/src/policy-permits.ts:44` (`LocalMutationPermits.install`) prunes expired permit receipts and caps them at 1,024, preserving consumed replay fences until expiry. External outcomes reserve capacity before PR creation and update that reservation afterward. Export/acknowledgment is deferred; no delivery claim is made.
- `worker/src/organization.ts:820` (`mutateConsent`) implements owner/target/action/recipient/expiry-specific audited consent with scoped replay and body fingerprint; deletes require the expected revision. `channelDecision` (`worker/src/organization.ts:935`) resolves ownership/enrollment from authority state and applies `decide`, never trusting supplied ownership. `authorizeChannelRead` (`worker/src/organization.ts:1095`) attenuates to reads; `issueMutationPermit` (`worker/src/organization.ts:1125`) issues bounded permits. `worker/src/workspace-api.ts:169` exposes owner consents and self-only human permissions; other-actor inspection stays denied.
- `worker/src/organization.ts:540` (`identityCatalog`) fixes touched P2R-1 by pushing visibility/keyset filtering and LIMIT 101 into SQL. `worker/src/execution-api.ts:98` bounds catalog authority calls and rechecks identity/catalog after cursor signing. `worker/src/policy.ts:178` limits self-owned principal metadata to active Organization members in the identity context; it grants no Workspace/private content rights. P2R-2 remains manager-only execution issuance.

### D1 trusted internal exception

`worker/src/channel.ts:1847` (`heartbeat`), `:1879` (`requireManagedLifecycle`) and `:1929` (`endSession`) accept only the already recorded active execution, matching Agent owner and linked Organization without a policy actor. Managed heartbeat skips Relay/Directive/lost-claim queues and usage/context reporting. These DO RPCs are trusted internal Worker lifecycle paths, not external content authorization. External actor-free lifecycle HTTP admission remains denied by the allowlist; external routes must authenticate an execution credential before ever reaching this exception. ADR wording is retained at `docs/adr/0057-one-policy-function-guards-managed-workspaces.md:27`. The PARTIAL router inventory explicitly documents the exception; the separate lifecycle tests cover owner mismatch and queue isolation. P3P-2 does not become a broad execution-revoke grant.

### Deferred to S2b

The allowlist (`worker/src/managed-channel.ts:11`, `:105`) continues to deny Memory; skill-file byte/chunk reads, uploads and skill publication; artifact PUT; Brief writes; librarian/GitHub proxy; settings/Langfuse; Hosts list/register/allow/remove and spawn/stop/pause/resume; task creation; tool-call telemetry; non-D1 Agent controls; shared history/events/search and roster-constituent projections; continuation/handOff. Durable authority export/acknowledgment/reconciliation of local outcomes and the complete native/integration/frame inventory are deferred to S2b. Streams remain S3 and MCP/OAuth remain S4. No new family was opened in this hardening continuation.

`worker/test/managed-route-inventory.test.ts:90` is a **PARTIAL inventory**: every actual `CHANNEL_ROUTE_MATCHERS` family plus the fixed `ROUTES` set has independent expected actions or explicit denial. Family/set comparisons detect additions, while examples assert actual matcher recognition. It is not exhaustive coverage of every dynamic matcher variant, native/integration API or accepted frame; S2b must complete that inventory. Unopened routes are exercised over HTTP on linked/pending/unknown bindings; unlinked subsystem dispatch is exercised without authority/storage fixtures.

### Tests added (file:line + exact it() titles)

All are new S2 files; the helper is `worker/test/managed-helpers.ts:18` (`bareChannel`) and `:40` (`managedAuthorityFixture`). None has been executed successfully in this sandbox.

- `worker/test/managed-read-paths.test.ts:26`: “checks authority before reading and freshly before releasing without caching”.
- `worker/test/managed-read-paths.test.ts:38`: “denies nonmembers before reading counts cursors or direct IDs”.
- `worker/test/managed-read-paths.test.ts:45`: “discards content when revocation or binding transition occurs during a read”.
- `worker/test/managed-read-paths.test.ts:63`: “returns redacted 503 on authority failure”.
- `worker/test/managed-read-paths.test.ts:75`: “bounds a hung authority call at two seconds without reading or leaking errors”.
- `worker/test/managed-read-paths.test.ts:94`: “denies pending and unknown bindings synchronously and preserves the legacy direct read”.
- `worker/test/managed-read-paths.test.ts:109`: “uses decide for linked reads and denies removed members foreign actors stale generations and write attenuation”.
- `worker/test/managed-read-paths.test.ts:175`: “catalog pagination performs filtering and bounded keyset SQL reads”.
- `worker/test/managed-route-inventory.test.ts:76`: “denies actor-free %s before accessing a subsystem”.
- `worker/test/managed-route-inventory.test.ts:82`: “keeps streams mutations MCP unknown HTTP routes and malformed private targets closed in the read facade”.
- `worker/test/managed-route-inventory.test.ts:90`: “enumerates every actual router family with explicit managed admission or default denial”.
- `worker/test/managed-route-inventory.test.ts:191`: “leaves unopened families denied on linked pending and unknown bindings”.
- `worker/test/managed-route-inventory.test.ts:230`: “preserves synchronous unlinked dispatch for unopened content families”.
- `worker/test/managed-route-inventory.test.ts:248`: “actual managed HTTP routes cannot bypass decide after Workspace membership removal”.
- `worker/test/managed-private.test.ts:6`: “requires target-owner action-specific consent for transcripts and screens”.
- `worker/test/managed-private.test.ts:59`: “never accepts caller-supplied ownership and cannot turn a screen read into typing”.
- `worker/test/managed-private.test.ts:83`: “scopes consent replay to owner target recipient action and body”.
- `worker/test/managed-claims.test.ts:27`: “concurrent eligible claims have one winner and holder retry is a no-op”.
- `worker/test/managed-claims.test.ts:41`: “sync completion precedes fresh permit acquisition and local state is reread”.
- `worker/test/managed-claims.test.ts:62`: “revocation during sync denies claim without a local write”.
- `worker/test/managed-claims.test.ts:73`: “rejects a permit at commit without changing task state”.
- `worker/test/managed-claims.test.ts:87`: “revoke during PR creation records external outcome and denies review commit”.
- `worker/test/managed-claims.test.ts:116`: “sync beyond two seconds precedes fresh permit acquisition”.
- `worker/test/managed-budgets.test.ts:8`: “persists execution burst ten and refills thirty per minute”.
- `worker/test/managed-budgets.test.ts:20`: “shares Channel burst fifty across executions and never partially debits on denial”.
- `worker/test/managed-budgets.test.ts:37`: “does not mint tokens when the clock moves backwards”.
- `worker/test/managed-budgets.test.ts:40`: “returns 429 and Retry-After before appending an Update”.
- `worker/test/managed-lifecycle.test.ts:7`: “allows only the recorded execution owner and never drains private queues”.
- `worker/test/managed-lifecycle.test.ts:44`: “recognizes native sessions synchronously without authenticating a forged payload”.
- `worker/test/managed-retention.test.ts:9`: “refuses a managed Update before append when outcome capacity is exhausted”.
- `worker/test/managed-retention.test.ts:35`: “prunes expired outcomes and refuses capacity without losing pending evidence”.
- `worker/test/managed-retention.test.ts:52`: “bounds permits retains consumed replay fences and prunes expired receipts”.
- `worker/test/managed-content.test.ts:8`: “admits exact shared content reads without admitting publishers or malformed targets”.
- `worker/test/managed-content.test.ts:16`: “keeps artifact HTML sandboxed and enforces owner deletion inside a permit”.
- `worker/test/managed-content.test.ts:62`: “checks current membership for shared content lists and direct lookups”.

### Commands run and actual results

This hardening continuation used `PATH=/home/box/.local/node22/bin:$PATH`:

- Worker `npm run typecheck`: run twice after changes, both exit 0 (production plus new tests).
- Worker `npm run lint`: run twice after changes, both exit 0; 180 files checked, no fixes.
- Restricted `npx biome check --write` on changed Channel/inventory/read-test files: exit 0; formatting only.
- Read-only `git diff --check`: exit 0. Read-only `git diff --name-only -- worker/test`: exit 0, empty output (no tracked test changes).
- Vitest **not run in this continuation**: binding supervisor instruction says sandbox EROFS prevents execution and the manager runs all tests. Earlier S2 attempts of `npx vitest run test/managed-read-paths.test.ts test/managed-route-inventory.test.ts test/policy.test.ts` and the read/inventory/private/claims/budgets/lifecycle selection failed at config startup with EROFS writing `worker/node_modules/.vite-temp`; no test bodies ran. No runtime pass is claimed, including existing P2 lifecycle tests.
- CLI checks/full suites/e2e: not run; CLI untouched and full runtime gate belongs to the manager. No installs, network requests, git writes, configuration/timeout changes or credential-file reads.

### Deviations, escalations and known limits

- Re-slice is binding: the previously incomplete S2 families are now explicitly deferred to S2b; this is no longer a completion blocker for S2a. D1/D2 supersede the earlier conflict with existing lifecycle tests; no existing test was edited.
- `stale-claims.ts` supplies takeover's real write hook; `policy-permits.ts` implements D4; `policy.ts` supplies owner-scoped identity metadata; ADR 0057 documents D1. New lifecycle/content/retention suites extend the original ownership table within coordinator-authorized scope.
- No new unresolved design conflict was found. Conservative denial remains for all unopened paths, cross-owner continuation even with consent, and implicit self-revoke. P1R-1/P1R-2 remain deferred. P2R-2 stays manager-only.
- Local records are bounded, but durable authority export/reconciliation is not implemented. Capacity exhaustion may deny mutations until expiry. Updates retain at-least-once retry behavior (a retry may append another Event); Claims retain existing no-op retries. Correlated PR intent/outcome records do not guarantee exactly-once external PR creation.
- Managed sockets are still closed, so private wrapper reads are not operationally demonstrated. Stream leases, pending read/Directive cancellation and delivery-time rechecks require S3. Enforcement covers Switchboard paths only; it cannot constrain direct GitHub/unrelated tools or recall received content. Runtime correctness, full legacy timing compatibility and live-agent/security certification remain unverified here.
