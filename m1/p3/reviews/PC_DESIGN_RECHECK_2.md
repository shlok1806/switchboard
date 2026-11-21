VERDICT: GO

### Summary of Verdict
The revised permit-before-effects and Host-bound consent redesign in [P3_PERMIT_CONSENT_REDESIGN.md](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md) and [ADR_DRAFT_PERMIT_CONSENT.md](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/ADR_DRAFT_PERMIT_CONSENT.md) faithfully incorporates Pranay Karpuram's binding rulings R1–R9 (Fri Nov 20 2026) and R10–R15 (Sat Nov 21 2026 8:13 AM CT, Prepared Durable Intent). 

All previous review findings ([Round 0 PC-1..PC-6](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/PREVIOUS_REVIEW.md#L33-L58), [Round 1 PC-1..PC-3](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/PREVIOUS_REVIEW.md#L110-L160)), the three cross-review defects ([CODEX_CROSS_REVIEW_1.md:10-14](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/CODEX_CROSS_REVIEW_1.md#L10-L14)), and the PCFIX durable-staging blocker ([PCFIX_NOTES.md:30-45](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/PCFIX_NOTES.md#L30-L45)) are fully **RESOLVED**.

Key architectural verifications:
1. **Prepared Durable Intent (R10, R11, R12)**: TXN-1 validates and consumes both permits (`agent.execution.start` and `agent.handoff.cross_owner`) and commits strictly an immutable intent row (`registration_intents`) with receipt bookkeeping in one synchronous `transactionSync`. Crucially, TXN-1 touches **no** shared state (no Person join, Agent roster, presence, Claim, Relay delivery, Directive, Task, Event, usage, `hosts.spawned`, in-memory waiter, broadcast, or audit). TXN-2 re-checks authority after confirmed Organization activation and runs the existing registration algorithm against live state. Staged shadow rows and notification journaling are rejected.
2. **Live State Wins (R13)**: TXN-1 takes no queue or Task snapshot. TXN-2 reads live state at apply time, cleanly draining current lost Claims, Relay deliveries, and Directives without resurrecting deleted rows or double-draining.
3. **Fail-Closed Lifecycle & State Machine (R14, PC-4)**: Pre-apply failures (activation rejection/timeout, fresh-check denial, TTL expiry, cancellation) leave zero shared registration effects. Consumed permits are never refunded. Crash recovery uses explicit fences and idempotency proofs.
4. **Trusted Host Enrollment Provenance (R3, R4, R11)**: Minimal, bounded `host_enrollments` records in Organization DO are written exclusively upon the completion of a verified-handoff registration in TXN-2. Neither advisory `agent.host` nor direct SQL bypass can enroll a Host.
5. **Central Decision Boundary & Host Authority (R2, R5, DD-1)**: Approval denial is opened under `decide()` in both Channel and Organization DOs. Host owners act directly on their own agents; cross-owner callers require unexpired, unrevoked `terminal_control` consent from the enrolled Host owner issued through `decide()`. Screen/read/history consent never authorizes keystrokes, terminal input, or approvals.

---

### Owner Ruling Compliance Matrix (Pranay Karpuram, R1–R15)

| Ruling | Status | Citation & Verification |
| :--- | :---: | :--- |
| **R1**: Reject deferral; `managed-agent-controls.test.ts:278` stays 200; no assertions loosened/deleted. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:10, :85](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L10); preserves HTTP 200 and response assertions; fixtures gain verified enrollment. |
| **R2**: Open approval deny NOW; Host owner acts directly; cross-owners require Host-bound `terminal_control` consent through `decide()`; DD-1 unchanged. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:63-65, :69-71](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L63-L65); `decide()` evaluates membership + Host owner; read/screen consent never authorizes control; admin cannot bypass. |
| **R3**: Add minimal Organization `host_enrollments` record; bind `hostId` into permit/decide `resourceKey`. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:61, :69](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L61); bounded `(orgId, workspaceId, hostId)` PK; `resourceKey` serializes `hostId ?? null`. |
| **R4**: Enrollment proof written ONLY inside verified owner-handoff registration transaction; unenrolled Host fails closed. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:38, :61](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L38); Organization writes enrollment only on verified completion of permit-backed handoff registration. Advisory `agent.host` cannot enroll. |
| **R5**: `agent.host` used ONLY as lookup hint matching trusted enrollment row; mismatch fails closed. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:69](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L69); Organization independently resolves active enrollment matching org, workspace, host, and owner; mismatch denies. |
| **R6**: CLI daemon machine-local recheck stays at B3b/B4 boundary. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:71, :81](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L71); Channel/Org authorization opens now; machine-local daemon ceiling remains at B3b/B4. |
| **R7**: Explicit activation failure / post-commit reconciliation state machine (PC-4). | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:46-57](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L46-L57); states (`absent`, `prepared`, `activated`, `cancelling`, `applied`, `completed`, terminal failures), cancellation fencing, bounded TTL ≤ 30s. |
| **R8**: Keep accepted architecture: synchronous local commit, DD-1, status-code contract, REBUILD_BASE 87b8813. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:14, :65, :75, :79](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L14); `transactionSync` for commits; 87b8813 confirmed. |
| **R9**: Replace XFIX1 hardcoded denials ([organization.ts:903, :1120](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L903)) with real authorization; do not special-case tests. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:8, :10, :79](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L8); diagnoses root cause in lines 903 & 1120 and replaces them with real enrollment and consent checks. |
| **R10**: TXN-1 consumes BOTH permits and commits ONLY immutable intent; NO shared-state effects. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:14, :22-26, :34](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L14); single `transactionSync` consumes START + HAND and inserts intent; zero writes to Person, Agent, roster, presence, queues, Claims, Relay, Directives, Tasks, Events, spawns, waiters, or broadcasts. |
| **R11**: After activation, re-check authority via `decide()` and run existing registration in TXN-2; write `host_enrollments` in TXN-2 completion only. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:36-38](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L36-L38); fresh `decide()` check issues short apply permit; TXN-2 verifies original consumption by this intent, consumes apply permit, runs existing registration; completion RPC writes enrollment. |
| **R12**: REJECT durable staged write set (no shadow/versioned rows, no notification journal). | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:14, :37](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L14); shadow rows and notification journal explicitly rejected; post-commit callbacks held in request-local list only. |
| **R13**: State explicitly which queue/Task state wins between intent and registration (live state wins). | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:43](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L43); TXN-1 stores no snapshot; TXN-2 reads live queue/Task state at apply time; interim changes stay changed; newly queued items are eligible under existing rules. |
| **R14**: FAIL CLOSED on activation failure/timeout/denial, re-check denial, expiry, cancel, crash; no shared effects; permits not refunded. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:46-57](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L46-L57); pre-apply terminal states leave zero shared registration effects; ambiguous activation cancels/ends; permits never refunded. |
| **R15**: Everything else from GO'd design and R1–R9 stays (retains 200/true assertions, REBUILD_BASE 87b8813, 0bfb31f byte-identical). | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:10, :79, :85](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L10); confirmed across all files. |

---

### Disposition of Previous Findings

#### Round 0 Findings
- **Original PC-1 (Test assertion weakening)**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:10, :85](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L10) preserves [managed-agent-controls.test.ts:278](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L278) expecting HTTP 200.
- **Original PC-2 (B3b CLI enforcement dependency)**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:69-71](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L69-L71) opens Channel/Org authorization immediately; daemon ceiling remains at B3b/B4.
- **Original PC-3 (Minimal Organization Host enrollment schema)**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:61](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L61) specifies `host_enrollments` schema, primary key, bounded capacity, and deactivation lifecycle.
- **Original PC-4 (Activation failure state machine)**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:46-57](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L46-L57) details explicit states, transitions, timeout, cancellation fencing, and failure visibility.
- **Original PC-5 (`resourceKey` serialization)**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:69](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L69) mandates appending `resource.hostId ?? null` to `resourceKey` in [policy-permits.ts:33-43](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy-permits.ts#L33-L43).
- **Original PC-6 (Route descriptor & consent check hostId resolution)**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:69](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L69) binds target Host into outer `input.resource` before `prepare()` and `decide()`.

#### Round 1 Findings
- **RECHECK-1 PC-1 (Outer input binding before `prepare()`)**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:69](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L69) specifies populating the descriptor's outer `input` with `targetExecutionId`, target owner, and Host ID before `prepare()` because `prepare()` closes over outer `input`.
- **RECHECK-1 PC-2 (Bounded capacity and lifecycle for `host_enrollments`)**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:61](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L61) specifies `MANAGED_RECORD_CAP`, 503 capacity refusal, and invalidation on execution end/revoke and unlink/rebind ([organization.ts:525-527, :701-720](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L525-L527)).
- **RECHECK-1 PC-3 (Test fixtures for Host enrollment)**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:10, :85, :95](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L10) and [PCDESIGN_RESOLUTION.md:18](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/PCDESIGN_RESOLUTION.md#L18) correctly reject direct SQL enrollment seeding (which would violate R4) and specify running real verified owner-handoff registration completion in test fixtures.

#### Codex Cross-Review 1 Findings
- **Finding 1 (Registration mutates state before permit consumption)**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:14, :34](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L14) consumes both permits in TXN-1 before any shared mutation, followed by fresh authorization in TXN-2.
- **Finding 2 (Control consent issued without verified Host ownership or `decide()`)**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:63-65](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L63-L65) routes consent issuance through `decide()` and validates issuer equals enrolled Host owner.
- **Finding 3 (Cross-owner approval route lacks hostId)**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:69](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L69) resolves target Host, binds it into permit resource and `resourceKey`, and checks consent matching.

#### PCFIX Durable-Staging Blocker
- **Staging registration's shared mutations**: **RESOLVED**. [P3_PERMIT_CONSENT_REDESIGN.md:14-18, :43](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L14-L18) faithfully implements R10–R15: TXN-1 performs zero shared mutations; TXN-2 evaluates live state. Shadow rows and notification journals are cleanly eliminated.

---

### Detailed Verification Against Review Checklist (1–9)

#### 1. PERMIT BEFORE EFFECTS
- **Dual Permit Consumption in TXN-1**: Both START and verified-owner HAND permits are installed, validated, and consumed in a single `transactionSync` alongside the insertion of the immutable intent row ([P3_PERMIT_CONSENT_REDESIGN.md:34](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L34)).
- **Verification of Zero Shared-State Effects in TXN-1**:
  - `withNextTurn` ([channel.ts:3147, :3315-3319](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L3147)): Not called in TXN-1. Draining lost Claims, Relay deliveries, and Directives occurs strictly in TXN-2.
  - `staleClaims.presenceChanged` ([channel.ts:657](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L657)): Not triggered in TXN-1 because presence is not updated.
  - `hosts.spawned` ([channel.ts:3157](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L3157), [hosts.ts:553-567](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/hosts.ts#L553-L567)): Not called in TXN-1. In-memory waiters and spawn sends are held until post-commit of TXN-2.
  - `host.broadcast` ([agents.ts:374](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/agents.ts#L374)): Not sent in TXN-1.
  - `Relay.eventAppended` ([channel.ts:4807](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L4807)): No events appended in TXN-1.
- **Reread & Fences**: Rereads binding, generation, revision floor, and existing predicates after the last `await` immediately before `transactionSync`. Bounded 503 on authority failure/timeout.
- **Unlinked Path**: Retains synchronous in-memory bypass before any `await` or managed schema initialization ([P3_PERMIT_CONSENT_REDESIGN.md:32](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L32)).

#### 2. HOST-BOUND CONSENT
- `terminal_control` issuance routes through `decide()` as the single decision point ([P3_PERMIT_CONSENT_REDESIGN.md:63](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L63)).
- Issuer must be verified as the active Organization and Workspace member and the enrolled Host owner in `host_enrollments`.
- Caller-supplied `hostId` or login is never trusted for ownership.
- Revocation advances revision and cancels permits; capacity capped by `MANAGED_RECORD_CAP`.
- Machine-local ceiling remains enforced by the CLI daemon at B3b/B4. No parallel authorization bypass.

#### 3. CROSS-OWNER APPROVAL hostId
- Target Host resolved from trusted state (lookup hint verified against `host_enrollments`).
- Outer `input.resource` populates `hostId`, `ownerPersonId`, `targetExecutionId` before `prepare()` and `decide()`.
- `resourceKey` serializes `hostId`.
- Rechecked with generation/revision immediately before `interruptTo` dispatch.

#### 4. DD-1 COMPLIANCE
- Keystrokes, terminal input, and approval control strictly require `terminal_control` consent.
- Screen-view, history, and read consents can never authorize control effects ([P3_PERMIT_CONSENT_REDESIGN.md:65, :71](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L65)).
- Workspace grants and Org/Workspace admins cannot bypass Host owner consent.

#### 5. FAIL-CLOSED & STATUS CODES
- 404 for unlinked/foreign non-disclosure.
- 403 for authenticated insufficient role/scope.
- 400 for malformed/missing `Idempotency-Key` (no random UUID fallback).
- 409 for conflict/self-continuation.
- Bounded 503 for timeout/capacity exhaustion.
- Zero positive authorization caching.

#### 6. ROOT CAUSE OF 2 FAILING TESTS & D5 INTEGRITY
- Root cause confirmed: XFIX1 hardcoded temporary denials at [organization.ts:903, :1120](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L903) returning `deny("host_authority_unavailable")`.
- Assertions in [managed-agent-controls.test.ts:278](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L278) (200) and [managed-consent-control.test.ts:374](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-consent-control.test.ts#L374) (true) are strictly preserved without weakening.
- Baseline test suite at `0bfb31f` verified 100% byte-identical (`git diff --diff-filter=M 0bfb31f HEAD -- worker/test/` returned empty).

#### 7. REBUILD BASE CHOICE
- `87b8813` is confirmed and justified: retains fail-closed XFIX1 guards, preserves the inactive-member test ([managed-consent-membership.test.ts:6](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-consent-membership.test.ts#L6)), and avoids unnecessary history rewrites.

#### 8. TEST PLAN & SIZING
- Comprehensive test matrix covering positive admission, non-member, foreign workspace, revoked/expired execution, wrong generation, role/scope denial, authority timeout 503, START/HAND independent races, snapshot diffs before/after TXN-1 (asserting strict equality of shared state), concurrent intents, live queue/Task verification during TXN-2, and rollback.
- Sizing is realistic for one Codex run: ~550–800 LOC production code + ~450–650 LOC tests across 5 files (`channel.ts`, `agents.ts`, `organization.ts`, `policy.ts`, `policy-permits.ts`).
- Channel is not renamed; no new DO/service bindings; no credentials in Channel storage.

#### 9. OWNER DECISION
- No owner decision needed. R1–R15 fully govern the implementation.

---

### Numbered Findings (REQUIRED-IN-PCFIX Implementation Additions)

#### PC-1: Ensure outer input binding in `#managedWrite` for control operations
- **Severity**: P2 (Should-fix) (REQUIRED-IN-PCFIX)
- **File:line**: [worker/src/channel.ts:1691-1706, :2266-2287](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L1691-L1706); [worker/src/managed-channel.ts:176-177](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/managed-channel.ts#L176-L177)
- **Problem**: In `#managedWrite`, `prepare()` closes over outer `input`. If outer `input.resource.hostId`, `ownerPersonId`, and `targetExecutionId` are not populated before calling `prepare()`, `org.issueMutationPermit` will issue a permit without `hostId`, causing `resourceKey` mismatch on consumption or rejection in Organization DO.
- **Evidence**:
  ```ts
  // channel.ts:2275-2287
  if (!owned) {
    const consentCheck = await enforcement.check({ ...input, ... }); // preliminary check with copied input
  }
  const prepared = await prepare(); // invokes org.issueMutationPermit with outer input lacking hostId!
  ```
- **Exact correction**: In `#managedWrite` and route handling for control operations (`/approval/deny`), resolve target agent and managed association, and rebind outer `input` prior to calling `prepare()`:
  ```ts
  input = {
    ...input,
    targetExecutionId: assoc.executionId,
    resource: {
      ...input.resource,
      targetId: agentId,
      ownerPersonId: targetOwner,
      hostId: targetHost ?? undefined,
    },
  };
  ```

#### PC-2: Strict dual-receipt enforcement and intent-correlation preservation in `consumeSet`
- **Severity**: P2 (Should-fix) (REQUIRED-IN-PCFIX)
- **File:line**: [worker/src/policy-permits.ts:89-130](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy-permits.ts#L89-L130); [P3_PERMIT_CONSENT_REDESIGN.md:95](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L95)
- **Problem**: The draft `consumeSet` primitive in `PCFIX_WIP.patch` allowed 1 to 2 receipts (`entries.length < 1 || entries.length > 2`). For managed registration, both the START permit and verified-owner HAND permit must be required. Furthermore, because receipts have a ≤ 2-second lifetime while activation may take longer (up to the 30s intent TTL), receipt records marked `used` must preserve correlation to `intentId` so that TXN-2 can verify they were consumed by *this* intent.
- **Evidence**: [P3_PERMIT_CONSENT_REDESIGN.md:95](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L95): *"Strengthen the set helper to require exactly BOTH registration receipts; validate bindings independently, persist consumed-by-intent correlation and preserve it beyond receipt expiry for TXN-2 proof."*
- **Exact correction**: In `consumeSet`, enforce `entries.length === 2` for registration, require matching common scopes (revision, generation, deadline, actor), record `consumedByIntentId: intentId` in the `managed_permits` row, and ensure TXN-2 recheck validates `consumedByIntentId === intent.intentId`.

#### PC-3: Request-local buffering of callbacks and `lastSeq` rollback in TXN-2
- **Severity**: P2 (Should-fix) (REQUIRED-IN-PCFIX)
- **File:line**: [worker/src/channel.ts:3140-3165, :4805-4807](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L3140-L3165); [worker/src/agents.ts:252, :374](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/agents.ts#L252)
- **Problem**: Registration invokes asynchronous and external side effects: `this.host.broadcast`, `this.watch()`, `this.hosts.spawned`, and `this.relay.eventAppended`. If executed inside `transactionSync`, or if an exception occurs mid-registration, external notifications and resolved waiters cannot be rolled back by SQLite. In addition, appending events increments in-memory `this.lastSeq`.
- **Evidence**: [P3_PERMIT_CONSENT_REDESIGN.md:37](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L37): *"SQL effects and synchronous presence/claim recovery remain synchronous INSIDE TXN-2; external sends, Relay scheduling, watch scheduling, host.spawned send and waiter resolution execute only after successful commit... The wrapper must cover nested append/Host callbacks, including lastSeq rollback."*
- **Exact correction**:
  1. Capture all post-commit notifications (`broadcast`, `watch`, `spawned` sends/waiters, Relay triggers) in a request-local list during TXN-2.
  2. Snapshot `this.lastSeq` before TXN-2.
  3. Execute buffered callbacks only after `transactionSync` completes. On exception or rollback, restore `this.lastSeq` and drop the callback list.

#### PC-4: Lazy schema initialization for `registration_intents`
- **Severity**: P3 (Cosmetic / Robustness) (REQUIRED-IN-PCFIX)
- **File:line**: [worker/src/channel.ts:490-520, :2750-2790](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L490-L520); [BATCH_RULES.txt:7](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/BATCH_RULES.txt#L7)
- **Problem**: Batch Rule 5 requires: *"no managed schema init in the constructor/legacy hot paths"*. Creating `registration_intents` in Channel DO constructor would violate unlinked baseline isolation.
- **Evidence**: [BATCH_RULES.txt:7](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/BATCH_RULES.txt#L7): *"every new check is a synchronous in-memory skip on the loaded binding BEFORE any extra await, JSON parse, storage read or RPC; no managed schema init in the constructor/legacy hot paths."*
- **Exact correction**: Lazily initialize the `registration_intents` table inside the managed registration path only (e.g., inside `#ensureManagedRegistrationSchema()`) after checking that the workspace is linked.

---

### Verified OK
- [x] Pre-existing tests at `0bfb31f` remain 100% byte-identical (`git diff --diff-filter=M 0bfb31f HEAD -- worker/test/` returned clean).
- [x] Channel is not renamed; no new Durable Object or service bindings introduced.
- [x] No credentials, credential digests, or secrets stored in Channel DO storage, events, or audit.
- [x] Single central policy decision boundary `decide()` in [worker/src/policy.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy.ts) retained; no parallel authorization bypasses.
- [x] Unlinked Channel behavior retains synchronous in-memory bypass before any `await`.
- [x] Rebuild base `87b8813` confirmed.
- [x] Both gate tests retain positive success assertions (HTTP 200 and true) without assertion weakening.
- [x] R1–R15 owner rulings fully satisfied without reopening design decisions.