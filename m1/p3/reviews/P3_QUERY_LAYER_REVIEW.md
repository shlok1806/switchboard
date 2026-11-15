VERDICT: GO

### Summary of Independent Review

The Switchboard Milestone 1 Package 3 Shared Managed Query Layer Design ([P3_QUERY_LAYER_DESIGN.md](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md)) is **SOUND** and provides an airtight, architecturally disciplined framework for completing all remaining Package 3 read surfaces within Milestone 1.

The design directly honors Pranay Karpuram's binding ruling ([OWNER_DECISION_QUERY_LAYER.txt](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/OWNER_DECISION_QUERY_LAYER.txt)): it replaces repetitive per-route authorization code and fragile inline candidate scanning with a single, shared query executor (`runManagedQuery`) and declarative constituent plans (`QueryPlan`), without creating a parallel authorization path, changing the policy action vocabulary (conforming to DD-1), storing credentials in Channel storage (conforming to DD-2), or adding new DO/service bindings.

---

### Architectural Verification Against the 9 Core Checks

1. **SINGLE DECISION POINT**:
   - `decide()` in [worker/src/policy.ts:92](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy.ts#L92) remains the **only** policy decision point.
   - All query operations route through `Organization.authorizeChannelRead` ([worker/src/organization.ts:1119-1140](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L1119-L1140)), which freshly verifies execution credentials at [worker/src/organization.ts:1129](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts#L1129) and enforces read-only attenuation.
   - Extends the existing B1a facade (`managedEnforcement` in [worker/src/managed-channel.ts:223](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/managed-channel.ts#L223)) with a `query()` method rather than establishing a competing authorization mechanism.
   - Strictly prohibits positive caching ([P3_QUERY_LAYER_DESIGN.md:146](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L146)). Fails closed with bounded 503 upon authority timeout or outage via `authorityRequest` (2,000 ms RPC bound, 10,000 ms total query preparation budget; [worker/src/policy-permits.ts:121](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy-permits.ts#L121)).
   - Domain-specific predicates (ownership, librarian cursor rules, claim-holder status, Lead, Host-local limits) remain strictly in their owning modules as additional filtering limits ([P3_QUERY_LAYER_DESIGN.md:152](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L152)). Mechanical per-route authorization duplication is completely eliminated.

2. **LEAKS & PROJECTION**:
   - Enforces `safeAgent` allowlist projection by construction ([worker/src/managed-projection.ts:5-18](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/managed-projection.ts#L5-L18)), strictly forbidding `Agent` spreading ([P3_QUERY_LAYER_DESIGN.md:158](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L158)).
   - Excludes private rows (Directives, directed Updates, captures, sessions, screens, and unadmitted types) **prior** to ordering, counting, cursor generation, or window capping ([P3_QUERY_LAYER_DESIGN.md:160, 188](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L160)).
   - Eliminates position/count leakage across sparse, short, and empty pages: forward cursors echo input positions on empty pages; trailing private rows never advance the cursor; merged/local/tail/before selectors utilize opaque cursors encoding only admitted boundaries ([P3_QUERY_LAYER_DESIGN.md:192-196](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L192-L196)).
   - The 10,000-candidate cap returns bounded 503 (`managed_read_unavailable` / `query_unavailable`) with zero partial results, avoiding false "end-of-history" disclosure ([P3_QUERY_LAYER_DESIGN.md:190, 200](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L190)).
   - Redacts legacy GitHub login strings and emails from Task and Note projections, attributing authors strictly through enrolled Agent identities or native Person UUIDs ([P3_QUERY_LAYER_DESIGN.md:162-165](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L162-L165)). Cross-Organization and cross-Workspace isolation is derived purely from the loaded binding tuple ([worker/src/channel.ts:908](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L908)).

3. **CONSISTENCY & REVOCATION**:
   - Generation and binding tuple fencing occurs after every `await` ([P3_QUERY_LAYER_DESIGN.md:174](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L174); [worker/src/channel.ts:872, 910](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L872)).
   - Mandates comprehensive release-time rechecks covering outer scope, all constituents, and all emitted author/target dependencies ([P3_QUERY_LAYER_DESIGN.md:143](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L143)).
   - Synchronously observes `managed_policy_floor` ([worker/src/policy-permits.ts:43-55](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy-permits.ts#L43-L55)) at boundaries and before release, immediately terminating execution if a revocation advances the floor mid-query ([P3_QUERY_LAYER_DESIGN.md:178](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L178)).
   - Verifies authority response deadlines against `now()`, disallowing reused authorization leases ([P3_QUERY_LAYER_DESIGN.md:180](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L180)).

4. **HOLDER REQUEST/REPLY PROTOCOL**:
   - The guarded machine query preparation in `managed-local-history.ts` ([P3_QUERY_LAYER_DESIGN.md:204-224](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L204-L224)) properly isolates the history-holding machine.
   - Enforces DD-1: a Workspace grant alone never authorizes reading or controlling another Person's machine; Host-local ceilings ([cli/src/host/check.ts:23-45](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/cli/src/host/check.ts#L23-L45)) and explicit target-owner consent are mandatory.
   - Restricts history queries to shared Event projections; terminal input and approval control remain strictly forbidden without DD-1 `terminal_control` consent.
   - Uses cryptographic UUID request IDs, strictly validates socket attachment identities matching [cli/src/host/supervisor.ts:314, 338-348](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/cli/src/host/supervisor.ts#L314), caps pending memory-only requests (32 per query, 128 per Channel), and verifies recipient leases before send without opening unguarded streams or new DO bindings.
   - Preserves safe unavailable status for authorized holders while concealing the existence of unauthorized/ineligible holders ([P3_QUERY_LAYER_DESIGN.md:223](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L223)).

5. **NON-BYPASS & UNLINKED BASELINE**:
   - Legacy readers that expose unprojected state or raw sequence positions are blocked from managed channels: `worker/src/librarian.ts:134-167` raw `latest`/`through`/`more` feed computation is bypassed in favor of authorized constituent assembly ([P3_QUERY_LAYER_DESIGN.md:231](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L231)); legacy `askChannel` ([worker/src/ask.ts:49, 152, 286](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/ask.ts#L49)) raw event/directive dumping is replaced by projected constituent assembly ([P3_QUERY_LAYER_DESIGN.md:229](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L229)).
   - Bare actor-free DO RPC methods remain denied ([worker/src/channel.ts:1540, 2902](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L1540)); MCP and WebSocket upgrade paths remain fail-closed until B4.
   - Unlinked Channels execute a synchronous in-memory skip on `this.binding.state !== "linked"` before any extra `await`, storage read, JSON parse, or DO RPC ([worker/src/channel.ts:867, 911](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L867); [worker/src/index.ts:295](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/index.ts#L295)), guaranteeing byte-identical baseline behavior.

6. **MAPPING COMPLETENESS**:
   - Table 9 ([P3_QUERY_LAYER_DESIGN.md:239-254](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L239-L254)) maps every remaining B1 surface group:
     - H02 stored forward/ID/Wake and merged/local/tail/before/agent/task
     - H31 librarian feed and cursor READ
     - H19 roster, detail, and summary (including eligible successors)
     - H03 native Persons and H33 GitHub reads
     - M02–M04 read preparation and W10/W11/W15/J04 stream/local preparation
   - Nothing is dropped or deferred to M2 for convenience.

7. **TEST STRATEGY**:
   - Specifies a unified table-driven test harness (`worker/test/managed-query-cases.ts`) executing real HTTP/RPC/frame handlers ([P3_QUERY_LAYER_DESIGN.md:278](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L278)).
   - Exercises positive admission alongside the complete 8-denial negative matrix (non-member, foreign Organization, foreign Workspace, revoked execution, expired execution, wrong generation, insufficient role, insufficient scope).
   - Validates constituent pre-read denials, private-row insertion invariance, sparse/empty window handling, lookahead proof, holder availability/forgery, and release-time denials.
   - Preserves baseline tests at `0bfb31f` byte-for-byte; flips Package-3-added deferral tests under strict D5 governance ([P3_QUERY_LAYER_DESIGN.md:293](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L293)).

8. **SLICING & B1c WIP DISPOSITION**:
   - Exactly 3 slices (B1q1, B1q2, B1q3), each sized realistically for a 25–40 minute execution run ([P3_QUERY_LAYER_DESIGN.md:301-303](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L301-L303)):
     - **B1q1**: Core executor (`managed-query.ts`), registry, revision-floor reader, and migration of shipped reads (stored H02, H03, H33, roster).
     - **B1q2**: Summary (H19 successors/notes) and librarian feed (H31 READ).
     - **B1q3**: Guarded local history (`managed-local-history.ts`), selector adapters, and connector/stream preparation.
   - Plausible root-cause analysis of the 72 failures in `managed-summary*.test.ts`:
     Direct verification confirms that `managed-summary.test.ts` (line 661) and `managed-summary-notes.test.ts` (line 1099) in `B1c_wip.patch` constructed synthetic bindings using `workspace: "${organizationId}:workspace"`. Because `"workspace"` is not a valid UUID, `workspaceParent()` ([worker/src/policy.ts:76, 88](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy.ts#L76)) returned `null`, causing `Channel.managedRequest` ([worker/src/channel.ts:908](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L908)) to fail-closed with 404 before reaching any authority or constituent read. Fixing fixtures to use valid UUIDs directly resolves these failures.
   - The disposition table for `B1c_wip.patch` ([P3_QUERY_LAYER_DESIGN.md:261-270](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L261-L270)) avoids wholesale patch reapplication while extracting the necessary pagination constants, adversarial assertions, and lookahead logic.

9. **STRUCTURAL / OWNER DECISION ASSESSMENT**:
   - The design introduces no structural complications and requires no new owner design decisions. It directly executes Pranay's binding ruling and complies with DD-1 and DD-2.

---

### Numbered Findings

#### QL-1: `managedQueryResponse` must serialize the route's expected payload, not wrap in `QueryEnvelope`
- **Severity**: P2
- **File:line**: [P3_QUERY_LAYER_DESIGN.md:109-129](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L109-L129)
- **Problem**: `QueryEnvelope<T>` defines `{ value: T; policyRevision: number; page?: { cursor: number | string | null; more?: boolean } }`. If `managedQueryResponse` serializes this envelope directly to JSON, the resulting body `{ value: ..., policyRevision: ..., page: ... }` would violate the public JSON schemas expected by existing HTTP endpoints (e.g., `GET /api/events` expects `{ events: [...], cursor: ... }`, `GET /api/agents` expects `{ agents: [...] }`, `GET /api/persons` expects `{ persons: [...] }`, and `GET /api/memory` expects `{ notes: [...], more?: true }`). In addition, exposing `policyRevision` in the HTTP response body leaks internal policy state.
- **Evidence**: Baseline and B1 handler tests (e.g., [worker/test/managed-read-paths.test.ts:98-105](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-read-paths.test.ts#L98-L105); [B1c_wip.patch:542](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/B1c_wip.patch#L542)) assert exact response bodies `{ events, cursor }`, `{ agents }`, and `{ persons }`.
- **Exact correction**: In B1q1, specify that `managedQueryResponse` serializes `envelope.value` directly into `Response.json(envelope.value, { headers: { "Cache-Control": "no-store" } })` (where `plan.assemble` formats `envelope.value` into the exact response schema expected by the HTTP route, embedding cursors/lookahead flags as appropriate). `policyRevision` remains an internal fence fact and is never leaked in HTTP response bodies.
- **Implementation Tag**: **REQUIRED-IN-B1q1**

#### QL-2: `QueryFailure.reason` must include existing error reason strings
- **Severity**: P2
- **File:line**: [P3_QUERY_LAYER_DESIGN.md:115-117](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L115-L117)
- **Problem**: `QueryFailure.reason` is defined as `"resource_denied" | "query_unavailable"`. However, existing baseline and Package 3 tests explicitly assert `reason: "authority_unavailable"` when `AuthorityUnavailable` is caught ([worker/src/managed-channel.ts:121](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/managed-channel.ts#L121); [worker/test/managed-read-paths.test.ts:73](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-read-paths.test.ts#L73)) and `reason: "managed_read_unavailable"` on candidate work-ceiling exhaustion ([worker/test/managed-read-integrations.test.ts:211](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-read-integrations.test.ts#L211)). If `runManagedQuery` produces only `"query_unavailable"`, tests expecting the existing reason strings will fail.
- **Evidence**: `worker/test/managed-read-paths.test.ts:73`: `expect(await response.json()).toEqual({ ok: false, reason: "authority_unavailable" })`.
- **Exact correction**: In B1q1, expand `QueryFailure.reason` to:
  ```ts
  type QueryFailureReason = "resource_denied" | "query_unavailable" | "authority_unavailable" | "managed_read_unavailable";
  ```
  Ensure `managedQueryResponse` outputs these exact reason strings to preserve full test compatibility.
- **Implementation Tag**: **REQUIRED-IN-B1q1**

#### QL-3: Omitted candidate rows must not retain author dependency checks for release rechecks
- **Severity**: P2
- **File:line**: [P3_QUERY_LAYER_DESIGN.md:73-75, 143, 166](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L73-L75)
- **Problem**: Section 3 line 143 requires reauthorizing "every emitted target/author dependency at release," and Section 4 line 166 states "An author denied during preparation is omitted. Loss of an already included author’s authority at release denies the whole prepared result." However, `ProjectionContext.check` ([P3_QUERY_LAYER_DESIGN.md:73](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L73)) is invoked during `project(row, context)`. If `ProjectionContext` unconditionally accumulates every authorization check, and the row is subsequently discarded (e.g. `project` returns `null`), a denied or revoked author of an omitted row would trigger a release recheck denial, incorrectly failing the entire query.
- **Evidence**: In [worker/src/channel.ts:1027](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L1027), `rosterChecks.push(check)` occurs only when the event projection is admitted and included.
- **Exact correction**: In B1q1, specify that `runManagedQuery` commits row-level dependency checks to the release recheck set only if `project(row, context)` returns an admitted (non-null) projected item. Any checks performed during evaluation of a row that is omitted (`null`) must be rolled back and excluded from release revalidation.
- **Implementation Tag**: **REQUIRED-IN-B1q1**

#### QL-4: Formalize safe projection types for summary Tasks and Notes to prevent login leaks
- **Severity**: P2
- **File:line**: [P3_QUERY_LAYER_DESIGN.md:162-163](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L162-L163)
- **Problem**: Section 4 requires that Task and Note projections redact legacy holder/author login fields and represent authors strictly via enrolled Agent identity or native Person ID. However, the existing domain types `Task.claim.holder` ([shared/src/domain.ts:120](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/shared/src/domain.ts#L120)) and `MemoryNote.person` ([shared/src/memory.ts:43](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/shared/src/memory.ts#L43)) include raw GitHub logins (`PersonName`). Without explicit projection type definitions, handlers risk either leaving legacy fields or introducing undefined attributes.
- **Evidence**: `shared/src/domain.ts:120`: `Holder = { kind: "agent"; agentId: AgentId } | { kind: "person"; person: PersonName }`.
- **Exact correction**: In B1q2, define explicit projected types `SafeTask` and `SafeMemoryNote` in `worker/src/managed-projection.ts` (mirroring `SafeAgent` and `safeSharedEvent`) that represent author attribution strictly as `{ kind: "agent", agentId: AgentId }` or `{ kind: "person", personId: string }`, omitting raw `person` login strings and `nickname` fields. Summary assembly must use these projectors.
- **Implementation Tag**: **REQUIRED-IN-B1q2**

#### QL-5: Bound individual socket reply timeouts in guarded local-history requests
- **Severity**: P2
- **File:line**: [P3_QUERY_LAYER_DESIGN.md:207, 221](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-QD/P3_QUERY_LAYER_DESIGN.md#L207)
- **Problem**: Legacy `askHistory` ([worker/src/channel.ts:3141](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L3141)) uses `setTimeout` with `this.historyWaitMs`. While the design bounds pending memory-only requests to 32 per query and 128 per Channel (line 207) and caps total preparation at 10,000 ms (line 154), an unresponsive holder could stall a query for the full configured wait time if not bounded by the remaining RPC budget.
- **Evidence**: `worker/src/policy-permits.ts:121` imposes a 2,000 ms RPC bound on authority requests. Local machine socket requests should adhere to a similar bounded ceiling.
- **Exact correction**: In B1q3, enforce that `managed-local-history.ts` caps individual holder socket reply timeouts to `Math.min(configuredHistoryWaitMs, remainingQueryBudgetMs, 2000)`. Upon timeout, the adapter immediately unregisters the pending request, resolves with `unavailable` for authorized holders, and clears all timers.
- **Implementation Tag**: **REQUIRED-IN-B1q3**

---

Verified OK