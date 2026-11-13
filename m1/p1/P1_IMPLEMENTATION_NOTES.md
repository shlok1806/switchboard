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
