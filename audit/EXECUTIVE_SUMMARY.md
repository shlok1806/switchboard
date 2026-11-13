# Switchboard executive summary

Repository: https://github.com/shlok1806/switchboard; branch `bulletin`; audited application HEAD `fe392689db002edb058eca9b6047be577c5bb656`; 2026-11-12. Method: Codex investigation.

**Review status: agy review is pending.**

Legend: [FACT-CODE] inspected implementation; [FACT-TEST] inspected test assertions; [DOC-ONLY] documentation only; [INFERENCE] conclusion; [RECOMMENDATION] proposed work. Repo references are relative to repo root; logs/reports are relative to this directory. “Implemented and verified” requires code, proving assertions and baseline pass evidence for the stated behavior; named-case mapping from aggregate logs is [INFERENCE].

[FACT-CODE] Checkout HEAD now reports `de0b25ff15178330df09bd67ca170deb66360928`; read-only diff against the audited SHA adds four audit reports only. Application source/tests and line numbers are unchanged. Baseline identity is the audited SHA (`baseline_logs/env.txt:3-4`). No tests, builds, installs, network access, clone changes or deployments occurred in this investigation.

## Implemented and working within the recorded baseline

[INFERENCE] Existing baseline: **14/14 successful steps; 1,347 tests passed, zero failed, two skipped; 95 test files passed, two skipped; 203 screenshots generated**. Worker passed 404 tests, CLI 700, Dashboard 243. Typechecks/lints, CLI test build and Dashboard build completed successfully (`SWITCHBOARD_BASELINE_RESULTS.md`, Recorded results; `baseline_logs/summary.tsv:2-16`; `baseline_logs/06_worker_test.log:44-45`; `baseline_logs/09_cli_test.log:21-22`; `baseline_logs/13_dashboard_test.log:9-10`; `baseline_logs/14_dashboard_shots.log:5`). Real GitHub/Jev tests were skipped; fake-backed passes do not verify production services. Logs also retain dependency vulnerability findings and a workerd exception despite passing totals (`SWITCHBOARD_BASELINE_RESULTS.md`, Warnings and anomalous output).

[FACT-CODE] Switchboard already coordinates independent sessions through a repo-named Channel, GitHub Issue Tasks, exclusive claims, shared Updates/Memory and PR review (`channelOf`, `worker/src/index.ts:63-65`; `mirroredFields`, `worker/src/tasks.ts:95-110`; `Claims.claim`, `worker/src/claims.ts:112-147`; `Channel.postUpdate/writeNote`, `worker/src/channel.ts:1148-1210`; `Branches.finish`, `worker/src/branches.ts:89-153`).

[FACT-TEST] **Implemented and verified** for narrow core behaviors: concurrent claim winner/loser/one Event (`worker/test/claims.test.ts:84-103`, it("lets exactly one of two concurrent Claims win, and the other names the holder")); addressed routing (`worker/test/relay.test.ts:911-940`, it("queues an Update for its one addressee even when Jev would drop it, and relays it to no one else")); fake PR creation/review/retry reuse (`worker/test/branches.test.ts:178-215`, it("opens a pull request that closes the Issue and names the Agent, and puts the Task in review")).

## Partial capabilities and architectural constraints

[FACT-CODE] **Partially implemented:** vendor coverage has four adapters with unequal capabilities. Claude/Codex enable Interrupt/Wake; Cursor/Gemini disable them; Host spawning accepts Claude only (`claude/codex/cursor/gemini` adapters, `cli/src/clis/claude.ts:21-33`, `cli/src/clis/codex.ts:320-338`, `cli/src/clis/cursor.ts:205-218`, `cli/src/clis/gemini.ts:110-125`; `checkSpawn`, `cli/src/host/check.ts:140`). Baseline fixtures do not prove real vendor-session interoperability (`cli/test/e2e.test.ts:364-383`).

[INFERENCE] Organizational identity/policy is **Partially implemented** overall: existing Person/session identities, membership, holder and subtree rules are useful, but independent company/vendor principals and business-mandate policy were not found (searches N2/N4 in `SWITCHBOARD_ENTERPRISE_GAP_ANALYSIS.md`; `AgentRoster.register`, `worker/src/agents.ts:252-261`; `Access.admit/checkMember`, `worker/src/access.ts:92-148`; `handleChannel`, `worker/src/index.ts:283-324`).

[FACT-CODE] Generic non-PR completion is **Blocked by a current architectural constraint**: Task keys are integer Issue numbers, Channels are repo-bound, and finish requires a branch/PR (`Tasks`, `worker/src/tasks.ts:131-135`; `channelOf`, `worker/src/index.ts:63-65`; `Branches.finish`, `worker/src/branches.ts:89-129`). Remote MCP is read-only (`handleMcp`, `worker/src/mcp/server.ts:94-108`).

[INFERENCE] Reliability/retention remain **Partially implemented**: heartbeat delivery deletes before receipt; post-PR-await checks omit original holder/branch comparison; rich history depends on machines (`Relay.takeDeliveries`, `worker/src/relay/relay.ts:267-272`; `Branches.finish`, `worker/src/branches.ts:112-129`; `Channel.withLocalEvents/insert`, `worker/src/channel.ts:1670-1690`, `:2290-2336`). These are inspected risks, not reproduced incidents. PR review state is not independent work acceptance; no generic acceptance operation was found (search N5 in gap analysis).

## Five smallest unlocking changes

All are [RECOMMENDATION], ordered around existing seams:

1. Add explicit agent kinds/capabilities and extract a small HTTP/WS SDK (`parseRegister`, `worker/src/agents-api.ts:142-175`; `ChannelClient`, `cli/src/channel-client.ts:224-259`).
2. Add stable sponsored principals, scoped executions and shared policy checks while retaining Person/session compatibility (`Access`, `worker/src/access.ts:92-148`, `:178-194`; `handleChannel`, `worker/src/index.ts:272-324`).
3. Harden delivery ACKs, scoped request replay and holder consistency before expanding external writes (`Relay.takeDeliveries/acknowledge`, `worker/src/relay/relay.ts:267-277`; `Branches.finish`, `worker/src/branches.ts:112-129`).
4. Add policy-governed follow-on proposals and revision-bound acceptance on existing Issue Tasks; add non-PR completion before broad provider migration (`Tasks.create`, `worker/src/tasks.ts:181-189`; `Branches.finish`, `worker/src/branches.ts:89-153`).
5. Add explicit external-model/data-retention policy and optional audit export (`HttpJev.verdict`, `worker/src/relay/jev.ts:66-85`; `Channel.insert`, `worker/src/channel.ts:2290-2336`).

## Preserve and reuse

[RECOMMENDATION] Preserve synchronous exclusive claims, explicit Person-controlled stale takeover, peer information exchange, local Host checks, GitHub field ownership, four adapters and read-only connector grants. Extend these mechanisms; no central LLM orchestrator or wholesale rewrite is necessary on inspected evidence (`Claims.claim`, `worker/src/claims.ts:112-147`; `StaleClaims.takeover`, `worker/src/stale-claims.ts:122-157`; `Channel.postUpdate`, `worker/src/channel.ts:1148-1181`; `checkFolderAndMode`, `cli/src/host/check.ts:98-117`; `mirroredFields`, `worker/src/tasks.ts:95-110`; `handleMcp`, `worker/src/mcp/server.ts:94-108`).

[INFERENCE] Reusable research foundations include fake-backed process/HTTP/WS tests, local dataset collection and outcome linkage (`cli/test/e2e.test.ts:1-4`; `syncDataset`, `cli/src/dataset/sync.ts:193-232`; `channelOutcome/linkOutcome`, `cli/src/dataset/outcomes.ts:181-199`, `:227-245`). [FACT-TEST] Dataset tests prove sampled redaction/thread extraction (`cli/test/dataset.test.ts:233-271`, it("copies the owner's session with its subagents and workflow run, every secret redacted")); “every” covers fixture secrets. No coordination-quality evaluator was found (search N7 in gap analysis); collection and screenshots are not quality scores.

## Founder questions

[RECOMMENDATION] Decide who sponsors/revokes vendor authority, whether work must belong to GitHub, who independently accepts revisions, which session details vendors may read, what may reach Jev, and what evidence must survive machine loss. These decisions govern current membership, shared-read, PR and history boundaries (`Access.checkMember`, `worker/src/access.ts:117-148`; `handleChannel`, `worker/src/index.ts:305-308`; `Branches.finish`, `worker/src/branches.ts:89-129`; `Channel.withLocalEvents`, `worker/src/channel.ts:1670-1690`).
