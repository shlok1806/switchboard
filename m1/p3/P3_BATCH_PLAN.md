# Package 3 batch plan

## Status and constraints

This plan supersedes S2c-2 through S2c-31. It continues HEAD `8a9ee8e`; it does not restart shipped S1–S2c work. Inventory row references are defined in `P3_ROUTE_INVENTORY.md`.

Read-only inspection only. Tests/builds/typechecks/lint: **not run**. The supplied manager baseline is not a result produced by this run.

Preserve all tests present at `0bfb31f` byte-for-byte. D5 permits narrowly updating Package-3-added deferral assertions as families open; preserve their negative cases and record changes. Existing deferral assertions are in `worker/test/managed-route-inventory.test.ts:96`; skill preparation still asserts closed admission at `worker/test/managed-skill-preparation.test.ts:130`.

Keep generation-zero sockets untagged and interpret missing tags as generation zero (`worker/src/channel.ts:3188`, `:3704`). Keep the Worker release fence (`worker/src/index.ts:320`) and Channel binding checks (`worker/src/channel.ts:857`). P2R-1 is already fixed by SQL filtering/keyset LIMIT (`worker/src/organization.ts:566`); preserve it. P2R-2 remains manager-only execution issuance (`worker/src/principals.ts:21`; `worker/src/policy.ts:246`); granting permission to run an existing execution must not grant credential issuance.

## Architecture assessment

**Verdict: shared facade warranted; no disproportionate architectural problem in the remaining HTTP admission work.** The implementation already centralizes managed reads in `managedRead` (`worker/src/managed-channel.ts:83`) and mutation preparation/consume/write/audit in one closure (`worker/src/channel.ts:1161`). Claims and finish already accept commit hooks (`worker/src/channel.ts:1382`). Extending these seams is smaller and safer than independent route implementations.

Mechanical scope: the 35 H inventory groups contain 32 ordinary read/write/control groups with the same outer pattern. H06 streaming, H20 registration/continuation, and H35 credential storage need specialized protocols. Within the 32, H11 external creation, H24 owner controls and Host-related work still require operation-specific predicates; common admission does not make their commits generic. The 18 W groups and five J groups are asynchronous recipient/lifecycle boundaries, not ordinary request wrappers.

### Proposed exact facade

Extend `worker/src/managed-channel.ts`, retaining `decide()` exclusively in `worker/src/policy.ts:92`. Introduce a declarative descriptor registry consumed by real managed dispatch and inventory tests:

```ts
interface ManagedOperation {
  id: string;
  action: string;
  mode: "read" | "write" | "external";
  target: string;
  operation: string;
  targetExecutionId?: string;
}

interface ManagedEnforcement {
  read<T>(
    operation: ManagedOperation,
    prepare: () => Promise<T>,
    project: (value: T) => unknown,
  ): Promise<Response>;
  prepare(
    operation: ManagedOperation,
    options?: { externalIntent?: boolean },
  ): Promise<{ commit<T>(write: () => T): T }>;
}
```

Construct it only inside an already-selected managed branch, with trusted request/actor resolution, binding snapshot, Organization stub, synchronous `current()`, credential expiry and outcome hooks. Route descriptors derive targets from validated paths/body identifiers; never accept actor, owner, action or permit from the client. Keep operation-specific handlers in their existing modules; use a declarative registry plus call-site helper, not a second router containing copied business algorithms.

Required facade behavior:

- Fresh authority call per admission and result release; no positive HTTP/private-read cache. `authorityRequest` bounds RPCs to two seconds and redacts failures (`worker/src/policy-permits.ts:94`). A timeout returns 503; late completion must never install a permit.
- Complete synchronization, validation, hashing and external preparation before the final permit. After its await, fence binding and re-read mutable local predicates; install/consume exact-resource single-use P inside `transactionSync`, with write and outcome (`worker/src/channel.ts:1182`; `worker/src/policy-permits.ts:59`).
- Introduce a durable locally known policy-revision floor for invalidation; reject permits older than that floor. Do not compare a permit only to its own supplied revision. Authority revocation currently deletes authority permits but does not invalidate installed Channel receipts (`worker/src/organization.ts:117`; `worker/src/policy-permits.ts:83`).
- Treat target enrollment, private consent and native credential expiry as release-time facts. Pin request target execution; do not reuse actor authentication after an arbitrary external wait. Current private read release is the model (`worker/src/channel.ts:922`; `worker/src/managed-channel.ts:93`).
- Project before response construction/counting; use `safeAgent` by explicit allowlist (`worker/src/managed-projection.ts:5`). Never serialize an Agent and remove fields afterward.
- Unlinked call sites retain their current synchronous branch before constructing facade inputs, parsing additional JSON, awaiting, reading storage or making RPCs. Do not initialize managed schemas in the constructor or legacy hot paths.
- Keep external intent/outcome correlation distinct from local commit. A GitHub success cannot be rolled back by a later authorization denial; existing finish records that distinction (`worker/src/channel.ts:1382`).

Migrate existing R/W paths behavior-preservingly at B1 start: task/relay/content/private reads, SafeAgent roster/summary, updates, Directives, claims/release/steps/branch/finish/takeover, memory, artifact writes and Brief writes (`worker/src/managed-channel.ts:11`, `:107`; `worker/src/channel.ts:1130`). Preserve local ownership/librarian/holder checks and response shapes.

Stay bespoke: Organization-native transactions/bootstrap/binding; D1; external-effect algorithms; Host-local verification; stream leases/send guards; connector credential issuance. They use the same policy authority but have different transaction or transport semantics.

### DESIGN DECISION NEEDED — narrow control and delegated private authority

Evidence: private actions include DIR/HAND/PT/PS (`worker/src/policy.ts:21`), but agents receive only contributor actions (`worker/src/principals.ts:31`), and Organization private decisions explicitly require a Person (`worker/src/organization.ts:1064`). Terminal input, approval control and account-field consent have no dedicated action in the current list (`worker/src/principals.ts:12`; terminal input `worker/src/channel.ts:3477`). Release also currently maps to TU, while approved proposal §7 maps it to TC (`worker/src/managed-channel.ts:137`).

Options: (1) keep agent private/control permanently denied; simplest, but fails the requested complete delegable layer where the contract permits explicit grants; (2) add narrowly scoped control actions/constraints and actor-aware owner consent; clearer boundary but changes the permission contract; (3) use existing actions plus exact operation/target/field constraints and consent; smaller vocabulary, greater risk of accidentally treating read consent as control.

Recommendation: owner/reviewer explicitly ratify option 3 where the approved action suffices, and option 2 for keyboard/approval control if no existing action can express it safely. Expand delegability only for explicitly approved private actions, intersecting sponsor authority and target-owner consent. Preserve manager-only START. Correct release to TC unless an owner-approved amendment says otherwise. Until resolution, deny the affected operations; continue independent families.

### DESIGN DECISION NEEDED — Langfuse credential location and legacy transition

Evidence: Channel `langfuse_project` stores `public_key` and `secret_sealed` (`worker/src/langfuse.ts:14`); settings PUT seals and writes through Channel (`worker/src/settings-api.ts:61`); connector costs reads and opens that row (`worker/src/mcp/server.ts:106`). Sealing does not satisfy “no credentials in Channel storage.”

Options: (1) use the existing Organization DO as a managed integration credential store, scoped to Workspace/repository, with policy and atomic audit; (2) add a dedicated secret-service binding; (3) leave managed Langfuse unavailable. Option 2 adds deployment/configuration work; option 3 violates the completion directive if permanent.

Recommendation: option 1, no new DO binding. Keep credentials and their digests entirely out of Channel permits/outcomes; return redacted connection metadata or computed costs, never keys. Organization commits credentials with OTX; Channel metadata, if needed, uses P. Fresh repo-admin remains an additional configuration predicate.

Owner must also choose the transition for a linked Channel containing an old sealed row: explicit owner-authorized migrate-and-delete protocol with recovery journal, or require disconnect/reconnect before managed integration activation. Do not silently grandfather the row, destroy legacy configuration, or pretend transfer/deletion is cross-DO atomic. B1 may open redacted GET only after its safe source is defined; B3 completes writes and transition.

## Host authority design

Workspace permission is necessary but never sufficient to control a machine. Existing Channel Host rows are advisory copies (`worker/src/hosts.ts:266`); actual limits live in CLI Host settings: roots, maximum permission mode, maximum agents, owner, allow-list and allow-channel (`cli/src/host/files.ts:23`; `cli/src/host/check.ts:23`).

The machine owner sets the ceiling at install/local configuration. A remote allow-list change additionally requires a locally trusted signing key, timestamp and replay checks (`cli/src/host/allow.ts:36`). Supervisor applies accepted changes to local settings (`cli/src/host/supervisor.ts:379`). Workspace/org administrators cannot widen roots, mode, capacity, trust keys or the owner’s allow-list merely through their role.

Managed effective Host authority must be:
`org ceiling ∩ Workspace policy ∩ explicit execution grant ∩ sponsor current delegable authority ∩ execution constraints ∩ Host-owner consent ∩ machine-local limits ∩ existing Lead/librarian rules`.
For human requests, replace execution grant/sponsor terms with the human’s current Workspace authority.

The authoritative owner identity must be bound to the Host and Workspace through verified registration; never derive native ownership solely from a caller-supplied login. For an execution, retain actual execution provenance and identify the sponsor/acting Person separately; never substitute a sponsor login to manufacture ownership.

Any foreign-owner Host control requires exact Host/action/recipient/expiry consent in addition to the local allow-list. The local owner or an execution genuinely acting within its owner/sponsor authority can satisfy the owner relationship, but sponsorship alone does not authorize a different owner’s Host. Existing `allowChannel` is a broad local ceiling (`cli/src/host/check.ts:60`), not target-specific managed consent. A historical Channel allow row cannot grant native authority by itself.

At use time: fresh decide and consent before recording control intent; exact permit at synchronous local commit; fresh generation/revision/lease check immediately before dispatch; local CLI rechecks requester, folder, mode and capacity. Existing CLI checks are `checkControl`, `cli/src/host/check.ts:72`, `checkSpawn`, `:133`, and `checkFolderAndMode`, `:98`; resume rechecks occur at `cli/src/host/supervisor.ts:535`, `:558`. Recheck pending request identity and caller authority before returning Host/private results.

Org/Workspace administrators may manage Workspace policy and membership, and perform owner-authorized Host operations within their ordinary grants. They cannot commandeer another owner’s Host, change its trust keys, type into its terminal, deny approvals, read its screens, continue its agents or impersonate its owner through admin status. Existing Channel Lead subtree/mode restrictions remain additional limits (`worker/src/hosts.ts:434`, control `:581`, selection `:787`).

Host negative tests must cover: admin without owner consent; local allow but no Workspace authority; Workspace grant but local deny; broad allowChannel without exact foreign consent; wrong owner/sponsor; unknown owner mapping; expired/revoked consent at dispatch/result; changed Host/target/binding generation; grant/sponsor revocation; wrong roots/symlink escape/mode/capacity; Lead outside subtree; foreign `from`; replayed allow signature; pending result from another Host. Positive tests must exercise own Host and explicitly consented foreign Host while demonstrating CLI can still refuse.

## Shared test gate for every opened family

Use parameterized managed fixtures, but exercise real HTTP/RPC/frame handlers. Each opened route needs positive permission coverage plus nonmember, foreign Organization/Workspace, expired/revoked execution, wrong binding generation and insufficient role/scope. Add owner/consent cases for private/control paths. Assert no side effect/bytes/counts/cursors before admission and no private result after release denial.

Add outage/timeout 503, exact permit expiry/replay, revoke-during-await, generation-change, SafeAgent marker and unlinked synchronous-spy cases. Do not satisfy these by testing the helper alone. Current helper-level boundary tests are at `worker/test/managed-s2b-boundaries.test.ts:61`; real matcher examples remain partial at `worker/test/managed-route-inventory.test.ts:96`.

## B1 — Shared facade and read surfaces

**Scope:** H02–H04, H08, H10, H19, H22/H23, H25/H27/H29/H31/H33/H34; C04/C11/C12/C15/C17/C19; M02–M04 read preparation; W10/W11/W15 and J04 projection/query preparation. Bare actor-free RPCs stay denied.

**B1a, independently gateable:** introduce facade/descriptor registry and migrate current S1–S2c R/W sites without opening new families. Introduce shared managed Event/Person/Agent projection helpers and query decomposition. Preserve unfinished-family default denial.

**B1b, independently gateable:** open history variants/ID lookup/wakes/merged-local queries, persons, librarian feed, constrained GitHub reads and permitted summary constituents/search. Implement owner-scoped account projection only after control/field mapping resolution; Langfuse GET after credential-source resolution. No new public search endpoint is necessary: cover actual memory and connector search (`worker/src/memory-api.ts:25`; `worker/src/ask.ts:152`).

**Files:** managed-channel.ts, channel.ts, managed-projection.ts, policy-permits.ts, organization.ts, ask.ts, librarian-api.ts, settings-api.ts; new projection/facade modules if they reduce Channel size; shared/m1 types only as necessary.

**Actions:** WR/TR/UR/HR/AV/PT/PS; WM plus fresh repo-admin for Langfuse settings. Query constituent scopes separately; SUB never substitutes for them.

**Tests:** new managed-facade.test.ts, managed-history.test.ts, managed-read-integrations.test.ts, managed-projections.test.ts; extend P3-added read/private/content tests and inventory under D5. Apply the complete shared negative matrix to every new descriptor, including direct lookup/search and merged local history.

**Estimate:** 10–14 production files, roughly +900–1,500/−250–450 lines; 70–110 parameterized cases. Whole B1 exceeds one 25–40 minute run; B1a and B1b each target one run. Stop if real implementation exceeds those gates rather than creating many slices.

**Risks/decisions:** preserving legacy query/index costs; private historical Events; count/cursor leakage; account-field mapping and Langfuse source decisions. Opened history must not depend on opening unguarded streams first; unavailable local holders produce existing bounded availability behavior.

**Done:** `m1/p3/B1_DONE.md`, with per-row status/evidence and unresolved design items explicitly listed.

## B2 — Core coordination and authorized continuation

**Scope:** H01/H05/H07/H09/H11–H18/H20/H21/H24/H32; C05–C10/C13; O02/O07/O08 extensions; G04/C08 typed integration boundary; W01/J02/J03 source metadata and authorization preparation.

**B2a:** human Task creation with external intent/outcome and fresh local permit; release mapping correction; telemetry; join; cursor; existing coordination migration verification. Add typed integration mirror scope without changing GitHub synchronization algorithms (`worker/src/tasks.ts:182`, `:193`, `:214`).

**B2b:** managed registration/heartbeat/end and remaining owner/self controls; continuation/handoff. Refactor registration so it cannot issue/store a legacy token as part of managed registration or return raw Agent (`worker/src/channel.ts:2029`, `:1864`). Require predecessor-owner consent before lineage/context use, before Host `from` dispatch and at private result release. Preserve claim ownership; handoff moves no Claim (`worker/src/channel.ts:2042`).

**Files:** channel.ts, managed-channel.ts, organization.ts, policy.ts, principals.ts, tasks.ts, agents.ts, claims.ts, branches.ts, stale-claims.ts, directives.ts, relay/relay.ts, relevant API handlers.

**Actions:** TC/TU/UW/WR/START/REVOKE/DIR/HAND with owner/self restrictions. START remains manager-only. Delegated private/control openings require the explicit action/consent resolution.

**Tests:** new managed-task-create.test.ts, managed-agent-controls.test.ts, managed-continuation.test.ts, managed-integration-actors.test.ts; extend P3-added claims/private/lifecycle tests. Positive and full negative matrix per operation; revoked-during-sync/PR/continuation, predecessor replacement, cross-owner grant expiry, no legacy credential writes, and D1 queue isolation.

**Estimate:** 12–17 files, roughly +1,100–1,800/−200–400 lines; 90–130 cases. Whole B2 exceeds one run; B2a/B2b each target one independently gated run.

**Risks/decisions:** external effect succeeded before denial; exact resource for not-yet-created Issue; preserving registration ID/token separation and D1; control action/delegability decision. Use intent target keyed by operation/request before Issue number exists, then exact resulting Task for commit; record that contract explicitly.

**Done:** `m1/p3/B2_DONE.md`.

## B3 — Privileged operations and Host authority

**Scope:** H26/H28/H30/H35, Host HTTP variants enumerated at C18/H06; H23/H24 owner-control decision remnants; C15/C18/C19; W07/W08/W13/W16/W17 preparation; M04 credential source.

**B3a:** skill upload/publication preparation → permit → synchronous revalidation/commit; preserve publisher ownership and librarian limits. Reuse upload preparation at `worker/src/skills.ts:407`; publication still awaits hashing at `:572`. Implement managed Langfuse storage/transition selected by owner, metadata GET/write and costs source; never put secrets/digests into Channel storage or audit.

**B3b:** Host list/register/remove/allow/spawn/stop/pause/resume with the authority model above. Scope Host roster without exposing foreign roots/identifiers. Preserve owner-only signed allow, actual local ceiling, Lead restrictions, foreign predecessor consent and response-time checks. Command frames remain closed until B4 guarded transport is enabled.

**Files:** skills.ts, skills-api.ts, channel.ts, managed-channel.ts, organization.ts, hosts.ts, hosts-api.ts, settings-api.ts, langfuse.ts, mcp/server.ts; cli Host check/supervisor/allow only for narrowly necessary managed validation, without adapter or Host behavior changes for legacy traffic.

**Actions:** UW + content ownership; WM + fresh repo-admin for settings; WR for scoped Host metadata; WM with owner restriction for Host configuration; START/REVOKE for lifecycle; HAND for foreign `from`; explicit control mapping for terminal/approvals.

**Tests:** new managed-skill-writes.test.ts, managed-settings.test.ts, managed-host-authority.test.ts; extend P3-added skill preparation/private tests. Full route negative matrix plus every Host deny case above, stale local copied ceiling, delayed Host answer, revoked pending spawn and credential-storage scans. Add new CLI managed Host tests if CLI enforcement changes.

**Estimate:** 11–16 files, roughly +1,100–1,900/−150–350 lines; 90–130 cases. Whole B3 exceeds one run; B3a/B3b each target one gated run.

**Risks/decisions:** Langfuse credential location/transition must be resolved before credential writes; Host native-owner binding and control mapping must be ratified. No permanent fail-closed deferral of these families, no new DO binding unless separately justified.

**Done:** `m1/p3/B3_DONE.md`.

## B4 — Final integration, S3/S4 completion and exhaustive regression

**Scope:** all rows; especially H06/G01–G08/N01–N13/C01–C08/C20/O05–O14/D01–D05/W01–W18/J01–J05/M01–M05. Revalidate all earlier IMPLEMENTED rows under revocation and alternate entry.

**B4a — S3:** authority-issued absolute leases, managed upgrade/authentication, every inbound action/permit, every synchronous send guard, pending-operation cancellation and recipient projections. Add durable concurrent invalidation to Organization revision changes; block new permits, invalidate Channel receipts/leases, cancel reads/Directives/interrupts, close 4403. Use one revoke-commit + ≤2,000 ms absolute deadline across all Channels, never serial waits. Do not send after lease expiry even when push/alarm is lost. Cover callbacks outside broadcast (`worker/src/channel.ts:682`, `:693`, `:711`, `:3408`, `:3769`). Add typed internal fetch invalidation path with no client-spoofable actor.

**B4b — S4 and final closure:** actor-aware read-only MCP facade, concrete native Person connector authorization/refresh, every batch entry and release, constrained GitHub/Brief/costs, no bare askChannel/private Directive leakage. Close native metadata central-policy gaps or explicitly ratify narrow public/bootstrap/internal exemptions. Finish historical outcome correlation/export without inventing provenance or acknowledgment of unverifiable rows (`worker/src/organization.ts:1243`; `worker/src/channel.ts:765`).

**Files:** channel.ts, organization.ts, policy.ts, policy-permits.ts, alarms.ts, index.ts, auth.ts, workspace-api.ts, execution-api.ts, identity-directory.ts, relay/relay.ts, directives.ts, terminal.ts, wakes.ts, mcp/server.ts, mcp/oauth.ts, mcp/tools.ts, ask.ts, managed-outcomes.ts, shared stream/m1 types; API descriptors/tests.

**Actions:** all current contract actions plus approved control mappings; SUB is only subscription eligibility. MCP channel decomposes TR/UR/HR/AV; GitHub TR; Brief/costs UR; OAuth current Person/Workspace eligibility. Unsupported resources/remote write MCP remain denied.

**Tests:** new managed-streams.test.ts, managed-revocation.test.ts, managed-mcp.test.ts, managed-oauth.test.ts, managed-surface-exhaustiveness.test.ts; extend outcome tests. Record revoke commit/server-send/client receipt timestamps; fake-time exact boundaries plus local elapsed-time integration. Include a hung Channel, delayed/lost push, hibernation, delayed lease response, sponsor demotion, credential rotation/expiry, delayed private result, queued Directive and foreign Host.

**Exhaustiveness:** enumerate actual fixed routes and all matcher method/kind variants, native/execution/auth/OAuth dispatch, public Channel/Organization/Directory RPCs, Channel.fetch branches, accepted inbound types, outbound send types and alarm jobs. Compare independent security expectations to production registration and source-discovered surfaces; do not prove exhaustiveness by comparing two hand-maintained subsets. New route/method/frame/job must fail until classified. Explicitly test public/bootstrap/D1/integration exceptions and actor-free denial.

**Estimate:** 16–22 files, roughly +1,800–2,800/−250–500 lines; 130–190 cases. B4a and B4b are the maximum two subparts, each likely at the upper end of a 40-minute run; do not claim a guaranteed runtime. Manager owns full Worker/CLI/dashboard suites and zero-failure CLI e2e gate; no timeout/config/dependency changes.

**Risks:** asynchronous side effects escaping permit/lease fences, shared raw Events, MCP error-message leaks (`worker/src/mcp/server.ts:198`), historical outbox provenance, and unlinked interrupt-delivery latency. Full regression and independent security review are completion gates, not substitutes for these invariants.

**Done:** `m1/p3/B4_DONE.md`, including remaining DENIED exceptions, complete inventory counts, measured evidence or “not run,” manager regression evidence and reviewer disposition. No production deploy or merge.

## S3/S4 relationship and completion rule

S3 projection/query preparation folds into B1; queue/control provenance into B2; Host authority into B3. Actual leases, concurrent revocation push, WS admission/frame checks and all send guards remain S3 work executed in B4a.

S4 read projectors/GitHub sources fold into B1; Langfuse credentials into B3. Connector actor/credential lifecycle, OAuth authorize/refresh, MCP batching and per-tool release remain S4 work executed in B4b. No separate S3/S4 implementation should duplicate those batch changes.

B4 is complete only when every inventory BLOCKED family has become admitted with positive/negative tests or is a specifically approved final DENIED operation; PARTIAL rows have closed gaps or explicit reviewed protocol exceptions. “Still fail-closed” is an intermediate safety state, not completion or movement to M2.
