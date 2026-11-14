# Package 2 implementation notes

## Changes (file:line)

## Tests added

## Commands run

## Deviations

## Escalations

## S1

### Changes

- `shared/src/m1.ts:65` (`AdminAuditRecord`) adds execution attribution and principal/execution targets. `shared/src/m1.ts:128` (`AgentPrincipal`), `:138` (`AgentExecution`), `:152` (`ExecutionActor`), `:158` (`VerifiedExecution`), `:161` (`AgentConstraints`), `:165` (`AgentGrant`), `:174` (`ExecutionCredentialMetadata`), `:182` (`IdentityCommand`), `:205` (`IdentityMutation`) and `:212` (`IdentityValue`) define separate stable/transient identities and metadata-only contracts. Optional legacy references are declarations only in S1.
- `worker/src/executions.ts:12` (`secretDigest`), `:16` (`equalDigest`), `:22` (`parseCredential`), `:31` (`prepareCredential`) implement SHA-256, a fixed 32-byte XOR comparison, strict canonical base64url parsing, and 32 random secret bytes. `:36` (`credentialExpiry`) uses server milliseconds, one-hour default, rejects invalid or >24-hour lifetimes and caps to grant expiry. `:48` (`validConstraints`) supports only action narrowing and denies unknown constraints. `:57` (`StoredCredential`) is Worker-internal digest storage.
- `worker/src/principals.ts:12`–`:31` define explicit role/action sets with no private or lifecycle delegation to executions. `:38` (`humanActions`) requires current matching Organization and Workspace membership/parent rows; `:59` (`administrator`) and `:63` (`managesPrincipal`) separate administration from sponsorship. `:71` (`effectiveActions`) intersects organization ceiling, Workspace policy, explicit grant, current sponsor authority and grant/execution constraints. Descriptors are never consulted.
- `worker/src/organization.ts:82` initializes separate principal/execution/grant/policy/credential/redemption tables in the existing Organization DO. `:143`–`:154` are private row helpers. `:156` (`mutateIdentity`) prepares crypto outside the synchronous transaction (`:160`, `:167`), re-reads current authority, checks parents, sponsorship, delegation, revision/generation and replay fingerprint, then commits state/revision/audit/metadata replay together (`:400`–`:435`). Server-generated execution owner is the authenticated actor; no owner field is accepted. Rotation increments generation without overlap. Revocation/disable are authoritative state changes. Secrets exist only in the initiating return value; replay explicitly removes them.
- `worker/src/organization.ts:438` (`verifyExecution`) hashes before its synchronous authoritative reads, verifies routing and exact credential/execution/principal/workspace/generation binding, expiry and current effective actions. It returns identity plus the current narrowed action set, never digest/secret. No positive authorization cache is introduced.
- `worker/src/organization.ts:508` (`audit`) retains execution attribution only for matching stored associations, bounded redacted denial aggregation, and principal/execution targets. `:575` (`cleanup`) adds bounded redemption-tombstone deletion using `retain_until`; existing replay cleanup remains bounded. S2 must populate Person-bound hashed code rows and set their 24-hour retention; S1 does not implement redemption.
- `worker/src/policy.ts:13`–`:15`, `:43` (`decide`) add fresh verified-execution scope and an explicit P2 `identityPolicy` opt-in. `worker/src/organization.ts:211` enables it only in identity lifecycle decisions; `:590` (`context`) defaults it off. Existing P1 tests explicitly require agent.register/task.read/channel.subscribe denial in P1 contexts (`worker/test/organizations.test.ts:490`–`:501`); their contexts and assertions remain unchanged. Agent lifecycle/grant actions remain denied for execution actors.
- File changes are confined to the S1 ownership table plus these notes and S1_DONE.md. No Channel/HTTP/auth/CLI/config/binding files or existing tests were edited. Linked Channel enforcement remains closed and outside S1; no legacy-path await/RPC was added. These are diff inspection statements, not runtime compatibility claims.

### Tests added

New file `worker/test/scoped-executions.test.ts` uses actual Organization RPCs and `runInDurableObject` for storage inspection/fault injection. Exact `it()` titles:

- `:102` — `attributes two distinct executions and credentials to one stable principal`
- `:125` — `uses server time with one hour default and exact expiry denial`
- `:139` — `caps execution lifetime at 24 hours and grant expiry`
- `:157` — `atomically rotates once and immediately rejects the old generation`
- `:173` — `denies on execution revoke principal disable sponsor removal demotion and grant revoke`
- `:247` — `rejects grants beyond grantor authority including Bob delegating what Bob lacks`
- `:276` — `rejects wrong length malformed and garbage secrets`
- `:303` — `never derives authority from declared capabilities or admin private access`
- `:353` — `denies organization offboarding and requires explicit organization sponsorship ceiling`
- `:452` — `denies admin start without workspace authority and never accepts an execution lifecycle actor`
- `:496` — `narrows execution actions without allowing foreign resources or invented constraints`
- `:557` — `cleans expired redemption tombstones in bounded batches without deleting retained hashes`
- `:577` — `replays only metadata and rolls back identity audit revision and replay together`

The demotion case asserts the recomputed read-only intersection and denial of task.claim, followed by complete denial after membership removal (`worker/test/scoped-executions.test.ts:173`). The rollback case injects a replay SQL failure within the DO and checks execution/credential/audit/revision rollback and survival of the previous credential (`:577`). Neither case is claimed executed.

### Commands and actual results

All Node commands used `export PATH=/home/box/.local/node22/bin:$PATH`, from `worker/`.

- `npm run typecheck`: initial incomplete implementation failed with strict indexing/unused-import errors; corrected. Subsequent runs, including the final production/test version, exited **0** (both TypeScript projects).
- `npm run lint`: initial run failed on import organization; intermediate runs exited 0 with warnings; corrected. Final run exited **0**, 161 files checked, no diagnostics.
- Targeted `npx biome check --write` / `npx biome format --write` on the six S1 source/test files: applied formatting/import fixes; final targeted check exited **0**. No configuration semantics changed.
- `npx vitest run test/scoped-executions.test.ts`: exited **1 during config startup**, `EROFS: read-only file system` writing `worker/node_modules/.vite-temp/vitest.config.ts.timestamp-…mjs`. Shared node_modules resolves outside the writable worktree. **Zero tests executed; no runtime test pass is claimed.** No sandbox/config/dependency workaround attempted.
- `git diff --check`: exited **0**. Read-only `git status --short`, `git diff`, source reads/searches were used for inspection.
- Full worker suites: **not run**, manager-owned. CLI checks/tests: **not run**, no CLI changes. HTTP/code lifecycle, registration, legacy integration and full managed-route/stream tests: **not run**, later slices/packages.

### Deviations and integration constraints

- Added private `identity.policy` command (`shared/src/m1.ts:194`) to express the explicit Organization and Workspace action ceilings. Both start empty (`worker/src/organization.ts:150`); admins configure them with audited revision-checked mutations. No new public policy route was added. S2 must expose/configure approved policy fields through authenticated adapters before API issuance can succeed.
- P2 decisions require the explicit context opt-in to preserve P1's existing closed action vocabulary (`worker/src/policy.ts:15`, `worker/test/organizations.test.ts:490`). Existing tests remain unmodified. Shared content-route enforcement remains P3; S1 only returns verified effective actions.
- Redemption schema/cleanup are present (`worker/src/organization.ts:87`, `:575`); one-use redemption creation/consumption and its error mapping remain S2 as planned. HTTP no-store/origin handling and managed bearer dispatch are also S2.
- No changes to the approved storage placement, dependencies, deployment configuration, Channel generation fences or legacy session semantics. P1R-1..4 remain deferred.

### Escalations

- **Deny pending explicit contributor-start design:** proposal §6 permits contributor start only when explicitly authorized as sponsor (`m1/M1_ARCHITECTURE_PROPOSAL.md:82`), but P2's command/API plan does not specify a separate human start-authority grant representation. S1 permits start/rotate only with current explicit Workspace manager membership plus current sponsor/admin control and an effective agent grant (`worker/src/organization.ts:240`, `worker/src/policy.ts:109`). Organization admin status alone does not confer start; Person sponsorship alone does not upgrade contributor authority. A separate mechanism must be approved before enabling contributor starts. No implicit administrative bypass was introduced; tested denial is authored at `worker/test/scoped-executions.test.ts:452`, not executed.
- Runtime evidence is blocked by the shared dependency directory's read-only Vite cache location; the manager must execute the 13 new tests and unchanged suites. S1 code completion is not a claim of runtime or full milestone acceptance.

## S2

### Changes

- `worker/src/execution-api.ts:7` (`isExecutionPath`) and `:14` (`handleExecutionApi`) implement the P2 principal, grant, execution, redemption, rotation and revocation route rows. `worker/src/workspace-api.ts:11` dispatches only matching P2 paths through the existing Worker `/api/m1` dispatch (`worker/src/index.ts:396`). No index edit is necessary. Diff inspection shows no Channel, legacy route, CLI, config, dependency or existing test edits; runtime compatibility has not been established here.
- `worker/src/execution-api.ts:16` (`reply`) applies no-store; `:21` (`error`) returns requestId/revision and redemption error codes; `:38` rejects malformed paths. `:75` reuses native Person authentication and its explicit cookie-write Origin check (`worker/src/auth.ts:125`, `readNativeActor`). `:79` handles scoped principal/grant reads, signed Person/path-bound ten-minute cursors and reauthorization per page. `:119` validates Idempotency-Key, bounded JSON and revision headers (PUT/rotate included); `:137` constructs allowlisted commands. Actor/owner/command injection and unknown sponsor fields deny; rotate requires expectedGeneration. Original method/path/body/revision fingerprints are supplied at `:208`. Foreign errors and CODE_INVALID redact revisions (`:210`); authority exceptions return static 503 (`:220`).
- `worker/src/auth.ts:146` (`readExecutionActor`) verifies header-only managed bearers through their authoritative Organization. Legacy `readCredential` remains unchanged (`worker/src/auth.ts:102`). The managed branch at `worker/src/execution-api.ts:48` allows only the execution's own principal view with agent.view; lifecycle/grant calls deny with redacted action audit through `worker/src/organization.ts:541` (`auditExecutionDenial`). Managed credentials are not enabled on Channel content or streams.
- `worker/src/organization.ts:157` (`mutateIdentity`) prepares crypto before transactionSync, validates code hash/Person/execution/generation (`:208`), and rechecks current authority (`:229`). Redemption-mode start returns an execution plus code, with no stored usable credential. Codes expire after 60 seconds, retaining unused/expired hashes until expiry plus 24 hours (`:449`); consumption and credential creation commit atomically, retaining consumed hashes for 24 hours (`:454`). Wrong Person/unknown/mismatch returns 400 CODE_INVALID, matching expired 410 CODE_EXPIRED, consumed 409 CODE_USED even on same-key retries (`:220`). Rotation invalidates pending codes by generation. Redemption recalculates grant/lifetime caps (`:377`) and advances generation. Replay strips both secret and code (`:491`). No plaintext code/secret enters SQL or replay in these changes.
- `worker/src/organization.ts:311` (`principal.update`) resolves omitted PATCH fields inside the transaction after original-body fingerprinting. `:507` (`identityCatalog`) returns at most 100 visible principals; `:528` (`identityGrant`) requires current sponsor/admin management plus Workspace grant authority; `:558` (`executionPrincipal`) re-verifies bearer before scoped metadata retrieval.
- `worker/src/workspace-api.ts:195` adds audited revision-checked ceiling-only organization/Workspace PATCH bodies using S1's `identity.policy`. Mixed name/ceiling bodies deny, avoiding non-atomic combined mutations. Current administrator authority remains enforced (`worker/src/organization.ts:266`).
- `shared/src/m1.ts:110` (`NativeResult`) adds 410; `:188` (`IdentityCommand`) adds explicit redemption start mode and redemption command; `:213` (`IdentityMutation`) adds trusted-adapter fingerprints; `:221` (`IdentityValue`) adds an ephemeral code. Durable replay excludes both one-time values (`worker/src/organization.ts:491`).

### Tests added

New file `worker/test/execution-api.test.ts`, using actual Organization RPCs and public Worker APIs. Exact `it()` titles (authored, not executed):

- `worker/test/execution-api.test.ts:86` — `rejects unauthorized sponsor and body owner impersonation`
- `worker/test/execution-api.test.ts:106` — `denies execution actors every lifecycle and grant mutation including self grant`
- `worker/test/execution-api.test.ts:127` — `denies foreign organization credentials without resource metadata`
- `worker/test/execution-api.test.ts:140` — `rejects tampered org and credential routing fields`
- `worker/test/execution-api.test.ts:150` — `returns invalid for wrong Person or unknown code expired 410 and used 409`
- `worker/test/execution-api.test.ts:189` — `serializes concurrent redemption and retains hashed tombstones for 24 hours`
- `worker/test/execution-api.test.ts:213` — `never replays secrets or codes on idempotent retry and rejects changed bodies`
- `worker/test/execution-api.test.ts:236` — `excludes planted secret markers from audit events logs replay and Channel storage`
- `worker/test/execution-api.test.ts:285` — `denies legacy session agent Host and connector tokens on m1 lifecycle routes`
- `worker/test/execution-api.test.ts:292` — `enforces no store origin revision generation pagination and foreign ID denial`
- `worker/test/execution-api.test.ts:330` — `paginates principal views with actor and resource bound cursors`
- `worker/test/execution-api.test.ts:364` — `rechecks principal and grant revocation on every managed bearer use`
- `worker/test/execution-api.test.ts:375` — `invalidates pending codes on rotation and rolls back consumption with issuance`

The confidentiality case inspects Organization SQL/audit/replay/digests, console spies and a fresh Channel SQL/KV sentinel (`worker/test/execution-api.test.ts:236`). No event producer or Channel call is present in `worker/src/execution-api.ts:14` (`handleExecutionApi`); source inspection is not runtime event delivery evidence. Legacy token-shaped strings supplement a signed historical Person session; they are rejection cases, not full Host/connector integration fixtures (`worker/test/execution-api.test.ts:285`). Injected SQL exceptions are caught inside the DO boundary to avoid the known uncaught-RPC failure pattern (`worker/test/execution-api.test.ts:377`).

### Commands and actual results

All Node commands used `export PATH=/home/box/.local/node22/bin:$PATH`, from worker/.

- `npm run typecheck`: initial development runs failed on an accidentally duplicated preparation block and an unused helper; corrected. Subsequent runs, including the final source/test version, exited **0**, both TypeScript projects.
- Targeted `npx biome check --write` on the changed source files, shared/src/m1.ts and new test file: applied formatting/import fixes. Final targeted run exited **0**, no diagnostics.
- `npm run lint`: final run exited **0**, 163 files checked, no diagnostics.
- `npx vitest run test/execution-api.test.ts`: exited **1 during config startup**, EROFS writing `worker/node_modules/.vite-temp/vitest.config.ts.timestamp-…mjs`. **Zero tests executed.** Shared dependency cache resolves outside the writable worktree. No test/config/dependency workaround used; no runtime pass is claimed. Later test additions were typechecked/linted but did not receive runtime verification through this blocked command.
- `git diff --check`: exited **0**. Read-only git status/diff and source reads/searches used for inspection.
- Existing S1 tests and full worker suites: **not run**; the manager owns full-suite execution, and focused S2 startup is blocked. CLI checks/tests: **not run**, no CLI changes. No network, dependency install, credential-file read, git mutation or deploy performed.

### Deviations

- Dispatch lives in workspace-api rather than adding another index branch (`worker/src/workspace-api.ts:11`, `worker/src/index.ts:396`). S1 crypto/lifetime helpers suffice without an executions.ts edit (`worker/src/executions.ts:12`, `:36`).
- Ceiling-only PATCH uses approved organization/Workspace rows; mixed name/policy updates safely deny (`worker/src/workspace-api.ts:195`). No unapproved policy endpoint was added.
- Rotation requires If-Match plus expectedGeneration, preserving S1's revision boundary (`worker/src/execution-api.ts:131`, `worker/src/organization.ts:288`). Lost issuance responses require fresh-key rotation; code/credential retries never replay secrets (`worker/src/organization.ts:491`). Same-code redemption retry returns CODE_USED (`worker/src/organization.ts:225`).
- Hash retention is 24 hours after expiry/consumption, preserving errors for the whole tombstone period (`worker/src/organization.ts:449`, `:458`).

### Escalations

- No new trust-boundary exception enabled. S1's unresolved contributor-start design remains safely denied: current Workspace manager/start authority and sponsor/admin control are required (`worker/src/organization.ts:271`). Registration/CLI linkage remains S3; content enforcement, linked Channel opening and stream revalidation remain P3. This slice does not establish live managed Channel operation.
- Runtime verification is blocked by read-only Vite cache storage. Manager must execute the 13 new cases, S1 tests and unchanged full suites before acceptance. Typecheck/lint do not establish runtime correctness.
