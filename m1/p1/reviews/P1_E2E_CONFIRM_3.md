VERDICT: GO

---

### Findings

#### E3-1 (P3 nit / advisory) — Statistical limitation of whole-suite e2e sample size vs baseline flake rate
- **File:line**: [cli/test/e2e.test.ts#L1](file:///home/box/engineering-workspace/worktrees/switchboard-m1/cli/test/e2e.test.ts#L1), [_agy_inputs/M1-P1-E2E-C3/DIAG7_SUMMARY.txt#L7-L9](file:///home/box/engineering-workspace/worktrees/_agy_inputs/M1-P1-E2E-C3/DIAG7_SUMMARY.txt#L7-L9)
- **Problem**: In DIAG7 round 3 (commit `e0b27c8`), both whole-suite `cli/test/e2e.test.ts` runs passed cleanly (run 1: 94 passed in 414.26s; run 2: 94 passed in 411.25s), and the manager full gate `final2-r3` passed (worker: 493 passed / 2 skipped; cli: 699 passed / 1 known baseline flake; dashboard: 243 passed). While this firmly rules out deterministic regressions (such as round 2's 2/2 failure of ADR 0021 terminal tests) and resolves the acute failure clustering observed in `293d116` (6/10 runs failing), a sample size of $N=2$ whole-suite runs is statistically thin against an underlying historical baseline flake rate of ~1 in 14 runs (~7.1%).
- **Correction**: No code change required for Package 1 sign-off. Ongoing CI runs across Packages 2–4 should maintain paired baseline comparisons to track long-term flake stability.

---

### Confirmation Review: Checks (1) through (8)

#### 1. Root-Cause Explanation vs Code and Evidence
- **Round-2 ADR 0021 regression**: In round 2 (`e671452`), [worker/src/index.ts#L377-L381](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/index.ts#L377-L381) added an early return `if (route === "GET /api/stream" && response.status === 101) return response;`, bypassing the `await channel.bindingCurrent(...)` RPC after dispatch. In DIAG7 r2, this introduced a deterministic 2/2 failure on `A live terminal (ADR 0021)` keyboard hold/attacher tests ([cli/test/e2e.test.ts#L2547](file:///home/box/engineering-workspace/worktrees/switchboard-m1/cli/test/e2e.test.ts#L2547), [cli/test/e2e.test.ts#L2579](file:///home/box/engineering-workspace/worktrees/switchboard-m1/cli/test/e2e.test.ts#L2579), [cli/test/e2e.test.ts#L2589](file:///home/box/engineering-workspace/worktrees/switchboard-m1/cli/test/e2e.test.ts#L2589)). Bypassing the microtask turn and DO await altered the handoff timing between the WebSocket upgrade completion, backlog delivery, wrapper attachment, and subsequent browser `terminal.watch` / keyboard hold frames. In round 3, that early return was deleted, restoring the common post-dispatch generation RPC. In DIAG7 r3, both runs passed (94/94 passed, exit 0).
- **Hot-path latency & DO reconstruction**: Relative to baseline `5a4ecba`, commit `293d116` executed `ctx.storage.transactionSync` with two `CREATE TABLE IF NOT EXISTS` DDL statements, an `INSERT OR IGNORE`, and two SELECT queries on *every* Channel constructor execution—including frequent WebSocket hibernation wakeups. In addition, inbound frames performed linear tag scans and array allocations at identity consumers on every recognized message, while `managedClosed()` allocated shallow copies `{ ...this.binding }`. In round 3, these specific overheads were targeted: warm reconstruction reads the snapshot with 1 SELECT and 0 DDL/transactions ([worker/src/channel.ts#L496-L526](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L496-L526)), `managedClosed()` reads `this.binding` directly ([worker/src/channel.ts#L748](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L748)), and generation-zero sockets omit `binding:0` tags and redundant tag allocations ([worker/src/channel.ts#L2145-L2176](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L2145-L2176)). As documented in [m1/p1/P1_IMPLEMENTATION_NOTES.md#L35-L42](file:///home/box/engineering-workspace/worktrees/switchboard-m1/m1/p1/P1_IMPLEMENTATION_NOTES.md#L35-L42), the code carefully distinguishes verified structural differences from inferences regarding second-scale test suite drift.

#### 2. Security — Fence Semantics
- **Two-phase generation fence (MCP / HTTP / WebSocket)**:
  - **MCP Tool Calls**: [worker/src/mcp/server.ts#L88-L125](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/mcp/server.ts#L88-L125) checks `channel.bindingCurrent(generation)` upon body receipt, carries generation into read operations, and performs a final pre-response `bindingCurrent(generation)` check before releasing single and batch responses.
  - **HTTP Reads**: [worker/src/index.ts#L368-L381](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/index.ts#L368-L381) passes generation to the DO, wraps execution in `channel.bindingCurrent(...)`, and cancels `response.body` if the generation changed during execution. Asynchronous DO reads ([worker/src/channel.ts#L1476](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L1476), [worker/src/channel.ts#L1514](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L1514), [worker/src/channel.ts#L1933](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L1933)) check `!this.managedClosed() && this.bindingState().generation === generation` immediately following their awaits.
  - **WebSocket Upgrades & Closure**: Stream upgrades in [worker/src/channel.ts#L2120-L2122](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L2120-L2122) and [worker/src/channel.ts#L2139-L2141](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L2139-L2141) recheck `this.bindingCurrent(generation)` after the final `await this.watchMembers()` in the same DO turn that returns HTTP 101. When a transition occurs, [worker/src/channel.ts#L857-L863](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L857-L863) synchronously iterates `this.ctx.getWebSockets()` and calls `ws.close(1008)` on every open socket.
  - **Worker-side Upgrade Window**: Restoring [worker/src/index.ts#L377-L380](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/index.ts#L377-L380) ensures that an upgrade completed inside the DO during a transition is fenced again at the Worker before handing the response to the client.
- **Short-Circuited State & Transition Safety**:
  - `this.binding` is set exclusively in `Channel.constructor` ([worker/src/channel.ts#L498-L525](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L498-L525)), `prepareBinding` ([worker/src/channel.ts#L851](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L851)), and `finishBinding` ([worker/src/channel.ts#L913](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L913)), always backed by synchronous SQLite transactions.
  - In `webSocketMessage` ([worker/src/channel.ts#L2168-L2176](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L2168-L2176)), the condition `if (this.managedClosed() || (this.binding.generation !== 0 && ...))` can never miss a transition:
    1. `managedClosed()` is evaluated first; any pending, recovery, or linked state immediately triggers WebSocket closure (code 1008).
    2. Once linked or unlinked, `generation` is incremented (to $\ge 1$ on link, $\ge 2$ on unbind) and never returns to 0. Thus `this.binding.generation !== 0` becomes true, enforcing full tag verification. Old sockets missing a matching generation tag are closed with 1008 (tested in [worker/test/workspace-binding.test.ts#L690-L715](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/test/workspace-binding.test.ts#L690-L715)).
- **Isolation & Policy**: Default-deny, org/workspace isolation, collaborator $\ne$ workspace access, and dual-authority linking (repo-admin + `workspace.manage`) remain intact.

#### 3. No Credentials in the DO
- The comment in [worker/src/index.ts#L177](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/index.ts#L177) (*"The Durable Object only ever sees the admitted Person and Agent, never a credential"*) remains true.
- `handleStream` ([worker/src/index.ts#L178-L186](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/index.ts#L178-L186)) builds a synthetic URL (`https://channel/stream`) containing only `person`, `generation`, `agent`, `host`, `history`, and `after`, dispatching with `{ headers: { Upgrade: "websocket" } }` without client request headers or credentials.
- The unreviewed round-1 attempt (`a432667`) that routed raw credentials into the DO was completely reverted in `b52922c` and remains absent.

#### 4. Legacy Parity
- Never-linked legacy Channels behave identically to baseline `5a4ecba`:
  - **Admission**: Zero added RPCs, zero added SQL reads, zero added awaits ([worker/src/channel.ts#L919-L932](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L919-L932)).
  - **Stream Upgrades**: Reconnects and stream upgrades take 3 Worker$\to$DO calls (admission + fetch + `bindingCurrent`), matching the approved Package 1 design; zero DO binding awaits or SQL reads during stream serving.
  - **Warm Frames & Broadcasts**: Zero SQL reads and zero awaits on frame processing. For generation 0, tag lookup and identity array allocations are skipped.
  - **Reconstruction**: Adding a single SELECT query without DDL or transactions on warm DO wakeups restores baseline hibernation reconstruction performance.

#### 5. No Test Weakened
- Verified via `git diff 5a4ecba..HEAD -- cli/test/ dashboard/test/`: completely empty.
- Verified via `git diff 5a4ecba..HEAD --name-status worker/test/`: zero pre-existing test files modified (only 5 new M1 test files added).
- Verified via `git diff 293d116..HEAD -- worker/test/ worker/vitest.config.ts worker/wrangler.jsonc`: completely empty.
- No timeouts were raised, no retries added, and no assertions loosened.

#### 6. Test Results & Gate Status
- `TESTS.txt` gate `final2-r3` (`e0b27c8`):
  - `06_worker_test`: 35 passed, 2 skipped (493 passed).
  - `09_cli_test`: 34 passed, 1 failed (699 passed; 1 failed is the documented baseline flaky `terminal.test.ts` attach cache test).
  - `13_dashboard_test`: 29 passed (243 passed).
- `DIAG7_SUMMARY.txt` round 3 (`e0b27c8`):
  - run 1: 94 passed (94), exit 0, duration 414.26s.
  - run 2: 94 passed (94), exit 0, duration 411.25s.
- `npm run typecheck` (Node 22): exit 0.
- `npm run lint` (Biome, 158 files): exit 0, 0 errors.
- `git diff --check`: exit 0.

#### 7. Minimality
- The net difference between `293d116` and `HEAD` is restricted entirely to [worker/src/channel.ts](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts) (+33 lines, -14 lines) alongside documentation notes in `m1/p1/`.
- No architectural rewrite, no new central component, and no request routing moved into the DO.

#### 8. Status of Earlier Deferred Findings
- **P1R-1** (P3 nit / DEFER-P3 — Unbounded accumulation of expired invitations in `organization.ts`): Unchanged. Deferred to Package 3/4.
- **P1R-2** (P3 nit / DEFER-P3 — Stale invitation routing rows retained in `IdentityDirectory`): Unchanged. Deferred to Package 3/4.
- **P1R-3** (P2 should-fix / DEFER-P3 — Defensive generation tag check on stream broadcast dispatch): [worker/src/channel.ts#L2654-L2658](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L2654-L2658) retains the existing broadcast loop; sockets are closed synchronously on transitions. Deferred to Package 3.
- **P1R-4** (DEFER-P3 — Linked Channel data access fail-closed until Package 3): Intentional fail-closed behavior ([worker/src/channel.ts#L747-L757](file:///home/box/engineering-workspace/worktrees/switchboard-m1/worker/src/channel.ts#L747-L757)) preserved.

---

### Remaining disagreements

None.