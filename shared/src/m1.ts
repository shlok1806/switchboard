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
}
export interface AdminAuditRecord {
  id: string;
  timestamp: number;
  requestId: string;
  actor: { kind: "person"; personId: string } | { kind: "unknown" };
  action: string;
  resource: PolicyResource;
  decision: "allow" | "deny";
  outcome: "committed" | "denied";
  reason: string;
  policyRevision: number;
  target?: { kind: "person" | "invitation"; id: string };
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
  | { ok: false; status: 400 | 403 | 404 | 409 | 503; reason: string; policyRevision: number };
