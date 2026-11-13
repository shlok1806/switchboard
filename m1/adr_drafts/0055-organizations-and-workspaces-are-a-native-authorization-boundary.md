# Organizations and Workspaces are a native authorization boundary

Status: proposed, 2026-11-13, M1 Gate 0. Saved outside the repository for review. Builds on ADR 0007, 0008 and 0040; changes Membership authority only for voluntarily managed Channels.

## Context

[DOC-ONLY] SPEC invariants 1–3 require repo-free Workspaces without changing legacy Channels. [FACT-CODE] Channel objects are named by repo (`worker/src/index.ts:63-65`, channelOf), and Access checks collaborator write permission (`worker/src/access.ts:117-148`, checkMember). Current bindings have only Channel (`worker/wrangler.jsonc:20-23`). Putting all organizational state inside Channel would require a repository to exist first.

## Decision

[DECISION] Add one SQLite Organization Durable Object per org, owning Workspaces, explicit memberships, sponsorship/grants, executions and policy revisions. Add IdentityDirectory for verified numeric GitHub identities and derived Person→org listing. Append `v2-m1-authorization` with new SQLite classes Organization and IdentityDirectory; add ORGANIZATION and IDENTITY_DIRECTORY bindings. Existing Channel, binding and v1 migration remain.

[DECISION] Reuse GitHub sign-in for identity, with numeric account id mapped to immutable Person ID; preserve displayed login and historical Agent IDs. Native sign-in skips collaborator admission; login-only sessions require fresh verification before managed access. Explicit accepted invitations create membership; org membership alone gives no Workspace content access. Workspace content requires active org AND Workspace membership; offboarding renders orphan Workspace rows inert and invalidates dependent sponsorship/permits/leases. Demotion recomputes ceilings. Explicit org-admin metadata/administration remains separately authorized without content access.

[DECISION] A Channel optionally binds to one Workspace through fresh GitHub repo-admin proof AND workspace.manage. Pending binding is closed; activation fences old sockets. No automatic migration or collaborator enrollment. Managed persons/agent/presence projections omit historical nonmembers and un-enrolled executions without deleting legacy records (proposal §7). Two-phase binding/outbox recovery is idempotent and generation checked. Unbind requires both authorities and explicitly restores legacy access only after completion.

## Consequences

[DECISION] Policy/admin state and audit changes are atomic inside an Organization. Cross-object indexes are derived and never authorize. Channel mutation and org policy cannot be one transaction; short-lived permits, generation fencing and revocation completion semantics are specified in M1_ARCHITECTURE_PROPOSAL.md §§2/8/9. Native Workspaces without repos have no generic Task lifecycle. Legacy Channels keep their current semantics.

## Alternatives considered

[DECISION] D1 offers relational listings but adds a storage/migration model and still cannot atomically mutate a Channel. Extending Channel as authority cannot support repo-free state cleanly. Replicated memberships in every Channel complicate revocation. A new central LLM orchestrator is neither needed nor permitted.
