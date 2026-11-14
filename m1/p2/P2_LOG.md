# Switchboard M1 — Package 2 log (Stable agent principals and scoped execution identity)

Supervisor: P2-#1 (started 11:56 AM CT Nov 14). Base: origin/bulletin 085b912 (Package 1 merged). Feature branch bot/m1-p2-agent-identity, worktree worktrees/switchboard-m1-p2 (node_modules symlinked from worktrees/switchboard-m1, same lockfiles; dependency changes forbidden → gate step fails). Driver: chain_p2.sh (PLAN → agy PLANCHECK (+1 Codex plan revision if not GO) → S1/S2 quick gates, S3 full gate (≤2 Codex fix rounds each) → full0 full+shots → PAIRED a (whole cli e2e, base 085b912 / P2 head ×3 alternating in worktrees/switchboard-p1-bisect; not FLAKE → 1 Codex E2EFIX + full gate + PAIRED b, still not FLAKE → STOP) → agy REVIEW → ≤2 REVISE/CONFIRM loops (no GO → STOP) → paired final if code changed → final gate → ff-only non-force push of bulletin after verifying origin/bulletin == 085b912).
Gate rule (p2_eval.py, carries P1's CLI e2e tolerance rule, T=1): every step exit 0 except cli test; worker/dashboard 0 failed with totals ≥ baseline (493p/2s, 243p); CLI failures only the known terminal.test.ts flake + ≤1 e2e failure; CLI total ≥ 700; no unhandled errors. Strict run_p2_tests gate also recorded.
Deferred P1 findings P1R-1..4 stay deferred unless P2 naturally touches them.

## Events
- 11:56 AM CT: [P2] M1-P2-PLAN run attempt 1 started
- 11:58 AM CT: [P2] M1-P2-PLAN done
- 11:58 AM CT: [P2] M1-P2-PLANCHECK run attempt 1 started
- 12:04 PM CT: [P2] M1-P2-PLANCHECK done
- 12:04 PM CT: [P2] agy P2 plan-check verdict: GO
- 12:04 PM CT: [P2] M1-P2-S1 run attempt 1 started
- 12:17 PM CT: [P2] M1-P2-S1 done
- 12:17 PM CT: [P2] tests S1 (quick) started at HEAD db84553
- 12:17 PM CT: [P2] tests S1: == totals (S1, quick, HEAD db84553) == 06_worker_test:  Test Files 36 passed | 2 skipped (38) | Tests 506 passed | 2 skipped (508)  | strict: PASS  | eval(T=1): cli failures: [] PASS   | exits: 04_worker_typecheck=0 05_worker_lint=0 06_worker_test=0 07_cli_typecheck=0 11_dashboard_typecheck=0 
- 12:17 PM CT: [P2] M1-P2-S2 run attempt 1 started
- 12:18 PM CT: [P2-#1] supervisor note: plan check GO; S1 quick gate PASS worker 506p/2s; S2 running. Executor P2-#1 returning; chain_p2.sh pid 941141 continues unattended.
- 12:19 PM CT: [P2-#2] executor P2-#2 took over (monitor). COORDINATOR CORRECTION applied: p2_eval.py (backup p2_eval.py.bak-p2-2) now forces e2e tolerance T=0 regardless of chain's argv T=1 (Pranay never approved an e2e flake tolerance; P1 merged 94/94); only tolerated CLI failure = test/terminal.test.ts 'reads the list again only once it changed' (now also file-anchored); worker/dashboard 0 failed, totals >= baseline unchanged. Verified: p1_logs/final (1 e2e fail, old eval PASS) → now FAIL; p1_logs/full0 (2 e2e + shots) → FAIL; p1_logs/final2-r3 (terminal flake only) → PASS; p2_logs/S1 → PASS. Effect: intermediate gate with any e2e failure → existing gate_fix Codex rounds; final gate with any e2e failure → 'CHAIN STOP: final gate failed' (no merge) → report to coordinator, no extra rounds/relaxing. Chain's hl text still prints 'eval(T=1)' (chain not edited while running) — eval.txt content is authoritative.
- 12:19 PM CT: [P2-#2] S1 diff check (fab661e..db84553): attribution OK; no channel.ts/index.ts change; no existing test/config/package files touched (only new worker/test/scoped-executions.test.ts); credentials live in Organization DO as SHA-256 digest (32-byte getRandomValues secret, token m1.<org>.<id>.<secret>), equalDigest fixed 32-byte XOR compare; test asserts no plaintext secret in any table and replay returns no secret. OK.
- 12:27 PM CT: [P2] M1-P2-S2 done
- 12:27 PM CT: [P2] tests S2 (quick) started at HEAD c7f044d
- 12:28 PM CT: [P2] tests S2: == totals (S2, quick, HEAD c7f044d) == 06_worker_test:  Test Files 37 passed | 2 skipped (39) | Tests 519 passed | 2 skipped (521)  | strict: PASS  | eval(T=1): cli failures: [] PASS   | exits: 04_worker_typecheck=0 05_worker_lint=0 06_worker_test=0 07_cli_typecheck=0 11_dashboard_typecheck=0 
- 12:28 PM CT: [P2] M1-P2-S3 run attempt 1 started
- 12:28 PM CT: [P2-#2] S2 → c7f044d (attribution OK). Quick gate PASS: worker 519p/2s (≥493), typecheck/lint 0 (new eval zero-e2e rule; quick gate has no CLI test). Diff check db84553..c7f044d: +execution-api.ts, auth.ts readExecutionActor (only 'Bearer m1.' headers → Organization DO verifyExecution; legacy Channel auth untouched), workspace-api PATCH ceiling; no channel.ts/index.ts change; no existing test/config touched (new worker/test/execution-api.test.ts). Redemption codes = 2×randomUUID, stored only as SHA-256 hex digest in Organization DO, looked up by digest (minor note for agy: lookup is SQL equality on digest of a high-entropy code, acceptable; bearer path uses equalDigest). S3 (Codex) running since 12:28 PM.
- 12:53 PM CT: [P2] M1-P2-S3 done
