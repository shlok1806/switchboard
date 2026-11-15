VERDICT: GO

### Summary of Independent Review

The Route Inventory ([P3_ROUTE_INVENTORY.md](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_ROUTE_INVENTORY.md)) and Batch Plan ([P3_BATCH_PLAN.md](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_BATCH_PLAN.md)) provide an accurate, sound, and comprehensive foundation for completing Package 3 within Milestone 1.

1. **Completeness**: The inventory correctly enumerates 123 surface groups across Channel HTTP routes, global auth/protocol endpoints, native Organization/Workspace APIs, public DO RPC methods (`Channel`, `Organization`, `IdentityDirectory`), WebSocket frames (11 inbound types, 18 outbound frame groups), alarm jobs, and MCP tools. One router group was omitted from Section H (Host HTTP endpoints `matchHostRoute`: `hosts`, `spawn`, `allow`, `stop`, `pause`, `resume`); this omission is non-fatal because the underlying RPCs (`C18`), frames (`W07`/`W16`), and authority model are thoroughly specified, and the HTTP routes can be added directly to Batch B3 (**ADD-TO-B3**). All reachable linked surfaces lacking a decision point are properly identified.
2. **Soundness**: The shared enforcement facade (`ManagedEnforcement` in [managed-channel.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/managed-channel.ts#L83)) preserves the approved architecture:
   - Central `decide()` in [worker/src/policy.ts:92](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy.ts#L92) without route-level duplication or bypasses.
   - Zero positive authorization caching; bounded fail-closed 503 (`authorityRequest` with 2 s timeout).
   - Single-use ≤2 s exact-resource permits consumed inside synchronous commit transactions.
   - Post-await generation fencing on binding and local enrollment.
   - Response-time recheck for private/cross-owner reads before release.
   - `SafeAgent` constructor allowlists with no `Agent` spreading.
   - UNLINKED legacy synchronous skip branching on memory-loaded `binding` state before extra awaits, storage reads, JSON parsing, or RPCs.
   - Honest scope: mechanical HTTP admission is unified via declarative descriptors, while bespoke lifecycle operations (bootstrap, D1, external GitHub sync/PR, streams, Host CLI verification) remain appropriately specialized.
3. **Host Authority Model**: Models the machine authority boundary faithfully against [cli/src/host/check.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/cli/src/host/check.ts#L23), [cli/src/host/files.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/cli/src/host/files.ts#L23), [cli/src/host/allow.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/cli/src/host/allow.ts#L36), and [cli/src/host/supervisor.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/cli/src/host/supervisor.ts#L379). Workspace authorization never implies authority to control another Person's machine; machine-local ceilings, signed owner allow-lists, and use-time consent must hold. Admins cannot commandeer machines, read screens, or type into terminals.
4. **Batch Plan**: B1–B4 cover every BLOCKED and PARTIAL surface without deferring to M2 or duplicating S3/S4. Sub-batch splits (B1a/b, B2a/b, B3a/b, B4a/b) are realistic (25–40 min per sub-batch). Preserves D1–D5, byte-identity of tests at `0bfb31f`, and no secrets in Channel storage.
5. **Architectural Assessment**: No architectural problem makes the facade disproportionately complicated. The two open design choices (Langfuse credentials and narrow control actions) have straightforward recommendations within the approved architecture.

---

### Numbered Findings

#### INV-1: Host HTTP router endpoints missing from Section H
- **Severity**: P1
- **File:line**: [P3_ROUTE_INVENTORY.md:59-100](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_ROUTE_INVENTORY.md#L59-L100); [worker/src/hosts-api.ts:59-80](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/hosts-api.ts#L59-L80)
- **Problem**: Table H enumerates 35 Channel HTTP route groups but completely omits the Host HTTP endpoints handled by `CHANNEL_ROUTE_MATCHERS.hosts` (`matchHostRoute`).
- **Evidence**: [worker/src/hosts-api.ts:59-80](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/hosts-api.ts#L59-L80) matches:
  - `GET /api/hosts` (`kind: "list"`)
  - `POST /api/hosts` (`kind: "register"`)
  - `DELETE /api/hosts/:name` (`kind: "remove"`)
  - `POST /api/hosts/:name/allow` (`kind: "allow"`)
  - `POST /api/agents/spawn` (`kind: "spawn"`)
  - `POST /api/agents/:id/stop` (`kind: "stop"`)
  - `POST /api/agents/:id/pause` (`kind: "pause"`)
  - `POST /api/agents/:id/resume` (`kind: "resume"`)
  [P3_BATCH_PLAN.md:148](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_BATCH_PLAN.md#L148) notes "Host HTTP variants enumerated at C18/H06", but C18 is an RPC row and H06 is `GET /api/stream`. On a linked Channel, these HTTP routes currently return 404 (`resource_denied`) via [worker/src/channel.ts:893](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L893) because they are absent from `managedReadRoute` and `managedWriteRoute`.
- **Exact correction**: Add row group H36 (or H36–H43) covering Host HTTP endpoints:
  - `GET /api/hosts`: Read, BLOCKED, Action: `workspace.read` (scoped Host metadata), Batch: B3.
  - `POST /api/hosts`: Write, BLOCKED, Action: `workspace.manage` + Host owner restriction, Permit: P, Batch: B3.
  - `DELETE /api/hosts/:name`: Write, BLOCKED, Action: `workspace.manage` + Host owner restriction, Permit: P, Batch: B3.
  - `POST /api/hosts/:name/allow`: Write, BLOCKED, Action: Host owner signed allow, Permit: P, Batch: B3.
  - `POST /api/agents/spawn`: Write/control, BLOCKED, Action: `agent.execution.start` + Host owner ceiling/consent + (`agent.handoff.cross_owner` for foreign `from`), Permit: E+P, Batch: B3.
  - `POST /api/agents/:id/stop`: Write/control, BLOCKED, Action: `agent.execution.revoke` + Lead/owner constraint, Permit: P, Batch: B3.
  - `POST /api/agents/:id/pause`: Control, BLOCKED, Action: Person owner constraint, Permit: P, Batch: B3.
  - `POST /api/agents/:id/resume`: Control, BLOCKED, Action: Person owner constraint, Permit: P, Batch: B3.
- **Batch tag**: **ADD-TO-B3**

#### INV-2: H20 classification conflates HTTP route with internal DO RPC method
- **Severity**: P2
- **File:line**: [P3_ROUTE_INVENTORY.md:84](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_ROUTE_INVENTORY.md#L84)
- **Problem**: H20 (`POST /api/agents`) is classified as `PARTIAL`, citing RPC implementation details at [worker/src/channel.ts:1757](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L1757).
- **Evidence**: `POST /api/agents` is not present in `managedWriteRoute` ([worker/src/managed-channel.ts:107](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/managed-channel.ts#L107)). External HTTP requests to `POST /api/agents` on a linked Channel hit fail-closed 404 at [worker/src/channel.ts:893](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L893) (F). The direct RPC method `registerManagedAgent` is row C05, which is `PARTIAL`.
- **Exact correction**: Update H20's linked class to `BLOCKED` (decision today: F). Keep C05 as `PARTIAL` for the internal DO RPC.
- **Batch tag**: **ADD-TO-B2**

#### INV-3: H13 file citation points past end of file
- **Severity**: P3
- **File:line**: [P3_ROUTE_INVENTORY.md:77](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_ROUTE_INVENTORY.md#L77)
- **Problem**: H13 cites `worker/src/managed-channel.ts:137`, but `managed-channel.ts` is only 135 lines long.
- **Evidence**: The release route mapping is at [worker/src/managed-channel.ts:131](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/managed-channel.ts#L131):
  `action: task[2] === "claim" ? "task.claim" : "task.update"`.
- **Exact correction**: Update the citation to `worker/src/managed-channel.ts:131`. In B2a, update the ternary operator so that `"release"` maps to `"task.claim"` per Proposal §7 ([M1_ARCHITECTURE_PROPOSAL.md:110](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/M1_ARCHITECTURE_PROPOSAL.md#L110)).
- **Batch tag**: **ADD-TO-B2**

#### INV-4: Shifted line citations in Sections H and G
- **Severity**: P3
- **File:line**: [P3_ROUTE_INVENTORY.md:65-70, 107-114](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_ROUTE_INVENTORY.md#L65-L70)
- **Problem**: Several citations to [worker/src/index.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/index.ts) are shifted by 15–20 lines due to earlier commits:
  - H01 cites `:192, :402` (actual route declaration is `:191`, handler dispatch is `:387`; `:402` is `handleStream` default).
  - H03 cites `:406` (actual dispatch is `:391`; `:406` is `inner.searchParams.set("bindingGeneration", ...)`).
  - H04 cites `:408` (actual dispatch is `:393`; `:408` is `response = await dispatch()`).
  - H05 cites `:410` (actual dispatch is `:395`; `:410` is post-await `bindingCurrent` verification).
  - G01 cites `:440, :492` (actual match is `:466`, handler is `:422`).
  - G04 cites `:454` (actual webhook dispatch is `:434`).
  - G08 cites `:460` (actual MCP dispatch is `:440–451`).
- **Evidence**: Direct line inspection of [worker/src/index.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/index.ts) at commit `e83193c`.
- **Exact correction**: Update citations to point to the exact lines in `worker/src/index.ts`.
- **Batch tag**: **ADD-TO-B1**

#### INV-5: Managed credential interception precedes WebSocket upgrade handler
- **Severity**: P2
- **File:line**: [P3_ROUTE_INVENTORY.md:70](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_ROUTE_INVENTORY.md#L70) (H06); [worker/src/index.ts:295-304](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/index.ts#L295-L304)
- **Problem**: H06 cites [worker/src/index.ts:171](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/index.ts#L171) (`handleStream`). However, for any request carrying a managed token (`Bearer m1...`), [worker/src/index.ts:295](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/index.ts#L295) intercepts the request and calls `channel.managedRequest(request, repo)` before `handleStream` can execute.
- **Evidence**: In [worker/src/index.ts:295-298](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/index.ts#L295-L298):
  ```ts
  if ("managed" in credential) {
    try {
      const binding = await authorityRequest(async () => await channel.bindingState());
      const response = await channel.managedRequest(request, repo);
  ```
  Since `managedRequest` checks `managedReadRoute` and `managedWriteRoute`, `GET /api/stream` returns 404 (`resource_denied`) before WebSocket upgrade validation or `channel.fetch` can be reached.
- **Exact correction**: In B4a (S3), update [worker/src/index.ts:295](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/index.ts#L295) to branch when `Upgrade: websocket` is present, forwarding the verified managed actor into an authenticated WebSocket upgrade path rather than routing into `managedRequest`.
- **Batch tag**: **ADD-TO-B4**

#### INV-6: Clarify H28 Artifact DELETE vs PUT in B3 batch scope
- **Severity**: P3
- **File:line**: [P3_ROUTE_INVENTORY.md:92](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_ROUTE_INVENTORY.md#L92) (H28); [P3_BATCH_PLAN.md:148](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_BATCH_PLAN.md#L148)
- **Problem**: H28 is classified as `IMPLEMENTED` in the inventory, but [P3_BATCH_PLAN.md:148](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_BATCH_PLAN.md#L148) lists H28 under B3 scope.
- **Evidence**: Both artifact PUT and DELETE are already implemented in `#managedWrite` ([worker/src/channel.ts:1284-1326](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L1284-L1326)) with permit wrapping, and tested in [worker/test/managed-artifact-publication.test.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-artifact-publication.test.ts). [P3_BATCH_PLAN.md:58](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_BATCH_PLAN.md#L58) correctly notes that artifact writes only need to be migrated to the new facade in B1a.
- **Exact correction**: Remove H28 from the B3 scope list in [P3_BATCH_PLAN.md:148](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_BATCH_PLAN.md#L148); treat H28 purely as an existing implemented path migrating to the facade in B1a.
- **Batch tag**: **ADD-TO-B1**

#### INV-7: Granular policy action mappings for H24 agent controls
- **Severity**: P2
- **File:line**: [P3_ROUTE_INVENTORY.md:88](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/P3_ROUTE_INVENTORY.md#L88) (H24); [worker/src/agents-api.ts:78-93](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/agents-api.ts#L78-L93)
- **Problem**: H24 groups multiple agent operations (`proxy-mode`, `nickname`, `model`, `approval`, `approval/deny`, `role`). The contract action vocabulary in [worker/src/principals.ts:12-32](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/principals.ts#L12-L32) lacks dedicated actions for model and approval controls.
- **Evidence**: Legacy handlers ([worker/src/channel.ts:2282-2331](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L2282-L2331)) enforce owner/self constraints. Without explicit mappings, these operations would either default to deny or require overly broad permissions.
- **Exact correction**: In B2b, formalize the following mappings:
  - Agent self-reporting (model, approval): `channel.update.write` + caller execution === target execution.
  - Person owner managing proxy-mode, nickname, model, approval/deny: `workspace.manage` (or `channel.update.write` with owner constraint) + caller Person === agent's owner.
  - `role`: `agent.grant.manage` (already in SPEC actions).
- **Batch tag**: **ADD-TO-B2**

---

### DESIGN DECISION: Langfuse Credential Storage and Legacy Transition

- **Context**: [worker/src/langfuse.ts:14](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/langfuse.ts#L14) stores `public_key` and `secret_sealed` in Channel storage. Sealing credentials does not satisfy the binding Milestone 1 invariant: "no secrets in Channel storage".
- **Options**:
  1. *(Recommended)* **Organization DO Credential Store**: Store managed integration credentials inside the `Organization` DO SQLite database, scoped by `(workspaceId, channelRepo)`. Mutations use atomic Organization transactions (`OTX`) and audit logging. The Channel DO stores zero secrets or sealed ciphertext. When the MCP `costs` tool runs, it requests computed costs or credentials directly from the Organization DO or a dedicated ephemeral worker context.
  2. **Dedicated Cloudflare Secret Binding / Service**: Introduce a dedicated Cloudflare Worker service or KV/D1 binding for secrets. (Cost: introduces new bindings and configuration changes, violating the minimal-change constraint).
  3. **Leave Langfuse Integration Closed in M1**: Keep H34/H35 permanently fail-closed (404) for managed Workspaces in M1. (Cost: leaves route group incomplete, conflicting with the owner's directive to complete all route groups).
- **Transition for Existing Sealed Rows in Linked Channels**:
  - *(Recommended)* **Disconnect on Link**: Binding a Channel to a Workspace requires explicit unlinking/clearing of legacy sealed rows. If a legacy sealed row exists when linking, the link CAS protocol clears `langfuse_project` from Channel storage. If the organization owner wishes to enable Langfuse in the managed Workspace, they configure it anew via `PUT /api/settings/langfuse`, which stores credentials in the Organization DO.
  - *Alternative*: Migrate-and-delete protocol with recovery journal during binding activation. (More complex, cross-DO two-phase commit).
- **Reviewer Recommendation**: Adopt **Option 1** with **Disconnect on Link**. H34 GET remains fail-closed in B1 until the Organization credential store is wired in B3a (**ADD-TO-B3**).

---

### DESIGN DECISION: Narrow Control and Delegated Private Authority

- **Context**: In [worker/src/policy.ts:21](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy.ts#L21), private actions include `agent.directive.send`, `agent.handoff.cross_owner`, `agent.private_transcript.read`, and `agent.private_screen.read`. Terminal keyboard input ([worker/src/channel.ts:3477](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts#L3477)) and approval actions currently lack a dedicated action in [worker/src/principals.ts:12](file:///home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/principals.ts#L12). Furthermore, `agent.private_screen.read` must never grant authority to send keystrokes.
- **Options**:
  1. *(Recommended)* **Use Existing Actions + Exact Operation Constraints & Owner Consent**: Map terminal keystroke input to `agent.private_screen.read` + an explicit, separate, auditable `terminal_control` target-owner consent record. Keystrokes are rejected if only screen-view consent is present. Map task release to `task.claim` per Proposal §7. Map approval decisions to `channel.update.write` + target owner verification.
  2. **Extend Action Vocabulary**: Introduce `agent.terminal.control` and `agent.approval.control` to `Action` in `worker/src/principals.ts`. (Cost: modifies the contract action vocabulary defined in Gate 0).
  3. **Permanently Deny Terminal Input / Approvals for Agents**: Allow only interactive human Persons with owner consent.
- **Reviewer Recommendation**: Adopt **Option 1** for Milestone 1. Enforce that terminal input requires explicit machine/session owner consent beyond `agent.private_screen.read`. Correct task release from `task.update` to `task.claim` in B2a (**ADD-TO-B2**).

---

### Verification and Execution Confirmation

- Inspection methodology: Read-only static analysis and cross-verification of:
  - `/home/box/engineering-workspace/worktrees/_agy_inputs/M1-P3-INV/` (`DIRECTIVE.txt`, `DECISIONS.txt`, `SPEC.md`, `M1_ARCHITECTURE_PROPOSAL.md`, `P3_PLAN.md`, `P3_IMPLEMENTATION_NOTES.md`, `P3_ROUTE_INVENTORY.md`, `P3_BATCH_PLAN.md`, `COMMIT.txt`).
  - Worktree codebase at commit `e83193c457bc1c64f3cb8a4263f93d25bd3d7982`.
- Verification checks executed:
  - Route and matcher dispatch in `worker/src/index.ts` and all 12 delegated route modules.
  - Public RPC method definitions across `Channel`, `Organization`, and `IdentityDirectory`.
  - WebSocket inbound and outbound frame dispatch in `worker/src/channel.ts`, `worker/src/relay/relay.ts`, `worker/src/directives.ts`, `worker/src/hosts.ts`, and `worker/src/terminal.ts`.
  - Host authority consistency between CLI checks (`cli/src/host/check.ts`, `files.ts`, `allow.ts`, `supervisor.ts`) and Worker (`worker/src/hosts.ts`).
  - Test suites and test expectations at `0bfb31f` vs `HEAD`.
- **Tests run**: **Zero tests were run during this review turn** (per sandbox read-only instructions; never claiming unexecuted tests passed).

Verified OK