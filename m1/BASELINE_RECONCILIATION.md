# Gate 0 baseline reconciliation

2026-11-13. Design investigation only; no repository tests, builds, installs, network calls, or git mutations executed. Repository citations below are relative to `/home/box/engineering-workspace/worktrees/switchboard-m1`; `baseline_logs/` is relative to this deliverable directory. [FACT-TEST] log results are manager-provided execution evidence, not executions by this author.

## Exact baseline and divergence

[FACT-CODE] Read-only commands and observed output:

```text
git -C <repo> rev-parse HEAD origin/main origin/bulletin
66abafbb15d68a40970b51eeac25928a9f7b80ad
fe392689db002edb058eca9b6047be577c5bb656
66abafbb15d68a40970b51eeac25928a9f7b80ad

git -C <repo> rev-list --count fe392689db002edb058eca9b6047be577c5bb656..origin/main
0

git -C <repo> diff --stat fe392689db002edb058eca9b6047be577c5bb656 HEAD
 audit/EXECUTIVE_SUMMARY.md                   |  55 +++
 audit/REVIEW_RESOLUTION.md                   |  41 +++
 audit/SWITCHBOARD_BASELINE_RESULTS.md        | 141 ++++++++
 audit/SWITCHBOARD_CAPABILITY_MATRIX.md       | 127 +++++++
 audit/SWITCHBOARD_CURRENT_STATE_AUDIT.md     | 308 +++++++++++++++++
 audit/SWITCHBOARD_ENTERPRISE_GAP_ANALYSIS.md | 137 ++++++++
 audit/notes/S1_ARCH_CORE.md                  | 480 +++++++++++++++++++++++++++
 audit/notes/S2_ARCH_OPS.md                   | 360 ++++++++++++++++++++
 audit/notes/S4_ENTERPRISE.md                 | 188 +++++++++++
 audit/reviews/S6_REVIEW.md                   | 183 ++++++++++
 audit/reviews/S8_CONFIRMATION.md             |  35 ++
 11 files changed, 2055 insertions(+)

git -C <repo> diff --stat fe392689db002edb058eca9b6047be577c5bb656 HEAD -- cli
<empty output>
```

[INFERENCE] Local `origin/main` equals the audited SHA; HEAD equals local `origin/bulletin`, whose differences are audit documents only. No source/test changes; CLI is byte-identical in the git comparison. These are local remote-tracking refs, not a claim about the server's present refs: no fetch/network was authorized. The supplied branch name is `bot/m1-integration`; `git -C <repo> branch --show-current` confirmed `bot/m1-integration`.

## Fresh manager baseline versus audit

[FACT-TEST] `baseline_logs/summary.tsv:2-16` records a complete run (`DONE` at line 16): 13 of 14 steps exit 0; only CLI tests exit 1 (line 10). Installs, package lint/typecheck, dashboard build, worker/dashboard tests, and screenshot generation exit 0 in those rows. This does not prove live services or visual correctness.

| Suite | Fresh pass/fail/skip | Audited pass/fail/skip | Evidence |
|---|---:|---:|---|
| worker | 404 / 0 / 2 | 404 / 0 / 2 | fresh `baseline_logs/totals.txt:2`; repo `audit/SWITCHBOARD_BASELINE_RESULTS.md:28` |
| CLI | 699 / 1 / 0 | 700 / 0 / 0 | fresh `baseline_logs/totals.txt:3`, `09_cli_test.log:50-51`; repo `audit/SWITCHBOARD_BASELINE_RESULTS.md:31` |
| dashboard | 243 / 0 / 0 | 243 / 0 / 0 | fresh `baseline_logs/totals.txt:4`; repo `audit/SWITCHBOARD_BASELINE_RESULTS.md:35` |
| aggregate | **1,346 / 1 / 2** | **1,347 / 0 / 2** | arithmetic from cited rows; audit aggregate `audit/SWITCHBOARD_BASELINE_RESULTS.md:5` |
| screenshots generated | 203 | 203 | fresh `baseline_logs/totals.txt:5`; repo `audit/SWITCHBOARD_BASELINE_RESULTS.md:36` |

[FACT-TEST] Fresh test files: 94 passed, 1 failed, 2 skipped (97 total), versus 95 passed, 0 failed, 2 skipped; same discovery surface (`baseline_logs/totals.txt:2-4`; `audit/SWITCHBOARD_BASELINE_RESULTS.md:5`). The failure is `switchboard attach > reads the list again only once it changed, so a revoke is seen at the next frame`, expected `bub`, received `bob` (`baseline_logs/09_cli_test.log:20-45`). Targeted manager reruns: **8 passes, 7 failures, 15 executions**; count only `Tests  1 passed`/`Tests  1 failed` summary lines, not the duplicate failure banners (`baseline_logs/09b_cli_flaky_rerun.log:1-18`). Each rerun selected one test and skipped 59; these selection skips are not additional baseline live-service skips.

[FACT-CODE] `cachedAttachList` caches by `ino:size:mtimeNs` (`cli/src/terminal/attach-keys.ts:77-88`); the test changes `bob` to equal-length `bub` using an in-place `writeFile` (`cli/test/terminal.test.ts:308-322`). Normal `writeAttachList` uses a temporary file and rename (`cli/src/terminal/attach-keys.ts:92-101`). [INFERENCE] The failed assertion depends on timestamp granularity when inode and size stay the same. Together with mixed reruns and the empty CLI diff, this is a pre-existing timing-dependent flaky test, not an M1 regression. [DECISION] P5 records it as known-flaky, preserves it without changing/skipping, and recommends a separate fix decision; no blanket acceptance of other failures.

## Current test and feature surface

[FACT-TEST] Read-only inventory: `rg --files <package>/test -g '*.test.ts' -g '*.test.tsx'`; literal assertion-line counts from `rg -c '\b(?:it|test)(?:\.(?:skip|each|todo|only))?\(' <package>/test -g '*.test.*'`, summed per package:

| Package | Test files | Matching assertion lines | Runtime tests in fresh logs |
|---|---:|---:|---:|
| worker | 33 | 406 | 406 including 2 skipped |
| CLI | 35 | 512 | 700 |
| dashboard | 29 | 212 | 243 |

[INFERENCE] `rg -c` counts matching source lines, not expanded parameterized runtime cases; it must not replace runtime totals. Worker execution uses `cloudflareTest`, Wrangler configuration and Miniflare bindings (`worker/vitest.config.ts:59-67`). Existing claim race assertions are in `worker/test/claims.test.ts:84-103`; identity/token assertions in `worker/test/identity.test.ts:339-418`; connector credential separation/read-only assertions in `worker/test/ask-channel.test.ts:644-725`.

[FACT-CODE] Feature anchors: GitHub browser/device sign-in and signed sessions (`handleAuthRoute`, `worker/src/auth-api.ts:94-120`, `:175-192`, `:227-246`; `signSession/verifySession`, `worker/src/session.ts:75-86`); login-based identity and per-Agent token admission (`Access.admit`, `worker/src/access.ts:92-114`); hashed token issuance and Gone revocation (`Access.issueAgentToken/revokeAgent`, `worker/src/access.ts:178-194`; `Channel` presence callback, `worker/src/channel.ts:554-559`). Repo Channel selection is `channelOf`, `worker/src/index.ts:63-65`; membership is cached GitHub collaborator write permission with outage grace (`Access.checkMember`, `worker/src/access.ts:117-148`). `channelRepo` applies the repo allowlist (`worker/src/auth.ts:54-66`).

[FACT-CODE] Wrangler has only `CHANNEL` → `Channel`, SQLite migration `v1`, static `ASSETS`, repo allowlist and runtime limits; no D1 binding (`worker/wrangler.jsonc:19-57`). Channel tables use `ctx.storage.sql`, and Skills/Artifacts also use the storage API (`Channel.constructor`, `worker/src/channel.ts:485-522`). [INFERENCE] Search `rg -n 'Organization|WorkspaceMembership|AgentPrincipal|AgentExecution|AgentGrant|policyRevision' worker/src worker/test shared/src cli/src cli/test dashboard/src dashboard/test -g '*.ts' -g '*.tsx'` returned no matches. Native M1 domain records are proposed extensions, not existing features.

## Audit-status correction

[DOC-ONLY] Binding `SPEC.md:7` says the reviewer verdict “remained `REQUEST_CHANGES` after the report revisions, with no re-review”. Actual reviewer files say **`VERDICT: REQUEST_CHANGES`** (`audit/reviews/S6_REVIEW.md:1`) and subsequently **`VERDICT: GO`** (`audit/reviews/S8_CONFIRMATION.md:1`). These exact verdicts also appear at line 1 of the supplied prior-audit directory's `reviews/S6_REVIEW.md` and `reviews/S8_CONFIRMATION.md`. S8 confirms no remaining disagreements (`audit/reviews/S8_CONFIRMATION.md:32-35`). The deliverables' review-status lines and `REVIEW_RESOLUTION.md` were left stale; e.g. `audit/SWITCHBOARD_CURRENT_STATE_AUDIT.md:3`, `:304-308`, `audit/REVIEW_RESOLUTION.md:41`. S8 is the independent reviewer's GO after S7 report revisions, not production-security approval and not approval of this new M1 design.

## Round 1 revision inspection

[FACT-CODE] Read-only `git log --oneline 66abafbb15d68a40970b51eeac25928a9f7b80ad..HEAD` now shows `b3a5e24` (design documents) and `4157ed8` (independent review); inspection HEAD is `4157ed8328f3d430fc17a458edc653970c6e075f`. `git diff --stat 66abafbb15d68a40970b51eeac25928a9f7b80ad HEAD` lists only eleven `m1/` deliverable/log/script files; the same diff restricted to `worker shared cli dashboard` is empty. Earlier baseline observations above remain historical, not current-HEAD claims. Application citations remain valid; no baseline rerun was performed.

[DOC-ONLY] Latest Gate 0 reviewer verdict is REQUEST_CHANGES (`reviews/G0_REVIEW.md:1`). Round 1 source rechecks and decisions are in `G0_RESOLUTION.md`; this is separate from historical audit S8 GO. [DECISION] No baseline test correction is needed for the seven design findings. All added security cases remain planned, not passed.
