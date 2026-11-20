VERDICT: GO

### Summary of Verdict
The revised permit-before-effects and Host-bound consent redesign in [P3_PERMIT_CONSENT_REDESIGN.md](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md) and [ADR_DRAFT_PERMIT_CONSENT.md](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/ADR_DRAFT_PERMIT_CONSENT.md) faithfully incorporates Pranay Karpuram's binding ruling of Fri Nov 20 2026 (R1–R9, Option 1). All six findings from Round 0 ([PC-1 through PC-6](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/PREVIOUS_REVIEW.md#L13-L97)) are fully **RESOLVED**.

Key architectural verifications:
1. **Assertion Integrity (R1, PC-1)**: Rejects test weakening; [managed-agent-controls.test.ts:278](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L278) strictly retains its expected HTTP `200` and response shape assertions.
2. **Central Decision Boundary (R2, PC-2)**: Approval denial is opened in Channel DO and Organization DO under `decide()`. The Host owner directly controls their own agent without delegated consent; cross-owners require auditable `terminal_control` consent from the Host owner. CLI machine-local enforcement remains at the B3b/B4 daemon boundary.
3. **Trusted Host Enrollment & Proof (R3, R4, PC-3)**: Adds minimal, bounded `host_enrollments` to Organization DO, written exclusively by the activation of verified owner-handoff registrations. Legacy or advisory `agent.host` alone never confers authority.
4. **Post-Commit Activation State Machine (R7, PC-4)**: Explicitly specifies states (`pending`, `active`, `reconciling`, `failed`), durable outbox retries (bounded exponential backoff ≤ 30s), authoritative cancellation, and terminal cleanup with no orphaned side effects.
5. **Exact Resource & Permit Binding (R3, R5, PC-5, PC-6)**: `hostId` is appended to `resourceKey` serialization in [policy-permits.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy-permits.ts#L33-L43) and bound into the approval route descriptor, consent check, and permit requests.

The redesign is structurally sound, minimal, and ready for implementation. Three minor implementation details are captured below as `REQUIRED-IN-PCFIX` additions for the implementation prompt.

---

### Owner Ruling Compliance Matrix (Pranay Karpuram, Fri Nov 20 2026)

| Ruling Item | Status | Verification & Evidence |
| :--- | :---: | :--- |
| **R1**: Reject deferral; `managed-agent-controls.test.ts:278` stays expecting 200; no assertions loosened/deleted (PC-1). | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:10, :50](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L10); retains 200 and response assertions; fixtures gain verified enrollment. |
| **R2**: Open approval deny NOW (PC-2); Host owner acts directly; cross-owner requires Host-bound `terminal_control` consent issued ONLY through `decide()`; DD-1 unchanged. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:28, :30, :34, :36](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L28); `decide()` evaluates active membership + Host owner; read/screen consent never authorizes control; admin cannot bypass. |
| **R3**: Add minimal Organization `host_enrollments` record (PC-3) and bind `hostId` into permit/decide `resourceKey` (PC-5); bounded; no credentials; Channel not renamed. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:26, :34](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L26); `(orgId, workspaceId, hostId)` PK, bounded identity policy; `resourceKey` includes `hostId ?? null`. |
| **R4**: Enrollment proof written ONLY inside verified owner-handoff registration transaction; un-enrolled Host fails closed. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:19, :26](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L19); activation requires unforgeable single-use reservation correlated to both permits; advisory `agent.host` cannot enroll. |
| **R5**: `agent.host` used ONLY as lookup hint matching trusted enrollment row; mismatch fails closed (PC-6). | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:34](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L34); Organization independently resolves active enrollment and execution binding; missing or mismatched row denies. |
| **R6**: CLI daemon machine-local recheck stays at B3b/B4 boundary (not in PCFIX). | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:36, :46](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L36); PCFIX opens Channel/Organization authorization now; machine-local limits rechecked at B3b/B4. |
| **R7**: Explicit activation failure / post-commit reconciliation state machine (PC-4). | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:20](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L20); `pending` → `active` / `reconciling` / `failed`; 30s deadline; cancellation fencing; no orphaned side effects. |
| **R8**: Keep accepted architecture: single synchronous local commit, DD-1, status-code contract, REBUILD_BASE 87b8813. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:14-18, :30, :40, :44](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L14); single `transactionSync` for permits + writes; 87b8813 confirmed. |
| **R9**: Replace XFIX1 hardcoded denials ([organization.ts:903, :1120](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L903)) with real authorization; do not special-case tests. | **COMPLIANT** | [P3_PERMIT_CONSENT_REDESIGN.md:8, :10, :44](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L8); diagnoses root cause in lines 903 & 1120 and replaces them with real enrollment and consent checks. |

---

### Disposition of Previous Review Findings (Round 0 Recheck)

#### PC-1: Proposing to weaken positive test assertion from 200 to 404 for owner approval denial
- **Status**: **RESOLVED**
- **Evidence**: [P3_PERMIT_CONSENT_REDESIGN.md:10, :50](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L10) rejects the 200 → 404 proposal and explicitly retains `:278 200 → 200`. In [PCDESIGN_RESOLUTION.md:3](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/PCDESIGN_RESOLUTION.md#L3), Codex confirms that owner approval remains HTTP 200 and all response assertions remain intact.

#### PC-2: False dependency on B3b machine-local CLI enforcement to open Channel DO approval routes
- **Status**: **RESOLVED**
- **Evidence**: [P3_PERMIT_CONSENT_REDESIGN.md:34-36](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L34-L36) opens Channel DO and Organization DO approval denial immediately in PCFIX. The CLI supervisor checks remain at the B3b/B4 daemon boundary. [ADR_DRAFT_PERMIT_CONSENT.md:13](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/ADR_DRAFT_PERMIT_CONSENT.md#L13) reflects this split.

#### PC-3: Minimal Organization DO Host enrollment schema must be specified for PCFIX
- **Status**: **RESOLVED**
- **Evidence**: [P3_PERMIT_CONSENT_REDESIGN.md:26](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L26) defines the Organization `host_enrollments` table schema with primary key `(organizationId, workspaceId, hostId)`, `ownerPersonId`, enrolling registration/execution references, `createdAt`, and `revokedAt`, written only by verified handoff registration activation.

#### PC-4: Under-specified terminal reconciliation for post-commit activation failure
- **Status**: **RESOLVED**
- **Evidence**: [P3_PERMIT_CONSENT_REDESIGN.md:20](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L20) defines the full state machine (`pending` → `active` / `reconciling` / `failed`), bounded exponential retry up to 30s, authoritative cancellation with Organization fencing, and synchronous cleanup marking the association inactive and agent gone.

#### PC-5: `resourceKey` serialization must bind `hostId`
- **Status**: **RESOLVED**
- **Evidence**: [P3_PERMIT_CONSENT_REDESIGN.md:34](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L34) and [ADR_DRAFT_PERMIT_CONSENT.md:13](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/ADR_DRAFT_PERMIT_CONSENT.md#L13) mandate appending `resource.hostId ?? null` to `resourceKey` in [policy-permits.ts:33-43](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy-permits.ts#L33-L43).

#### PC-6: Route descriptor and consent check for `/approval/deny` must resolve target `hostId`
- **Status**: **RESOLVED**
- **Evidence**: [P3_PERMIT_CONSENT_REDESIGN.md:34](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L34) mandates resolving target execution, target owner, and Host ID before `decide()` and permit acquisition, treating `agent.host` as an advisory hint verified against Organization `host_enrollments`.

---

### Verification Against Criteria Checks (1–9)

1. **PERMIT BEFORE EFFECTS**:
   - Section 1 specifies Option (a): complete authentication, validation, and Organization `prepare/reserve` before any local mutation.
   - After the final `await`, mutable state (generation, binding, association, predecessor, resume ticket) is re-read.
   - In ONE `transactionSync`, both START and HAND receipts are verified and consumed before Person join, Agent registration, roster/presence, queue/handoff, or SQL events. Any failure throws and rolls back SQLite.
   - Outbox record stages effects as non-authorizing and invisible (`pending`) until confirmed activation.
   - Unlinked path takes its synchronous in-memory bypass before any `await`.

2. **HOST-BOUND CONSENT**:
   - `terminal_control` issuance routes through `decide()` as the single decision point ([P3_PERMIT_CONSENT_REDESIGN.md:28](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L28)).
   - Issuer is verified as the active Organization and Workspace member and the verified Host owner from `host_enrollments`.
   - No parallel authorization shortcuts; ad-hoc checks are forbidden.

3. **CROSS-OWNER APPROVAL hostId**:
   - Resolved from trusted association state (hint) and validated against Organization `host_enrollments`.
   - Bound into `PolicyResource.hostId`, `resourceKey`, and the permit.
   - Rechecked immediately before `interruptTo` dispatch.

4. **DD-1 COMPLIANCE**:
   - Keystrokes, terminal input, and approval control map strictly to `terminal_control` consent.
   - Read, screen-view, and history consent can never satisfy `terminal_control`.
   - Workspace admins have no bypass to control another Person's Host.

5. **FAIL-CLOSED & STATUS CODES**:
   - Uniform 404 for unlinked/foreign non-disclosure; 403 for authenticated insufficient role/scope.
   - 400 for malformed/missing `Idempotency-Key` (retaining 0bfb31f contract; no UUID fallback).
   - 409 for conflict/self-continuation; bounded 503 on authority timeout.
   - Zero positive authorization caching.

6. **ROOT CAUSE OF FAILING TESTS & D5 INTEGRITY**:
   - Root cause confirmed: XFIX1 hardcoded denials at [organization.ts:903, :1120](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L903).
   - Test suite at `0bfb31f` is 100% byte-identical (`git diff --diff-filter=M 0bfb31f HEAD -- worker/test/` is clean).
   - No assertions loosened or flipped to denial.

7. **REBUILD BASE CHOICE**:
   - `87b8813` is justified: retains XFIX1 safety guards while replacing temporary denials, preserves the inactive-member test ([managed-consent-membership.test.ts:6](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-consent-membership.test.ts#L6)), and avoids unnecessary git history rewrites.

8. **TEST PLAN & SIZING**:
   - Comprehensive matrix: positive admission, non-member, foreign org/ws, revoked/expired execution, wrong generation, role/scope denial, authority timeout 503, START/HAND race matrix, snapshot diffs before/after.
   - Sizing is realistic for one Codex run: ~300–500 LOC production code + ~250–400 LOC tests across 5 files (`channel.ts`, `agents.ts`, `organization.ts`, `policy.ts`, `policy-permits.ts`).

9. **OWNER DECISION**:
   - None required. Owner ruling Fri Nov 20 2026 (R1–R9) resolved the former escalation and selected Option 1. The design aligns with it in full.

---

### Numbered Findings (Round 1)

#### PC-1: Channel `#managedWrite` and route handling must populate `input.resource.hostId` and `targetExecutionId` before calling `prepare()`
- **Severity**: P2 (Should-fix) (REQUIRED-IN-PCFIX)
- **File:line**: [worker/src/channel.ts:1691-1706, :2266-2287](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L1691-L1706); [worker/src/managed-channel.ts:176-177](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/managed-channel.ts#L176-L177)
- **Problem**: In [channel.ts:1094-1102](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L1094-L1102), `#managedWrite` constructs the outer `input.resource` with only `targetId: route.targetId` and `operation: route.operation`. When `/api/agents/:id/approval/deny` runs, `prepare()` calls `enforcement.prepare(input, ...)` using the outer `input`. If `input.resource.hostId`, `ownerPersonId`, and `targetExecutionId` are not populated on `input` before `prepare()`, `org.issueMutationPermit` will issue a permit without `hostId`. This causes `resourceKey` mismatch upon `permits.consume()`, or denies inside Organization DO.
- **Evidence**:
  ```ts
  // channel.ts:2275-2287
  if (!owned) {
    const consentCheck = await enforcement.check({ ...input, ... }); // sets resource.targetId but not hostId
  }
  const prepared = await prepare(); // calls org.issueMutationPermit with outer input.resource lacking hostId!
  ```
- **Exact correction**: In [channel.ts:2266-2287](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L2266-L2287) (and in `#managedWrite` entry for control operations), look up the target agent via `this.agents.find(agentId)` and `this.managedAssociation(agentId)`. Extract `targetHost = agent.host ?? agent.history_host` and `targetOwner = target.ownerPersonId`. Rebind `input` before calling `prepare()`:
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

#### PC-2: Bounded capacity and deactivation lifecycle for `host_enrollments` in Organization DO
- **Severity**: P2 (Should-fix) (REQUIRED-IN-PCFIX)
- **File:line**: [worker/src/organization.ts:880-940, :1115-1175](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L880-L940); [P3_PERMIT_CONSENT_REDESIGN.md:26](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_PERMIT_CONSENT_REDESIGN.md#L26)
- **Problem**: The redesign specifies `createdAt` and `revokedAt` for `host_enrollments`, but does not specify row capacity caps (`MANAGED_RECORD_CAP`) or enrollment invalidation triggers when an execution ends or is revoked.
- **Evidence**: [BATCH_RULES.txt:8](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/BATCH_RULES.txt#L8) Rule 6 mandates bounded storage (`MANAGED_RECORD_CAP`) for managed tables, and Section 2 states: *"revoke it on unlink/rebind or ownership invalidation"*.
- **Exact correction**: In [organization.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts):
  1. Enforce row capacity check on `host_enrollments` before writing: `if (count >= MANAGED_RECORD_CAP) return deny("capacity_exhausted", 503);`.
  2. In `execution.end`, `execution.revoke`, and workspace unlink/rebind, set `revokedAt = Date.now()` on matching `host_enrollments` rows.
  3. In `decide()` and `issueMutationPermit()`, filter queries to `revokedAt IS NULL`.

#### PC-3: Test fixtures in `managed-agent-controls.test.ts` and `managed-consent-control.test.ts` must seed verified Host enrollments
- **Severity**: P3 (Cosmetic / Test fixture) (REQUIRED-IN-PCFIX)
- **File:line**: [worker/test/managed-agent-controls.test.ts:221-283](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L221-L283); [worker/test/managed-consent-control.test.ts:355-385](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-consent-control.test.ts#L355-L385); [worker/test/managed-query-cases.ts:24-105](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-query-cases.ts#L24-L105)
- **Problem**: `queryExecutionFixture()` (used by `managed-agent-controls.test.ts`) and `managedAuthorityFixture()` (used by `managed-consent-control.test.ts`) currently create executions and channels with arbitrary or un-enrolled host strings. Under R4, control operations fail closed without a matching `host_enrollments` row.
- **Evidence**: In [managed-consent-control.test.ts:357](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-consent-control.test.ts#L357), `hostId = "test-host-1"` is an arbitrary string not present in `host_enrollments`. In [managed-agent-controls.test.ts:222](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L222), `queryExecutionFixture` registers the agent directly via internal helper rather than owner handoff.
- **Exact correction**: In both tests (or helper fixtures), insert the corresponding `host_enrollments` row:
  ```ts
  await runInDurableObject(f.org, (_object, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO host_enrollments VALUES(?,?,?,?,?,?,NULL)",
      f.organizationId, f.workspaceId, hostId, f.actor.personId, "reg-fixture", f.executionId, Date.now()
    );
  });
  ```
  Ensure [managed-agent-controls.test.ts:278](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L278) continues to assert `expect(ownerDeny.status).toBe(200)` and [managed-consent-control.test.ts:374](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-consent-control.test.ts#L374) asserts `expect(created.ok).toBe(true)`.

---

### Verified OK
- [x] Pre-existing tests at `0bfb31f` remain 100% byte-identical (`git diff --diff-filter=M 0bfb31f HEAD -- worker/test/` returned empty).
- [x] Channel is not renamed; no new Durable Object or service bindings introduced.
- [x] No credentials, credential digests, or secrets stored in Channel DO storage, events, or audit.
- [x] Single central policy decision boundary `decide()` in [worker/src/policy.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy.ts) retained; no parallel authorization bypasses.
- [x] Unlinked Channel behavior retains synchronous in-memory bypass before any `await`.
- [x] Rebuild base `87b8813` confirmed.
- [x] Both failing gate tests retain positive success assertions (HTTP 200 and true) without assertion weakening.