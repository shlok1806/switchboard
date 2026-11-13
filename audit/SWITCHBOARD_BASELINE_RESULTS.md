# Switchboard baseline results — S3

Totals: **14/14 steps exited 0; 95 test files passed, 0 failed, 2 skipped; 1,347 tests passed, 0 failed, 2 skipped; 203 screenshots generated.** Skips are **Not verified (needs credentials/real service)**. Total recorded step time: 784 seconds.

## Evidence and environment

This report reads existing manager-run logs only; no tests, installs, builds, deployments, or network operations were executed for S3. Source references are relative to the clone root; `baseline_logs/` and `run_baseline.sh` references are relative to the report directory. Logs establish execution outcomes; [FACT-TEST] denotes assertions in source, not independent verbose per-test execution records. The logs contain aggregate Vitest summaries rather than individual test names. Mapping named source tests to those successful suites below is [INFERENCE], constrained by the inspected configs and skip gates. No missing-feature conclusion is made.

Repository: https://github.com/shlok1806/switchboard; audited clone `/home/box/engineering-workspace/worktrees/switchboard-bulletin`; branch `bulletin`; HEAD `fe392689db002edb058eca9b6047be577c5bb656` (`baseline_logs/env.txt:3-4`; identity supplied in task context). Runtime: Node **v22.23.5**, npm **10.9.9** (`baseline_logs/env.txt:1`). OS: `Linux grok-bot-vm-331677601 6.12.94+ #1 SMP PREEMPT_DYNAMIC Fri Oct 16 00:53:04 UTC 2026 x86_64 GNU/Linux` (`baseline_logs/env.txt:2`).

[DOC-ONLY] Binding manager context says system Node was v20.19.2 and a SHA256-verified Node v22.23.5 tarball was installed at `~/.local/node22`. The provided logs prove the selected runtime version, but contain no original tarball digest/checksum transcript, so checksum verification and original system version are not independently verified here. [FACT-CODE] CLI `engines.node` requires `>=22.13` (`cli/package.json:10-12`); CI selects Node 22 (`.github/workflows/ci.yml:21-24`, `:36-39`, `:59-62`). Runner prepends `$HOME/.local/node22/bin`, unsets `JEV_API_KEY`, `LIVE_GITHUB_TOKEN`, `CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, and exports `CI=true` (`run_baseline.sh:5-7`). No credential files were read.

Run window: **2026-11-12 19:21:20–19:34:24 CST (America/Chicago, UTC−06:00)**; ending time calculated from last start 19:29:16 + 308 seconds (`baseline_logs/summary.tsv:2-15`). Summary has `DONE` at line 16; all 14 corresponding logs exist. No step is incomplete. `baseline_logs/git_status_after.txt` exists and is empty (0 bytes): recorded post-run porcelain status reports no tracked changes or visible untracked files. It does not prove absence of ignored generated artifacts or intermediate writes. The runner itself installs dependencies and generates builds/screenshots; S3 did not execute it (`run_baseline.sh:16-30`; `baseline_logs/14_dashboard_shots.log:5`).

## Recorded results

Durations are runner wall-clock seconds, not Vitest's parallel test timings. P/F/S means passed/failed/skipped. A dash means not a Vitest step. Diagnostic counts are reported only when printed: clean tools do not print numeric error/warning totals, so these rows say “no diagnostics printed” rather than inventing counts. Evidence for each row: corresponding `baseline_logs/<step>.log` and `baseline_logs/summary.tsv:2-15`.

| Step | Directory | Exact command | Exit code | Duration | Test files P/F/S | Tests P/F/S | Notes |
|---|---|---|---:|---:|---|---|---|
| 01_worker_ci | `worker` | `npm ci` | 0 | 12 s | — | — | 99 packages added; 100 audited; 10 vulnerabilities (2 moderate, 8 high). |
| 02_cli_ci | `cli` | `npm ci` | 0 | 3 s | — | — | 151 added; 152 audited; prepare builds CLI; 12 vulnerabilities (7 moderate, 5 high). |
| 03_dashboard_ci | `dashboard` | `npm ci` | 0 | 3 s | — | — | 187 added; 188 audited; 5 vulnerabilities (2 moderate, 3 high). |
| 04_worker_typecheck | `worker` | `npm run typecheck` | 0 | 1 s | — | — | tsc worker and scripts; no diagnostics printed. |
| 05_worker_lint | `worker` | `npm run lint` | 0 | 0 s | — | — | Biome: Checked 148 files in 129ms. No fixes applied. No diagnostic totals printed. |
| 06_worker_test | `worker` | `npm test` | 0 | 24 s | 31/0/2 | 404/0/2 | workerd exception emitted; final suite passes; live-service skips. |
| 07_cli_typecheck | `cli` | `npm run typecheck` | 0 | 0 s | — | — | tsc; no diagnostics printed. |
| 08_cli_lint | `cli` | `npm run lint` | 0 | 0 s | — | — | Biome: Checked 130 files in 208ms. No fixes applied. No diagnostic totals printed. |
| 09_cli_test | `cli` | `npm test` | 0 | 421 s | 35/0/0 | 700/0/0 | Includes CLI esbuild; no build diagnostics printed. |
| 10_dashboard_lint | `dashboard` | `npm run lint` | 0 | 0 s | — | — | Biome: Checked 133 files in 124ms. No fixes applied. No diagnostic totals printed. |
| 11_dashboard_typecheck | `dashboard` | `npm run typecheck` | 0 | 1 s | — | — | tsc -b; no diagnostics printed. |
| 12_dashboard_build | `dashboard` | `npm run build` | 0 | 2 s | — | — | tsc -b and Vite; 2130 modules transformed; built in 557ms; no error/warning counts printed. |
| 13_dashboard_test | `dashboard` | `npm test` | 0 | 9 s | 29/0/0 | 243/0/0 | All aggregate tests passed. |
| 14_dashboard_shots | `dashboard` | `timeout 900 npm run shots` | 0 | 308 s | — | — | 203 screenshots; no warning/failure counts printed; no missing-browser error. |

Exact Vitest summary lines (no failed counts printed; zero failures follows the successful aggregate summaries and exit codes):

```text
# baseline_logs/06_worker_test.log:44-45
 Test Files  31 passed | 2 skipped (33)
      Tests  404 passed | 2 skipped (406)
# baseline_logs/09_cli_test.log:21-22
 Test Files  35 passed (35)
      Tests  700 passed (700)
# baseline_logs/13_dashboard_test.log:9-10
 Test Files  29 passed (29)
      Tests  243 passed (243)
```

## Every skipped test

Search performed: `rg -n 'skipIf|\.skip\(|\.todo\(' worker/test cli/test dashboard/test` found the two live suite gates below. This matches exactly two skipped files and two skipped tests in `baseline_logs/06_worker_test.log:44-45`; CLI/dashboard report no skips. Each gated file declares one test.

| File and named test | Gate and reason | Outcome |
|---|---|---|
| `worker/test/github-live.test.ts:20-39`, `it("lists every open Issue in the repo as a Task")` | [FACT-TEST] `describe.skipIf(!token)`; token comes from `env.LIVE_GITHUB_TOKEN` at line 13. Runner unsets it. Assertions compare real GitHub issues to API Tasks. | **Not verified (needs credentials/real service)** |
| `worker/test/jev-live.test.ts:29-93`, `it("gives a Verdict with a probability for each option")` | [FACT-TEST] `describe.skipIf(!env.JEV_API_KEY)`; runner unsets key. Assertions at lines 84-91 require real Jev verdict provenance and bounded probabilities summing approximately to one. | **Not verified (needs credentials/real service)** |

[FACT-CODE] Worker config passes absent keys as empty bindings (`worker/vitest.config.ts:8-22`, `:59-66`). Default `beforeEach` installs `FakeJev` (`worker/test/setup.ts:1-11`). Passing mocked tests do not substitute for these real-service tests.

## Warnings and anomalous output

No command failed and no test failed in the supplied results (`baseline_logs/summary.tsv:2-16`; quoted summaries above). Every warning/error-like output category found in the logs is retained below. No remediation commands were run.

Dependency audit output:

```text
# baseline_logs/01_worker_ci.log:7
10 vulnerabilities (2 moderate, 8 high)
# baseline_logs/02_cli_ci.log:23
12 vulnerabilities (7 moderate, 5 high)
# baseline_logs/03_dashboard_ci.log:7
5 vulnerabilities (2 moderate, 3 high)
```

[INFERENCE] These are npm dependency audit findings, not compiler/linter/test failures. Across installs they total 27 reported findings (11 moderate, 16 high), **not 27 distinct vulnerable packages**: duplicate dependencies/advisories may overlap. The logs contain no advisory IDs, dependency chains, or affected symbols, so exploitability, precise root cause, and code-defect attribution are **Not verified**. They are dependency-state findings in this installation; they cannot be classified as merely an OS/browser issue. [RECOMMENDATION] Review a separately authorized detailed dependency audit before selecting fixes; the output's `npm audit fix` suggestions are not evidence a fix is safe.

Worker runtime anomaly:

```text
# baseline_logs/06_worker_test.log:20
exception = workerd/api/unsafe.c++:228: failed: jsg.Error: Application called deleteAllDurableObjects().
```

A native workerd stack follows on line 21; it identifies no application test name. [INFERENCE] Likely associated with test teardown/reset of Durable Objects in the local Cloudflare pool: e.g. `afterEach` calls `reset()` in `worker/test/claims.test.ts:76-80` and `worker/test/handoff.test.ts:135-139`; the pool is configured by `cloudflareTest` (`worker/vitest.config.ts:59-66`). This association is a hypothesis, not proven causality. Classification: local runtime/harness anomaly; no demonstrated production code defect, and not proven OS-specific. The successful summary does not explain or erase the exception. [RECOMMENDATION] If investigated separately, capture verbose per-test output to locate the triggering teardown.

The repeated “Using secrets defined in process.env” messages expose no values (`baseline_logs/06_worker_test.log:8-19`, `:22-42`); they are informational, not evidence of live credentials or real-service coverage. Build/typecheck/lint logs print no warnings, and screenshots complete successfully (`baseline_logs/14_dashboard_shots.log:1-5`). In particular, no missing-browser failure occurred.

## Focus-area evidence and limits

The following source assertions were located with `rg -n 'it\(|test\(' worker/test cli/test dashboard/test`, plus targeted `rg` searches for `claim|concurrent|relay|handoff|resume|permission|forged|takeover|Codex|Cursor|Gemini`. [FACT-TEST] describes what those tests prove. [INFERENCE] The named non-gated tests belong to the passing aggregate run: worker 404, CLI 700, dashboard 243. The compact logs do not provide individual test-case pass lines. Coverage statements below concern the specified assertions, not measured code coverage. No coverage report is present in the supplied logs. [FACT-CODE] CLI Vitest uses Node with `short-tmpdir` global setup and 60/90-second test/hook timeouts (`cli/vitest.config.ts:3-10`); dashboard discovery explicitly includes `test/**/*.test.{ts,tsx}` (`dashboard/vitest.config.ts:11`).

| Focus area | Named tests mapped to successful runs; strongest assertions | What remains Not verified |
|---|---|---|
| Worker & Durable Object behaviour | [FACT-CODE] `Channel extends DurableObject<Env>` (`worker/src/channel.ts:420`); `claimTask` delegates to `claims.claim` (`:743-745`). [FACT-TEST] `worker/test/channel.test.ts:168-185`, “delivers a posted Update to every connected WebSocket as an Event naming its Person”, posts through the API and checks both subscribers' Event payloads. Worker pool runs under `cloudflareTest` (`worker/vitest.config.ts:59-66`); worker aggregate passed. | Production Cloudflare deployment, geographically distributed load, and production persistence/operational reliability are not established by this local run. |
| CLI integrations & lifecycle | [FACT-TEST] `cli/test/clis.test.ts:22-36`, “leaves a new session to Codex, and knows a resumed one by its ID”, asserts session plans; `:135-145`, “plans sessions from --resume and create-chat for new ones”, checks Cursor resume/discovery plans; `:147-164`, “reads Cursor hooks as Claude Code's and answers sessionStart”, asserts translated payload/context; `:168-178`, “plans sessions from --resume”, checks Gemini plans. `cli/test/e2e.test.ts:1473-1541`, “marks the Claim of a Gone Agent Stale; a Person takes it over, and the resumed Agent is told”, exercises the Claude wrapper fixture and recovery. CLI aggregate passed. | Real installed vendor CLIs and real model sessions are not proved: e2e uses fake CLI fixtures and local stand-ins (`cli/test/e2e.test.ts:364-383`; `cli/test/fixtures/fake-claude.mjs`, `fake-codex.mjs`, `fake-gemini.mjs`). Cursor test's name mentions create-chat, but its shown assertions prove plans, not a real Cursor process. |
| Dashboard build & tests | Build exited 0 (`baseline_logs/12_dashboard_build.log:3-7`, `:58`); dashboard aggregate passed. [FACT-TEST] `dashboard/test/host-sharing.test.tsx:64-77`, “sends the list signed by this browser's key when a Person is toggled”, checks request and UI state; `:80-92`, “shows the Host's refusal with the command that trusts this browser, and leaves the toggle off”, checks refusal display. Screenshot run prints 203 generated (`baseline_logs/14_dashboard_shots.log:5`). | Screenshots were not manually reviewed in S3; generation does not establish visual quality or pixel-regression equivalence. UI tests use stand-ins, not production services. [FACT-CODE] screenshot script checks expected state and phone-layout failures, and exits 1 on failures (`dashboard/scripts/shots.mjs:314-342`). |
| Shared types/API contracts | Three package typechecks exited 0 (logs `baseline_logs/04_worker_typecheck.log:2-3`, `baseline_logs/07_cli_typecheck.log:2-3`, `baseline_logs/11_dashboard_typecheck.log:2-3`). [FACT-CODE] `compilerOptions`/`include` include shared source in `worker/tsconfig.json:18`, `cli/tsconfig.json:17`, `dashboard/tsconfig.app.json:21-23`; package scripts at `worker/package.json:10`, `cli/package.json:16`, `dashboard/package.json:9`. [FACT-TEST] claims test below checks runtime response status and typed refusal payload. | Compile-time agreement is not exhaustive runtime schema validation, compatibility with older independently deployed clients, or validation of every external payload. Dashboard app config includes src/shared, not all test source. |
| Concurrent claims | [FACT-TEST] `worker/test/claims.test.ts:84-102`, “lets exactly one of two concurrent Claims win, and the other names the holder”: `Promise.all` starts two claims, asserts statuses `[200,409]`, loser names winner, final holder matches, and exactly one claim Event exists. Worker aggregate passed. | This is a two-request race in the local pool, not sustained load, multi-region concurrency, or a stress-test result. |
| Agent-to-agent communication | [FACT-TEST] `worker/test/relay.test.ts:911-937`, “queues an Update for its one addressee even when Jev would drop it, and relays it to no one else”: asserts addressed Queue verdict, unaddressed Carol drop/no deliveries, and Alice receives delivery. Worker aggregate passed. | Real Jev behaviour is **Not verified (needs credentials/real service)**; default and test-specific stand-ins do not prove real model delivery decisions. |
| Permission enforcement | [FACT-TEST] `worker/test/claims.test.ts:177-191`, “lets a Person claim for their own Agent, but not for another Person's”, asserts foreign-Agent 403/no claim then own-Agent 200; `:194-207`, “lets an Agent claim only for itself, and only as its own Person”, asserts other-Agent 403 and forged bearer 401. Worker aggregate passed. Dashboard refusal test above verifies UI response handling, not backend enforcement. | These checks do not constitute a full security audit or prove every route/policy; real GitHub access checks and production credential configuration are not established by the skipped live test. |
| Agent recovery & handoffs | [FACT-CODE] `Channel.takeoverTask` delegates to `staleClaims.takeover` (`worker/src/channel.ts:773-775`). [FACT-TEST] `cli/test/e2e.test.ts:1473-1541` (name above): verifies Gone/stale retention, Agent takeover 403, Person takeover 200, handoff Event, resumed hook notice once, and former holder unable to complete step. CLI aggregate passed. `dashboard/test/handoff.test.tsx:90-102`, “says which Agent it continues, and the predecessor says which continue it, each a link”, checks both links; dashboard aggregate passed. | Real crash/disaster recovery and real successor execution remain unverified. The title “opens the Start an Agent sheet in its folder with a brief to edit, and starts the successor from it” (`dashboard/test/handoff.test.tsx:106-129`) is stronger than its assertions: mocked spawn returns Offline; assertions prove request fields, not successful successor startup. |

Status vocabulary: the cited `Channel.claimTask` and `Channel.takeoverTask` paths are **Implemented and verified** for the narrow tested behaviours (code plus source assertions and aggregate baseline pass). This does not confer that status on every product capability or the broader proposed organizational work layer. The live integrations are **Implemented but unverified** by this baseline; their tests were skipped, never passed.

## Not run

- CI deploy job: **Not verified**; deliberately excluded; never deploy. [FACT-CODE] CI `deploy` is gated on push to main and runs `npx wrangler deploy` (`.github/workflows/ci.yml:82-84`, `:122-127`). No deployment is among runner steps (`run_baseline.sh:16-29`).
- Opt-in real GitHub and Jev tests: **Not verified (needs credentials/real service)**, gates and exact test names listed above. They were discovered and skipped, not omitted from discovery.
- GitHub Actions checkout/cache/setup execution and screenshot artifact upload: no local baseline execution evidence; runner performs local package commands. CI uploads screenshots at `.github/workflows/ci.yml:74-80`. CI parallel scheduling is not reproduced: runner is sequential. Dashboard standalone typecheck and screenshot timeout are local additions to the command sequence (`run_baseline.sh:26`, `:29`; CI `.github/workflows/ci.yml:69-73`).
- No separate `npm audit` detail run, coverage instrumentation, manual screenshot inspection, production smoke run, or new S3 test execution is evidenced. No report of those activities passing is made.

## Reproduction (instructions only; not executed by S3)

Use a separate disposable fresh clone with the exact SHA above, not the protected audit clone. Obtaining that clone and the verified Node tarball is an external prerequisite; this report does not invent network or checksum commands absent from the runner. Ensure the existing SHA256-verified Node v22.23.5 installation is at `$HOME/.local/node22`. The following commands are copied from `run_baseline.sh:5-7`, `:17-30`, with directory changes added to make each working directory explicit. Set `R` to the fresh clone. These reproduction commands install and write build outputs, so must not be run in the read-only audit clone.

```bash
export PATH="$HOME/.local/node22/bin:$PATH"
unset JEV_API_KEY LIVE_GITHUB_TOKEN CLOUDFLARE_API_TOKEN GITHUB_TOKEN GH_TOKEN
export CI=true
R=/absolute/path/to/disposable-fresh-switchboard-clone
(cd "$R/worker" && npm ci)
(cd "$R/cli" && npm ci)
(cd "$R/dashboard" && npm ci)
(cd "$R/worker" && npm run typecheck)
(cd "$R/worker" && npm run lint)
(cd "$R/worker" && npm test)
(cd "$R/cli" && npm run typecheck)
(cd "$R/cli" && npm run lint)
(cd "$R/cli" && npm test)
(cd "$R/dashboard" && npm run lint)
(cd "$R/dashboard" && npm run typecheck)
(cd "$R/dashboard" && npm run build)
(cd "$R/dashboard" && npm test)
(cd "$R/dashboard" && timeout 900 npm run shots)
git -C "$R" status --porcelain
```

To reproduce the exact logging format, use the supplied `run_baseline.sh` only after adapting its `R` to that disposable clone and `L` to a permitted report/log directory. Its `run()` function captures stdout/stderr and exit code independently for every step, records CT start and seconds, then writes status and `DONE` (`run_baseline.sh:8-15`, `:30-31`). It uses `set -u`, not fail-fast: inspect each recorded exit code; `DONE` alone does not mean success. The actual input's success is established by all 14 zero exit codes plus the summaries.
