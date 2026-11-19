VERDICT: BLOCKER

### Summary of Verdict
The redesign in [P3_PERMIT_CONSENT_REDESIGN.md](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/P3_PERMIT_CONSENT_REDESIGN.md) and [ADR_DRAFT_PERMIT_CONSENT.md](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/ADR_DRAFT_PERMIT_CONSENT.md) is sound in its core local-commit transaction proposal (Section 1), but is **structurally wrong** in its resolution of Host-bound consent and approval controls (Sections 2, 3, 5, 6), and explicitly halts on an escalated Owner Decision:
1. **Structural Flaw & Assertion Weakening**: Codex proposes changing an existing Package-3-added test ([managed-agent-controls.test.ts:278](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L273-L282)) from `200` to `404`, converting an authorized owner approval-deny positive test into a denial test, and keeping H24 approval control permanently fail-closed until B3b. This violates [BATCH_RULES.txt](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/BATCH_RULES.txt) Rule 3 ("Never delete or loosen an assertion...") and [DIRECTIVE.txt](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/DIRECTIVE.txt) ("Finish ALL remaining Package 3 route groups within Milestone 1. Do not leave them permanently blocked or move them to M2 just to get a merge").
2. **Conflation of Channel DO Authorization with CLI Daemon Enforcement**: Codex misdiagnosed Finding 3 of [CODEX_CROSS_REVIEW_1.md](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/CODEX_CROSS_REVIEW_1.md) (which was simply that the route descriptor and permit serialized resource omitted `hostId`). An execution owner denying their own agent's approval does not require cross-owner consent under DD-1. Channel DO authorization and permit issuance can be fully completed in PCFIX; CLI daemon enforcement remains at the B3b daemon boundary.
3. **Owner Decision Escalation**: Codex explicitly marked the design incomplete and halted in [PCDESIGN_DONE.md](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/PCDESIGN_DONE.md) and Section 6: *"Approve the B3b enrollment and machine-local enforcement dependency and post-commit activation reconciliation before rebuilding."* By definition, an Owner Decision is required to rule on this escalation.

---

### Numbered Findings

#### PC-1: Proposing to weaken positive test assertion from 200 to 404 for owner approval denial
- **Severity**: P1 (Must-fix / Structurally wrong)
- **File:line**: [P3_PERMIT_CONSENT_REDESIGN.md:10, :45, :50](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/P3_PERMIT_CONSENT_REDESIGN.md#L10); [managed-agent-controls.test.ts:273-282](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L273-L282)
- **Problem**: Codex proposes changing `worker/test/managed-agent-controls.test.ts:278` from asserting HTTP `200` to asserting HTTP `404`. This weakens the test suite, eliminates the positive test for approval denial, and leaves H24 approval control fail-closed.
- **Evidence**: In [P3_PERMIT_CONSENT_REDESIGN.md:45](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/P3_PERMIT_CONSENT_REDESIGN.md#L45):
  > `worker/test/managed-agent-controls.test.ts:273–278 owner 200 → 404 while local enforcement absent`
  
  [BATCH_RULES.txt](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/BATCH_RULES.txt) Rule 3 strictly commands: *"Never delete or loosen an assertion, raise a timeout or change test/tool config to pass."*
  In [managed-agent-controls.test.ts:273-282](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L273-L282), the caller is Alice (`isPerson = true`), who is the verified owner of the target execution (`target.ownerPersonId === actor.personId`). Alice is denying approval for her own agent. DD-1 ([OWNER_DESIGN_DECISIONS.txt:4](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/OWNER_DESIGN_DECISIONS.txt#L4)) governs delegated cross-owner control of another person's machine; it does not forbid an owner from denying approval for their own agent. The route returned 404 only because XFIX1 introduced an unconditional blanket block: `if (isControlEffect) return deny("host_authority_unavailable");` in [organization.ts:1120](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L1120).
- **Exact correction**: Reject the assertion change from 200 to 404. In [organization.ts:1115-1135](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L1115-L1135), permit `isControlEffect` when the caller is the verified owner of the target execution (`target.ownerPersonId === actor.personId`), or when the caller holds an unexpired, unrevoked `terminal_control` consent matching the target's bound Host. The test must continue to assert HTTP 200 and verify `{ ok: true, agent: { approval: expect.objectContaining({ id: "app-1", deniedBy: "alice" }) } }`.

#### PC-2: False dependency on B3b machine-local CLI enforcement to open Channel DO approval routes
- **Severity**: P1 (Must-fix / Structurally wrong)
- **File:line**: [P3_PERMIT_CONSENT_REDESIGN.md:31-32, :41, :49-51](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/P3_PERMIT_CONSENT_REDESIGN.md#L31-L51); [P3_BATCH_PLAN.md:129, :152](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_BATCH_PLAN.md#L129)
- **Problem**: Codex claims that approval control cannot be permitted in B2b/PCFIX because Channel DO's `interruptTo` callback does not prove machine-local enforcement on the CLI host, and uses this to justify deferring H24 approval control to B3b.
- **Evidence**: [P3_BATCH_PLAN.md:129](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_BATCH_PLAN.md#L129) explicitly placed H24 write/control operations in B2b. Channel DO's responsibility is policy enforcement, permit validation, and internal state mutation ([channel.ts:2289](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L2289)). In integration tests, `interruptTo` is stubbed via `runInDurableObject` ([managed-agent-controls.test.ts:244](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L244)) because Worker vitest suites do not run multi-process host daemons. B3b ([P3_BATCH_PLAN.md:152](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_BATCH_PLAN.md#L152)) owns the CLI supervisor limits ([supervisor.ts:170-190](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/cli/src/host/supervisor.ts#L170-L190); [check.ts:72](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/cli/src/host/check.ts#L72)). Refusing to open Channel DO authorization in B2b because CLI daemon transport is B3b/B4 violates [DIRECTIVE.txt](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/DIRECTIVE.txt).
- **Exact correction**: Authorize approval denial in Channel DO and Organization DO under the central policy boundary (`decide()` + exact mutation permit). Channel DO checks the permit, commits the state change, and dispatches `interruptTo`. The CLI host daemon will recheck its machine-local limits when the frame is delivered (B3b/B4 boundary).

#### PC-3: Minimal Organization DO Host enrollment schema must be specified for PCFIX
- **Severity**: P1 (Must-fix) (REQUIRED-IN-PCFIX)
- **File:line**: [P3_PERMIT_CONSENT_REDESIGN.md:25-27](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/P3_PERMIT_CONSENT_REDESIGN.md#L25-L27); [organization.ts:883-940](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L883-L940)
- **Problem**: Section 2 states: *"If the existing managed Host enrollment/proof is unavailable, creation and use of Host-bound authority deny until B3b supplies it"*. If Organization DO denies `terminal_control` consent until B3b, then Test 1 ([managed-consent-control.test.ts:355](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-consent-control.test.ts#L355)) cannot pass in PCFIX.
- **Evidence**: [managed-consent-control.test.ts:374](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-consent-control.test.ts#L374) asserts `expect(created.ok).toBe(true)` when creating a `terminal_control` consent. In Section 5 line 45, Codex plans for `:374 true → true` by updating the fixture to enroll a Host. Therefore, Organization DO must have the enrollment table and verification logic implemented in PCFIX.
- **Exact correction**: Specify the exact minimal Organization DO schema for PCFIX:
  ```sql
  CREATE TABLE IF NOT EXISTS host_enrollments (
    organizationId TEXT NOT NULL,
    workspaceId TEXT NOT NULL,
    hostId TEXT NOT NULL,
    ownerPersonId TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (organizationId, workspaceId, hostId)
  );
  ```
  In [organization.ts:883-903](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L883-L903), when `action === "terminal_control"`:
  1. Verify the issuer is an active Organization and Workspace member via `decide(input.actor, "workspace.read", resource, context)`.
  2. Verify `hostId` exists in `host_enrollments` for `(state.organization.id, input.workspaceId)` with `status === "active"`.
  3. Verify `host_enrollments.ownerPersonId === input.actor.personId` (the issuer is the verified Host owner).
  4. Verify target execution is enrolled and bound to that Host.
  5. Remove the blanket `return deny("host_authority_unavailable")`.

#### PC-4: Under-specified terminal reconciliation for post-commit activation failure
- **Severity**: P2 (Should-fix) (REQUIRED-IN-PCFIX)
- **File:line**: [P3_PERMIT_CONSENT_REDESIGN.md:19-20, :47](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/P3_PERMIT_CONSENT_REDESIGN.md#L19-L20); [channel.ts:2841-2960](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L2841-L2960)
- **Problem**: In Section 1 step 4, the redesign specifies that if the post-commit `activate` call to Organization DO fails, registration returns an error (e.g., 503) and reconciles via durable outbox. It does not define what happens to the locally committed Agent if Organization activation fails permanently or times out.
- **Evidence**: If the local commit successfully joined the Person and registered the Agent, but the activation RPC fails permanently, the Channel DO SQLite database retains an un-activated Agent with presence `live`.
- **Exact correction**: Define the reconciliation state machine in the design:
  1. Channel returns bounded 503 on activation timeout/failure.
  2. The outbox retry worker retries activation with exponential backoff up to a bounded deadline (e.g., 30s).
  3. If activation permanently fails or times out, the Channel outbox processor synchronously transitions the Agent's local record to presence `"gone"`, marks the association inactive, emits an agent end event, and cleans up any pending handoff.
  4. An idempotent client retry with the same `Idempotency-Key` while activation is pending re-attaches to the outbox outcome.

#### PC-5: `resourceKey` serialization must bind `hostId`
- **Severity**: P2 (Should-fix) (REQUIRED-IN-PCFIX)
- **File:line**: [P3_PERMIT_CONSENT_REDESIGN.md:8, :31](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/P3_PERMIT_CONSENT_REDESIGN.md#L8); [policy-permits.ts:33-43](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy-permits.ts#L33-L43)
- **Problem**: [policy-permits.ts:33-43](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy-permits.ts#L33-L43) currently omits `hostId` from `resourceKey(resource)`. Even if `hostId` is passed in `PolicyResource`, permits do not bind to the specific Host.
- **Evidence**:
  ```ts
  export function resourceKey(resource: PolicyResource): string {
    return JSON.stringify([
      resource.kind, resource.organizationId, resource.id,
      resource.channel ?? null, resource.targetId ?? null,
      resource.ownerPersonId ?? null, resource.operation ?? null,
    ]);
  }
  ```
- **Exact correction**: Update `resourceKey` to serialize `resource.hostId ?? null`:
  ```ts
  export function resourceKey(resource: PolicyResource): string {
    return JSON.stringify([
      resource.kind, resource.organizationId, resource.id,
      resource.channel ?? null, resource.targetId ?? null,
      resource.ownerPersonId ?? null, resource.operation ?? null,
      resource.hostId ?? null,
    ]);
  }
  ```

#### PC-6: Route descriptor and consent check for `/approval/deny` must resolve target `hostId`
- **Severity**: P2 (Should-fix) (REQUIRED-IN-PCFIX)
- **File:line**: [P3_PERMIT_CONSENT_REDESIGN.md:8, :31](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/P3_PERMIT_CONSENT_REDESIGN.md#L8); [managed-channel.ts:176-177](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/managed-channel.ts#L176-L177); [channel.ts:2275-2285](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L2275-L2285)
- **Problem**: Finding 3 of CODEX_CROSS_REVIEW_1 noted that cross-owner approval deny cannot match consent because `resource.hostId` is missing.
- **Evidence**: [channel.ts:2275-2285](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L2275-L2285) constructs `resource` with `targetId: agentId, operation: "agent.approval.deny"`, but does not populate `hostId`. In [policy.ts:254](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy.ts#L254), `hostMatches` evaluates to false whenever `resource.hostId` is absent.
- **Exact correction**: In [channel.ts:2266-2286](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L2266-L2286), look up the target agent via `this.agents.find(agentId)`. Extract its bound `host` (`agent.host ?? agent.history_host`). Populate `resource.hostId = targetHost` in the consent check and in `prepare()`.

---

### OWNER DECISION BLOCK

> [!IMPORTANT]
> **Owner Decision Required (Pranay Karpuram)**
>
> In [P3_PERMIT_CONSENT_REDESIGN.md](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/P3_PERMIT_CONSENT_REDESIGN.md) Section 6 and [PCDESIGN_DONE.md](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-PCR/PCDESIGN_DONE.md), Codex halted implementation requesting an owner ruling on:
> 1. Whether H24 approval control may be kept fail-closed until B3b, weakening [managed-agent-controls.test.ts:278](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L278) from `200` to `404`;
> 2. The dependency of Host-bound authority on B3b Host enrollment and machine-local enforcement.
>
> **Options:**
> - **Option 1 (Recommended)**: **Reject test weakening and B3b deferral.** Reaffirm that [managed-agent-controls.test.ts:278](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L278) must continue to assert HTTP `200` for owner approval denial. Direct PCFIX to implement minimal Organization DO Host enrollment (PC-3), bind `hostId` into `resourceKey` (PC-5) and route resources (PC-6), and open approval denial for owners (direct) and cross-owners (with Host-bound `terminal_control` consent). Machine-local CLI daemon verification remains at the B3b/B4 daemon boundary.
> - **Option 2**: **Accept Codex's Option (1).** Authorize keeping approval control fail-closed in Channel DO until B3b, approve changing [managed-agent-controls.test.ts:278](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L278) from `200` to `404` as a documented Incompatible Existing Expectation, and defer H24 approval denial to B3b.
> - **Option 3**: **Expand PCFIX Scope.** Implement the full B3b Host registration and machine-local CLI daemon protocol within this fix batch.

---

### Verification Against Review Criteria (Checks 1–8)

1. **PERMIT BEFORE EFFECTS**:
   - Section 1 (Option a) correctly mandates that all external sync, validation, and Organization `prepare/reserve` occur before Channel mutations.
   - Immediately after the final `await`, it synchronously re-reads binding state, operation, generation, repo/workspace, association, predecessor, and local predicates.
   - In ONE `transactionSync`, both START and HAND receipts are validated and consumed before any Person join, Agent register, presence/roster, handoff/queue, or event write. Any failure throws and rolls back SQLite.
   - Broadcasts and watches are buffered and dispatched strictly post-commit.
   - Unlinked path takes its synchronous in-memory skip prior to any `await`.
   - *Gap*: Post-commit activation timeout/failure requires the explicit terminal reconciliation specified in PC-4.

2. **HOST-BOUND CONSENT**:
   - `terminal_control` issuance is routed through `decide()` as the single decision point.
   - Issuer is verified as active Organization and Workspace member.
   - Host ownership is verified against trusted state rather than caller-supplied fields.
   - *Gap*: Organization DO enrollment schema must be implemented in PCFIX as specified in PC-3 so Test 1 ([managed-consent-control.test.ts:355](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-consent-control.test.ts#L355)) passes.

3. **CROSS-OWNER APPROVAL hostId**:
   - Target Host is resolved from trusted agent/execution state.
   - Target Host is bound into the consent check and mutation permit.
   - *Gap*: `resourceKey` serialization ([policy-permits.ts:33-43](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy-permits.ts#L33-L43)) and route check ([channel.ts:2275-2285](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L2275-L2285)) must include `hostId` as specified in PC-5 and PC-6.

4. **DD-1**:
   - Keystrokes, terminal input, and approval control map strictly to `terminal_control` consent.
   - Read/screen/history consent (`channel.history.read`, `agent.view`, `session.transcript`) can never satisfy `terminal_control`.
   - Workspace admins have no bypass for another Person's Host (`admin && !requiresTargetOwnerConsent` does not apply to control effects).

5. **FAIL-CLOSED + STATUS CODES**:
   - Fully consistent: 404 for unlinked/foreign non-disclosure, 403 for authenticated insufficient role/scope, 400 for missing/invalid `Idempotency-Key` (retaining pre-existing 0bfb31f contract; no UUID fallback), 409 for conflict/self-continuation, 503 bounded on authority timeout.
   - No positive caching.

6. **ROOT CAUSE OF THE 2 FAILING TESTS**:
   - Plausible and verified against `git diff 0392395 87b8813`: failures in [managed-agent-controls.test.ts:278](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L278) (404 instead of 200) and [managed-consent-control.test.ts:374](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-consent-control.test.ts#L374) (false instead of true) were directly caused by XFIX1's hardcoded denials in [organization.ts:903, :1120](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L903).
   - Test weakening proposed for [managed-agent-controls.test.ts:278](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-agent-controls.test.ts#L278) is rejected (PC-1).
   - Pre-existing tests present at `0bfb31f` remain 100% byte-identical (`git diff --diff-filter=M 0bfb31f HEAD -- worker/test/` is clean).

7. **REBUILD BASE CHOICE**:
   - Continuing from `87b8813` is justified: `87b8813` preserves the inactive-member validation test ([managed-consent-membership.test.ts:6](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-consent-membership.test.ts#L6)) and implementation notes without rewriting git history.

8. **TEST PLAN & SIZING**:
   - Test plan is comprehensive (positive + full negative matrix, races for START and HAND permits, snapshot comparisons).
   - Sizing is realistic for one Codex run (~300–500 LOC + tests) provided Option 1 is corrected and Option 2 (full B3b expansion) is avoided.

---

### Verified OK
- [x] Zero changes to pre-existing `0bfb31f` tests (`git diff --diff-filter=M 0bfb31f HEAD -- worker/test/` returned empty).
- [x] Channel is not renamed; no new Durable Object or service bindings.
- [x] No credentials or secret digests stored in Channel DO storage or audit.
- [x] Unlinked Channel behavior retains synchronous in-memory bypass before any `await`.
- [x] Single central policy boundary `decide()` in [worker/src/policy.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy.ts) retained.