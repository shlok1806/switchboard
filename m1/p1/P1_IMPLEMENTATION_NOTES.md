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
