# One policy function guards managed Workspaces

Status: proposed, 2026-11-13, M1 Gate 0. Builds on ADR 0005, 0007, 0040 and 0041. Central policy is deterministic authorization, not a central LLM orchestrator.

## Context

[FACT-CODE] Current routes admit repo members before dispatch (`worker/src/index.ts:272-280`, handleChannel), exempt transcript/summary/screen reads from agent-self restriction (`:301-311`), and replay/snapshot broadly on connect (`worker/src/channel.ts:1867-1873`, fetch). MCP closures do not carry an actor (`worker/src/mcp/server.ts:94-108`, handleMcp). Person Directives lack the Lead subtree restriction (`worker/src/channel.ts:993-1007`, sendDirective). [DOC-ONLY] SPEC invariants 6–10 require the same boundary across direct APIs and alternate reads.

## Decision

[DECISION] Use one `decide(actor,action,resource,context)` function returning allow/deny, reason and policyRevision. Agents receive the intersection of org ceiling, Workspace policy, explicit grant and current sponsor delegable authority. Humans receive explicit resource-scoped role action sets. Administrative roles do not grant private transcript/screen consent, Person impersonation or cross-owner continuation.

[DECISION] Check immediately before every managed sensitive action and result release, including Channel RPCs, HTTP, MCP batch tools, snapshots/history/search, Host responses, Relay/Jev context, notification queues and terminal watchers. Shared projections exclude raw private context. Unknown routes/actions deny. Unlinked legacy Channels retain existing admission and visibility.

[DECISION] Organization authorizes short-lived, one-use exact-resource permits, maximum two seconds; Channel validates generation/deadline immediately at synchronous local commit. Revocation blocks new permits and completes after fences acknowledge or old permits expire. No distributed transaction is claimed. Administrative audit is atomic in Org; Channel outcome audit is atomic locally and exported by durable outbox. External side effects have correlated replay records rather than exactly-once claims.

[DECISION] Push revocation to Channels, invalidate recipient leases and close streams. Managed stream leases last at most five seconds; expired leases cannot send even if alarm/push is delayed. Recheck incoming actions, queued deliveries and private response release. Measured tests must cover lost push, hibernation, delayed replies and sponsor demotion before this becomes an operational claim.

## Consequences

[DECISION] More policy RPCs and fail-closed outages are accepted for a verifiable boundary. No positive HTTP authorization cache or legacy outage grace on managed paths. Permission grants do not constrain direct GitHub access or tools outside Switchboard. Independent Gate 0 review must resolve any trust-boundary contradiction before implementation.

## Alternatives considered

[DECISION] UI-only checks, prompt-based rules and route-entry checks alone leave bypasses. Long-lived cached permissions leave stale streams. Replacing Relay with authorization-driven orchestration confuses relevance with permission and violates scope. Instant cross-DO atomic revocation is an unsupported promise; explicit permits/fences define completion instead.
