VERDICT: REQUEST_CHANGES

Commit statuses below reflect findings still present at HEAD `9b4628c`; repaired historical defects are addressed in the round-1 disposition.

COMMIT 0c55d77: OK  
COMMIT 67b21db: OK  
COMMIT ec51091: FINDINGS (1, 5)  
COMMIT 2501ea1: OK  
COMMIT 7b86184: OK  
COMMIT cd3946e: OK  
COMMIT 1872c8b: OK  
COMMIT 0392395: OK  
COMMIT f9e1378: OK  
COMMIT eeb2e97: OK  
COMMIT 87b8813: OK  
COMMIT 492e0a2: OK  
COMMIT f54690c: OK  
COMMIT addd4c5: OK  
COMMIT 110d7c3: OK  
COMMIT 2e7bac9: OK  
COMMIT 06e0cca: OK  
COMMIT 3adacdf: FINDINGS (1, 2, 3, 4)  
COMMIT 1609ac1: OK  
COMMIT 88ee93a: OK  
COMMIT 9b4628c: OK  

1. **P1 must-fix — Managed control responses disclose raw Agent records.**  
   The approval-denial handler serializes its complete `RosterResult` at [worker/src/channel.ts:2337](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts:2337). `denyApproval` returns the raw Agent at [worker/src/agents.ts:594](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/agents.ts:594). Consequently, a cross-owner caller granted only `terminal_control` receives session/context and other fields excluded from `SafeAgent`. Heartbeat, end, proxy-mode, nickname, model, approval reporting and role responses follow the same raw-result pattern; see [channel.ts:2170](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts:2170) and [channel.ts:2357](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts:2357). The required allowlist already exists at [managed-projection.ts:10](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/managed-projection.ts:10).

   **Required change:** Project every managed roster mutation response through the allowlist using trusted execution identity. Keep operation outcomes separate from private Agent fields. Add marker-based response tests, particularly for cross-owner approval consent without private-read consent. Update Package-3-added assertions that currently require raw Agent fields, documenting the design correction.

2. **P1 must-fix — Registration’s apply permit can outlive predecessor consent.**  
   `registrationCurrent` checks cross-owner handoff through `channelDecision` but retains only `.ok`, discarding its authority deadline at [worker/src/organization.ts:1665](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts:1665). Activation then gives the apply permit a deadline of `min(now + 2000, reservation.expiresAt)` at [organization.ts:1808](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts:1808). Reservation expiry does not include predecessor-consent expiry ([organization.ts:1541](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts:1541)).

   A consent valid at activation can therefore expire before TXN-2 while its apply permit remains valid. TXN-2 commits the continuation; the subsequent completion check may deny only after shared effects occurred ([channel.ts:3106](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts:3106), [channel.ts:3130](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts:3130)).

   **Required change:** Preserve the deadlines from all constituent policy decisions and cap the compound apply permit by their minimum, including predecessor consent. Add a real-handler race where consent expires after activation issuance but before TXN-2; assert no registration, handoff, queue or presence effects.

3. **P2 should-fix — One completed registration prevents subsequent executions on the same Host.**  
   Enrollment has a primary key of `(organizationId, workspaceId, hostId)` at [worker/src/registration-enrollments.ts:27](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/registration-enrollments.ts:27), but rejects any existing row with a different intent or execution at [registration-enrollments.ts:51](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/registration-enrollments.ts:51).

   A second legitimate session on that Host—or a new registration of the same session with a new key—therefore fails completion after TXN-2. Completion converts this failure into a retryable 503 ([organization.ts:1889](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts:1889), [organization.ts:1909](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts:1909)), leaving an applied registration that cannot complete normally.

   **Required change:** Support multiple independently verified execution attachments to the same owner’s Host while preserving exact target consent and ownership immutability. Add sequential same-Host registration, resume/re-registration, and independent execution-revocation tests.

4. **P2 should-fix — Retention pruning removes authorization provenance for active enrollments.**  
   Every enrollment use requires its completed reservation still to exist ([worker/src/organization.ts:1105](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts:1105)). Reservation pruning deletes completed rows after the outcome-retention interval, irrespective of an active enrollment or execution ([worker/src/registration-reservations.ts:262](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/registration-reservations.ts:262)). That interval is 24 hours ([managed-retention.ts:3](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/managed-retention.ts:3)).

   Once pruning runs, a still-active enrollment silently becomes unusable for consent and control.

   **Required change:** Retain the necessary provenance for active enrollments, or persist independently verifiable completion provenance with the enrollment. Keep terminal-record storage bounded. Test pruning beyond retention while an execution remains active, followed by legitimate consent/control and explicit revocation.

5. **P2 should-fix — Managed heartbeat/end contain unbounded authority waits and omit response-release rechecks.**  
   Heartbeat directly awaits `touchRegisteredExecution`, then returns the captured roster result without fresh authorization ([worker/src/channel.ts:2165](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts:2165)). End similarly awaits `endManagedAssociation` before returning ([channel.ts:2199](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts:2199)); its delivery RPC has no `authorityRequest` bound ([channel.ts:3373](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts:3373)). Ownership RPCs in these control handlers are also awaited directly, for example [channel.ts:2179](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts:2179).

   Authority stalls can therefore exceed the required bound, and revocation or rebinding during a post-commit await does not prevent response release.

   **Required change:** Bound managed authority RPCs through the shared helper. Recheck authorization and binding before releasing response data, preserving the distinction between a committed mutation and denied result release. Add timeout and revoke/rebind-during-await handler tests.

Round-1 disposition:

- **Finding 1 — RESOLVED for the reported permit-consumption ordering defect.** TXN-2 consumes the fresh permit before invoking registration ([registration-commit.ts:119](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/registration-commit.ts:119)). Finding 2 above identifies a separate remaining deadline defect.
- **Finding 2 — RESOLVED at the reviewed consent-issuance boundary.** Issuance resolves enrollment and calls `decide()` with owner facts ([organization.ts:924](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/organization.ts:924), [policy.ts:256](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/policy.ts:256)).
- **Finding 3 — RESOLVED for exact Host binding and local target revalidation.** The handler updates the outer enforcement input before preparation and rereads target association/Host at commit ([channel.ts:2297](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts:2297), [channel.ts:2312](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/src/channel.ts:2312)). Actual machine-local enforcement remains a B3b/B4 obligation; the positive test mocks interrupt dispatch ([managed-verified-control.test.ts:82](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/worker/test/managed-verified-control.test.ts:82)).

Validation: Worker `npm run typecheck` **passed, exit 0**. Runtime tests were **not run** in this read-only review. No files were modified. No package/configuration changes were found in the reviewed range. The sole modified baseline test contains the two documented R16 exceptions ([P3_IMPLEMENTATION_NOTES.md:1768](/home/box/engineering-workspace/worktrees/switchboard-m1-p3/m1/p3/P3_IMPLEMENTATION_NOTES.md:1768)).

`B2_REVIEW.md`, `B3_REVIEW.md` and the requested confirmation files are absent from this worktree, so comparison against them was unavailable.