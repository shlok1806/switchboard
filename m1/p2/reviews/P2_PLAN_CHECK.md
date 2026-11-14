VERDICT: GO

---

### Executive Summary

The Package 2 implementation plan (`P2_PLAN.md`) has been checked independently against the binding contract (`SPEC.md` Package 2, Invariants 1–12), the accepted architecture design (`M1_ARCHITECTURE_PROPOSAL.md` §§4, 5, 6, 11, 12, 14, 15), `ADR_0056.md`, the Package 1 implementation history and regression lessons (`P1_LOG.md`), and the current code at `/home/box/engineering-workspace/worktrees/switchboard-m1-p2/` on branch `bot/m1-p2-agent-identity`.

The plan is well-conceived, faithful to the approved Gate 0 architecture, respects legacy paths and P1 generation fences, avoids scope creep into Packages 3 and 4, and specifies an exhaustive, adversarial test suite.

---

### Comprehensive Plan Check & Requirement Verification

#### 1. Package 2 Core Requirements and Design Adherence
- **Principal ≠ Execution**: The plan strictly separates durable `AgentPrincipal` (scoped to an Organization, sponsored explicitly, capabilities as descriptors only) from transient `AgentExecution` (scoped to one Workspace, attributable execution ID, unique credential generation, bound to a specific owner Person and session/CLI reference) in [shared/src/m1.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/shared/src/m1.ts). Tested in `scoped-executions.test.ts` (`attributes two distinct executions and credentials to one stable principal`).
- **Per-execution Credential & Cryptography**: 256-bit (32-byte) random secret formatted as opaque `m1.<org-id>.<credential-id>.<base64url-secret>`. Stored exclusively as SHA-256 digest in the Organization SQLite DO without pepper. Verification uses fixed-length, timing-safe 32-byte comparison. Default lifetime is 1 hour, absolute maximum 24 hours, and strictly capped by grant expiry. Tested in `scoped-executions.test.ts` (`uses server time with one hour default and exact expiry denial`, `caps execution lifetime at 24 hours and grant expiry`, `rejects wrong length malformed and garbage secrets`).
- **Redemption Code Flow**: One-use 60-second Person-bound redemption code hash stored in Organization DO. Strict error taxonomy implemented: authenticated expired code returns 410 `CODE_EXPIRED`, invalid/mismatched/unknown code returns 400 `CODE_INVALID`, already consumed code returns 409 `CODE_USED`. Consumed and expired hashed tombstones are retained for 24 hours. Tested in `execution-api.test.ts` (`returns invalid for wrong Person or unknown code expired 410 and used 409`, `serializes concurrent redemption and retains hashed tombstones for 24 hours`).
- **Use-time Authorization & Revocation**: Rotation, revocation, expiration, principal disablement, sponsor removal/demotion, and grant revocation are checked authoritatively at use time on every managed request, failing closed. Tested in `scoped-executions.test.ts` (`atomically rotates once and immediately rejects the old generation`, `denies on execution revoke principal disable sponsor removal demotion and grant revoke`).
- **Delegation Ceiling**: Enforces company policy as the ceiling: agent effective authority = org ceiling ∩ workspace policy ∩ agent grant ∩ sponsor's current delegable authority. Evaluated both at grant time and at use time. Tested in `scoped-executions.test.ts` (`rejects grants beyond grantor authority including Bob delegating what Bob lacks`).
- **Lifecycle & Identity Isolation**: Lifecycle mutations (register, grant, execution start/revoke) are restricted to authorized owners/admins/sponsors (`H` actor). Execution actors (`E`) cannot self-grant or perform lifecycle mutations. Legacy tokens cannot be exchanged or upgraded. Tested in `execution-api.test.ts` (`denies execution actors every lifecycle and grant mutation including self grant`, `denies legacy session agent Host and connector tokens on m1 lifecycle routes`).

#### 2. Trust Boundaries, Confidentiality & Anti-Leakage
- **Sponsor & Body Impersonation**: Server enforces authenticated caller identity (`H`); no caller-supplied sponsor or owner spoofing is trusted. Tested in `execution-api.test.ts` (`rejects unauthorized sponsor and body owner impersonation`).
- **Foreign-org Isolation & Untrusted Routing**: Credentials from other Organizations are rejected with uniform 404/403 without leaking foreign metadata or revision numbers. Routing fields in `m1.<org-id>.<credential-id>.<secret>` are untrusted until verified in the authoritative Organization DO. Tested in `execution-api.test.ts` (`denies foreign organization credentials without resource metadata`, `rejects tampered org and credential routing fields`).
- **Confidentiality / Secret Leakage Prevention**: Secrets and redemption codes are returned exactly once to the initiating client over `Cache-Control: no-store` responses. Never written to SQLite `aggregate`, `replay`, `audit`, outbox, Events, logs, or Channel DO storage. Planted marker test verifies zero plaintext leaks. Tested in `execution-api.test.ts` (`excludes planted secret markers from audit events logs replay and Channel storage`).
- **Idempotency & Replay**: Replay table stores only metadata; identical retry returns metadata only and never replays the secret. Different body with same key yields 409. Lost secret requires fresh-key rotation. Tested in `execution-api.test.ts` (`never replays secrets or codes on idempotent retry and rejects changed bodies`).

#### 3. Legacy Path Protection & P1 Generation Fence Preservation
- **Zero Extra RPCs / Awaits on Legacy Hot Path**: Protects against the CLI e2e timing regression documented in [P1_LOG.md](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P2-PC/P1_LOG.md). Legacy registration without intent and legacy heartbeats bypass new execution logic with zero new awaits/RPCs.
- **DO Constructor & WebSocket Preservation**: Channel DO constructor, stream upgrade, `webSocketMessage`, and MCP handlers add zero new synchronous or asynchronous DO calls for unlinked legacy channels. Untagged generation-0 socket semantics established in P1 FIX3 ([worker/src/channel.ts#L2144-L2157](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/channel.ts#L2144-L2157)) remain intact.
- **Generation Fence Maintained**: Worker post-dispatch fence ([worker/src/index.ts#L373-L381](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/index.ts#L373-L381)) and DO transition fences ([worker/src/channel.ts#L2096-L2101](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/channel.ts#L2096-L2101)) remain untouched.
- **No Identity Mutation**: User-visible session IDs, `AgentId` formatting, Host behavior, Lead subtree restrictions, and the four CLI adapters are preserved without modification.

#### 4. Scope Discipline
- **No Creep into P3**: Channel route-by-route authorization, permit infrastructure, WebSocket stream revalidation, event projections, and opening linked Channels remain strictly deferred to Package 3. Linked channels remain fail-closed.
- **No Creep into P4**: Dashboard UI components, admin views, and visual redemption screens remain deferred to Package 4.
- **Explicit Exclusions**: No generic tasks, no central LLM orchestrator, no external agent adapters, no production deploy, no changes to Git/Relay/claims algorithms.

#### 5. Test Matrix Adequacy
- The 23 planned test cases map 1:1 to every Package 2 requirement in `SPEC.md`, `ADR_0056.md`, and `M1_ARCHITECTURE_PROPOSAL.md`.
- Adversarial tests cover all high-risk paths: concurrent redemption races, replay attacks, tampered routing fields, malformed secret parsing, privilege escalation beyond sponsor scope, and foreign-org token probes.
- Tests are split cleanly across 4 targeted files:
  - `worker/test/scoped-executions.test.ts` (domain, storage, policy, lifecycle, crypto)
  - `worker/test/execution-api.test.ts` (API routes, auth, redemption, idempotency, audit)
  - `worker/test/managed-registration.test.ts` (Channel registration linkage, legacy compatibility, resume)
  - `cli/test/managed-executions.test.ts` (CLI client, redemption exchange, token usage)

#### 6. Slice Staging & Ownership
- **Slice S1 (Domain, Storage, Policy)**: Extends `shared/src/m1.ts`, creates `principals.ts` and `executions.ts`, updates `organization.ts` and `policy.ts`, creates `scoped-executions.test.ts`.
- **Slice S2 (API & Credential Lifecycle)**: Creates `execution-api.ts` and `execution-api.test.ts`, updates `auth.ts`, `index.ts`, `workspace-api.ts`, `organization.ts`, `executions.ts`, `m1.ts`.
- **Slice S3 (Registration Linkage, CLI, Compatibility)**: Creates `principal-config.ts`, `managed-executions.test.ts`, `managed-registration.test.ts`, updates `agents-api.ts`, `channel.ts`, `organization.ts`, `shared/src/agents.ts`, `channel-client.ts`, `run.ts`, `main.ts`, `CONTEXT.md`, and conditionally `ADR_0056.md`.
- Staging is strictly sequential with non-conflicting file sets. Correctly adjusted CLI build entrypoint from nonexistent `cli/src/index.ts` to `cli/src/main.ts`.

---

### File:Line Claim Verification

All file and line citations in `P2_PLAN.md` were verified against `/home/box/engineering-workspace/worktrees/switchboard-m1-p2/`:
- [worker/src/organization.ts#L21-L27](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/organization.ts#L21-L27) (`State` interface) — Verified OK.
- [worker/src/organization.ts#L56-L71](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/organization.ts#L56-L71) (`Organization` DO constructor & DDL) — Verified OK.
- [worker/src/organization.ts#L137-L192](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/organization.ts#L137-L192) (`audit()` & `cleanup()`) — Verified OK.
- [worker/src/organization.ts#L204-L214](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/organization.ts#L204-L214) (`mutate()` signature, digest, transactionSync) — Verified OK.
- [worker/src/organization.ts#L260-L274](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/organization.ts#L260-L274) (`replay` lookup, 409 conflict, expectedRevision) — Verified OK.
- [worker/wrangler.jsonc#L20-L30](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/wrangler.jsonc#L20-L30) (DO bindings & v2 migration tag) — Verified OK.
- [worker/worker-configuration.d.ts#L23-L25](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/worker-configuration.d.ts#L23-L25) (DO namespace types) — Verified OK.
- [worker/src/identity-directory.ts#L6-L13](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/identity-directory.ts#L6-L13) (`IdentityDirectory` schema) — Verified OK.
- [shared/src/m1.ts#L2-L112](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/shared/src/m1.ts#L2-L112) (P1 native domain model) — Verified OK.
- [shared/src/index.ts#L19](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/shared/src/index.ts#L19) (`export * from "./m1";`) — Verified OK.
- [worker/src/session.ts#L26-L43](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/session.ts#L26-L43) (`base64url` and `fromBase64url`) — Verified OK.
- [worker/src/policy.ts#L30-L78](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/policy.ts#L30-L78) (`decide()` deny-first skeleton) — Verified OK.
- [worker/src/index.ts#L396](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/index.ts#L396) (`/api/m1` routing entry) — Verified OK.
- [worker/src/workspace-api.ts#L9-L97](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/workspace-api.ts#L9-L97) (`handleWorkspaceApi` common handling) — Verified OK.
- [worker/src/auth.ts#L123-L141](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/auth.ts#L123-L141) (`readNativeActor` cookie/bearer handling) — Verified OK.
- [worker/src/agents-api.ts#L267-L280](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/agents-api.ts#L267-L280) (`register`, `heartbeat`, `end` dispatch) — Verified OK.
- [worker/src/channel.ts#L1052-L1095](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/channel.ts#L1052-L1095) (`registerAgent` legacy registration) — Verified OK.
- [cli/src/channel-client.ts#L230-L235](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/cli/src/channel-client.ts#L230-L235) (`register` token exchange) — Verified OK.
- [cli/src/run.ts#L309-L311](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/cli/src/run.ts#L309-L311) (CLI registration comment & client setup) — Verified OK.
- [cli/src/channel-client.ts#L294-L296](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/cli/src/channel-client.ts#L294-L296) (WebSocket URL query token) — Verified OK.
- [cli/package.json#L14](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/cli/package.json#L14) (`esbuild src/main.ts` entry) — Verified OK.
- [cli/src/main.ts#L221-L260](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/cli/src/main.ts#L221-L260) (`main()` CLI command dispatch) — Verified OK.
- [shared/src/agents.ts#L195](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/shared/src/agents.ts#L195) (`RegisterAgentRequest`) & [shared/src/agents.ts#L260](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/shared/src/agents.ts#L260) (`AgentResponse`) — Verified OK.
- [CONTEXT.md#L11-L30](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/CONTEXT.md#L11-L30) (M1 glossary definitions) — Verified OK.
- [worker/src/index.ts#L373-L381](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/index.ts#L373-L381) (P1 Worker post-dispatch fence) — Verified OK.
- [worker/src/channel.ts#L2096-L2175](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/channel.ts#L2096-L2175) (DO fetch fence, socket tagging, webSocketMessage fence) — Verified OK.
- [worker/test/m1-helpers.ts#L9-L18](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/test/m1-helpers.ts#L9-L18) (native test helpers) — Verified OK.
- [worker/test/setup.ts#L1-L12](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/test/setup.ts#L1-L12) (FakeJev setup) — Verified OK.
- [cli/test/agent-link.test.ts#L30-L45](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/cli/test/agent-link.test.ts#L30-L45) (`slowChannel` mock pattern) — Verified OK.

---

### Numbered Findings

#### P2P-1 (P3 advisory) — Custom error code mapping for redemption errors in `execution-api.ts`
- **Plan section / file:line**: `P2_PLAN.md:36-37`, `P2_PLAN.md:76`; [worker/src/workspace-api.ts#L16-L25](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/workspace-api.ts#L16-L25).
- **Problem**: `workspace-api.ts:error()` hardcodes `code: status === 404 || status === 403 ? "RESOURCE_DENIED" : "REQUEST_FAILED"`. Proposal §12 and `ADR_0056` explicitly require `CODE_EXPIRED` (410), `CODE_INVALID` (400), and `CODE_USED` (409) in the JSON error payload.
- **Exact correction**: In `worker/src/execution-api.ts`, ensure error responses for redemption explicitly emit the required error code string (`{ error: { code: "CODE_EXPIRED" | "CODE_INVALID" | "CODE_USED", reason }, policyRevision, requestId }`), rather than falling back to `"REQUEST_FAILED"`.

#### P2P-2 (P3 advisory) — Strict canonical unpadded base64url validation for 32-byte secret
- **Plan section / file:line**: `P2_PLAN.md:25`, `P2_PLAN.md:75`; [worker/src/session.ts#L26-L43](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/session.ts#L26-L43).
- **Problem**: A 256-bit (32-byte) secret encoded in unpadded base64url has exactly 43 characters (`Math.ceil(256 / 6) = 43`). Accepting padded base64url or arbitrary lengths could introduce parser ambiguity or trailing garbage malleability.
- **Exact correction**: In `worker/src/executions.ts`, validate that the secret component strictly matches `/^[A-Za-z0-9_-]{43}$/` before computing its SHA-256 digest, ensuring test `rejects wrong length malformed and garbage secrets` passes strictly.

#### P2P-3 (P3 advisory) — Explicitly strip secret from stored replay mutation results
- **Plan section / file:line**: `P2_PLAN.md:13-14`, `P2_PLAN.md:23`, `P2_PLAN.md:33`; [worker/src/organization.ts#L260-L271](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/organization.ts#L260-L271).
- **Problem**: `organization.ts` serializes `JSON.stringify(result)` into the `replay` table for idempotent request matching. If the returned object contains `secret`, an idempotent retry would read and replay the secret from storage, violating the display-once requirement.
- **Exact correction**: When serializing the `replay.result` row for `execution.start` or `execution.rotate`, store a sanitized object omitting `secret` (e.g., `{ ...metadata }`), while returning the secret solely in the synchronous return value of the initial call.

#### P2P-4 (P3 advisory) — Bounded batch cleanup for expired redemption tombstones
- **Plan section / file:line**: `P2_PLAN.md:24`; [worker/src/organization.ts#L182-L192](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/organization.ts#L182-L192).
- **Problem**: Consumed and expired redemption code tombstones are retained for 24 hours per ADR 0056, but should not accumulate indefinitely in the Organization SQLite DO.
- **Exact correction**: Add bounded batch cleanup in `Organization.cleanup()`: `DELETE FROM redemption_tombstones WHERE created_at < ? LIMIT 100` (where `?` is `Date.now() - 86_400_000`), matching the bounded cleanup pattern of `replay` and `audit`.

#### P2P-5 (P3 advisory) — Reaffirm untagged generation-0 socket convention in `channel.ts`
- **Plan section / file:line**: `P2_PLAN.md:41-45`, `P2_PLAN.md:94-96`; [worker/src/channel.ts#L2144-L2157](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p2/worker/src/channel.ts#L2144-L2157), [P1_LOG.md#L140-L149](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P2-PC/P1_LOG.md#L140-L149).
- **Problem**: The P1 regression was resolved in FIX3 by ensuring generation-0 sockets remain untagged. S3 edits to `channel.ts` must not inadvertently add tags or extra RPCs to unlinked registrations.
- **Exact correction**: Ensure that `channel.ts:registerAgent` handles optional registration intent without introducing any asynchronous RPCs or DO storage writes when `intent` is absent, and verify that socket tagging for unlinked Channels remains strictly untagged.

---

### Verified OK

- Contract compliance: SPEC M1 Package 2 and Invariants 1–12 fully addressed.
- Approved architecture alignment: `M1_ARCHITECTURE_PROPOSAL.md` §§4, 5, 6, 11, 12, 14, 15 satisfied.
- Identity separation: `AgentPrincipal` is decoupled from `AgentExecution` and legacy tokens cannot be upgraded.
- Cryptographic security: 32-byte secret, SHA-256 digest only, timing-safe compare, 1 h default / 24 h max / grant-expiry cap.
- Redemption lifecycle: One-use 60 s Person-bound code, exact 410/400/409 error taxonomy, 24 h tombstones.
- Use-time policy: Rotation, revocation, expiration, demotion, and ceiling checks occur at invocation.
- Legacy path safety: 0 new awaits/RPCs on legacy hot paths, P1 generation fences intact, untagged gen-0 preserved.
- Scope bounds: P3 (channel enforcement/streams) and P4 (UI) deferred cleanly; no scope creep.
- Test plan: 23 comprehensive positive and adversarial test blocks covering all SPEC scenarios.
- File:line citations: 100% verified against current worktree source.