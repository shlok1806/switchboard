# Agent principals are separate from executions

Status: accepted design, 2026-11-13, following Gate 0 confirmation (m1/reviews/G0_CONFIRM_1.md). P2/P3 implementation remains future work. Builds on ADR 0007 and the existing Agent/Host terminology; does not redefine an Agent ID.

## Context

[FACT-CODE] Legacy token rows bind hashes to AgentId/person with issuance time (`worker/src/access.ts:32-38`, ACCESS_SCHEMA); admission resolves those rows and checks membership (`:92-114`, admit). Registration uses existing session references (`worker/src/channel.ts:815-848`, registerAgent). [DOC-ONLY] SPEC invariants 4–6 require persistent sponsored identity and separately attributable executions.

## Decision

[DECISION] AgentPrincipal is stable within one Organization, sponsored explicitly by an authorized Person or Organization. Capabilities describe an agent and grant nothing. AgentExecution identifies one principal's run in one Workspace, associates existing session/AgentId/owner and has its own revocable credential generation. Two executions can share a principal without sharing tokens.

[DECISION] Extend registration and wrapper metadata, preserving session IDs, four CLI adapters, Host ownership, terminal signatures and Lead subtree restrictions. Human authorization links legacy sessions to a principal; legacy agent tokens cannot exchange themselves into Org grants. No perpetual authority arises from old registration.

[DECISION] Mint 256-bit random secrets; store SHA-256 digests without pepper and compare fixed-length digests using a timing-safe implementation. Bind credentials to execution/principal/workspace, enforce one-hour default and 24-hour absolute maximum capped by grant expiry. Rotate without overlap; expiry/revoke/sponsor demotion/principal disable deny server-side. Secrets are displayed once to the initiating CLI and excluded from Events, Dashboard DOM, logs and audit. Lost issuance responses require rotation, never plaintext replay. Person-bound CLI redemption expires after 60 seconds: authenticated expired code returns 410 CODE_EXPIRED, invalid 400 CODE_INVALID, used 409 CODE_USED; hashed tombstones retained 24 hours. Expiry starts a fresh bounded authenticated exchange (proposal §§5/12).

## Consequences

[DECISION] Attribution survives principal reuse and remains specific to each execution. Scoped credentials need explicit issuance/reconnection lifecycle; initial managed enrollment may require fresh login. Capability discovery is not permission. Sponsor authority is checked at grant creation and at every decision so demotion takes effect. Organization sponsorship uses an explicit revocable policy ceiling, not an impersonated Person.

## Alternatives considered

[DECISION] Reusing AgentId as persistent principal conflates parallel runs with identity. A shared principal token loses execution attribution and selective revocation. Upgrading legacy session tokens silently violates default deny. Vendor/model claims do not prove identity or authority. Arbitrary external-agent adapters remain out of M1.
