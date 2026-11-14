# Package 2 implementation plan

## 1. Scope and storage

Binding sources: `m1/SPEC.md:19-72`, `:84-94`, `:113-129`; accepted ADR `docs/adr/0056-agent-principals-are-separate-from-executions.md:3-23`; redemption resolution `m1/G0_RESOLUTION.md:17`. Historical pending-review prose does not supersede Gate 0 confirmation (`m1/p1/P1_PLAN.md:7`). This document proposes work; it claims no implementation or test execution.

Approved proposal §4: “AgentPrincipal is stable within one Organization” (`m1/M1_ARCHITECTURE_PROPOSAL.md:56`); §5: “Rotation atomically invalidates prior generation, with no overlap” (`:66`); §14: “P2 extends it; P3 completes enforcement before enabling managed use” (`:219`). PR2 owns principals, executions, lifecycle and minimal CLI linkage; no adapter changes (`:224`). Preserve Channel terminology and existing session IDs, AgentId construction, Host ownership and Lead restrictions (`:58-60`).

P2 delivers explicit sponsorship, grants, separately attributable executions, scoped credential verification and lifecycle APIs. P3 retains Channel route enforcement/inventory, permits, stream revalidation/termination, projections, and opening linked Channels. P4 retains Dashboard redemption-code UI and management screens. Exercise redemption now through authenticated API calls and Worker/CLI tests: a Person starts an execution in redemption mode, receives a code once, then the same authenticated CLI Person exchanges it. Direct issuance returns a credential once to the initiating CLI. No UI is required. Acceptance step 3 and credential failures in step 6 are P2; open-connection delivery bounds remain P3 (`m1/SPEC.md:115-119`). No generic Tasks, external adapters, central LLM orchestrator, sync/Relay/claims/worktree changes, deployment or enterprise claims (`:122-129`). Permissions cannot constrain direct GitHub/external-tool use (`:31`).

**Storage decision:** reuse Organization SQLite DO, with separate identity/grant/execution/digest/redemption tables and existing audit/replay infrastructure. This follows proposal §2 (`m1/M1_ARCHITECTURE_PROPOSAL.md:26`) and co-locates current memberships, policy, credential generation and mutation audit in one transaction. Current aggregate/tables and transaction boundary are `worker/src/organization.ts:21-27`, `:56-71`, `:204-214`; audit/replay/cleanup are `:137-192`, `:260-274`. No new DO, binding or migration tag: existing bindings suffice (`worker/wrangler.jsonc:20-30`, `worker/worker-configuration.d.ts:23-25`). IdentityDirectory remains identity/routing hints only (`worker/src/identity-directory.ts:6-13`); do not add credential routing there. Server-generated principal/execution IDs encode org routing; credential routing fields remain untrusted until authoritative row/binding verification.

Organization stores only secret/code SHA-256 digests and metadata; no plaintext in aggregate, replay, audit or outbox. Channel stores at most server-verified association IDs, never execution credentials, credential digests or codes. Shared credential metadata excludes secrets and digest internals. One-time response secrets are ephemeral return values, excluded from replay results.

## 2. Exactly three dependent implementation slices

Each slice targets **≤30 minutes**, including focused verification, with frequent saved partial work. These are ambitious estimates, not permission to omit security checks. If time expires, record incomplete work and continue within the same slice under manager coordination; do not label it complete or create a fourth slice.

### S1 — Domain, storage and policy (30 minutes)

Extend `shared/src/m1.ts:2-112` with AgentPrincipal (organization/person sponsor, descriptors, active/disabled/revoked), AgentExecution (one Workspace, owner Person, optional legacy references, CLI, timestamps/status/generation), AgentGrant (actions/constraints/grantor/expiry/revision), execution actor, metadata and typed commands/results. Existing barrel already exports m1 (`shared/src/index.ts:19`); leave it unchanged.

Create `worker/src/principals.ts` and `worker/src/executions.ts` as Organization-owned helpers, not DOs. Add minimal schema initialization and RPC methods to Organization. Each mutation rechecks current authority, parents, expected revision/generation and replay fingerprint; writes state, revision, redacted AuditRecord and metadata-only replay atomically. Denials are audited with bounded fields. Crypto preparation may precede transactionSync; re-read all mutable authority inside it. No awaits inside synchronous transactions. Extend audit actor/target types to preserve principal/execution attribution without bodies (`worker/src/organization.ts:137-180`; proposal `m1/M1_ARCHITECTURE_PROPOSAL.md:169-175`). Clean replay/code tombstones in bounded batches; retain hashed redemption tombstones 24 hours.

Mint `m1.<org-id>.<credential-id>.<base64url-secret>` using 32 bytes from crypto.getRandomValues. Hash SHA-256; compare fixed 32-byte digests with fixed-length timing-safe byte comparison, never strings. Strictly parse canonical secret encoding/length. Use server milliseconds: default 1 hour, maximum 24 hours, grant-expiry cap; reject invalid lifetimes and already-expired grants. Generation starts explicitly and increments atomically on rotate. Reuse encoding/hash primitives only where appropriate (`worker/src/session.ts:26-43`); do not change legacy session/token semantics.

Extend deny-first `policy.ts` (`worker/src/policy.ts:30-78`) for agent.register/view/grant.manage/execution.start/execution.revoke and explicit action ceilings. Effective delegation = org ceiling ∩ Workspace policy ∩ grant ∩ sponsor's **current** delegable authority, plus execution constraints. Grantor cannot delegate more than its own scope, including Bob (SPEC step 5). Organization sponsorship uses an explicit owner/admin-controlled ceiling; Person sponsorship requires current active org/workspace membership. Lifecycle requires current sponsor/approved administrative authority; start additionally requires explicit delegable start authority, not merely admin role. No self-grants, body actor substitution, or capability-based authority. Admin roles never imply private-session access (`m1/M1_ARCHITECTURE_PROPOSAL.md:72-86`). Add domain/policy tests below.

### S2 — API and credential lifecycle (30 minutes; depends S1)

Create execution-api.ts, dispatched only for P2 paths through existing `/api/m1` routing (`worker/src/index.ts:396`; `worker/src/workspace-api.ts:63-75`). Implement proposal rows (`m1/M1_ARCHITECTURE_PROPOSAL.md:188-194`): GET/POST organizations/:o/agents; PATCH organizations/:o/agents/:a; GET/PUT/DELETE workspaces/:w/grants/:a; POST workspaces/:w/executions; POST executions/:e/redemption; POST executions/:e/rotate; DELETE executions/:e. Prefix all with `/api/m1`.

Follow P1 no-store/error/requestId/body limits, scoped pagination, Idempotency-Key and If-Match conventions (`worker/src/workspace-api.ts:9-97`): include PUT in write replay protection; PATCH/DELETE require revision; rotate requires expectedGeneration. Same key/different body →409; same issuance key returns metadata only, never secret/code. Lost response requires fresh-key rotation. Audit lifecycle and protected denials, not raw bodies. Foreign IDs disclose no resource metadata/revision. Native browser writes require explicit same-origin Origin; bearer uses authenticated native Person (`worker/src/auth.ts:123-141`).

Add isolated managed bearer verification in auth.ts: `m1.` becomes actor E only after Organization verification of digest, exact org/credential/execution/principal/workspace binding, current generation, active execution/principal, server expiry, valid grant and current sponsor authority. Recheck at every managed use, fail closed on unavailable authority. All lifecycle/grant/sponsor writes require H; legacy session/agent/Host/connector tokens never become H/E. Permit E only scoped principal view where explicitly granted. No mutation trusts caller-supplied owner/sponsor impersonation.

Code creation is an explicit mode of execution start; no hidden UI endpoint. Store Person-bound code hash with 60-second expiry. Atomically consume and mint once. Wrong Person/mismatch/unknown →400 CODE_INVALID; authenticated matching expired →410 CODE_EXPIRED; consumed →409 CODE_USED, including retry. Never replay secret; retain tombstones 24 hours (`m1/G0_RESOLUTION.md:17`). Add API cases below.

### S3 — Registration linkage, CLI and compatibility (30 minutes; depends S2)

Registration/heartbeat dispatch currently calls Channel directly (`worker/src/agents-api.ts:267-280`); registerAgent creates existing session identity and legacy token (`worker/src/channel.ts:1052-1095`). Add optional principal/workspace intent with a fresh native Person-authorized execution association, server-derived owner/legacy identity, and additive response metadata. Validate intent before side effects; reject legacy-token exchange. Keep the association authoritative in Organization. No credential crosses into Channel storage. End/Gone ends the execution; resume creates a fresh execution with the same principal/session reference (proposal `m1/M1_ARCHITECTURE_PROPOSAL.md:66`). Registration without intent and legacy heartbeat take the unchanged branch with no extra awaits/RPCs.

Create principal-config.ts for nonsecret approved principal/workspace selection and authenticated redemption exchange. Minimal channel-client/run/main wiring: accept codes via non-echo interactive input, authenticate with fresh native Person session, bound expired-code retries, keep execution secret in memory, redact errors, use Authorization headers for managed HTTP and stdio tools. Existing register switches credentials (`cli/src/channel-client.ts:230-235`; `cli/src/run.ts:309-311`). Never send m1 credentials through the existing query-token stream (`cli/src/channel-client.ts:294-296`); deny managed streaming until P3, with no legacy fallback. CLI tests use mocked HTTP/socket transports; linked live Channels remain closed, so no claim of usable managed Channel workflows yet.

**Source-driven adjustment:** requested cli/src/index.ts does not exist; build entry is main.ts (`cli/package.json:14`, `cli/src/main.ts:221-260`). Use that file. Shared registration/response declarations require additive changes in shared/src/agents.ts (`:195`, `:260`). Update ADR 0056 only for actual refinements in existing ADR style; add four glossary terms beside native concepts (`CONTEXT.md:11-30`). Preserve P1 Worker post-dispatch fence and DO checks, generation tags and untagged generation-0 semantics (`worker/src/index.ts:373-381`, `worker/src/channel.ts:2096-2175`; explanation `m1/p1/P1_IMPLEMENTATION_NOTES.md:488-490`).

## 3. File ownership

Codex owns files sequentially; C=create, M=modify. No existing tests/helpers are edited.

| Slice | Files |
|---|---|
| S1 | C worker/src/principals.ts, worker/src/executions.ts, worker/test/scoped-executions.test.ts; M shared/src/m1.ts, worker/src/organization.ts, worker/src/policy.ts |
| S2 | C worker/src/execution-api.ts, worker/test/execution-api.test.ts; M worker/src/auth.ts, worker/src/index.ts, worker/src/workspace-api.ts, worker/src/organization.ts, worker/src/executions.ts, shared/src/m1.ts |
| S3 | C cli/src/principal-config.ts, cli/test/managed-executions.test.ts, worker/test/managed-registration.test.ts; M worker/src/agents-api.ts, worker/src/channel.ts, worker/src/organization.ts, shared/src/agents.ts, cli/src/channel-client.ts, cli/src/run.ts, cli/src/main.ts, CONTEXT.md; conditional M docs/adr/0056-agent-principals-are-separate-from-executions.md |

Every slice fills m1/p2/P2_IMPLEMENTATION_NOTES.md with exact changed file:line evidence, actual commands/results, deviations and escalations. session.ts, identity-directory.ts, shared barrel, wrangler.jsonc and generated Env remain unchanged under this storage choice. No dependencies/config/timeouts change.

## 4. Test matrix and evidence

All titles below are planned `it(` titles. D=worker/test/scoped-executions.test.ts; A=worker/test/execution-api.test.ts; R=worker/test/managed-registration.test.ts; C=cli/test/managed-executions.test.ts. Use actual DO boundaries with native helpers (`worker/test/m1-helpers.ts:9-18`), existing fake-service setup (`worker/test/setup.ts:1-12`) and CLI controlled-response patterns (`cli/test/agent-link.test.ts:30-45`); create new fixtures locally in new test files.

| SPEC / threat | File → exact title |
|---|---|
| §P2, invariant 4, step 3 | D → `attributes two distinct executions and credentials to one stable principal` |
| Invariants 5/9, impersonation | A → `rejects unauthorized sponsor and body owner impersonation` |
| Expiry | D → `uses server time with one hour default and exact expiry denial` |
| Lifetime limits | D → `caps execution lifetime at 24 hours and grant expiry` |
| Rotation | D → `atomically rotates once and immediately rejects the old generation` |
| Revocation, step 6 credential part | D → `denies on execution revoke principal disable sponsor removal demotion and grant revoke` |
| Lifecycle isolation | A → `denies execution actors every lifecycle and grant mutation including self grant` |
| Invariant 6, step 5 | D → `rejects grants beyond grantor authority including Bob delegating what Bob lacks` |
| Org isolation | A → `denies foreign organization credentials without resource metadata` |
| Untrusted routing | A → `rejects tampered org and credential routing fields` |
| Parsing | D → `rejects wrong length malformed and garbage secrets` |
| G0-7 | A → `returns invalid for wrong Person or unknown code expired 410 and used 409` |
| One use | A → `serializes concurrent redemption and retains hashed tombstones for 24 hours` |
| Invariant 10 | A → `never replays secrets or codes on idempotent retry and rejects changed bodies` |
| Audit/confidentiality | A → `excludes planted secret markers from audit events logs replay and Channel storage` |
| Legacy cannot upgrade | A → `denies legacy session agent Host and connector tokens on m1 lifecycle routes` |
| Descriptors only | D → `never derives authority from declared capabilities or admin private access` |
| API conventions | A → `enforces no store origin revision generation pagination and foreign ID denial` |
| Compatibility | R → `preserves legacy registration heartbeat session IDs AgentId and Host behavior` |
| Explicit linkage | R → `links only human authorized intent and rejects legacy token exchange` |
| Execution termination | R → `ends managed execution on Gone and resumes with a fresh execution` |
| CLI exchange | C → `redeems as the bound Person retries expired codes within a fixed bound and keeps secrets out of URLs and output` |
| Transport/compatibility | C → `uses scoped bearer HTTP denies managed streaming and preserves legacy registration and streaming` |

Planted-marker assertions inspect Organization SQL/replay/audit, Channel SQL/KV, emitted responses/events and captured logs; permit only the initiating one-time response. Add fault/rollback and concurrent rotate checks to D. Full route/stream/private-content acceptance remains P3/P4, not established by these tests (proposal `m1/M1_ARCHITECTURE_PROPOSAL.md:230-245`).

Planned commands: export PATH=/home/box/.local/node22/bin:$PATH; worker npm run typecheck / npm run lint / npx vitest run test/scoped-executions.test.ts test/execution-api.test.ts test/managed-registration.test.ts; cli equivalents with test/managed-executions.test.ts. Run only files present at each slice. Record workerd/listen EPERM as blocked, never passed. Manager runs unchanged full suites; terminal/e2e flakes are not waived or edited. **This documentation task: tests not run.**

## 5. Risks, assumptions and escalations

No new legacy-path awaits, constructor migration work, socket checks or MCP admission RPCs. Compare before/after branch behavior and preserve all P1 fences. P1R-1..4 remain deferred (`m1/p1/reviews/P1_REVIEW.md:7-38`), especially broadcast-tag hardening before P3 opens Channels.

Code issuance mode and administrative start authority must remain narrowly explicit; absent authority/unsupported constraints deny. Organization sponsorship is not an imaginary Person. Verification must re-read authority after crypto awaits to avoid rotation/revocation races. Bounded code cleanup must preserve error tombstones without storing plaintext. CLI native authentication may require fresh login; legacy login cannot silently upgrade (`m1/M1_ARCHITECTURE_PROPOSAL.md:48-50`).

Escalate any contradiction about sponsor authority, code issuance, lifecycle ownership or managed registration before enabling access; implement deny and record file:line under Escalations. No new trust-boundary exception is authorized here. Thirty-minute bounds and linked-Channel closure limit demonstrable integration; report partial work honestly. No push, commit, merge, main changes, network access, credential-file reads or deployment.
