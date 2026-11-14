import type { Agent } from "./domain";

/** Native foundation; unrelated legacy Channel identities are deliberately unchanged. */
export interface PersonActor {
  kind: "person";
  personId: string;
  githubId: string;
}
export type OrganizationRole = "owner" | "admin" | "member";
export type WorkspaceRole = "manager" | "contributor" | "viewer";
export interface OrganizationMembership {
  personId: string;
  role: OrganizationRole;
  status: "active" | "revoked";
  grantedBy: string;
  grantedAt: number;
}
export interface WorkspaceMembership {
  personId: string;
  workspaceId: string;
  role: WorkspaceRole;
  status: "active" | "revoked";
  grantedBy: string;
  grantedAt: number;
  reason: string;
}
export interface NativeWorkspace {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  visibility: "private";
  status: "active" | "archived";
  createdAt: number;
  channel?: string;
}
export interface NativeOrganization {
  id: string;
  name: string;
  status: "active";
  createdAt: number;
  policyRevision: number;
}
export interface MembershipInvitation {
  id: string;
  organizationId: string;
  githubId: string;
  organizationRole: OrganizationRole;
  workspaceId?: string;
  workspaceRole?: WorkspaceRole;
  createdBy: string;
  expiresAt: number;
  acceptedAt?: number;
}
export type P1Action =
  | "organization.manage"
  | "organization.member.manage"
  | "workspace.create"
  | "workspace.read"
  | "workspace.manage"
  | "workspace.member.manage";
export interface PolicyResource {
  kind: "organization" | "workspace";
  organizationId: string;
  id: string;
  /** Exact managed subresource; all fields participate in permit binding. */
  channel?: string;
  targetId?: string;
  ownerPersonId?: string;
  operation?: string;
}
export interface SafeAgent {
  id: Agent["id"];
  principalId: string;
  executionId: string;
  ownerPersonId: string;
  cli: Agent["cli"];
  presence: Agent["presence"];
  startedAt: Agent["startedAt"];
  lastSeenAt: Agent["lastSeenAt"];
}
export interface AdminAuditRecord {
  id: string;
  timestamp: number;
  requestId: string;
  actor: { kind: "person"; personId: string } | ExecutionActor | { kind: "unknown" };
  action: string;
  resource: PolicyResource;
  decision: "allow" | "deny";
  outcome: "committed" | "denied";
  reason: string;
  policyRevision: number;
  target?: { kind: "person" | "invitation" | "principal" | "execution"; id: string };
  count?: number;
  lastTimestamp?: number;
}
export interface NativeMutation {
  actor: PersonActor;
  key: string;
  requestId: string;
  expectedRevision?: number;
  /** Trusted HTTP adapter hashes original fields before applying PATCH defaults. */
  requestFingerprint?: string;
  command: OrganizationCommand;
}
export type OrganizationCommand =
  | { kind: "organization.rename"; name: string }
  | { kind: "organization.member"; personId: string; role: OrganizationRole; status: "active" | "revoked" }
  | { kind: "workspace.create"; name: string; description: string; acceptManager: true }
  | { kind: "workspace.update"; workspaceId: string; name: string; description: string; status: "active" | "archived" }
  | {
      kind: "workspace.member";
      workspaceId: string;
      personId: string;
      role: WorkspaceRole;
      status: "active" | "revoked";
      reason: string;
    }
  | {
      kind: "invitation.create";
      githubId: string;
      organizationRole: OrganizationRole;
      workspaceId?: string;
      workspaceRole?: WorkspaceRole;
    }
  | { kind: "invitation.accept"; invitationId: string };
export type NativeResult<T> =
  | { ok: true; value: T; policyRevision: number }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 410 | 503;
      reason: string;
      policyRevision: number;
      operationId?: string;
    };

/** Durable cross-object binding journal; IDs route to their Organization. */
export interface BindingOperation {
  id: string;
  actor: PersonActor;
  workspaceId: string;
  repo: string;
  mode: "bind" | "unbind";
  phase: "reserved" | "prepared" | "committed" | "done" | "conflict";
  generation: number | null;
  key: string;
  warning?: string;
}

/** Capabilities describe an agent; only grants convey authority. */
export interface AgentPrincipal {
  id: string;
  organizationId: string;
  sponsor: { kind: "organization" | "person"; id: string };
  displayName: string;
  capabilities: string[];
  status: "active" | "disabled" | "revoked";
  createdBy: string;
  createdAt: number;
}
export interface AgentExecution {
  id: string;
  principalId: string;
  workspaceId: string;
  ownerPersonId: string;
  legacyAgentId?: string;
  legacyChannel?: string;
  sessionReference?: string;
  cli: string;
  startedAt: number;
  lastSeen: number;
  endedAt?: number;
  status: "active" | "revoked" | "ended";
  credentialGeneration: number;
}
export interface ExecutionActor {
  kind: "execution";
  principalId: string;
  executionId: string;
  workspaceId: string;
}
export interface VerifiedExecution extends ExecutionActor {
  actions: string[];
}
export interface AgentConstraints {
  /** Only action narrowing is supported in P2; unknown constraints deny. */
  actions?: string[];
}
export interface AgentGrant {
  principalId: string;
  workspaceId: string;
  actions: string[];
  constraints: AgentConstraints;
  grantedBy: string;
  expiresAt: number;
  policyRevision: number;
}
export interface ExecutionCredentialMetadata {
  id: string;
  executionId: string;
  principalId: string;
  workspaceId: string;
  generation: number;
  expiresAt: number;
}
export type IdentityCommand =
  | { kind: "principal.create"; sponsor: AgentPrincipal["sponsor"]; displayName: string; capabilities: string[] }
  | { kind: "principal.update"; principalId: string; displayName: string; status: AgentPrincipal["status"] }
  | {
      kind: "grant.put";
      principalId: string;
      workspaceId: string;
      actions: string[];
      constraints: AgentConstraints;
      expiresAt: number;
    }
  | { kind: "grant.revoke"; principalId: string; workspaceId: string }
  | { kind: "identity.policy"; workspaceId?: string; actions: string[] }
  | {
      kind: "execution.start";
      principalId: string;
      workspaceId: string;
      cli: string;
      mode?: "direct" | "redemption";
      /** Trusted registration adapter only; public lifecycle APIs do not accept this. */
      registration?: { agentId: string; sessionId: string; channel: string };
      lifetimeMs?: number;
      constraints?: AgentConstraints;
    }
  | { kind: "execution.rotate"; executionId: string; expectedGeneration: number; lifetimeMs?: number }
  | { kind: "execution.redeem"; executionId: string; code: string }
  | { kind: "execution.revoke"; executionId: string };
export interface IdentityMutation {
  requestFingerprint?: string;
  actor: PersonActor;
  key: string;
  requestId: string;
  expectedRevision?: number;
  command: IdentityCommand;
}
export interface IdentityValue {
  principal?: AgentPrincipal;
  grant?: AgentGrant;
  execution?: AgentExecution;
  credential?: ExecutionCredentialMetadata;
  /** Ephemeral only: never persisted in replay, audit or Channel storage. */
  secret?: string;
  code?: string;
}
