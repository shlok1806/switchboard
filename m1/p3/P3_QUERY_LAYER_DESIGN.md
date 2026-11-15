# Package 3 shared managed query layer

Status: proposed for independent review against HEAD `57412ce`. Documents only; no implementation changes. Tests, builds, typecheck and lint: **not run**.

## 1. Boundary and existing evidence

The query layer prepares authorized projections; it does not become another policy engine.

Existing foundations:

- `worker/src/policy.ts:92` defines `decide()`; resource-parent validation is at `:110` and `:117`, execution authority intersection at `:125`.
- `worker/src/organization.ts:1119` calls `decide()` for Channel authorization. `authorizeChannelRead` freshly verifies execution credentials at `:1129` and restricts actions to reads at `:1132`.
- `worker/src/managed-channel.ts:159` defines the operation registry; `:218` resolves registered operations; `:223` supplies the enforcement facade.
- `worker/src/managed-channel.ts:87` revalidates independent constituents; `:107` performs admission/read/release. These mechanisms are reused and extended, not duplicated.
- `worker/src/channel.ts:897` binds managed HTTP requests to the actual Channel, constructs authority inputs at `:923`, and currently accumulates query/author checks at `:940`.
- Stored history currently scans one window at `worker/src/channel.ts:999`, projects rows at `:1007`, and authorizes historical authors at `:1011`.
- Summary currently falls through the roster branch and returns only `{agent}` (`worker/src/channel.ts:1114`, `:1137`).
- Legacy summary joins local activity, Tasks, Updates, files, notes and successors (`worker/src/channel.ts:2149`, `:2204`).
- Legacy librarian feed calculates metadata from raw Event positions (`worker/src/librarian.ts:134`, `:158`, `:167`).
- Legacy connector answers contain raw Agents and Events including Directives (`worker/src/ask.ts:49`, `:65`, `:73`, `:286`).

## 2. Proposed files and exact public contracts

Add `worker/src/managed-query.ts` for execution, `managed-query-registry.ts` for declarative plans, and `managed-local-history.ts` for guarded machine-query preparation. Retain `managed-history.ts` for parsing and bounded Event scanning.

Types below are proposed TypeScript contracts. `ChannelAuthorization`, `NativeResult` and `SafeAgent` retain their existing meanings. `AuthorityValue` derives from Organization rather than copying its response shape.

```ts
type AuthorityValue = Extract<
  Awaited<ReturnType<Organization["authorizeChannelRead"]>>,
  { ok: true }
>["value"];

type QueryId =
  | "history" | "summary" | "librarian"
  | "connector.channel" | "connector.github" | "connector.brief"
  | "persons" | "agents" | "github"
  | "stream.backlog" | "stream.event" | "local.history";

type ConstituentId =
  | "tasks" | "history" | "brief" | "summary"
  | "notes" | "events" | "agents" | "persons";

interface QueryBinding {
  organizationId: string;
  workspaceId: string;
  channel: string;
  generation: number;
  operation: string; // completed binding-operation identity
}
interface QueryScope {
  id: QueryId;
  binding: QueryBinding;
  authorization: ChannelAuthorization;
}
interface QueryGuard {
  bindingCurrent(): boolean;
  revisionFloor(): number; // synchronous, managed-only
  now(): number;
}
interface QueryAuthority {
  check(input: ChannelAuthorization): Promise<NativeResult<AuthorityValue>>;
}
interface QueryRow {
  key: string; // internal stable merge/dedup/order key
  value: unknown;
}
interface ProjectionSpec<T> {
  id: string;
  project(row: QueryRow, context: ProjectionContext): Promise<T | null>;
}
interface ProjectionContext {
  check(input: ChannelAuthorization): Promise<AuthorityValue | null>;
  boundary(): void; // throws on generation/revision/deadline failure
}
interface PageRequest {
  source: "stored" | "merged" | "local";
  selector:
    | { kind: "forward"; after: number }
    | { kind: "before"; before: number }
    | { kind: "tail" }
    | { kind: "ids"; ids: readonly string[] };
  agentId?: string;
  taskNumber?: number;
  wakesOnly: boolean;
  limit: number;
  cursor?: string; // managed composite/local opaque cursor
}
interface CandidateWindow {
  rows: readonly QueryRow[];
  nextInternal: string | null;
  exhausted: boolean; // explicit; short window alone is insufficient
}
interface ConstituentDescriptor<T> {
  id: ConstituentId;
  authorization: ChannelAuthorization;
  page: PageRequest;
  projection: ProjectionSpec<T>;
  readWindow(
    position: string | null,
    limit: number,
  ): Promise<CandidateWindow>;
}
interface QueryPlan<T> {
  scope: QueryScope;
  constituents: readonly ConstituentDescriptor<unknown>[];
  assemble(parts: ReadonlyMap<ConstituentId, readonly unknown[]>): T;
}
interface QueryEnvelope<T> {
  value: T;
  policyRevision: number;
  page?: { cursor: number | string | null; more?: boolean };
}
interface QueryFailure {
  status: 404 | 502 | 503;
  reason: "resource_denied" | "query_unavailable";
}
type QueryResult<T> =
  | { ok: true; envelope: QueryEnvelope<T> }
  | { ok: false; error: QueryFailure };

function runManagedQuery<T>(
  plan: QueryPlan<T>,
  authority: QueryAuthority,
  guard: QueryGuard,
): Promise<QueryResult<T>>;

function managedQueryResponse<T>(result: QueryResult<T>): Response;
```

The registry supplies trusted factories; request bodies cannot supply actions, projections, SQL callbacks or authority resources. Duplicate constituent IDs and unknown plans fail closed.

Add a `query()` method to `managedEnforcement` delegating to `runManagedQuery`; supply `authority.check` through its existing fresh `check()` boundary. Simple `read()` remains supported. Query results are serialized only after final synchronous fences, with `Cache-Control: no-store`.

## 3. Admission, constituents and release

For each execution of a plan:

1. Validate trusted plan identity and exact binding tuple.
2. Authorize the outer scope once at admission.
3. Authorize each independent constituent once before its first content access.
4. Fetch bounded candidates, apply additional module predicates, authorize row-specific targets/authors, and project.
5. Reauthorize outer scope, every constituent, and every emitted target/author dependency at release.
6. Synchronously validate generation, revision and all authority deadlines, assemble the bounded response, and release without another await.

“Once” means once per scope per phase, not a permanent grant. Different independently protected resources retain separate checks even when their action strings match. No positive authorization cache survives or substitutes for an authority call.

All checks go through Organization `authorizeChannelRead` and its `decide()` boundary (`worker/src/organization.ts:1129`, `:1119`). The layer contains no membership, role or delegability implementation.

Task/history/Brief/summary/notes/events are separate constituent descriptors. Notes require UR and HR; summary requires AV plus TR/UR/HR for its selected content; author eligibility additionally requires exact-target AV.

Keep ownership, librarian, claim-holder, Lead and Host-local predicates in their owning modules as additional limits. For example, librarian cursor mutation already has a librarian-specific restriction (`worker/src/channel.ts:2854`); the query layer does not replace it or authorize cursor writes.

Use `authorityRequest` with its existing maximum 2,000 ms RPC bound (`worker/src/policy-permits.ts:121`). Add a 10,000 ms absolute preparation deadline; each await receives the remaining budget. Deadline exhaustion or authority outage returns bounded, redacted 503 and no partial result. External integration errors may retain redacted 502 semantics.

## 4. Projection and historical attribution

Reuse `safeAgent` by construction: its eight allowlisted fields are explicit (`worker/src/managed-projection.ts:5`). Never spread an Agent into managed output. Apply it to roster, target detail, successors, summary, connector and eventual stream projections.

Use explicit managed Event, note, Task and attribution projectors. Exclude Directives, directed Updates, captures, sessions, raw screens and unknown payload types before sorting visible results, counting, limiting, cursor construction or formatting. Existing shared Event projection excludes directed Updates and unknown types (`worker/src/managed-projection.ts:46`); stored Wake projection removes references (`worker/src/managed-history.ts:38`).

Task and note projections must also redact legacy holder/author login fields. Preserve public content fields, but represent admitted authors with enrolled Agent identity or native Person ID obtained from authority. Do not reuse legacy display attribution as native identity.

Historical enrolled-agent Events require exact execution association and `eventAt`; Organization checks enrollment time at `worker/src/organization.ts:1071`. Retain conservative omission of historical/login-only Persons, system actors and unverifiable execution attribution, matching `worker/src/managed-history.ts:40`. No fabricated enrollment and no login/email fallback.

An author denied during preparation is omitted. Loss of an already included author’s authority at release denies the whole prepared result.

Eligible successors require independent exact-target AV checks and SafeAgent projection. A successor relationship grants no private context access or continuation authority.

## 5. Isolation and mid-query changes

Derive Organization, Workspace, repository and generation from the loaded binding, never selectors. Existing HTTP identity checks are at `worker/src/channel.ts:903`; Organization checks completed binding facts at `worker/src/organization.ts:993`.

The guard checks the complete captured binding tuple after every await, including credential resolution, Task synchronization, candidate fetch, author checks, holder replies and release checks.

Require one consistent policy revision across admission, constituent, row and release decisions. Revision change denies the complete query; a retry starts fresh.

Expose a managed-only synchronous revision-floor reader alongside `LocalMutationPermits`. Reuse the existing `managed_policy_floor` table, currently created and advanced at `worker/src/policy-permits.ts:43` and `:48`; do not introduce another revision store. Check the floor at every boundary and immediately before release. `invalidateManagedPolicy` currently advances that floor (`worker/src/channel.ts:865`).

Retain each authority response’s deadline internally; it is not a reusable authorization lease. Reject at `now >= deadline`. Fresh release checks detect revoked execution, credential rotation, sponsor demotion, membership removal and expiry. Revision observations fence revocation arriving during later awaits.

No query session, token or authority response is persisted in Channel storage. Existing B4 concurrent revocation and socket cancellation obligations remain necessary.

## 6. Paging, selectors and non-disclosure

Read at most 1,000 candidates per window and 10,000 candidates across the entire query, including joined constituents, local replies and visible lookahead. Enforce separate bounded retained-output caps.

Projection precedes visible ordering/counts/caps. Deduplicate admitted merged Events before output; stable ordering uses admitted Event time/identity, never holder response order.

Continue across sparse, short and empty windows when `exhausted` is false. Reject non-progressing internal positions. Return short/empty success only after exhaustion or the requested visible cap. If the cap is reached without enough evidence to complete the requested answer, deny the whole read with 503; never return a partial “end of history.”

Stored-forward compatibility retains numeric `cursor`: last returned admitted Event sequence, or the input cursor for an empty page. Never return the last scanned private position. No raw latest-sequence, scanned count, candidate count or hidden-gap metadata.

Numeric Event sequences are already public in admitted stored projections (`worker/src/managed-history.ts:38`); this design adds no withheld-row position. It cannot retroactively conceal gaps in previously disclosed sequence numbers.

For merged/local/before/tail continuation, use an opaque cursor encoding only the last admitted boundary and selector/binding identity; never encode internal scan positions, hidden totals or holder inventory. Validate every cursor and reauthorize every page. An empty page returns the input cursor or null.

`more` requires an additional admitted row; absence of lookahead evidence is not `false`. Read the lookahead within the same cap or fail the whole query. ID lookup omits denied/unknown IDs uniformly. Tail/before/agent/task selectors change candidate acquisition only; none changes policy or projection.

The 10,000-cap failure exposes a bounded availability outcome, not a count or position. No stronger timing noninterference is claimed.

## 7. Guarded local-history request/reply

Do not call legacy `withLocalEvents` from managed plans: it is intentionally closed at `worker/src/channel.ts:3052`. Its holder selection and reply correlation are useful references (`:3084`, `:3136`, `:3161`), not authority.

`managed-local-history.ts` prepares a bounded request containing requester identity, exact binding, original selector, random request ID, target execution/Host, approved projection class, deadline and authority revision. Pending state is memory-only, bounded to 32 requests per query and 128 per Channel; reject excess with 503.

Before requesting:
- Independently authorize HR and constituent scopes through the facade.
- Resolve holder identity from trusted enrollment/Host registration, never caller login.
- Require current owner membership, exact execution/Host binding and holder capability.
- Check machine-local limits and target-owner consent for any private constituent.
- A Workspace grant alone never authorizes querying arbitrary machine-private data.

Shared history is restricted to shared Event projections. Transcript/screen/file activity requires its corresponding private action and current target-owner consent. DD-1 terminal_control consent is required for control effects; no history request may contain terminal input or approval control. Unsupported delegated private-agent requests remain denied until the DD-1 implementation supplies exact constraints.

Transport adapter checks generation/revision/authority deadline immediately before dispatch. Actual managed socket sends additionally require B4’s valid recipient lease and synchronous send guard. No new binding or unguarded stream is introduced.

Accept replies only from the exact pending socket/connection identity, Host/execution, generation, request ID and approved selector. Validate size, schema and bounds before projection; reject replay, replacement socket, foreign owner and selector expansion. Recheck requester and target identity/consent after reply and before release.

Use existing configured history wait as an upper bound (`worker/src/channel.ts:713`, `:3141`), further capped by query/authority deadlines. Cancel on invalidation, disconnect and timeout.

Preserve partial holder-unavailability behavior only for already authorized holders: return safe unavailable status and available admitted Events. Do not reveal unauthorized holder names, IDs or counts. Ineligible undisclosed holders are omitted. Authority failure is 503, not “holder offline.”

## 8. Non-bypass and adapters

Managed HTTP, typed internal query RPC, future MCP and future frame handlers all resolve the same registered plan. Actor-free managed query RPCs deny. Keep existing bare legacy RPC fences (`worker/src/channel.ts:1540`, `:2902`).

Do not feed raw query sources into legacy `askChannel`. Its raw connector contract is unsuitable (`worker/src/ask.ts:65`, `:73`). Define a managed answer assembled only from projected constituents; unknown lookup markers must be identical for absent and inaccessible targets.

Librarian quiet claims, Brief budget/counts and changes all derive from authorized constituents. Never call legacy feed for managed output; its raw `latest/through/more` computation is at `worker/src/librarian.ts:135`, `:158`, `:167`.

B1 creates reusable backlog/frame/query preparation. Managed upgrade and MCP admission remain closed until B4. At B4, SUB/session admission is additional to content-query authorization, and every frame has synchronous lease/generation/revision checking.

## 9. Family mapping

AV = agent.view; HR = channel.history.read; UR = channel.update.read; TR = task.read; WR = workspace.read.

| Inventory family | Plan / outer action | Constituents and projection | Required handler tests |
|---|---|---|---|
| H02 stored forward/ID/Wake | history / HR | events UR, agents AV, per-author AV; safe Event/Wake | Existing behavior plus sparse windows, IDs, release denial |
| H02 merged/local/tail/before/agent/task | history / HR | Same plus guarded holder adapter; private constituents separately denied/authorized | Every selector, holder identity, unavailable, private omission |
| H31 feed/cursor READ | librarian / HR | events UR, tasks TR, Brief UR, authors AV; safe changes/quiet/native holders | Initial/subsequent cursor, no raw latest/hidden more |
| H19 roster/detail | agents / AV | Per-target AV; SafeAgent | Roster/detail matrix and replacement execution |
| H19 summary | summary / AV | Tasks TR; history HR; Updates/notes UR; authors/successors AV | Independent constituents, successors, note caps, release denial |
| H03 | persons / WR | Native Person IDs through Organization roster adapter | Dual membership and changed roster at release |
| H33 | github / TR | Existing constrained integration reader | Exact repository, outage, binding/release changes |
| M02 preparation | connector.channel / WR | TR/HR/UR/AV; projected tasks/events/notes/agents; no Directives | Typed internal handler and fail-closed external MCP |
| M03 preparation | connector.github / TR | Reuse H33 plan/source | Internal handler plus external denial |
| M04 Brief preparation | connector.brief / UR | Allowlisted Brief page/list | Internal handler plus external denial |
| M04 costs | No B1 opening | Organization credential source belongs to B3/DD-2, MCP admission B4 | Preserve denial |
| W10/W11 preparation | stream.event/backlog / HR or payload action | Reuse Event/Task/Person/SafeAgent projections | Internal preparation plus actual closed-frame/upgrade assertions |
| W15/J04 preparation | local.history / HR | Guarded holder request/reply contract | Pending identity, no unguarded send, release denial |

Migrate shipped H02, H03, H19 roster/detail and H33 behavior onto the layer. Preserve H33 constrained GitHub reader (`worker/src/managed-github.ts:6`) and H03 Organization roster reader (`worker/src/organization.ts:1159`). Do not rebuild their authority logic.

## 10. B1c patch disposition and diagnostic failures

The saved patch is evidence only; do not apply it wholesale.

| Patch file/symbol | Disposition |
|---|---|
| managed-history.ts constants | Keep 1,000/10,000 values |
| managedHistoryPage | Keep with changes: explicit exhaustion/progress, shared query budget, lookahead, generic cursor adapter |
| channel.ts history scan hunk | Move into history plan/source adapter; remove embedded author-check duplication |
| channel.ts agent.summary hunk | Keep selection intent; replace with descriptors, shared notes/tasks/author projection and eligible successors |
| noteFromEvent use | Keep content selection with changes: explicit native attribution; no legacy login/person field release |
| New history-pagination tests | Preserve adversarial assertions; port fixtures to shared harness |
| New summary/notes/policy tests | Preserve assertions; repair invalid fixtures and use common authority fixtures |
| Notes/inventory hunks | Replace stale completion statements; retain useful diagnostic history, labelled unapplied |

Likely root cause of the reported 72 failures: both synthetic summary fixture families construct `${organizationId}:workspace`. Current `workspaceParent` accepts UUID:UUID only (`worker/src/policy.ts:76`, `:88`), and `managedRequest` rejects invalid parents before authority/content access (`worker/src/channel.ts:908`). This explains positives returning 404, empty constituent reads and outage tests returning 404 instead of reaching 503.

This is a source-based diagnosis, not a reproduced result. Fix fixtures with valid Workspace IDs; do not relax production parsing. The real-Organization fixture family must remain independently covered. Further failures may become visible after this correction.

## 11. One shared test harness

Add `worker/test/managed-query-cases.ts`: a surface table specifying request/RPC/frame invocation, expected scopes/targets, fixture constituents and observable effects. Reuse `managedAuthorityFixture` rather than inventing invalid identities (`worker/test/managed-helpers.ts:39`).

For every opened surface/selector run:
- Authorized positive through its real HTTP/RPC/frame handler.
- Non-member, foreign Organization, foreign Workspace, revoked execution, expired execution, wrong generation, insufficient role and insufficient scope.
- Each independent constituent denied before its first read and at release.
- Private-row insertion invariance for visible bytes/counts/cursors/order.
- Sparse/empty/short windows, exact cap, lookahead, malformed/replayed cursor and ID lookup.
- Holder unavailable/ineligible/replaced, consent absent/expired/revoked, forged reply and release-time denial.
- Authority timeout, revision-floor change and binding change during each await.

Assert no source reads, dispatch, counts or cursor before admission; no prepared bytes after release denial. Include real Organization/decide cases, not only injected authority denials.

Add source-discovered inventory coverage for actual router methods/matchers, public Channel RPCs, MCP tools and frame types. Each discovered surface must map to a query descriptor, explicit non-query protocol or justified denial. Fail on unknown entries; registry self-comparison alone is insufficient.

Compare every test present at `0bfb31f` byte-for-byte. D5 permits only deliberately opened-family deferral flips in P3-added tests; record file:line, old → new and matching positive/negative coverage. No timeout/config changes. Runtime status: **not run**.

## 12. Implementation slices

Estimates target one 25–40 minute run each; manager gates and independent review remain required.

| Slice | Exact scope/files | Estimated production/test delta | Tests and completion |
|---|---|---|---|
| B1q1 | managed-query.ts, registry, managed-channel.ts, managed-history.ts, policy-permits.ts, Channel adapters; migrate shipped stored history/H03/H33/roster | +450–650/−100–180 production; +250–400 tests | Shared harness, real authority matrix, sparse/cap/revision tests; `m1/p3/B1q1_DONE.md` |
| B1q2 | Query registry, projection/source adapters, Channel summary/librarian handlers; complete H19 successors/notes and H31 READ | +400–600/−80–150 production; +300–450 tests | Summary/feed matrices, native attribution, quiet/count/cursor tests; `m1/p3/B1q2_DONE.md` |
| B1q3 | managed-local-history.ts, history selector adapters, typed query RPC and connector/frame preparation; inventory and B1 summary | +400–650/−80–160 production; +300–450 tests | All selectors, guarded holder/pending cases, internal connector/frame preparation, exhaustive registry; `m1/p3/B1q3_DONE.md` and B1 summary |

Each slice updates inventory and implementation notes. Unopened families remain denied. B1q3 completes all B1 query/projection work, including guarded transport preparation; actual managed stream/MCP admission remains B4 as allocated.

Risks: q1 cursor compatibility and revision observations; q2 historical attribution and hidden relational counts; q3 reply identity, holder fanout and accidental stream opening. If estimates prove insufficient, leave a coherent gated subset with precise Remaining notes; do not claim completion.

## 13. B2–B4 impact and verdict

B2 cursor mutation must validate managed visible boundaries and use Organization permits; this read layer grants no mutation authority. B2 continuation may reuse authorized summary projection but must separately authorize private context/control.

B3 supplies trusted Host ownership, local ceilings, DD-1 consent and DD-2 credential sources. This design neither implements those controls nor stores credentials.

B4 reuses plans for per-tool MCP queries, backlog, frames and local-history dispatch. It must add leases, concurrent invalidation, pending cancellation and use-time send fences before opening those transports. Existing MCP closures call bare legacy readers (`worker/src/mcp/server.ts:100`); replace them with the actor-aware facade at that stage.

**No disproportionate architectural problem.** The existing Organization decision service, enforcement facade, binding fence and revision floor provide the necessary authority seams (`worker/src/organization.ts:1129`, `worker/src/managed-channel.ts:223`, `worker/src/channel.ts:872`, `worker/src/policy-permits.ts:48`). A bounded query executor and declarative constituent plans address the missing composition without changing policy vocabulary, adding bindings or rebuilding legacy readers.
