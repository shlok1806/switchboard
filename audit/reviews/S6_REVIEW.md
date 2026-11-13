VERDICT: REQUEST_CHANGES

---

### Executive Assessment

The audited deliverables produced by the prior Codex investigation (S1–S5) represent a comprehensive, rigorous, and technically sophisticated review of `shlok1806/switchboard` at application HEAD `fe392689db002edb058eca9b6047be577c5bb656`. The analysis of core primitives—specifically atomic SQLite claim transactions, the lack of an overarching LLM orchestrator, Jev's routing boundaries, the Durable Object repo-partitioning topology, and the post-await PR finish race condition—is grounded in the source code.

However, an independent adversarial review against the codebase reveals several **critical inconsistencies and oversights** that require changes before these deliverables can be accepted:
1. **Capabilities Misclassified as Unverified (WRONG-CLAIM)**: Multiple functions and adapters (`checkFolderAndMode` in `cli/src/host/check.ts` and `claude.install` in `cli/src/clis/claude.ts`) were marked `Implemented but unverified` with `Test evidence: none`, despite having dedicated, passing unit tests in `cli/test/host-check.test.ts` and `cli/test/session-settings.test.ts`.
2. **Matrix Self-Contradictions**: GitHub Field Ownership (`Tasks.apply`) was marked unverified in the Phase 4 section of the Capability Matrix, directly contradicting earlier rows in the same matrix that cite passing unit tests.
3. **Reconcile Reopening Trap for Proposed Workflows**: The Enterprise Gap Analysis proposes non-PR completion strategies for GitHub-backed Tasks without accounting for `Tasks.apply` line 336, which will automatically revert completed tasks to `open` whenever the periodic 5-minute GitHub reconcile alarm runs.
4. **Understated Security Gaps for Vendor/External Agents**: Several severe attack vectors—specifically unbudgeted `/api/updates` denial-of-service, unrestricted cross-agent terminal screen/transcript exfiltration, cross-person directive injection, and unauthenticated handoff declarations—were minimized or omitted from the core findings.

---

### Findings by Severity

#### Finding 1 (P1 — Must-Fix): Misclassification of `checkFolderAndMode` Test Coverage
* **Document & Section**: `SWITCHBOARD_CAPABILITY_MATRIX.md` (Row 54) & `SWITCHBOARD_CURRENT_STATE_AUDIT.md` (§10, line 181).
* **Problem**: The capability `10 — Local root/mode launch boundary` (`cli/src/host/check.ts:98-117 checkFolderAndMode`) is listed as `Implemented but unverified` with `Test evidence: none (not test-covered)`.
* **Evidence**: Source inspection reveals that `checkFolderAndMode` is directly imported and exercised across five dedicated test cases in `cli/test/host-check.test.ts:48-81`, specifically:
  - `it("refuses a folder that only starts with a root's name")` (lines 53-58)
  - `it("refuses a link inside a root that points out of it")` (lines 60-62)
  - `it("refuses a path with .. in it, even one that ends up inside a root")` (lines 64-68)
  - `it("refuses a mode looser than this Host's, and one that is not a mode")` (lines 70-81)
  Remarkably, the author's own preparatory note (`notes/S4_ENTERPRISE.md:91-92`) explicitly cited `cli/test/host-check.test.ts:60-75`, but this evidence was omitted in the final audit deliverables.
* **Exact Correction**: Update Row 54 of `SWITCHBOARD_CAPABILITY_MATRIX.md` and §10 of `SWITCHBOARD_CURRENT_STATE_AUDIT.md` from `Implemented but unverified` to `Implemented and verified`, citing `cli/test/host-check.test.ts:48-81`.

#### Finding 2 (P1 — Must-Fix): Misclassification of `claude.install` Test Coverage
* **Document & Section**: `SWITCHBOARD_CAPABILITY_MATRIX.md` (Row 31) & `SWITCHBOARD_CURRENT_STATE_AUDIT.md` (§4, line 99).
* **Problem**: `4 — Claude hook/MCP installation` (`cli/src/clis/claude.ts:65-79 claude.install`) is categorized as `Implemented but unverified` with `Test evidence: none (not test-covered)`.
* **Evidence**: In `cli/test/session-settings.test.ts:126-154`, the test suite directly exercises `claude.install`:
  - Lines 126-135 invoke `await claude.install({ ... })`.
  - Lines 141-146 (`it("keeps tool search on for a session bound for the Anthropic API")`) verify proxy environment and `ENABLE_TOOL_SEARCH`.
  - Lines 148-153 (`it("leaves tool search alone behind the Person's own gateway, or when they set it")`) verify custom gateway and manual settings preservation.
* **Exact Correction**: Update Row 31 and §4 from `Implemented but unverified` to `Implemented and verified`, citing `cli/test/session-settings.test.ts:126-154`.

#### Finding 3 (P1 — Must-Fix): Internal Inconsistency Regarding GitHub Field Ownership
* **Document & Section**: `SWITCHBOARD_CAPABILITY_MATRIX.md` (Row 78 vs. Rows 21 & 23).
* **Problem**: Row 78 (`Phase-4 C — GitHub field ownership`, `worker/src/tasks.ts:335-344 Tasks.apply`) is classified as `Implemented but unverified` with `Test evidence: none`. However, Rows 21 and 23 in the same matrix classify `Tasks.apply` mirrored fields and webhook/alarm reconciliation as `Implemented and verified`.
* **Evidence**: In `worker/test/tasks.test.ts:101-155` and `worker/test/tasks.test.ts:268-290`, `Tasks.apply` is proven to preserve local workflow fields (`status`, `claim`, `branch`, `pr`) while reconciling external GitHub changes (edits, closes, steps, blockers).
* **Exact Correction**: Upgrade Row 78 to `Implemented and verified`, citing `worker/test/tasks.test.ts:268-290`, which asserts that incoming GitHub changes update mirrored fields without overwriting Switchboard claim metadata.

#### Finding 4 (P1 — Must-Fix): Reconcile Reopening Trap for Proposed Non-PR Completion
* **Document & Section**: `SWITCHBOARD_ENTERPRISE_GAP_ANALYSIS.md` (§2.6, lines 63-68; Row 8 in vision table).
* **Problem**: Extension 6 recommends introducing non-PR task completion and independent review on existing GitHub-mirrored tasks before migrating to provider-neutral work identifiers. However, it fails to account for the core GitHub bidirectional sync invariant in `Tasks.apply`.
* **Evidence**: In [worker/src/tasks.ts#L336-L340](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/tasks.ts#L336-L340):
  ```typescript
  const status = closed ? "done" : before.status === "done" ? "open" : before.status;
  const done = before.status !== "done" && closed;
  const reopened = before.status === "done" && !closed;
  ```
  Switchboard does not own the `closed` state; GitHub owns it. If an agent or independent reviewer marks an issue-backed task `done` on Switchboard without closing the GitHub issue, the 5-minute background alarm (`Tasks.alarm()`, [worker/src/tasks.ts#L201-L210](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/tasks.ts#L201-L210)) or any incoming webhook for that issue will observe `closed === false`, trigger `reopened = true`, and spontaneously revert the task from `done` to `open` (`task.reopen` event).
* **Exact Correction**: Add an explicit design constraint to Extension 6: non-PR task completion on GitHub-mirrored tasks cannot function merely by adding a Switchboard completion endpoint; it requires either adding a GitHub Issue close call (`RestGitHub.closeIssue`) or modifying `Tasks.apply` to prevent GitHub reconcile alarms from reopening tasks that carry a Switchboard-internal completion record.

#### Finding 5 (P2 — Should-Fix): Understated Denial-of-Service Risk via Unbudgeted Updates
* **Document & Section**: `SWITCHBOARD_CURRENT_STATE_AUDIT.md` (§14, lines 231-239) & `SWITCHBOARD_ENTERPRISE_GAP_ANALYSIS.md` (§2.7, lines 69-74).
* **Problem**: The audit highlights configured daily limits for Memory notes (300/day), Brief writes (200/day), and Artifact publishes (200/day), but fails to flag that `POST /api/updates` has **no rate limit or daily quota whatsoever**.
* **Evidence**: In [worker/src/channel.ts#L1148-L1181](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/channel.ts#L1148-L1181), `Channel.postUpdate` unconditionally appends an event to SQLite, broadcasts to all WebSockets, and invokes `Relay.consider(recorded)`. A misconfigured or adversarial agent can flood `/api/updates`, which:
  1. Spams paid HTTP requests to TypeSafe's Jev endpoint ([worker/src/relay/jev.ts#L74-L85](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/relay/jev.ts#L74-L85)).
  2. Quickly breaches `INDEX_BUILD_CEILING = 80_000` ([worker/src/channel.ts#L250](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/channel.ts#L250)), which permanently disables scoped history indexes and causes `/api/events` history queries to fail with HTTP 501 `indexMissing` ([worker/src/index.ts#L85-L89](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/index.ts#L85-L89)).
* **Exact Correction**: In the Enterprise Gap Analysis and Current-State Audit §14, identify the absence of rate limiting on `postUpdate` as an enterprise stability vulnerability, and recommend a per-agent and per-channel token bucket on `/api/updates`.

#### Finding 6 (P2 — Should-Fix): Unrestricted Cross-Agent Terminal and Transcript Data Exfiltration
* **Document & Section**: `SWITCHBOARD_ENTERPRISE_GAP_ANALYSIS.md` (§1 Vision Requirement 7, lines 21-22) & `SWITCHBOARD_CURRENT_STATE_AUDIT.md` (§10, lines 175-177).
* **Problem**: The audit characterizes cross-agent inspection as an intentional shared-visibility feature (ADR 0019/0024), but understates the severe data exfiltration vulnerability when integrating untrusted third-party or vendor agents into a Channel.
* **Evidence**: In [worker/src/index.ts#L305-L308](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/index.ts#L305-L308), the token owner check explicitly exempts:
  ```typescript
  agentRoute.kind !== "transcript" &&
  agentRoute.kind !== "summary" &&
  agentRoute.kind !== "terminal" &&
  ```
  Consequently, **any** admitted agent token (including an unprivileged vendor agent) can query `/api/agents/:id/transcript` or `/api/agents/:id/terminal` of any other agent on the Channel. This allows vendor agents to stream live PTY terminal screens and historical prompt transcripts of employee agents, exfiltrating shell outputs, credentials, and proprietary code displayed in the terminal.
* **Exact Correction**: Elevate this finding to a major security risk for enterprise multi-tenancy. Recommend that transcript and terminal access require matching `person` ownership or an explicit mutual trust policy.

#### Finding 7 (P2 — Should-Fix): Cross-Person Directive Privilege Escalation
* **Document & Section**: `SWITCHBOARD_CURRENT_STATE_AUDIT.md` (§6 & §10) & `notes/S4_ENTERPRISE.md` (line 89).
* **Problem**: The audit notes that an ordinary Agent cannot send Directives, but fails to emphasize the security implications of `Channel.sendDirective` allowing any Person to direct any Agent on the Channel.
* **Evidence**: In [worker/src/channel.ts#L993-L996](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/channel.ts#L993-L996):
  ```typescript
  sendDirective(caller: Caller, to: AgentId, text: string): DirectiveResult {
    if (caller.agent === undefined) {
      this.join(caller.person);
      return this.directives.send({ person: caller.person }, to, text);
    }
  ```
  If `caller.agent === undefined`, the caller is an authenticated Person session. The method performs **no check** that `to` belongs to `caller.person`. Under ADR 0005 and `AGENTS.md:23-24`, Directives carry instruction weight. If an external contractor or guest collaborator is granted write access to the GitHub repository, their Person session can dispatch authoritative Directives into employee-owned agents.
* **Exact Correction**: Document this authorization gap in `SWITCHBOARD_CURRENT_STATE_AUDIT.md` §10 and recommend restricting Person directives to owned agents unless delegated via role policy.

#### Finding 8 (P2 — Should-Fix): Unchecked Cross-Person Handoff Declarations
* **Document & Section**: `SWITCHBOARD_CURRENT_STATE_AUDIT.md` (§8, line 147) & `SWITCHBOARD_CAPABILITY_MATRIX.md` (Row 43).
* **Problem**: The audit asserts that handoff links retain predecessor claims, but overlooks that session registration allows an agent to claim continuation of *any* agent on the Channel without consent from the target agent's owner.
* **Evidence**: In [worker/src/channel.ts#L819-L826](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/channel.ts#L819-L826):
  ```typescript
  if (request.continues !== undefined) {
    if (request.continues === agentIdFor(person, request.cli, request.sessionId)) {
      return { ok: false, status: 409, reason: "A session cannot continue its own Agent." };
    }
    if (!this.agents.has(request.continues)) {
      return { ok: false, status: 404, reason: `No Agent ${request.continues} on this Channel to continue.` };
    }
  }
  ```
  Registration checks only that `continues` exists on the Channel. As verified in [worker/test/handoff.test.ts#L220-L226](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/test/handoff.test.ts#L220-L226), Person Bob can start an agent declaring that it continues Person Alice's agent, emitting an `agent.handoff` event that links Bob's agent into Alice's task context and successors list.
* **Exact Correction**: Note in §8 that `continues` linkage lacks cross-person authorization checks, allowing foreign sessions to attach themselves to another person's agent lineage.

#### Finding 9 (P2 — Should-Fix): Indefinite Agent Token Lifetime Lacks Expiration
* **Document & Section**: `SWITCHBOARD_CURRENT_STATE_AUDIT.md` (§1, lines 51-58) & `SWITCHBOARD_CAPABILITY_MATRIX.md` (Row 19).
* **Problem**: The audit notes that Agent tokens are revoked when an agent goes `Gone`, but omits that active Agent tokens have no expiration timestamp (`exp`).
* **Evidence**: In [worker/src/access.ts#L181-L188](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/access.ts#L181-L188), `issueAgentToken` stores only `hash`, `agent`, `person`, `issued_at`, and `librarian`. As long as the agent sends periodic heartbeats within `PRESENCE_GONE_AFTER_SECONDS` (600s), the token never expires. If an agent token is intercepted or leaked from `.switchboard/session/agent`, an attacker can sustain the token indefinitely by heartbeating.
* **Exact Correction**: Note in §1 that Agent tokens lack an absolute maximum lifetime or sliding session TTL, relying entirely on absence of heartbeats to trigger revocation.

#### Finding 10 (P3 — Nit): Subsystem 2 Header Status Rollup Inconsistency
* **Document & Section**: `SWITCHBOARD_CURRENT_STATE_AUDIT.md` (§2, lines 63 & 69).
* **Problem**: Section 2 header reports `Status: Implemented and verified`, while bullet 2 within the same section reports `Repo Channel partition key — Implemented but unverified` (`worker/src/index.ts:63-65 channelOf. Test evidence: none`).
* **Evidence**: [SWITCHBOARD_CURRENT_STATE_AUDIT.md#L63](file:///home/box/engineering-workspace/worktrees/_agy_inputs/S6/SWITCHBOARD_CURRENT_STATE_AUDIT.md#L63) vs. [SWITCHBOARD_CURRENT_STATE_AUDIT.md#L69](file:///home/box/engineering-workspace/worktrees/_agy_inputs/S6/SWITCHBOARD_CURRENT_STATE_AUDIT.md#L69).
* **Exact Correction**: Clarify the subsystem header to state `Status: Implemented and verified (core primitives verified; partition key isolation unverified)`.

#### Finding 11 (P3 — Nit): Minor Citation Line Number Offsets (WRONG-LINE)
* **Document & Section**: Various audit deliverables.
* **Problem**: Minor line number drift exists in several citations:
  1. `worker/src/channel.ts:1148-1210` cited for `postUpdate/writeNote` ([worker/src/channel.ts#L1148-L1215](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/channel.ts#L1148-L1215)): `writeNote` extends through line 1215.
  2. `worker/test/relay.test.ts:911-940` cited for addressed update delivery ([worker/test/relay.test.ts#L911-L943](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/test/relay.test.ts#L911-L943)): test assertion block ends at line 943.
  3. `worker/test/branches.test.ts:178-214` cited in S2 notes ([worker/test/branches.test.ts#L178-L215](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/test/branches.test.ts#L178-L215)): test block ends at line 215.
* **Exact Correction**: Adjust the line boundaries in the citation index.

---

### Citation Spot-Check Table (35 Load-Bearing Citations)

Each cited location was inspected directly in the clone at HEAD `fe392689db002edb058eca9b6047be577c5bb656`.

| # | Citation | Deliverable Location | Code File:Line Checked | Status | Details |
|---|---|---|---|---|---|
| 1 | `Claims.claim` | `CURRENT_STATE_AUDIT.md:79` | [worker/src/claims.ts#L112-L147](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/claims.ts#L112-L147) | **CONFIRMED** | Synchronous claim check, state write, and event append without an intervening await. |
| 2 | `Claims.holderFor` | `CURRENT_STATE_AUDIT.md:85` | [worker/src/claims.ts#L242-L259](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/claims.ts#L242-L259) | **CONFIRMED** | Checks `agent.person !== acting.person`, but omits `agent.presence !== "gone"` check. |
| 3 | `StaleClaims.presenceChanged` | `CURRENT_STATE_AUDIT.md:83` | [worker/src/stale-claims.ts#L73-L86](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/stale-claims.ts#L73-L86) | **CONFIRMED** | Marks claims stale when agent presence changes to `gone`. |
| 4 | `StaleClaims.takeover` | `CURRENT_STATE_AUDIT.md:77` | [worker/src/stale-claims.ts#L122-L157](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/stale-claims.ts#L122-L157) | **CONFIRMED** | Restricts takeover of stale claims to Person sessions; rejects agents with 403. |
| 5 | `Access.admit` | `CURRENT_STATE_AUDIT.md:53` | [worker/src/access.ts#L92-L114](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/access.ts#L92-L114) | **CONFIRMED** | Queries `agent_tokens` by hash, derives identity, and invokes `checkMember`. |
| 6 | `Access.checkMember` | `CURRENT_STATE_AUDIT.md:55` | [worker/src/access.ts#L117-L148](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/access.ts#L117-L148) | **CONFIRMED** | Caches GitHub permissions in SQLite; re-checks GitHub at most every 5 minutes. |
| 7 | `Access.revokeAgent` | `CURRENT_STATE_AUDIT.md:57` | [worker/src/access.ts#L192-L194](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/access.ts#L192-L194) | **CONFIRMED** | Deletes rows matching agent ID from `agent_tokens` table. |
| 8 | `AgentRoster.register` | `CURRENT_STATE_AUDIT.md:51` | [worker/src/agents.ts#L252-L261](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/agents.ts#L252-L261) | **CONFIRMED** | Generates Agent ID from Person, CLI, and session ID; rejects collisions with 409. |
| 9 | `AgentRoster.denyApproval` | `CURRENT_STATE_AUDIT.md:183` | [worker/src/agents.ts#L542-L575](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/agents.ts#L542-L575) | **CONFIRMED** | Verifies owning Person, prompt ID, and deniable state; delivers one-shot denial. |
| 10 | `channelOf` | `CURRENT_STATE_AUDIT.md:69` | [worker/src/index.ts#L63-L65](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/index.ts#L63-L65) | **CONFIRMED** | Binds repo string to Durable Object instance via `idFromName(repo)`. |
| 11 | `handleChannel` routes | `CURRENT_STATE_AUDIT.md:107` | [worker/src/index.ts#L283-L324](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/index.ts#L283-L324) | **CONFIRMED** | Restricts agents to GET for tasks, enforces self-identity, exempts transcript/terminal reads. |
| 12 | `mirroredFields` | `CURRENT_STATE_AUDIT.md:67` | [worker/src/tasks.ts#L95-L110](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/tasks.ts#L95-L110) | **CONFIRMED** | Extracts title, description, labels, blockers, subtasks, and parsed steps from GitHub issue. |
| 13 | `Tasks` table schema | `CURRENT_STATE_AUDIT.md:65` | [worker/src/tasks.ts#L131-L156](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/tasks.ts#L131-L156) | **CONFIRMED** | Declares `tasks` table with integer `number PRIMARY KEY` and JSON `data` column. |
| 14 | `Tasks.apply` sync rules | `CURRENT_STATE_AUDIT.md:65` | [worker/src/tasks.ts#L321-L361](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/tasks.ts#L321-L361) | **CONFIRMED** | Ignores unobserved closed issues; updates status; sets `closed ? "done" : ...`. |
| 15 | `Branches.finish` | `CURRENT_STATE_AUDIT.md:167` | [worker/src/branches.ts#L89-L153](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/branches.ts#L89-L153) | **CONFIRMED** | Opens PR via `createPullRequest`, sets status `review`, and appends `task.review`. |
| 16 | `Branches.finish` race | `CURRENT_STATE_AUDIT.md:161` | [worker/src/branches.ts#L126-L129](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/branches.ts#L126-L129) | **CONFIRMED** | Post-await check omits `sameHolder(now.claim.holder, holder)` and `now.branch === branch`. |
| 17 | `Relay.consider` Proxy guard | `CURRENT_STATE_AUDIT.md:129` | [worker/src/relay/relay.ts#L254-L264](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/relay/relay.ts#L254-L264) | **CONFIRMED** | Strips raw proxy events using `agentDeliverable` before scheduling Relay execution. |
| 18 | `Relay.takeDeliveries` | `CURRENT_STATE_AUDIT.md:129` | [worker/src/relay/relay.ts#L267-L277](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/relay/relay.ts#L267-L277) | **CONFIRMED** | Executes `DELETE FROM deliveries RETURNING *` before heartbeat response reaches client. |
| 19 | `Relay.relay` no-overlap | `CURRENT_STATE_AUDIT.md:131` | [worker/src/relay/relay.ts#L287-L305](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/relay/relay.ts#L287-L305) | **CONFIRMED** | Directly drops events with no file/symbol overlap and no explicit addressee. |
| 20 | `HttpJev.verdict` | `CURRENT_STATE_AUDIT.md:137` | [worker/src/relay/jev.ts#L66-L85](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/relay/jev.ts#L66-L85) | **CONFIRMED** | Issues external HTTP POST to TypeSafe Jev API using Worker bearer secret. |
| 21 | `handleMcp` read-only | `CURRENT_STATE_AUDIT.md:205` | [worker/src/mcp/server.ts#L94-L108](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/mcp/server.ts#L94-L108) | **CONFIRMED** | Passes strictly read-only interfaces (`ReadOnlyChannel`, `readOnlyGitHub`) to MCP tools. |
| 22 | `TOOLS` connector list | `CURRENT_STATE_AUDIT.md:203` | [worker/src/mcp/tools.ts#L117](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/mcp/tools.ts#L117) | **CONFIRMED** | Array contains exactly 4 tools: `[channelTool, githubTool, briefTool, costsTool]`. |
| 23 | `token` grant types | `CURRENT_STATE_AUDIT.md:209` | [worker/src/mcp/oauth.ts#L482-L517](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/mcp/oauth.ts#L482-L517) | **CONFIRMED** | Handles `authorization_code` and `refresh_token`; returns `unsupported_grant_type` otherwise. |
| 24 | `ChannelClient` primitives | `CURRENT_STATE_AUDIT.md:41` | [cli/src/channel-client.ts#L224-L259](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/cli/src/channel-client.ts#L224-L259) | **CONFIRMED** | Implements HTTP calls for `join`, `register`, `heartbeat`, and `end`. |
| 25 | `SwitchboardTools` stdio | `CURRENT_STATE_AUDIT.md:105` | [cli/src/mcp-server.ts#L494-L506](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/cli/src/mcp-server.ts#L494-L506) | **CONFIRMED** | Exposes local stdio MCP implementations of `listTasks` and `claimTask`. |
| 26 | `list_tasks` status enum | `CURRENT_STATE_AUDIT.md:109` | [cli/src/mcp-server.ts#L1030-L1035](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/cli/src/mcp-server.ts#L1030-L1035) | **CONFIRMED** | Zod input schema restricts status to `["open", "claimed", "done"]`, omitting `"review"`. |
| 27 | `checkFolderAndMode` | `CAPABILITY_MATRIX.md:54` | [cli/src/host/check.ts#L98-L117](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/cli/src/host/check.ts#L98-L117) | **WRONG-CLAIM** | Implementation confirmed, but deliverable claimed "Test evidence: none"; tested in `host-check.test.ts:48-81`. |
| 28 | `checkSpawn` Claude only | `CURRENT_STATE_AUDIT.md:91` | [cli/src/host/check.ts#L133-L143](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/cli/src/host/check.ts#L133-L143) | **CONFIRMED** | Line 140 explicitly checks `frame.cli !== "claude-code"` and refuses all other CLIs. |
| 29 | `claude.install` | `CAPABILITY_MATRIX.md:31` | [cli/src/clis/claude.ts#L65-L79](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/cli/src/clis/claude.ts#L65-L79) | **WRONG-CLAIM** | Implementation confirmed, but deliverable claimed "Test evidence: none"; tested in `session-settings.test.ts:126-154`. |
| 30 | `AttachGate.checkOne` | `CURRENT_STATE_AUDIT.md:175` | [cli/src/terminal/gate.ts#L72-L123](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/cli/src/terminal/gate.ts#L72-L123) | **CONFIRMED** | Enforces Ed25519 signature, monotonic sequence check, and allow-list match. |
| 31 | `channelCheckout` | `CURRENT_STATE_AUDIT.md:163` | [cli/src/task-worktree.ts#L134-L162](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/cli/src/task-worktree.ts#L134-L162) | **CONFIRMED** | Validates git dir location, rejects bare repositories, submodules, and mismatched URLs. |
| 32 | `openWorktree` | `CURRENT_STATE_AUDIT.md:161` | [cli/src/task-worktree.ts#L240-L272](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/cli/src/task-worktree.ts#L240-L272) | **CONFIRMED** | Discovers remote main, fetches origin, creates/tracks worktree, and pushes branch. |
| 33 | `postUpdate / writeNote` | `CURRENT_STATE_AUDIT.md:15` | [worker/src/channel.ts#L1148-L1215](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/channel.ts#L1148-L1215) | **WRONG-LINE** | `postUpdate` starts at 1148; `writeNote` extends through line 1215 (deliverable cited 1210). |
| 34 | Addressed update test | `CURRENT_STATE_AUDIT.md:121` | [worker/test/relay.test.ts#L911-L943](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/test/relay.test.ts#L911-L943) | **WRONG-LINE** | Test body spans lines 911-943 (deliverable cited lines 911-940). |
| 35 | Closing PR test | `CURRENT_STATE_AUDIT.md:167` | [worker/test/branches.test.ts#L178-L215](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/test/branches.test.ts#L178-L215) | **CONFIRMED** | Asserts fake PR body `Closes #<task>`, status `review`, and sequential retry idempotence. |

---

### Agreements (Major Findings Independently Confirmed)

1. **Decentralized Coordination Architecture (No Central LLM Orchestrator)**: The audit correctly concludes that Switchboard is not driven by an autonomous central LLM coordinator. Work discovery, selection, and claiming are executed by independent agents via standard HTTP/MCP APIs, while conflict resolution is handled deterministically by Durable Object SQLite locks ([worker/src/claims.ts#L112-L147](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/claims.ts#L112-L147)).
2. **Post-Await Race Condition in PR Finish**: The audit accurately spotted that [worker/src/branches.ts#L126-L129](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/branches.ts#L126-L129) fails to verify whether the task's holder or branch changed during the asynchronous GitHub API call to open the pull request, creating a potential release/reclaim race.
3. **Heartbeat Delivery Deletion Prior to Network Acknowledgment**: The audit correctly identified the reliability flaw in [worker/src/relay/relay.ts#L267-L272](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/relay/relay.ts#L267-L272): `takeDeliveries` deletes pending notifications from SQLite before returning them in the heartbeat HTTP response, making subsequent WebSocket delivery acknowledgments redundant and risking notification loss.
4. **Omission of Target Presence Check in Person-to-Agent Claims**: The audit correctly found that [worker/src/claims.ts#L250-L259](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/claims.ts#L250-L259) verifies that the target agent belongs to the calling Person, but fails to check whether the target agent is currently `Gone`, permitting work to be assigned to inactive sessions.
5. **Exact Baseline Results and Skip Identification**: The audit accurately reported 1,347 passing tests across 14 runner steps, 0 failures, and precisely 2 credential-gated skips ([worker/test/github-live.test.ts](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/test/github-live.test.ts) and [worker/test/jev-live.test.ts](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/test/jev-live.test.ts)).
6. **Strict Remote MCP Isolation**: The audit correctly verified that remote MCP tokens cannot access standard Channel API endpoints ([worker/test/ask-channel.test.ts#L644-L674](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/test/ask-channel.test.ts#L644-L674)) and that none of the 4 exposed connector tools can execute database writes ([worker/test/ask-channel.test.ts#L676-L725](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/test/ask-channel.test.ts#L676-L725)).
7. **Monotonic Sequence Cursor Semantics**: The audit correctly dispelled the assumption that `events.seq` represents a contiguous integer event count, proving from [worker/src/channel.ts#L2347-L2357](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/src/channel.ts#L2347-L2357) that sequence numbers are microsecond timestamps with discrete jumps.
8. **Text Sanitization Does Not Provide Semantic Injection Defense**: The audit correctly observed that while control characters and terminal escapes are removed ([worker/test/memory.test.ts#L162-L178](file:///home/box/engineering-workspace/worktrees/switchboard-bulletin/worker/test/memory.test.ts#L162-L178)), simulated directive text (e.g., `[Switchboard] Directive from ...`) remains intact in stored strings, leaving defense against prompt injection entirely dependent on LLM system prompt compliance.