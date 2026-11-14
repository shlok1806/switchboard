# Package 1 implementation notes

## Changes (file:line)

## Tests added

## Commands run

## Deviations

## Escalations

## S1

### Changes (file:line + symbol)

- `shared/src/m1.ts:2` (`PersonActor`), `:8` (`OrganizationMembership`), `:16` (`WorkspaceMembership`), `:25` (`NativeWorkspace`), `:34` (`NativeOrganization`), `:41` (`MembershipInvitation`), `:64` (`AdminAuditRecord`), `:79` (`NativeMutation`): new P1 domain/command/result types. `shared/src/index.ts:19` exports the module.
- `worker/src/organization.ts:53` (`Organization`): SQLite-backed aggregate; native state is a JSON document in SQLite, with separate creation/replay/audit/outbox tables. `:70` (`initialize`) atomically creates the explicit owner and immutable creation replay result, checking the DO routing ID. `:115` (`enqueue`) and `:123` (`alarm`) schedule durable directory repair and bounded cleanup.
- `worker/src/organization.ts:132` (`audit`) stores bounded redacted fields, target identifiers, and first/last/count denial aggregation. `:177` (`cleanup`) deletes at most 100 expired replay/audit rows per call; audit reads exclude records older than 90 days. No API updates/deletes individual audit records; only denial aggregate counters and retention cleanup mutate existing audit storage.
- `worker/src/organization.ts:199` (`mutate`): SHA-256 canonical command fingerprints; authoritative checks, expected revision, last-owner guard, mutation, revision increment, audit, replay and outbox enqueue in one synchronous SQLite transaction. Replay expires after 24 hours; seven-day exact-numeric-ID invitations require explicit acceptance, and acceptance rechecks inviter authority. Workspace creation explicitly accepts creator manager membership. Direct org enrollment and reactivation require invitations; workspace grants require active org membership and a bounded reason.
- `worker/src/organization.ts:466` (`metadata`): authoritative active membership before exposing org metadata.
- `worker/src/organization.ts:481` (`workspace`): explicit workspace membership for reads, with a separate admin metadata flag and redacted read-denial audit.
- `worker/src/organization.ts:499` (`auditRecords`): admin-only bounded audit reads.
- `worker/src/organization.ts:526` (`repairDirectory`): generation-fenced outbox acknowledgment; invitation routes and Person→org candidates are derived, never authority.
- `worker/src/identity-directory.ts:6` (`IdentityDirectory`), `:14` (`resolve`), `:31` (`associated`), `:39` (`createOrganization`), `:79` (`indexCandidate`), `:82` (`organizations`), `:103` (`routeInvitation`), `:106` (`invitationOrganization`): singleton `directory-v1` identity and routing seam. Numeric ID uniquely maps to Person UUID; login changes preserve UUID. Org creation reserves a server ID transactionally before RPC so interrupted retries reuse it. Candidate listings are bounded at 50 and recheck each authoritative Organization before exposing names; failures propagate closed.
- `worker/src/policy.ts:16` (`validPerson`), `:27` (`workspaceParent`), `:31` (`decide`): concrete Person/UUID and parent validation, deny unknown actors/actions/resources/roles, require active org membership, enumerate P1 role actions, separate admin metadata access from content. No P2/P3 action is enabled.
- `worker/wrangler.jsonc:20` preserves CHANNEL; `:27` preserves v1 and appends exactly v2-m1-authorization with the two SQLite classes. `worker/src/index.ts:57` exports IdentityDirectory and Organization. `worker/worker-configuration.d.ts:23` adds bindings and `:30` adds namespace names (small manual generated-declaration update; no Wrangler generation command).
- `worker/vitest.config.ts:62` uses explicit local main/compatibility/DO/assets configuration rather than Wrangler loading. Test values remain the existing pinned bindings (`worker/vitest.config.ts:9`, `:28`); this avoids credential-file loading during the permitted targeted tests. Production Channel source, auth, adapters, sync and existing tests/helpers were not edited (reviewable changed-file list from `git status --short`).

### Tests added

All cases below are in `worker/test/organizations.test.ts`; these are authored assertions, **not passing runtime evidence**. HTTP-sounding planned titles exercise internal RPC/decision behavior in S1; HTTP/cursor authentication cases remain S2.

- `worker/test/organizations.test.ts:59` — it("creates Org A and B and repo-free Operations and Finance").
- `worker/test/organizations.test.ts:70` — it("creates explicit owner and creator manager memberships").
- `worker/test/organizations.test.ts:82` — it("updates metadata only with current authority and revision").
- `worker/test/organizations.test.ts:87` — it("accepts only the exact invited numeric GitHub id").
- `worker/test/organizations.test.ts:96` — it("rejects expired and consumed invitations").
- `worker/test/organizations.test.ts:115` — it("requires audited explicit workspace grants").
- `worker/test/organizations.test.ts:139` — it("supports one Person in multiple organizations").
- `worker/test/organizations.test.ts:143` — it("denies nonmember direct ID GET without metadata").
- `worker/test/organizations.test.ts:147` — it("rejects foreign-org resource IDs").
- `worker/test/organizations.test.ts:159` — it("prevents cross-org listing and cursor leakage").
- `worker/test/organizations.test.ts:164` — it("denies revoked membership despite orphan workspace rows").
- `worker/test/organizations.test.ts:192` — it("denies unknown actors actions and resources").
- `worker/test/organizations.test.ts:217` — it("does not infer workspace access from GitHub collaboration").
- `worker/test/organizations.test.ts:225` — it("allows admin metadata without shared-content or private-session access").
- `worker/test/organizations.test.ts:251` — it("recomputes demoted admin authority while retaining explicit membership").
- `worker/test/organizations.test.ts:287` — it("refuses last-owner removal and demotion").
- `worker/test/organizations.test.ts:298` — it("refuses conflicting invitation roles without silently demoting an owner").
- `worker/test/organizations.test.ts:308` — it("rolls back state revision audit and replay together").
- `worker/test/organizations.test.ts:328` — it("replays identical keys and returns 409 for changed bodies").
- `worker/test/organizations.test.ts:334` — it("rejects stale If-Match").
- `worker/test/organizations.test.ts:341` — it("scopes redacted audit reads to organization admins").
- `worker/test/organizations.test.ts:348` — it("never authorizes from stale directory entries and repairs missing index entries").
- `worker/test/organizations.test.ts:363` — it("routes invitations to the exact identity and preserves UUID across login changes").
- `worker/test/organizations.test.ts:375` — it("denies replay after authority revocation").
- `worker/test/organizations.test.ts:389` — it("refuses admin owner escalation and invitations from demoted inviters").
- `worker/test/organizations.test.ts:416` — it("accepts explicit workspace invitations atomically").
- `worker/test/organizations.test.ts:433` — it("expires replay records after 24 hours and bounds audit retention cleanup").
- `worker/test/organizations.test.ts:447` — it("aggregates bounded redacted denial records").
- `worker/test/organizations.test.ts:456` — it("uses exact P1 role action sets and refuses all future content actions").

### Commands run / actual results

All Node commands used `export PATH=/home/box/.local/node22/bin:$PATH`, working directory `worker/`. No dependency installation, network/live-service commands, git writes, or deployment.

- `npm run typecheck`: passed, exit 0, on the initial implementation and subsequent revisions; final result recorded below after completion.
- `npx biome check --write` on only owned source/config/new-test paths: exit 0. Initial formatting run reported two optional-chain warnings; both fixed. Subsequent formatting runs succeeded.
- `npm run lint`: passed, exit 0, including revised source/tests; reported 153 files checked with no fixes. Final result recorded below after completion.
- `npx vitest run test/organizations.test.ts`: attempted; exit 1 before any test assertions, `Error: listen EPERM: operation not permitted 127.0.0.1` on Node v22.23.5. Sandbox forbids the local listener. A final retry after additional cases is recorded below. No test is claimed passed.
- `git diff --check`: exit 0. Read-only `git status --short`/`git diff` and bounded source/document reads were used for inspection.
- Full worker/CLI/dashboard suites: not run; manager-owned. No legacy compatibility pass or measured outbox recovery is claimed.

### Deviations from plan/proposal

- Physical aggregate state uses a single JSON row inside SQLite, with separate transactional replay/audit/outbox tables (`worker/src/organization.ts:53`), rather than inventing a normalized table contract. Local atomicity and one authoritative Organization remain as designed. Runtime SQL/DO behavior still needs the manager's targeted run.
- Test configuration is explicit local Miniflare configuration (`worker/vitest.config.ts:62`) to avoid Wrangler credential discovery. Keep compatibility date/DO/assets entries aligned with `worker/wrangler.jsonc:5`, `:19`, `:20` in future changes.
- Env declarations were updated manually (`worker/worker-configuration.d.ts:23`); no credential-loading type generation command was run.
- Organization listing's internal cursor is a last candidate ID and always queries the current actor's candidates (`worker/src/identity-directory.ts:82`). HTTP scope-bound cursor validation, native session verification, and API headers belong to S2. No native HTTP surface has been enabled in S1 (`worker/src/index.ts:57` adds class exports only).

### Escalations

- **Trust-boundary ambiguity, implemented deny:** accepting an invitation that offers a different org role to an already-active member returns `membership_role_conflict`, rather than silently replacing the role (which could demote the last owner). Explicit role changes remain the revision-checked membership command. The proposal requires exact offered roles and last-owner protection but does not specify this collision; review this conservative behavior before S2.
- **Conservative lifecycle boundary:** archived workspaces fail the policy's active-workspace check, including attempted updates; no restoration shortcut is provided. Owner-reserved deletion/ceiling operations have no supported S1 command and default deny. No P2/P3 policy ceiling/grants or managed data authorization is claimed (`worker/src/policy.ts:31`).
- **Verification blocker:** local workerd/Vitest assertions cannot run because of sandbox listener EPERM. Independent reviewer/manager must run the new test file, including rollback-trigger, alarm/outbox and all role cases, before relying on runtime correctness. Existing tests remain unchanged; no exception requested.

### Final S1 verification

- Final standalone `worker/ npm run typecheck` with Node 22 PATH: **exit 0**.
- Final standalone `worker/ npm run lint` with Node 22 PATH: **exit 0**, 153 files checked, no fixes.
- Final `worker/ npx vitest run test/organizations.test.ts`: **exit 1**, identical local-listener `EPERM` before assertions. The file contains 29 authored `it()` cases; zero are claimed executed/passed.
- Final `git diff --check`: **exit 0**. No existing test file/helper was edited; runtime compatibility remains unverified in this sandbox.

## S2

### Changes (file:line + symbol)

- `worker/src/github/app.ts:56` (`GitHubSignIn.userIdentity`) adds an optional numeric identity seam so legacy fixtures remain compatible; `:254` (`GitHubApp.userIdentity`) validates a positive safe-integer GitHub account id from the authenticated user response. No login-to-identity upgrade is provided.
- `worker/src/session.ts:104` (`signNativeSession`) and `:121` (`verifyNativeSession`) use a distinct versioned native payload with issuer, Person UUID, numeric GitHub id, displayed login, issue time and bounded expiry. Existing `signSession`/`verifySession` stay at `:77`/`:83` with legacy semantics.
- `worker/src/auth.ts:124` (`readNativeActor`) authenticates native bearer or cookie sessions, requires explicit matching Origin on cookie writes, and verifies the directory association. Authorization headers never fall back to cookies. Query tokens, legacy login-only sessions and non-Person credentials do not authenticate here.
- `worker/src/auth-api.ts:129` (`startWebFlow`), `:164` (`finishWebFlow`), `:206` (`startDeviceFlow`), `:248` (`pollDeviceFlow`), `:318` (`nativeSession`): explicit `destination=native` authenticates destination in signed OAuth/device state; native sign-in requires numeric identity and bypasses Channel admission only on the native branch. Native device browser session issuance also requires same-origin Origin. Legacy member admission remains at `:90`, `:198`, `:288`; existing FakeSignIn/helpers were not edited.
- `worker/src/index.ts:378` dispatches native APIs before repo routing. `worker/src/workspace-api.ts:8` (`handleWorkspaceApi`) implements org create/list/get/rename; org member list/invite/change/revoke; exact invitation acceptance; workspace create/list/get/update; workspace member list/invite/grant/change/revoke; and admin audit read. Commands use explicit fields and the authenticated actor. Unknown fields/actions deny. Native replies carry no-store, requestId/revision and uniform JSON errors (`:10`); foreign resource denials have no metadata (`:121`).
- `worker/src/workspace-api.ts:30` signs expiring actor/path-scoped cursors, `:71` scopes idempotency keys to the resource path, `:89` validates revision headers. Original request fingerprints preserve retries across PATCH default application (`:237`); `shared/src/m1.ts:85` adds trusted `NativeMutation.requestFingerprint`, consumed by `worker/src/organization.ts:206`. No raw body is persisted in replay/audit.
- `worker/src/organization.ts:200` (`mutate`) resolves invitation numeric targets before the local transaction, then checks current authoritative roles inside it. `:380` restricts manager invitations to already-active org members without role changes; `:408` rechecks inviter workspace administration at acceptance. Workspace invitations now use workspace.member.manage, rather than requiring org administration (`:246`).
- `worker/src/organization.ts:521` (`auditRecords`) adds timestamp/id keyset continuation so equal-timestamp rows are not skipped. `:550` (`catalog`) adds bounded authorized workspace/member pages; every page rechecks current authority. Existing workspace metadata policy remains authoritative (`worker/src/organization.ts:502`).
- `worker/src/identity-directory.ts:32` (`personForGithub`) is an internal identity lookup for invitation restriction. `:76` (`createOrganization`) bounds creation to ten new reservations per Person per UTC day; existing idempotent reservations bypass quota consumption. The table is lazily created at `:12`.
- `worker/test/m1-helpers.ts:8` provides absolute production-origin native requests and `:25` an independent `NativeSignIn` fixture. Existing test/helper files are unchanged except appended S2 cases in the explicitly owned organizations test (`worker/test/organizations.test.ts:498`).

### Tests added

Authored assertions only; runtime execution was blocked before assertions.

`worker/test/native-auth.test.ts`:
- `:28` — it("supports native browser and device sign-in without repo permission").
- `:47` — it("preserves legacy browser and device membership prerequisites").
- `:55` — it("preserves Person UUID across login changes").
- `:59` — it("rejects recycled-login legacy sessions for native access").
- `:66` — it("denies agent legacy connector and Host tokens on api m1").
- `:76` — it("rejects forged expired or mismatched native identity").
- `:87` — it("rejects native cookie writes with missing or foreign Origin").
- `:114` — it("ignores body-supplied actor identity").
- `:126` — it("authenticates native destination in device state").

`worker/test/organizations.test.ts` (only appended cases):
- `:500` — it("requires Idempotency-Key on every native write").
- `:509` — it("returns no-store and uniform JSON errors").
- `:522` — it("reauthorizes every bounded cursor page").
- `:544` — it("exercises native create update invite accept grant revoke and audit over HTTP").
- `:588` — it("replays original PATCH fields and rejects changed bodies and stale If-Match").
- `:610` — it("allows manager invitations only within existing org membership and rechecks inviter authority").
- `:673` — it("bounds organization creation while retaining idempotent retries").

### Commands run / actual results

Node commands used `export PATH=/home/box/.local/node22/bin:$PATH` in `worker/`.

- `npm run typecheck`: initial exit 1 for two possibly-undefined accesses; corrected. Subsequent runs including the final production/test revision exited **0**.
- `npx biome check --write` on owned changed source/new tests and shared type: exit **0**; initial optional-chain/non-null warnings fixed. No existing assertions were reformatted (`git diff -- worker/test/organizations.test.ts` shows only appended lines).
- `npm run lint`: exit **0**, final run checked 156 files, no fixes.
- `npx vitest run test/organizations.test.ts test/native-auth.test.ts`: attempted twice, both exit **1** before assertions with `listen EPERM: operation not permitted 127.0.0.1` (Node v22.23.5). **Zero runtime tests are claimed passed.** This includes the final test revision; the last tiny production change (invalid-path/identity-body validation) was statically checked afterward.
- `git diff --check`: exit **0** before notes; final check also recorded below. Read-only status/diff and bounded source/document reads supported inspection. No git writes, installs, network, deploy or credential-file reads.
- Full suites: **not run**, manager-owned. Runtime legacy compatibility and new security assertions remain for manager verification.

### Deviations from plan/proposal

- No new dependencies. The native GitHub seam is optional at the interface level solely for backward-compatible legacy fixtures; native issuance denies if absent (`worker/src/auth-api.ts:325`). Session envelope HMAC remains v1; the native payload has a separate kind and version (`worker/src/session.ts:112`).
- Workspace PATCH fills omitted fields from authorized metadata and commits against If-Match. Trusted requestFingerprint preserves original-body replay semantics (`worker/src/workspace-api.ts:158`, `:237`). DELETE and explicit POST workspace grants also require a revision, preserving S1's stricter membership transaction requirement (`worker/src/organization.ts:271`).
- Scope-bound cursors expire after ten minutes and contain a last key, not a permission grant (`worker/src/workspace-api.ts:51`). Audit continuation is a timestamp/id pair (`:135`). Organization creation's concrete local rate bound is ten per UTC day (`worker/src/identity-directory.ts:76`); proposal requested a bound without specifying a number.
- HTTP tests are appended to the explicitly S2-owned organizations file per the plan's ownership/test mapping; pre-existing cases and all legacy helpers remain unchanged (`worker/test/organizations.test.ts:498`).

### Escalations

- **Conservative invitation boundary:** accept numeric GitHub-id targets only; no unverified login resolution. Workspace managers may invite existing active org members at their current org role, but may not enroll/reactivate or promote org members. Org admin/owner invitations remain the route for org enrollment. This follows the separate organization.member.manage ceiling; ambiguous attempts deny (`worker/src/organization.ts:380`, `:408`).
- S1's conflicting-active-org-role and archived-workspace restrictions remain in force (`worker/src/organization.ts:427`, `worker/src/policy.ts:64`). Unsupported owner-reserved lifecycle/ceiling changes remain denied by the HTTP allowlist (`worker/src/workspace-api.ts:164`), rather than silently implementing P2/P3 policy.
- **Verification blocker:** sandbox listener EPERM prevents runtime evidence. Manager must run both targeted files and legacy suites before accepting the slice. Native APIs expose administrative metadata only; Channel binding/closed managed paths are S3 (`m1/p1/P1_PLAN.md:44`), and general-user enablement remains deferred (`m1/M1_ARCHITECTURE_PROPOSAL.md:219`).

### Final S2 whitespace check

- `git diff --check`: **exit 0**, including the S2 notes and completion marker.

## S3

**Partial implementation; slice is NOT complete. No S3_DONE.md is written.** Binding activation remains denied under the explicit safety fallback in `m1/p1/P1_PLAN.md:81`. This is not runtime compatibility or security acceptance evidence.

### Changes (file:line + symbol)

- `worker/src/channel.ts:488` (`Channel.constructor`): additive idempotent singleton binding schema with version, nullable workspace/operation, monotonic generation, and a local operation-evidence outbox. No existing data is rewritten by these new statements. Existing schema initialization follows at `worker/src/channel.ts:494`.
- `worker/src/channel.ts:699` (`bindingState`) and `worker/src/channel.ts:717` (`managedClosed`): unknown versions, pending/linked states and non-null workspace bindings deny admission. `worker/src/channel.ts:723` (`prepareBinding`) provides an internal-only pending CAS with transactionally coupled outbox evidence, same-operation replay, stale-generation/conflict refusal and old-socket closure. It is deliberately not called by any HTTP activation endpoint. This is a foundation, not a complete binding coordinator or administrative audit export.
- `worker/src/channel.ts:761` (`admit`), `worker/src/channel.ts:1906` (`fetch`), `worker/src/channel.ts:1952` (`webSocketMessage`): deny new admission, upgrades/replay and queued incoming socket messages when the local binding is managed or unknown. Unlinked requests still delegate to the existing admission implementation at `worker/src/channel.ts:764`. These checks do NOT claim to fence every pre-admitted RPC or asynchronous completion.
- `worker/src/workspace-api.ts:126` (`handleWorkspaceApi`): POST/DELETE workspace Channel routes return a no-store native 503 denial rather than starting an unsafe cross-object operation. Existing native authentication remains at `worker/src/workspace-api.ts:26`; no repo-admin bypass or managed data path is enabled.
- `CONTEXT.md:11`–`:30`: glossary entries for Organization, OrganizationMembership, Workspace, WorkspaceMembership, Invitation, Person identity and administrative AuditRecord. Channel's existing definition remains at `CONTEXT.md:7`.
- Moved the three ADR drafts to `docs/adr/0055-organizations-and-workspaces-are-a-native-authorization-boundary.md:1`, `docs/adr/0056-agent-principals-are-separate-from-executions.md:1`, and `docs/adr/0057-one-policy-function-guards-managed-workspaces.md:1`; status at line 3 distinguishes accepted Gate 0 design from incremental/future implementation. Removed obsolete outside-repository/pending-Gate-0 wording; retained Context/Decision/Consequences/Alternatives and P2/P3 design decisions.

### Tests added (authored, not runtime passes)

`worker/test/workspace-binding.test.ts`:
- `:12` — it("refuses native binding activation while pre-admitted Channel work is not fenced").
- `:42` — it("closes existing sockets at the pending transition").
- `:57` — it("replays pending preparation and rejects stale generations and competing workspaces").
- `:66` — it("rolls back the pending fence if its durable outbox cannot commit").
- `:75` — it("denies pending admission and reconnects without changing legacy membership authority").
- `:88` — it("keeps unknown schemas closed and refuses to overwrite them").

`worker/test/m1-migration.test.ts`:
- `:10` — it("preserves pre-M1 Events persons and stored Skills and Artifacts across repeated startup"). Seeds existing Event/Person SQL and actual Skill/Artifact chunk tables, removes the new schema, constructs Channel twice, compares preserved rows/chunks. This is a focused synthetic fixture, not a production dataset or complete realistic migration matrix.
- `:39` — it("preserves unlinked session admission and does not erase unknown binding versions on startup").

Existing tests/helpers were not edited (read-only `git status --short`/`git diff` inspection). The full planned dual-authority, operation polling, interruption recovery, agent/stream compatibility and migration matrix remain incomplete; these eight cases are foundation coverage only (`worker/test/workspace-binding.test.ts:11`, `worker/test/m1-migration.test.ts:9`).

### Commands run / actual results

Node commands used `export PATH=/home/box/.local/node22/bin:$PATH` in `worker/`; no dependency install, network, credential-file read, git write or deploy was performed.

- `npm run typecheck`: initial migration/fence implementation passed (exit 0); a later HTTP test addition failed with TS2339 on the mutation result union. Added an explicit `"id" in result.value` guard (`worker/test/workspace-binding.test.ts:27`); final rerun passed (exit 0).
- `npx biome check --write src/channel.ts src/workspace-api.ts test/workspace-binding.test.ts test/m1-migration.test.ts`, followed by focused new-test formatting after edits: exit 0. Formatting touched only these owned changed files.
- `npm run lint`: passed, exit 0; final run checked 158 files with no fixes.
- `npx vitest run test/workspace-binding.test.ts test/m1-migration.test.ts`: attempted twice; both exited 1 before assertions, `Error: listen EPERM: operation not permitted 127.0.0.1`, Node v22.23.5. Zero tests are claimed executed/passed. The final union-narrowing correction was statically checked afterward.
- `git diff --check`: exit 0 before this notes append; final result recorded below.
- Full suites and existing organizations/native-auth files: not run in S3; manager-owned broader validation. No compatibility pass is claimed.

### Deviations from plan/proposal

- S3 is incomplete. No Organization reservation/link coordinator, fresh dual-authority orchestration, operation polling authorization, bind/unbind recovery, completed binding audit/outbox delivery, or restore-to-legacy transition has been implemented. HTTP binding stays refused (`worker/src/workspace-api.ts:126`). No activation or unbind is claimed.
- The internal Channel CAS is intentionally only a pending-phase primitive (`worker/src/channel.ts:723`). It must not be wired to a public transition before the escalation below is resolved; the outbox stores local pending evidence and does not imply external acknowledgment or repair.
- Minimal admission/socket closure guards implement the plan's stated scope clarification (`m1/p1/P1_PLAN.md:43`, `:81`). They are insufficient as the complete managed enforcement inventory.

### Escalations

- **Trust-boundary gap; safest denial implemented.** MCP admission happens before `request.json()` (`worker/src/mcp/server.ts:81`, `:90`), and tool closures later invoke Channel reads without carrying a binding generation (`worker/src/mcp/server.ts:95`–`:108`, `:180`). A request admitted before a pending transition can therefore dispatch a later read even after all sockets close. Channel transcript reads also authorize before awaiting wrapper data and return it afterward (`worker/src/channel.ts:1289`–`:1321`). Adding only admission/upgrade guards cannot establish the promised closed-pending boundary. Solving this requires a generation-fenced dispatch/result boundary and coverage of outstanding asynchronous work; this overlaps P3's full inventory, including a file outside S3 ownership (`worker/src/mcp/server.ts`). Under `m1/p1/P1_PLAN.md:81`, activation remains denied rather than improvising permissive behavior. Independent reviewer/manager must resolve the scope and complete this before enabling the coordinator. This is a concrete inspection finding, not a claim of an executed exploit.
- **Runtime verification blocked:** local listener EPERM prevented all new runtime assertions. Manager must run targeted and legacy suites, then adversarially review the completed binding protocol. Static checks alone do not establish migration or socket correctness.
- S3_DONE.md intentionally absent until the entire slice is complete, as required by the task.

### Final S3 whitespace check

- `git diff --check`: exit 0, including the S3 notes. S3 remains partial; no completion marker was created.

### S3 continuation — migration and admission hardening

Still **partial**, continuing the existing working-tree implementation rather than replacing it. No completion marker is written. The existing S3 changes and limitations above remain, except for the updates below; earlier Channel line citations predate this continuation.

#### Changes (file:line + symbol)

- `worker/src/channel.ts:488` (`Channel.constructor`): make binding schema initialization atomic. A previously migrated table with a missing singleton, or a missing table with retained operation outbox evidence, initializes to `recovery_required`, never permissive `unlinked`. Preserve existing singleton versions and outbox evidence on repeated startup (`:498`). A genuinely pre-M1 object without either table retains the original unlinked default.
- `worker/src/channel.ts:728` (`managedClosed`): refuse malformed/negative/noninteger generations and orphan operation IDs even if the row says unlinked. `:741` (`prepareBinding`) rejects empty identifiers, invalid generations and overflow, and refuses mismatched state before writing the pending fence/outbox.
- `worker/src/channel.ts:786` (`admit`): recheck local closure and binding generation after asynchronous legacy admission returns, so a GitHub lookup started before pending cannot return successful admission afterward. The unlinked Access result is otherwise preserved. This does not fence work already admitted before the transition or establish complete managed enforcement.

#### Tests added (authored; not runtime passes)

- `worker/test/workspace-binding.test.ts:101` — it("refuses admission when binding starts during the GitHub permission lookup"): deterministic paused GitHub permission response, pending transition before release, denial on completion.
- `worker/test/workspace-binding.test.ts:129` — it("keeps mismatched operation and invalid generation states closed").
- `worker/test/workspace-binding.test.ts:145` — it("rejects invalid pending transition inputs without writing operation evidence").
- `worker/test/m1-migration.test.ts:49` — it("keeps missing binding state closed when prior migration or pending outbox evidence remains"): missing singleton, missing table with outbox, repeated construction, admission refusal and retained operation evidence.

#### Commands run / actual results

All Node commands ran in `worker/` with `export PATH=/home/box/.local/node22/bin:$PATH`. No dependencies installed; no credential files read, network calls, git writes or deployment.

- `npx biome check --write src/channel.ts test/workspace-binding.test.ts`: exit **0**; formatted both edited files.
- First continuation `npm run typecheck`: exit **0**. First `npm run lint`: exit **0**, 158 files, no fixes.
- First `npx vitest run test/workspace-binding.test.ts test/m1-migration.test.ts`: exit **1**, localhost listener `EPERM` before assertions.
- After migration hardening, `npx biome check --write src/channel.ts test/workspace-binding.test.ts test/m1-migration.test.ts`: exit **0**, three files checked, two formatted.
- Final `npm run typecheck`: exit **0**. Final `npm run lint`: exit **0**, 158 files, no fixes.
- Final `npx vitest run test/workspace-binding.test.ts test/m1-migration.test.ts`: exit **1**, `listen EPERM: operation not permitted 127.0.0.1`, Node v22.23.5. **No runtime assertions passed or are claimed executed.**
- `git diff --check`: exit **0** before this notes append. Full suites: **not run**, manager-owned. Existing tests/helpers remain unmodified by this continuation.

#### Deviations and escalations

- The plan explicitly requires keeping activation denied if an uncovered entry point needs P3 work (`m1/p1/P1_PLAN.md:81`). That restriction remains in force. Binding HTTP requests still return 503 (`worker/src/workspace-api.ts:126`); no reservation/link coordinator, fresh dual-authority operation, operation polling, activation or unbind recovery is claimed complete.
- The outstanding MCP admission-before-body/dispatch boundary remains (`worker/src/mcp/server.ts:81`, `:90`, `:95`). Fixing the admission-in-flight race above does not fence requests that already received admission. The prior escalation therefore remains unresolved; manager/reviewer scope resolution is needed before activation. Asked whether to authorize the broader fencing work; no affirmative authorization has been received at the time of this record.
- `recovery_required` is a conservative corruption/interruption state, not an automatic repair or unbind. It never silently restores legacy access. Runtime recovery tests remain blocked by the sandbox listener restriction.

### S3 continuation — outstanding read cancellation

S3 remains **partial**. Continued the existing files; no `S3_DONE.md` is written.

#### Changes (file:line + symbol)

- `worker/src/channel.ts:769` (`prepareBinding`): after the durable pending transaction succeeds, resolve outstanding transcript, terminal and history requests before closing sockets. The existing request answer callbacks remove their entries and clear timers (`worker/src/channel.ts:1456`, `worker/src/channel.ts:1876`). Failed pending transactions never reach cancellation.
- `worker/src/channel.ts:1324` (`readTranscript`) and `worker/src/channel.ts:1368` (`readTerminal`): reject locally managed state before resource lookup; capture generation and check it again after the wrapper await, before recording a successful read or returning its data.
- `worker/src/channel.ts:1779` (`withLocalEvents`): reject locally managed state and discard retained history when generation changes during the machine-history await. This internal history path throws a fixed denial rather than returning a page containing pre-transition Events. A uniform public HTTP translation is not implemented here; activation remains disabled (`worker/src/workspace-api.ts:126`).

#### Tests added (authored, not executed assertions)

- `worker/test/workspace-binding.test.ts:155` — it("discards history captured before a pending transition while its result is outstanding"): deterministically start a history read with a retained Event, enter pending before its promise resumes, expect rejection and verify the stored Event remains intact.
- `worker/test/workspace-binding.test.ts:170` — it("denies transcript and screen reads before resolving managed Channel resource identities"): pending reads deny even for nonexistent Agent IDs.
- Cancellation of live wrapper requests and the complete response/dispatch boundary remain without runtime evidence; these two cases do not establish complete fencing.

#### Commands run / actual results

Node commands ran in `worker/` with `export PATH=/home/box/.local/node22/bin:$PATH`.

- `npx biome check --write src/channel.ts test/workspace-binding.test.ts`: exit **0**, two files checked, no fixes.
- `npm run typecheck`: exit **0**.
- `npm run lint`: exit **0**, 158 files checked, no fixes.
- `npx vitest run test/workspace-binding.test.ts test/m1-migration.test.ts`: exit **1** before assertions, `listen EPERM: operation not permitted 127.0.0.1`, Node v22.23.5. No runtime test pass claimed.
- `git diff --check`: exit **0** before and after this notes update.
- Full suites: **not run**, manager-owned. No dependency installation, network, git write, deployment or credential-file read.

#### Deviations and escalations

- Read cancellation and local result checks reduce the outstanding asynchronous-read gap, but do not resolve the previously recorded MCP pre-admission/dispatch gap (`worker/src/mcp/server.ts:81`, `:90`, `:95`). No binding coordinator, operation polling or unbind implementation is claimed complete.
- The binding safety fallback remains mandatory: `m1/p1/P1_PLAN.md:81` says “If an uncovered entry point requires P3 work, keep binding activation denied and report it rather than open access.” Requested an explicit scope extension for MCP dispatch and necessary new fencing tests through the asynchronous clarification tool. No affirmative response received when writing this note; no outside-ownership file was changed. The request is about this binding trust boundary, not permission to run static checks or write the currently owned files.

### S3 option B — chunk 1: transition fences and bounded binding reads

- Coordinator authorization in this task resolves the prior MCP ownership escalation. `worker/src/channel.ts:485` (`binding`) caches the singleton; constructor uses bounded `PRAGMA table_info` instead of scanning sqlite_master. `bindingState`/`bindingCurrent` (`:719`, `:730`) perform no SQL per request. Pending commits refresh memory synchronously after the transaction, never before a possible rollback (`prepareBinding`, `:753`). This addresses the reported row budgets; runtime budgets are **not measured here**.
- `worker/src/index.ts:287` (`dispatch`) and `:369` discard HTTP responses after generation changes. `worker/src/mcp/server.ts:88` captures the admission generation before parsing the body and discards single/batch results after changes; tool Channel reads carry the same generation. Channel upgrades capture/recheck generation, socket tags retain it across hibernation, queued socket dispatch refuses old tags (`worker/src/channel.ts:2036`). No permits, stream leases, or permissive managed paths added.
- New fixture fix: `worker/test/workspace-binding.test.ts:158` it("discards history captured before a pending transition while its result is outstanding") now stores JSON actor data, as required by Event deserialization; same correction in the new migration fixture. SQL-corruption tests reconstruct Channel to model startup and load deliberately modified durable binding state.
- Commands in worker/ with Node 22: first combined biome/typecheck/lint shell command exited **1**, with duplicate local `tag` diagnostics (individual exits were not captured); renamed it `bindingTag`. Final `npx biome check --write src/channel.ts src/index.ts src/mcp/server.ts test/workspace-binding.test.ts test/m1-migration.test.ts`, `npm run typecheck`, and `npm run lint` each exited **0**. `git diff --check`: **0**. Vitest **not run**, per sandbox instruction. Existing tests/helpers untouched.

### S3 option B — chunk 2: durable coordinator and activation

- `worker/src/organization.ts:536` (`coordinateBinding`) now reserves workspace/repo, journals generation and phase, installs Channel pending CAS, atomically commits the Workspace link/revision/audit, and finalizes Channel. Retries use the durable operation ID or original scoped idempotency key. Losing CAS records terminal conflict and releases its reservation. Unbind follows the same protocol with an explicit acknowledgment that legacy access resumes. Operations poll only for original actor or active org admin (`bindingOperation`, `:519`); polling cannot mutate/recover without fresh authority.
- `worker/src/channel.ts:756` (`bindingOwner`) uses existing fresh `isOwner` with dev bypass disabled and additionally checks GitHub's permission response user.id against the native numeric identity; missing reader/identity/lookup refuses. `prepareBinding` (`:781`) handles bind/unbind pending generations and durable local evidence; `finishBinding` (`:839`) commits/replays the final local outcome. Linked/pending managed data stays denied.
- `worker/src/workspace-api.ts:114` exposes operation polling; `:133` replaces the 503 activation stub with native authenticated orchestration, ALLOWED_REPOS guard, field allowlist, and signed-session login. `shared/src/m1.ts:115` defines the binding journal; NativeWorkspace now optionally records its Channel.
- Constructor refinement (`worker/src/channel.ts:495`): final normal-start path reads the binding singleton by primary key once; missing table alone enters additive migration; missing row with existing table/outbox remains recovery_required. This supersedes chunk 1's intermediate PRAGMA implementation and further reduces startup reads.
- Commands (worker/, Node 22): biome, typecheck and lint each exit **0** after coordinator and 503 removal. Intermediate lint exit 0 reported a non-null assertion warning; removed it, final checks exit **0**, no warnings. Vitest **not run** (sandbox restriction). Tests for this chunk are being added next; no runtime correctness or rows-read pass claimed.
- Recovery is explicitly driven by an authenticated POST/DELETE retry, not GET or a background actor with stale repo-admin proof. This preserves the fresh dual-authority requirement; unavailable/revoked actors leave pending transitions closed. No Package 3 authorization permits or UI added.

### S3 option B — chunk 3: recovery, races, compatibility fixtures and final checks

**S3 implementation now includes working binding/unbinding; earlier “partial/503 stub” statements are historical and superseded. Runtime verification remains manager-owned.**

Changes/evidence:
- `worker/src/channel.ts:493` (`constructor`) uses a primary-key singleton read on normal startup and additive migration only when absent; no binding SQL remains in `bindingState`/`bindingCurrent` (`:729`, `:740`). `prepareBinding` (`:781`) and `finishBinding` (`:846`) return the committed snapshot from their synchronous transactions, then assign it with no SQL or await before the next request can run. Failed evidence writes leave memory/durable state unchanged. This supersedes chunk 2's post-commit SQL refresh; row budgets require manager measurement.
- Native repo-admin proof uses existing `Access.isOwner` (`worker/src/access.ts:156`, fresh GitHub lookup `worker/src/github/rest.ts:117`) without collaborator cache/grace or dev admission, plus numeric user.id from a fresh permission response (`worker/src/channel.ts:756`). Missing configured GitHub reader denies. No existing GitHub modules changed.
- `worker/src/organization.ts:536` (`coordinateBinding`) returns operation ID on recoverable errors; `:519` authorizes operation polling. `:685`–`:696` adds final `channel.bind.complete`/`channel.unbind.complete` audit evidence alongside final journal acknowledgment/reservation cleanup, distinct from org-link commit audit. Terminal losing CAS cannot silently reactivate. `shared/src/m1.ts:112`, `:115` type error operation IDs/journal; `:33` records optional Workspace Channel reference.
- `worker/src/workspace-api.ts:115`, `:134` expose operation reads and bind/unbind; `:160` propagates recovery IDs. Native auth and same-origin rules are retained through `readNativeActor`; request body cannot select actor/login. The 503 permanent activation stub is removed.
- `worker/src/index.ts:287` (`dispatch`), `:369`–`:382` discard results or translate asynchronous transition exceptions to 403 after generation changes. `worker/src/mcp/server.ts:88`, `:99`, `:101`, `:109`, `:119`, `:123` carry generation through body parsing, Channel tool dispatch and final single/batch release. The synchronous Channel checks and last Worker RPC check are transition fences, not P3 permits or revocation leases.
- `worker/src/channel.ts:1437`, `:1481`, `:1900`, `:2073`, `:2129` fence transcript, terminal, history, upgrades and queued WS dispatch. WS generation tags survive hibernation/attachment updates. Linked/pending data admission remains refused for all callers until P3; unbind generation remains monotonic.
- The history fixture's JSON actor correction (`worker/test/workspace-binding.test.ts:207`, `worker/test/m1-migration.test.ts:14`) matches `rowToEvent`'s `JSON.parse(row.actor)` (`worker/src/channel.ts:393`). Existing tests/helpers remain untouched.

Tests authored in `worker/test/workspace-binding.test.ts` (not executed here; earlier foundation titles remain except obsolete stub expectation):
- `:74` — "binds with fresh repo admin and workspace manage".
- `:230` — "refuses binding without repo admin even with cached collaborator admission".
- `:240` — "refuses binding without workspace manage".
- `:259` — "refuses active workspace viewers binding and unbinding despite fresh repo admin".
- `:290` — "refuses binding when GitHub lookup fails without legacy grace".
- `:300` — "refuses recycled login or unavailable numeric identity proof".
- `:308` — "rejects nonhuman binding actors and legacy sessions".
- `:331` — "rejects a channel already bound to another workspace and releases the losing reservation".
- `:355` — "replays binding operations by key and operation ID without incrementing generation".
- `:368` — "scopes operation reads to the original actor or an organization admin".
- `:392` — "unbinds only with both authorities and explicit warning then restores legacy behavior".
- `:424` — generated titles `recovers ${mode} interruption at ${interruption} without repeating its generation`: modes `bind`, `unbind`; interruptions `generation`, `pending`, `prepared`, `committed`, `activation`, `done` (12 cases). SQL triggers interrupt durable phase/evidence writes; retries assert original operation ID, no repeated generation, and managed denial while pending. Before the Channel pending CAS, reservation alone has not changed legacy Channel admission; after org unlink plus Channel unlink agree, final journal acknowledgment may be retried without re-closing legacy access.
- `:488` — "fences MCP admitted before its request body completes including batches".
- `:523` — "discards MCP tool results outstanding at the pending transition".
- `:571` — "refuses stale HTTP stream upgrades after bind and unbind while fresh legacy upgrades work".
- `:592` — "discards HTTP history results admitted before a pending transition".
- `:617` — "rejects changed-mode idempotency replay and competing operations".
- `:630` — "fences queued WS dispatch from old generations after legacy access resumes".
- `:650` — "keeps linked HTTP history persons and stream data closed until Package 3".

`worker/test/m1-migration.test.ts:73` adds "preserves pending linked and unbinding fences across repeated startup". The three earlier migration tests remain; seeded Events, Persons, Skills/Artifacts chunk data and repeated startup fixtures are preserved (`:10`, `:39`, `:49`). No production data was accessed.

Commands/results:
- All Node commands used Node 22 PATH in worker/. No vitest was attempted in this continuation, per the explicit sandbox instruction; all test assertions and full suites are **not run** here.
- Intermediate test typechecks reported unused future MCP-test imports and a missing `HistoryPage.unavailable` fixture field. Those were fixed; the combined shells' final exit was 0 because lint followed typecheck, so individual failing typecheck exit codes were not captured. No pass is claimed for those intermediate typechecks.
- Final separately captured `npm run typecheck`: **exit 0**; `npm run lint`: **exit 0**, 158 files; focused `npx biome check src/channel.ts src/index.ts src/mcp/server.ts src/organization.ts src/workspace-api.ts ../shared/src/m1.ts test/workspace-binding.test.ts test/m1-migration.test.ts`: **exit 0**, eight files. The last added restart fixture was subsequently formatted and typecheck/lint again reported no errors (combined shell exit 0). Final whitespace check recorded below.
- New SQL cache/startup implementation addresses all three reported row-read regressions structurally, but the unchanged `worker/test/rows-read.test.ts` must establish the actual budgets at the manager gate. No regression pass claimed.

Deviations / Escalations:
- Coordinator-approved option B resolves the earlier MCP scope escalation. Full managed authorization, execution identity, projections, permits, leases and UI remain P2–P4 work; managed content stays closed.
- Safest deny for actor substitution: operation recovery retries require the original actor, still authorized for workspace.manage and fresh numeric-bound repo-admin. Org admins may inspect operations but cannot take over another actor's pending mutation. The design explicitly authorizes admin **reads**, not actor substitution on recovery; revoked/unavailable original actors therefore leave incomplete transitions closed rather than granting implied takeover authority (`worker/src/organization.ts:591`). If administrative takeover is desired, its explicit authority/audit contract needs a later decision. Normal same-actor interruption recovery is implemented.
- Legacy network-buffered frames already sent before the pending CAS cannot be recalled (proposal §8); new pending/linked sends/admissions are fenced. Full membership-revocation stream leases remain P3, not a claim of S3.
- No dependencies, network requests, credential-file reads, git writes, deploys, existing test changes or remote operations performed.

Final saved-state gate (after restart fixture and S3_DONE.md): individually captured `npm run typecheck` **0**, `npm run lint` **0**, focused eight-file `npx biome check` **0**, `git diff --check` **0**. Completion handoff: `m1/p1/S3_DONE.md:1`. Runtime tests remain **not run**; manager commands are in that file.

### S3 fix 1

Read the complete failing manager log `../engineering-ops/projects/switchboard-m1/p1_logs/S3/06_worker_test.log` and its `summary.tsv` (external read only). Only Worker tests failed: reported 17 failed, 474 passed, two skipped, three unhandled errors, runtime crash/restart and shutdown timeout. Worker typecheck/lint and CLI/Dashboard typechecks exited zero in that manager run. This is historical manager evidence, not a local runtime pass.

Failures → diagnosis → fixes:

- **Eleven Worker terminal failures** (`worker/test/terminal.test.ts:127`, `:148`, `:161`, `:181`, `:195`, `:212`, `:241`, `:249`, `:265`, `:276`, `:294`): S3 inserted an empty identity tag plus binding metadata into Person sockets. Legacy watcher classification requires an absent second identity tag; treating metadata/empty padding as an identity excludes all Person watchers and suppresses their close notifications. Fix: remove the empty padding (`worker/src/channel.ts:2105`), separate binding metadata from identity tags (`:2122`), locate generation by prefix rather than third-slot position (`:2133`), and consistently use identity-only tags for socket routing/history/close/watchers (`:1914`, `:1986`, `:2013`, `:2171`, `:2371`, `:2413`, `:2425`, `:2530`, `:2616`). Generation fences remain enforced independently. Existing terminal tests are untouched and provide the regression assertions.
- **HTTP history transition test timeout, missing `latestEvents` RPC, associated unhandled rejection**: the new test shadowed the prototype RPC method with a Vitest mock; workerd rejected that receiver instead of invoking the mock, so the test waited forever for its start signal. Fix: pause private `withLocalEvents` while retaining the real prototype `latestEvents` RPC (`worker/test/workspace-binding.test.ts:604`); the delayed response must still be denied with 403 (`:620`), exercising Worker result-release fencing (`worker/src/index.ts:377`). No denial assertion weakened.
- **Injected SQL failure unhandled rejection**: the new Channel rollback test sent a synchronous throwing transaction over RPC (`worker/src/channel.ts:790`, `:813`). Catch the deliberately injected exception inside `runInDurableObject` (`worker/test/workspace-binding.test.ts:122`), still asserting the exact failure and unchanged durable/cache snapshot (`:125`). The manager log also printed the analogous Organization injected failure (`worker/src/organization.ts:214`, `:482`); apply local exception assertion to this Package 1-owned test (`worker/test/organizations.test.ts:315`). State/revision/audit/replay rollback and successful retry assertions remain (`:326`, `:329`, `:332`). No baseline test edited.
- **Five additional legacy timeouts**: concurrent claims (`worker/test/claims.test.ts:84`), Proxy registration (`worker/test/proxy.test.ts:201`), Gemini/Codex Interrupts (`worker/test/relay.test.ts:836`), stale takeover (`worker/test/stale-claims.test.ts:233`), transcript wrapper response (`worker/test/transcript.test.ts:235`). The manager log reports only timeouts, with first-test elapsed times around 40 seconds, followed by runtime teardown/crash errors. These do not establish five independent source defects. **Inference only:** runtime contention/teardown from the broken history test may contribute; causation is unverified. No timeout increase, assertion change or unrelated workflow edit. They remain required rerun targets.
- **Pool exit, deleteAllDurableObjects, WebSocket disconnect, shutdown timeout**: the log shows outstanding HTTP history work during resets, missing-RPC rejection, then fatal runtime termination. Fixing the hanging fixture addresses a concrete outstanding-work cause; the complete crash/shutdown outcome still requires manager verification. Do not count it resolved without a runtime rerun.

Checks actually executed locally with Node 22 PATH, in `worker/`:

- `npx biome check --write src/channel.ts test/workspace-binding.test.ts test/organizations.test.ts`: exit 0, three files, no fixes on final run.
- `npm run typecheck`: exit 0 after final code/test edits.
- `npm run lint`: exit 0 after final code/test edits, 158 files.
- `npx vitest run test/workspace-binding.test.ts test/terminal.test.ts test/claims.test.ts test/proxy.test.ts test/relay.test.ts test/stale-claims.test.ts test/transcript.test.ts`: exit 1 before assertions, `listen EPERM: operation not permitted 127.0.0.1`.
- `npx vitest run test/organizations.test.ts test/workspace-binding.test.ts test/m1-migration.test.ts`: exit 1 before assertions, same listener EPERM.
- `git diff --check`: exit 0 before this notes append; final check below. Full suites not run. No runtime pass claimed.

Escalations: local listener restrictions prevent verifying the fixes and distinguishing the five legacy timeouts from runtime-wide disruption. Manager must rerun the failing gate; this revision does not claim the full gate is green. No architectural/trust-boundary change, dependency, network call, baseline-test edit, git write, credential read or deployment.

Final `git diff --check` after notes append: exit 0.

### S3 fix 2

Read the complete external read-only `S3-fix1/06_worker_test.log` and `summary.tsv` under `/home/box/engineering-workspace/engineering-ops/projects/switchboard-m1/p1_logs/`. Only Worker tests exited nonzero. The manager log reports 489 passed, two skipped, one unhandled pool error, and a runtime crash; it does not establish completion of all 495 collected tests. Worker typecheck/lint and CLI/Dashboard typechecks exited zero in that manager run. These are manager observations, not local test results.

Failures → root cause → fix:

- **Four uncaught `interrupted: SQLITE_CONSTRAINT_TRIGGER` exceptions**: the new bind/unbind recovery cases deliberately abort Channel outbox INSERT/UPDATE (`worker/test/workspace-binding.test.ts:430`). The coordinator previously invoked the synchronous throwing `prepareBinding`/`finishBinding` directly over RPC; the manager stacks point to those outbox writes (now `worker/src/channel.ts:833`, `:898`). Although the coordinator catches RPC rejection, the test runtime also reports the exceptions as uncaught. Added `transitionBinding` to catch transaction failures inside the owning Channel and return a plain discriminated result (`worker/src/channel.ts:780`). Coordinator uses that result for prepare and finish (`worker/src/organization.ts:700`, `:735`), returning recoverable 503 with operation ID while preserving the reservation and journal. A negative CAS remains a distinct 409, with the prior conflict cleanup. Local transactional implementations and synchronous cache assignment remain intact (`worker/src/channel.ts:801`, `:866`).
- **Fatal “Promise callback destroyed itself”, unexpected pool exit, RPC disposal warning, subsequent “Expected global Vitest state”, reset/WebSocket teardown errors and shutdown timeout**: the complete log shows runtime teardown/crash alongside the uncaught injected RPC errors, then failed Vitest state after restart. The concrete source defect addressed is the escaping Channel transaction exception above. The runtime's exact fatal mechanism and resolution of every teardown diagnostic remain **unverified** without a manager rerun; no independent legacy assertion failure is reported in this round. No runtime configuration, timeout, baseline assertion or dependency was changed.
- Strengthened all four local-failure recovery cases: failed preparation retains the original cache; failed activation retains the pending generation; both compare cached state with the durable singleton and check absent/pending operation evidence (`worker/test/workspace-binding.test.ts:429`, `:462`). Existing 503, original operation ID, denial, retry and idempotent replay assertions remain (`:448`, `:460`, `:484`, `:496`). These tests exercise the real HTTP coordinator and Channel RPC wrapper. No pre-existing tests edited.

Checks actually executed locally in `worker/`, using Node 22 PATH:

- `npx biome check --write src/channel.ts src/organization.ts`: exit 0 (formatted Organization).
- `npx biome check --write test/workspace-binding.test.ts`: exit 0, no fixes.
- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0, 158 files, no fixes.
- `npx vitest run test/workspace-binding.test.ts test/organizations.test.ts test/m1-migration.test.ts`: exit 1 **before assertions**, listener `EPERM` on `127.0.0.1`; no runtime tests passed locally.
- `git diff --check`: exit 0 before notes append; final check follows. Full suites not run; manager must rerun the Worker gate.

Escalations: sandbox listener restriction prevents runtime confirmation. No trust-boundary design change; storage failures retain retryable state and never become successful transitions. No network, dependencies, credential reads, git writes, deployment or files outside the worktree changed.

### S3 fix 3

- **Failure → root cause:** supervisor evidence in `/home/box/engineering-workspace/engineering-ops/projects/switchboard-m1/p1_logs/diag3/DIAGNOSIS.md:1`, `single_http_history.log:48` and `full_verbose.log:546-595` reports the HTTP history test's cross-context I/O error and fatal workerd crash (489 passed does not constitute a successful suite). At HEAD `0093e3a`, `worker/test/workspace-binding.test.ts:618-640` created `reading`/`waiting` promises in the runner and resolved/awaited them inside the Channel's mocked `withLocalEvents`. Read the diagnosis and single-test log fully, and full verbose lines 500–640; these are supplied supervisor observations, not tests executed here.
- **Harness fix:** `worker/test/workspace-binding.test.ts:618-635` creates the promise/resolver inside `runInDurableObject` and keeps them on a Channel-local gate. The runner polls only a boolean through `runInDurableObject` (`:640-642`), prepares the binding after the history merge starts (`:643`), and releases from another Channel-context callback in `finally` (`:644-647`). The original post-release HTTP **403** assertion is retained (`:649`). No promise, resolver, Request/Response or stream crosses into the Channel from the runner's harness.
- **RPC disposal warning:** the coordinator previously retained RPC object results without explicit disposal at HEAD `0093e3a`, `worker/src/organization.ts:647`, `:700`, `:735`; the recovery tests similarly retained snapshots at `worker/test/workspace-binding.test.ts:429`, `:462`. RPC object return types carry a top-level disposer (`worker/worker-configuration.d.ts:14135-14147`). Added `using` to those five results at the same lines so block exit, early return and injected storage exceptions dispose them. This addresses concrete undisposed results in the reported recovery path; elimination of the runtime warning is **not verified** without the supervisor rerun.
- **Other three tests reviewed:** `worker/test/workspace-binding.test.ts:652-663` uses an entirely DO-local SQL trigger; `:665-683` creates and consumes its Request, Response and sockets inside one Channel callback; `:685-692` performs HTTP requests in the runner. None captures a runner-created pending promise/resolver for DO use, so no harness change was needed there. The modified test file does not exist at baseline `5a4ecba` (read-only `git cat-file -e` reported that absence). No baseline test, pool/config, skip or expectation was changed.
- **Validation actually run:** Worker `npm run typecheck` **passed**, exit 0; Worker `npm run lint` **passed**, exit 0 (158 files, no fixes); `git diff --check` **passed**, exit 0. Node 22 PATH was used. An initial typecheck invocation from the wrong directory failed with ENOENT for `/package.json`; the explicit Worker-directory invocation above passed. **No tests run**, per supervisor instruction; full suite/crash resolution and warning disappearance require supervisor verification. No git writes or network operations performed.
- **Escalations:** no new design/trust-boundary deviation. Runtime evidence remains pending; do not interpret static validation as proof of a passing suite.

### S3 fix 4

Failure → root cause → fix:

- **Fatal workerd teardown after queued WS dispatch:** supervisor `diag4/DIAGNOSIS.md:1-9`, `diag4/combo14.log:4`, `diag4/combo12.log:41` and `S3-fix3/06_worker_test.log:13` identify the queued-dispatch test followed by a DO-deleting reset as the reproducer. At HEAD `90b6fda`, `worker/test/workspace-binding.test.ts:665-683` accepted the client inside the Channel callback and never closed/awaited it. The client and its close listener now belong to the runner (`worker/test/workspace-binding.test.ts:691`); only server dispatch and binding assertions run inside the Channel (`:699`). `finally` answers the server close and awaits the client close (`:712`). Shared cleanup also polls the owner until no sockets remain, preventing reset from racing the server-side handshake (`:23`). The exact 1008/"Managed Channel access is closed until P3." close assertion and `bindingCurrent(0) === false` assertion remain (`:709-710`). Existing product close handling already answers the peer (`worker/src/channel.ts:2383-2391`); the fenced message handler is synchronous (`:2152-2157`), so this revision changes the fixture lifecycle rather than that product path.
- **Other open Package-1 WebSockets:** the pending-transition test now cleans up in `finally`, retaining its 101 and 1008 assertions (`worker/test/workspace-binding.test.ts:103-119`). Fresh HTTP upgrade cleanup likewise closes, awaits the close event, and waits for server socket removal in `finally`, retaining stale/fresh generation assertions (`:614-637`). The remaining upgrade in this file is intentionally denied before socket creation (`:145-153`). No accepted socket remains intentionally open at test completion.
- **RPC disposal warning during recovery:** supervisor `diag4/file_workspace-binding.log:35` reports that FIX3's snapshot/transition `using` declarations did not eliminate the warning. Further ownership defects existed outside those five sites: IdentityDirectory directly returned the result of Organization.initialize without disposing it (HEAD `90b6fda`, `worker/src/identity-directory.ts:95-97`), and catalog forwarding retained metadata RPC results (`:119-120`). Fix at the forwarding source: scope the initialize result with `using`, reconstruct the declared data-only response before crossing the next RPC boundary (`worker/src/identity-directory.ts:95-100`), and clone catalog metadata before disposing the original (`:122-123`). The binding HTTP adapter now disposes operation-read, metadata and coordinateBinding results after serialization (`worker/src/workspace-api.ts:118`, `:131`, `:146`). Fixture create/mutate/metadata results have explicit scopes (`worker/test/workspace-binding.test.ts:34`, `:37`, `:56`); recovery admission/workspace/final snapshot results do too (`:499`, `:508`, `:517`). FIX3's correctly typed snapshot/transition ownership remains (`worker/src/organization.ts:647`, `:700`, `:735`; `worker/test/workspace-binding.test.ts:443`, `:476`). RPC object return types explicitly include Disposable (`worker/worker-configuration.d.ts:14135-14147`), so these are RPC results, not local plain-data values with an invented disposer. **Runtime attribution remains an inference:** these are concrete previously unowned RPC/forwarding sites, but disappearance of the warning requires supervisor execution; no runtime success is claimed.

Validation actually executed with Node 22 PATH in `worker/`: `npm run typecheck` **exit 0** and `npm run lint` **exit 0**, 158 files, after final code/test edits. `git diff --check` **exit 0** before this notes append; final check follows. An initial edit script used repository-relative paths from `worker/` and exited with FileNotFoundError before writing anything; it was rerun from the repository root. **Vitest and full suites not run**, as instructed due to the established listener EPERM. Supervisor should rerun `test/workspace-binding.test.ts` (including queued-dispatch followed by linked-history), the recovery cases, then the Worker suite, checking both fatal and disposal diagnostics.

Scope / Escalations: read-only `git ls-tree 5a4ecba worker/test/workspace-binding.test.ts` returned no entry; no baseline test was edited. No pool/config changes, skips, removed tests, weakened assertions, dependencies, network calls, credential reads, git writes, deployment, or writes outside this worktree. No new trust-boundary/design escalation. Crash and disposal-warning elimination remain unverified pending supervisor runtime checks.

Final `git diff --check` after notes append: **exit 0**.
