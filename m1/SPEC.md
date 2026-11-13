# Switchboard — Milestone 1 Implementation Contract

**Owner:** Antonio (GrokBot), coordinating Codex implementation and independent Antigravity review

**Stage:** Implementation authorized in isolated branches/worktrees. No production deployment, data migration in production, main-branch merge, or destructive operations without explicit human approval.

**Baseline:** `https://github.com/shlok1806/switchboard`, audited application SHA `fe392689db002edb058eca9b6047be577c5bb656` (audit dated 2026-11-12). Discover latest `main` before branching; reconcile changes since the audited SHA. Use audit files `EXECUTIVE_SUMMARY.md`, `SWITCHBOARD_CURRENT_STATE_AUDIT.md`, `SWITCHBOARD_CAPABILITY_MATRIX.md`, `SWITCHBOARD_ENTERPRISE_GAP_ANALYSIS.md`, `SWITCHBOARD_BASELINE_RESULTS.md`, and, if available, `REVIEW_RESOLUTION.md`. The audit's independent reviewer verdict remained `REQUEST_CHANGES` after the report revisions, with no re-review; do not claim a clean audit sign-off without obtaining one.

## Purpose and product boundary

Switchboard **already** coordinates independent Claude Code, Codex, Cursor and Gemini coding agents using GitHub-repository Channels, GitHub Issue Tasks, exclusive Claims, peer Updates, Memory, Relay, Directives, handoffs, and a human Dashboard. **Do not rebuild these features.**

The long-term product is a vendor-neutral, agent-native organizational work environment: central policy and decentralized initiative, where independently operating agents can discover, claim, propose, and review work across a company. **Milestone 1 only establishes the organizational workspace, identities, and authorization foundation.** It does not implement arbitrary external agent integration, generic noncoding work objects, advanced discovery, or independent generic reviews. Those come later.

**Native Workspaces: YES, now. Native generic Tasks: NOT in M1.**

An Organization owns Workspaces, memberships, permission policies and agent sponsorship. A Workspace is a native Switchboard authorization/collaboration boundary that exists without GitHub. The current `Channel` remains a repository-bound coding collaboration primitive and may optionally be linked to one Workspace, subject to authorization. Do not rename the existing `Channel` concept into `Workspace`; honor `CONTEXT.md` and ADR terminology. A Workspace without a repository has identity, membership and participant/permission state but no native noncoding task lifecycle in M1. Existing GitHub Tasks stay GitHub-backed.

## Nonnegotiable invariants

1. Existing four-CLI coding-agent workflows, repository Channels, GitHub Issue/PR behavior, exclusive claims, Relay, local Hosts, and Dashboard continue operating. Unlinked legacy Channels retain their existing access semantics in this milestone; do not silently change them. Explicitly document remaining legacy trust assumptions.
2. A newly created organization-managed Workspace is **default deny**. Being a GitHub repo collaborator or a member of an Organization does not itself grant access to a managed Workspace.
3. A Person may belong to multiple Organizations and Workspaces. Every human request is authenticated; every decision has a concrete actor and resource. Reuse existing GitHub login as the initial human authentication option, but do **not** make GitHub repository write permission a prerequisite for native Workspace membership.
4. A **stable agent principal** is distinct from a **transient agent execution/session**. Multiple executions of the same authorized agent preserve principal identity, but execution tokens remain attributable individually.
5. An agent is sponsored by an Organization or authorized Person. Sponsor/administrator authority must be explicit and revocable. Agent capabilities are descriptors, **not** a grant of authority.
6. Company policy is the ceiling. A user's delegation cannot exceed the permissions they can delegate, and an agent's effective authority cannot exceed its explicit grant **or** its sponsor's delegable authority. Authorization is decided server-side, not by prompts or self-declared model behavior.
7. Organization admins can administer and revoke Workspace/agent grants according to policy; they do **not** automatically get to read another Person's private raw agent transcripts/screens or send Directives as that Person. Such access requires a separate auditable grant (consider emergency access out of scope).
8. Default agent visibility: only explicitly authorized Workspace data; private transcripts/screens and sensitive context are owner-only unless specifically and narrowly granted. Shared task Updates/Events are visible only to eligible Workspace members. Read-only connectors, WebSockets, snapshots, event history, notification queues, and search must honor the same boundary; no alternate read path may bypass it.
9. An authenticated agent may not forge a Person identity or grant itself permission. No implicit cross-Organization access or ability to continue another Person's agent session without explicit grant.
10. Mutations are authorized at the server and include auditable actor/target/action/outcome. All scoped writes should be idempotent or have an explicit documented replay strategy; do not claim exactly-once agent reasoning or external side effects.
11. Permissions can only guarantee actions flowing through Switchboard or integrated enforcement points. They cannot restrict direct access to an underlying GitHub repository or unrelated external tools. State this product limitation explicitly.
12. No long-lived vendor trust or enterprise deployment claim until live-agent and security testing is complete.

## Proposed minimum concepts / domain contract

- **Organization**: durable ID, name, created_at, owner(s), policy version, status. Organization admin rights are role-based; no unilateral creation of hidden memberships.
- **OrganizationMembership**: Person identity, org role (`owner`, `admin`, `member`), status, audited grantor/time.
- **Workspace**: durable globally unique ID, Organization ID, name, description, visibility mode (default private), lifecycle state, optional linked GitHub Channel reference. Not derived from a repo name.
- **WorkspaceMembership**: Person, Workspace, role (`manager`, `contributor`, `viewer`), explicit grant/revocation, reason/audit event. Organization administrators can manage workspace membership but cannot bypass separate private-session consent.
- **AgentPrincipal**: stable ID, Organization ID, sponsor kind/id, display name, declared capabilities, active/revoked state. Cannot infer rights from declared capabilities.
- **AgentExecution**: distinct ID, principal ID, session/CLI reference when relevant, started_at, last_seen, ended_at, current status, credential binding. Legacy `AgentId` remains functional. Avoid requiring external agents/HTTP adapters now.
- **AgentGrant / Policy**: principal, Workspace, allowed actions and optional constraints, granted_by, expires_at, policy revision. Effective permission = org policy ceiling ∩ workspace policy ∩ agent grant ∩ sponsor's delegable authority (or an explicitly documented equivalent with tests). Use actions, not role names alone, for enforcement.
- **AuditRecord**: timestamp, actor, action, resource, decision/result, reason, policy revision. No plaintext credentials or unnecessary session contents.

The exact schema, role names and storage technology may change only after a documented design justification. The required semantics above must remain intact.

## Action permissions required for M1

Define explicit permission checks for these operations (using existing task/API names where possible):

- `organization.manage`, `organization.member.manage`
- `workspace.create`, `workspace.read`, `workspace.manage`, `workspace.member.manage`
- `agent.register`, `agent.view`, `agent.grant.manage`, `agent.execution.start`, `agent.execution.revoke`
- `task.read`, `task.claim`, `task.update` for **Workspace-bound existing GitHub Tasks** (do not add agent task creation in M1)
- `channel.update.read`, `channel.update.write`, `channel.history.read`, `channel.subscribe`
- `agent.private_transcript.read`, `agent.private_screen.read`, `agent.directive.send`, `agent.handoff.cross_owner`

The policy implementation may group operations if tests prove precise least-privilege outcomes. A role must not be treated as automatic permission to read private agent sessions.

## Permission examples (expected defaults)

| Actor | Default on a newly created private Workspace |
|---|---|
| Organization owner/admin | May manage organization/workspace memberships and policy; cannot read private session transcripts solely from admin role |
| Workspace manager | May manage workspace membership/grants within the allowed organizational ceiling; shared workspace data access only |
| Workspace contributor | May read shared workspace data and perform explicitly granted actions; no membership or policy administration |
| Workspace viewer | May read permitted shared data; no claims or mutations |
| Newly registered agent principal | **No Workspace access** until explicit sponsorship and scoped grant |
| Agent with `task.read,task.claim,channel.update.write` grant | May see and claim eligible tasks and post updates only in that Workspace; no privileged Directives, private transcripts, grants or policy changes |
| Nonmember / other Organization | No access to Workspace data, subscription streams, summaries, history, or other private resources |

An Owner/manager action should be explicitly authorized at every endpoint, not just hidden in the UI. Treat cross-Workspace agent discovery and resource catalogs as scoped.

## Engineering work packages and gates

### Gate 0 — Reconcile audited baseline and write design ADR(s)

**Antonio:** Confirm branch, exact current SHA, divergence from audited SHA, current tests and feature surface. Read `CONTEXT.md`, ADRs and audit reports; inspect `REVIEW_RESOLUTION.md` if present. Write a brief, source-linked architecture design covering org/workspace storage placement and consistency (Cloudflare Durable Object vs D1 or other existing store), authentication, identity separation, migration/compatibility, policy-evaluation boundary, WebSocket/history safety, and API contract. Identify high-risk routes. Independent Antigravity review before implementation. No implementation if there is an unresolved trust-boundary contradiction.

### Package 1 — Native Organization / Workspace foundation

Create durable native Organizations, Workspaces and explicit human membership. Support create/read/list/manage in Worker APIs and minimal Dashboard admin flows; do not require a GitHub repo to create a Workspace. Respect existing user authentication but replace repo-based membership as the source of Workspace authorization. Add a voluntary binding from an existing GitHub Channel to one Workspace, verified by both repo-admin authority and organization/workspace authority. Existing unlinked repo Channels retain prior behavior. Do not migrate or rename legacy Channels. Test org/workspace isolation and authorization on creation, listing, direct ID access, and membership changes.

### Package 2 — Stable agent principals and scoped execution identity

Persist stable AgentPrincipals and link existing coding-agent sessions/executions without changing their user-visible session IDs, Host behavior, or four CLI adapters. Support sponsor registration, revocation, principal disable, scoped execution credential issuance/rotation/expiry, and separation between principal identity and session identity. Restrict identity lifecycle to approved owners/admins. Do not turn legacy session tokens into perpetual Organization grants. Test same principal with two distinct executions, unauthorized sponsor impersonation, expiration, rotation, revocation, and backward compatibility.

### Package 3 — Central authorization and trust-boundary hardening

Create a central policy decision function and enforce it at **each managed Workspace API route**, event stream subscription, event history retrieval, read-only connector exposure, and mutating operation. Confirm policy checks occur immediately before sensitive actions; revalidate/terminate existing streams on membership or grant revocation within a documented and tested bound. Restrict cross-owner raw transcript/screen access, cross-owner Person Directives and cross-owner continuation for managed Workspaces absent explicit grant. Avoid raw sessions and sensitive data in shared Event broadcasts. Ensure default deny and nonmember denial for lookup/search endpoints, not just task list APIs. Preserve existing Channel behavior for unlinked legacy channels and explicitly test that no new managed authorization route can bypass the policy engine. Add per-agent/channel update budgets and bounded error behavior if required to prevent untrusted event amplification; document deferral if not part of current write surface.

### Package 4 — Minimal management UI and auditability

Add a small, usable Organization/Workspace selector, workspace membership management, agent sponsorship/grant editor, revocation controls and permissions-visible agent roster to the existing Dashboard. Avoid redesigning Tasks, Activity, or the visual system. Show a human-readable denial and the effective scope on selected Agent pages. Log policy/admin changes and denied protected actions with actor, resource, policy revision and outcome. Do not expose secret tokens in event history or UI.

### Package 5 — Compatibility, security, and acceptance testing

Run the existing baseline from clean install and compare against recorded audit: 1,347 passed, 0 failed, two live-service tests skipped, 203 screenshots (as of audited SHA). The number may change with additions, but previously passing scenarios must remain passing. Add dedicated tests for the access matrix, direct HTTP attempts, WebSocket event leaks, subscription after revocation, read-only MCP scope, API token use from foreign org, impersonation, grant escalation, cross-owner Directives/screens/handoffs, same-principal multi-session identity, concurrent claim semantics, and stale claims. Validate migrations on an isolated copy of realistic pre-M1 records, not production. Run build, typecheck, lint, tests and UI visual checks. Record evidence and limitations, including live-service gaps. Independent Antigravity review with a clean final verdict (or clearly reported outstanding blockers).

## Suggested PR / coordination order

Antonio may change physical PR grouping after design review, but preserve dependencies and clear file ownership:

1. **PR 1 — Organization/Workspace domain, storage, membership, migration/compatibility tests.**
2. **PR 2 — AgentPrincipal, AgentExecution, sponsor/scoped credential lifecycle.**
3. **PR 3 — Central policy decision boundary, secured APIs/streams, cross-owner controls and adversarial tests.**
4. **PR 4 — Minimal Dashboard admin flows, audit trail, full regression evidence and acceptance demo.**

Do not run competing coding agents against the same files simultaneously. Antonio owns the implementation plan, ensures explicit issue/task ownership, runs quality gates, and coordinates review. Codex implements only assigned slices. Antigravity reviews code and tests independently; a reviewer-requested change is addressed with a new tested revision and re-reviewed, rather than waived without explanation. Use short bounded loops: plan → implement → tests → inspect failures → critique → fix → rerun → review. Pause and escalate architectural/security ambiguities, not minor coding details.

## Required acceptance scenario

1. Create **Org A** and **Org B**, both with native Workspaces; Org A creates `Operations` and `Finance` Workspaces without needing a GitHub repository.
2. Add Alice as Org A admin and Bob as a contributor of `Operations` only. Carol has access to `Finance`. Org B's Dave is unrelated.
3. Alice sponsors a persistent agent principal `ops-helper`, granting `task.read`, `task.claim`, `channel.update.write` only for Operations. Show two executions of that principal with distinct tokens and correct attribution.
4. Bind one existing GitHub Channel to Operations under explicit verified administrative authority. Bob and `ops-helper` can read permitted shared tasks, claim eligible GitHub issues, and post Updates through existing Switchboard features. Claims remain atomic.
5. `ops-helper` cannot read Finance, Org B, Carol's private session screen/transcript, manage members/grants, or issue an unauthorized Directive. Bob cannot grant the agent privileges Bob lacks.
6. Revoke the agent's Workspace grant while a connection is open. Subsequent requests are denied; event delivery stops within a measured and documented bound. Expired/revoked execution credentials fail.
7. Legacy unbound GitHub coding Channels continue to work with the original four adapters. No new GitHub Issue or generic task provider is required for Org/Workspace creation.
8. Confirm APIs, subscriptions, and Dashboard display identical access boundaries. Log material administrative and authorization decisions.

## Explicitly OUT of M1

- General noncoding native Work Objects/Tasks, acceptance revisions, and non-PR completion.
- Arbitrary external company-agent adapters, vendor A2A protocol, remote write MCP, arbitrary SDK publishing (Milestone 2).
- Agent-originated task proposals, learned work ranking, generalized review (later milestones).
- Full enterprise SSO/SAML, SCIM, billing, SOC 2, enterprise multi-region SLAs, and production deployment.
- A master LLM agent or replacement of existing Relay, GitHub synchronization, worktree/PR flows.
- Broad policy enforcement of external API actions that bypass Switchboard.

## Deliverables Antonio must return

- Short design ADRs and final domain/API contract.
- Source-linked change log per PR/commit, migration notes, backward compatibility proof.
- New security and policy tests with run commands and actual pass/fail outcomes.
- Live demo evidence or scripted local integration demonstrating the scenario above, including negative/denied paths.
- Review report from Antigravity with final verdict after fixes (or explicit remaining issues).
- `M1_IMPLEMENTATION_REPORT.md` summarizing done/partial/deferred, audit/security findings, risks and exact repo SHA.
- Proposed and **not yet implemented** Milestone 2 scope based on final M1 interfaces.

## Final stop condition

**M1 DONE only when** native Org/Workspace auth exists without GitHub, stable sponsored principals and executions are represented, centrally enforced managed-Workspace policies withstand negative API/stream tests, legacy coding-agent coordination is unchanged, the acceptance demo passes, and Codex/Antigravity verification results are provided. No deploy/merge to production without the founders' explicit approval.
