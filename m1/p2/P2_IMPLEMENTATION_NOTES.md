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

## S3

### Changes

- `shared/src/agents.ts:197` (`RegisterAgentRequest.managed`) adds explicit principal/Workspace intent; `:264` (`AgentResponse.execution`) adds metadata without changing existing Agent/session IDs. `shared/src/m1.ts:150` (`AgentExecution.legacyChannel`) and `:209` (`IdentityCommand.registration`) add internal association/routing references. Public lifecycle start still allowlists only principalId/cli/lifetimeMs/constraints/mode (`worker/src/execution-api.ts:179`), so callers cannot supply these trusted registration fields.
- `worker/src/agents-api.ts:270` (`handleAgentRoute`, register branch) detects intent before the legacy parser can discard it. Ordinary registration still dispatches directly to `channel.registerAgent`; heartbeat dispatch is unchanged (`worker/src/agents-api.ts:277`, `:283`). Managed intent does not silently become legacy registration.
- `worker/src/channel.ts:1062` (`registerManagedAgent`) validates intent, fresh native Person association, exact linked Workspace/Channel pairing, prior native ownership and a bounded idempotency key before issuing through Organization. It derives the legacy Person/AgentId from the signed native session (`:1181`, `nativeLogin`), not a body owner. Managed registrations serialize per Channel; all awaited enrollment stages have generation checks before association/result release. Issuance retries return 409 without replaying a secret. Failed registration queues execution termination. Managed continuation/handoff is denied pending P3's consent enforcement; Host validation remains in the existing registration method (`:1288`, `registerAgent`).
- `worker/src/channel.ts:1132` initializes **only after authorized issuance**, lazily, `m1_agent_executions` (AgentId, Organization ID, execution ID, active bit) and `m1_agent_execution_ends` (IDs only). No managed bearer, code, digest or native session is persisted there. No constructor migration/query/await was added. `:602` (`presenceChanged`) synchronously invalidates a managed association on Gone before notifying Organization. `:1203` (`registeredExecutionActive`) checks the persisted association and current roster/binding, including after restart. `:1217` (`queueManagedEnd`), `:1236` (`deliverManagedEnd`), `:1256` (`retryManagedEnds`) persist idempotent metadata-only retries and drain at most 20 per alarm. `worker/src/alarms.ts:10` adds the `executions` job; `worker/src/channel.ts:730` dispatches it independently of legacy presence deadlines.
- `worker/src/channel.ts:1312` (`registerAgent`) ends a previous managed association after existing registration validation; `:1425` (`heartbeat`) touches managed execution liveness. Both use a synchronous binding-workspace branch and perform no new RPC/await/association query for unlinked requests. This is source inspection, not executed compatibility evidence.
- `worker/src/organization.ts:421` (`mutateIdentity`) authoritatively checks Workspace/Channel pairing and stores the server-provided legacy AgentId/session/Channel alongside execution ownership. `:574` (`touchRegisteredExecution`) updates server lastSeen; `:583` (`registeredExecutionOwnedBy`) prevents native-owner takeover; `:588` (`endRegisteredExecution`) atomically marks ended, advances generation and audits once, returning false on recoverable storage failure instead of throwing across RPC. `:631` (`verifyExecution`) verifies the digest before calling the managed-only Channel association check, then re-reads credential, generation, principal, grant and current authority after that await. Failed/missing association or unavailable Channel denies. Unassociated executions take no Channel RPC.
- `cli/src/principal-config.ts:11` (`principalSelection`) accepts only nonsecret same-Organization selections; `:38` (`authenticateNative`) always uses a new native device flow, without legacy config/session exchange or Channel join. `:80` (`readRedemptionCode`) uses non-echo raw TTY input and restores the terminal. `:119` (`readFreshExecutionId`) accepts a new nonsecret execution ID after expiry. `:130` (`redeemExecution`) authenticates each attempt, sends code only in POST JSON, disables redirects, binds returned execution/principal/Workspace/credential metadata and retries CODE_EXPIRED at most once with a fresh execution. CODE_USED/invalid errors do not retry; errors omit response bodies and credentials. Secrets remain return values in memory; this module imports no filesystem persistence API.
- `cli/src/channel-client.ts:110` (`managed`) latches managed intent, rejects credential downgrade/fallback and legacy joins, and validates managed registration metadata (`:249`, `register`). `:152` (`requestAs`) carries scoped bearers only in Authorization, refuses redirects and redacts managed failures. `:301` (`follow`) denies managed streaming, including when a preexisting legacy stream switches to managed intent/token; the guard precedes query-token construction. Legacy registration/streaming use their existing branches. The existing stdio tool layer already uses this client (`cli/src/mcp-server.ts:273`, `SwitchboardTools`; `:308`, `useAgentToken`), so an in-memory scoped credential uses the same header path without a tool-layer edit.
- `cli/src/main.ts:232` (`execution redeem`) wires explicit selection, new native login, hidden input and bounded redemption; parse errors are static so unexpected argv is not echoed. It retains no credential after the command exits. `cli/src/run.ts:211` (`runCli`) explicitly denies managed wrapper switches until P3 instead of allowing adapter passthrough or a legacy fallback. `CONTEXT.md:29` adds AgentPrincipal, AgentExecution, AgentGrant and execution credential terminology.
- P1 fences are untouched in the diff: Worker post-dispatch checks (`worker/src/index.ts:373`, `:377`), Channel fetch checks (`worker/src/channel.ts:2342`), generation-zero untagged socket behavior (`:2391`, `socketTags`; `:2396`, `socketIdentityTags`) and WebSocket generation checks (`:2411`, `webSocketMessage`). Existing tests, adapters, Host implementation, session signing, GitHub sync, Relay, claims, dependencies and test/deployment configuration were not edited. These are diff-inspection claims, not full-suite runtime results.

### Tests added

New `worker/test/managed-registration.test.ts` uses actual Organization/Channel RPC boundaries, native identity helpers, local GitHub fakes and bounded in-DO storage inspection. Exact `it()` titles (authored; **not executed**):

- `:101` — `preserves legacy registration heartbeat session IDs AgentId and Host behavior`
- `:123` — `links only human authorized intent and rejects legacy token exchange`
- `:149` — `ends managed execution on Gone and resumes with a fresh execution`
- `:173` — `denies unlinked intent without registration and never replays a managed secret`
- `:195` — `denies Gone credentials while retrying a failed execution end notification`
- `:227` — `serializes competing registrations without reviving the replaced execution`

The failure test installs a SQL trigger, checks the end RPC's false result, verifies credential denial while the local outbox remains pending, then removes the trigger and explicitly makes only the new execution alarm due (`worker/test/managed-registration.test.ts:195`). It changes no test timeout/config and lets no deliberate exception escape over RPC.

New `cli/test/managed-executions.test.ts` uses mocked HTTP, sockets and terminal input; no live service is contacted. Exact `it()` titles (authored; **not executed**):

- `:30` — `redeems as the bound Person retries expired codes within a fixed bound and keeps secrets out of URLs and output`
- `:67` — `uses scoped bearer HTTP denies managed streaming and preserves legacy registration and streaming`
- `:106` — `uses scoped bearer headers and redacted failures in the stdio tool layer`
- `:129` — `rejects legacy fallback after explicit managed registration intent`
- `:152` — `authenticates through the native device flow without a legacy session or Channel join`
- `:181` — `reads redemption codes without echo and restores terminal input`

The stdio-layer case injects the scoped bearer through the existing `SwitchboardTools` memory callback and checks headers, URL/body confidentiality, returned errors and captured stderr (`cli/test/managed-executions.test.ts:106`). It does not establish live wrapped-CLI usability.

### Commands and actual results

Node commands used `export PATH=/home/box/.local/node22/bin:$PATH` in the relevant package directory.

- Worker `npm run typecheck`: initial production-only pass; later new fixture typing failed and was corrected. Final source/test runs exited **0**, both TypeScript projects.
- Worker `npm run lint`: intermediate concurrency-test non-null assertions produced warnings; removed. Final run exited **0**, 164 files, no diagnostics.
- CLI `npm run typecheck`: passed; an intermediate main.ts help-comment edit produced a syntax error, corrected immediately. Final source/test run exited **0**.
- CLI `npm run lint`: intermediate duplicate stream variable and help-comment errors were corrected. Final run exited **0**, 132 files, no diagnostics.
- Targeted `npx biome check --write` on only changed production/shared files and the new tests applied formatting/import fixes; final targeted runs exited **0**. No configuration was changed.
- Worker `npx vitest run test/managed-registration.test.ts`: attempted twice; both exited **1 at config startup** with EROFS writing `worker/node_modules/.vite-temp/vitest.config.ts.timestamp-…mjs`. **Zero tests executed.** Later concurrency/fault-test refinements were typechecked/linted; runtime remains unverified.
- CLI `npx vitest run test/managed-executions.test.ts`: attempted twice; both exited **1 at config startup** with the equivalent read-only `cli/node_modules/.vite-temp` error. **Zero tests executed.** Later native-login/raw-input test additions were typechecked/linted; runtime remains unverified. No dependency/cache/config workaround attempted.
- One npm typecheck invocation from the repository root failed with ENOENT because no root package.json exists; all actual package verification above used worker/ or cli/. Two initial test-file write attempts used package-relative paths from the wrong cwd and failed without writing; the files were subsequently created in the worktree root and checked.
- `git diff --check`: exited **0** during inspection and after implementation. Read-only git status/diff and source reads/searches were used. Full worker/CLI suites and live managed workflows: **not run**; manager-owned. No git mutation, network access, install, credential-file read or deploy performed.

### Deviations

- Added one runtime-only AlarmJob union member in `worker/src/alarms.ts:10`, outside the original S3 ownership table. This is required for durable execution-end retries without overwriting the legacy presence schedule. No alarm scheduler semantics, config, binding, migration tag or timeout changed; the new job is scheduled solely by managed association termination (`worker/src/channel.ts:1217`).
- Added internal registration fields in `shared/src/m1.ts:150`, `:209` because the authoritative Organization needs the Channel/session routing reference. The public API allowlist continues to reject body-supplied association/owner fields (`worker/src/execution-api.ts:179`). Channel retains only association/outbox IDs and an inactive bit; authoritative lifecycle/policy/credentials remain in Organization (`worker/src/organization.ts:421`, `:588`, `:631`).
- The CLI uses an explicit `execution redeem` command rather than enabling managed `run` while P3 enforcement is absent (`cli/src/main.ts:232`, `cli/src/run.ts:211`). Nonsecret selection is explicit argv, not persisted config. Expiry prompts for a freshly server-issued execution ID plus hidden code because S2 has no code-refresh endpoint on an expired execution (`cli/src/principal-config.ts:119`, `:171`). The command is enrollment/verification scaffolding: it deliberately does not persist or print the credential, start an adapter, or claim a usable managed Channel workflow.
- No ADR change: stable principal/execution separation, opaque credential lifecycle, storage placement and the accepted fail-closed P2/P3 boundary are unchanged (`docs/adr/0056-agent-principals-are-separate-from-executions.md:11`, `:15`). P1R-1..4 remain deferred.

### Escalations

- **Deny until P3 admission:** native and legacy sessions have distinct payload kinds (`worker/src/session.ts:83`, `:115`, `:129`), and linked Channels intentionally deny public admission (`worker/src/channel.ts:761`, `managedClosed`; `worker/src/index.ts:373`). S3 must not make an auth exception to open linked Channels. Positive registration tests therefore call the internal native-authenticated adapter; public managed registration/content/streams remain closed. P3 must route native/execution actors through its enforcement inventory before enabling them. No new managed content permission or legacy-token exchange was enabled (`worker/src/channel.ts:1062`, `cli/src/channel-client.ts:306`).
- **No disk handoff for scoped secrets:** the existing wrapped-CLI stdio handoff writes legacy Agent credentials to its temporary agent file (`cli/src/mcp-config.ts:99`, `:101`). S3 does not put an m1 credential through that path; managed `run` fails closed (`cli/src/run.ts:211`). Scoped HTTP and the existing stdio tool layer support in-memory bearer use and have dedicated tests (`cli/test/managed-executions.test.ts:67`, `:106`), but live adapter/process integration remains behind the P3 gate. No file-based workaround or adapter change was introduced.
- S1's contributor-start authority escalation remains unchanged. Runtime acceptance is blocked by read-only Vite cache storage; the manager must execute all 12 S3 cases plus existing suites. Passing typecheck/lint is not evidence that these runtime/security assertions passed.
