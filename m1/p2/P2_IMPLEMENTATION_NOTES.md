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
