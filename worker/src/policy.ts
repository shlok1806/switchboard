import type { OrganizationMembership, PersonActor, PolicyResource, WorkspaceMembership } from "../../shared/src/m1";

export interface PolicyContext {
  organizationId: string;
  policyRevision: number;
  available: boolean;
  organizationMembership?: OrganizationMembership;
  workspaceMembership?: WorkspaceMembership;
  workspaceActive?: boolean;
  /** Metadata administration is never shared-content authority. */
  metadataOnly?: boolean;
}
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PERSON_ID = new RegExp(`^${UUID}$`);
const WORKSPACE_ID = new RegExp(`^(${UUID}):${UUID}$`);
export function validPerson(actor: unknown): actor is PersonActor {
  if (!actor || typeof actor !== "object") return false;
  const a = actor as Partial<PersonActor>;
  return (
    a.kind === "person" &&
    typeof a.personId === "string" &&
    PERSON_ID.test(a.personId) &&
    typeof a.githubId === "string" &&
    /^[1-9][0-9]{0,19}$/.test(a.githubId)
  );
}
export function workspaceParent(id: string): string | null {
  return WORKSPACE_ID.exec(id)?.[1] ?? null;
}
/** Only P1 human actions can be allowed. Callers supply authoritative current rows. */
export function decide(actor: unknown, action: string, resource: PolicyResource, context: PolicyContext) {
  const result = (decision: "allow" | "deny", reason: string) => ({
    decision,
    reason,
    policyRevision: context.policyRevision,
  });
  if (!context.available || !validPerson(actor)) return result("deny", "authority_unavailable_or_actor_invalid");
  if (
    !resource ||
    resource.organizationId !== context.organizationId ||
    !["organization", "workspace"].includes(resource.kind)
  )
    return result("deny", "resource_mismatch");
  if (
    resource.kind === "organization"
      ? resource.id !== context.organizationId
      : workspaceParent(resource.id) !== context.organizationId
  )
    return result("deny", "resource_mismatch");
  const org = context.organizationMembership;
  if (
    !org ||
    org.personId !== actor.personId ||
    org.status !== "active" ||
    !["owner", "admin", "member"].includes(org.role)
  )
    return result("deny", "membership_required");
  const admin = org.role === "owner" || org.role === "admin";
  if (resource.kind === "organization") {
    return admin && ["organization.manage", "organization.member.manage", "workspace.create"].includes(action)
      ? result("allow", "organization_administrator")
      : result("deny", "action_denied");
  }
  if (!context.workspaceActive) return result("deny", "workspace_inactive");
  if (
    admin &&
    (["workspace.manage", "workspace.member.manage"].includes(action) ||
      (action === "workspace.read" && context.metadataOnly))
  )
    return result("allow", "workspace_administration");
  const member = context.workspaceMembership;
  if (!member || member.personId !== actor.personId || member.workspaceId !== resource.id || member.status !== "active")
    return result("deny", "workspace_membership_required");
  if (action === "workspace.read" && ["manager", "contributor", "viewer"].includes(member.role))
    return result("allow", "explicit_membership");
  return member.role === "manager" && ["workspace.manage", "workspace.member.manage"].includes(action)
    ? result("allow", "workspace_manager")
    : result("deny", "action_denied");
}
