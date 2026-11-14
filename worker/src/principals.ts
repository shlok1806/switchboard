import type {
  AgentExecution,
  AgentGrant,
  AgentPrincipal,
  NativeOrganization,
  NativeWorkspace,
  OrganizationMembership,
  WorkspaceMembership,
} from "../../shared/src/m1";
import { validConstraints } from "./executions";

export const VIEW_ACTIONS = [
  "workspace.read",
  "agent.view",
  "task.read",
  "channel.update.read",
  "channel.history.read",
  "channel.subscribe",
];
export const CONTRIBUTOR_ACTIONS = [...VIEW_ACTIONS, "task.claim", "task.update", "channel.update.write"];
export const MANAGER_ACTIONS = [
  ...CONTRIBUTOR_ACTIONS,
  "workspace.manage",
  "workspace.member.manage",
  "agent.register",
  "agent.grant.manage",
  "agent.execution.start",
  "agent.execution.revoke",
];
/** Agents never receive lifecycle, administration or private-consent authority in P2. */
export const DELEGABLE_ACTIONS = CONTRIBUTOR_ACTIONS;
export interface IdentityAuthority {
  organization: NativeOrganization;
  members: Record<string, OrganizationMembership>;
  workspaces: Record<string, NativeWorkspace>;
  workspaceMembers: Record<string, Record<string, WorkspaceMembership>>;
}
export function humanActions(state: IdentityAuthority, personId: string, workspaceId: string): string[] {
  const organizationMember = state.members[personId];
  const workspace = state.workspaces[workspaceId];
  if (
    organizationMember?.status !== "active" ||
    organizationMember.personId !== personId ||
    workspace?.status !== "active" ||
    workspace.id !== workspaceId ||
    workspace.organizationId !== state.organization.id
  )
    return [];
  const member = state.workspaceMembers[workspaceId]?.[personId];
  if (member?.status !== "active" || member.personId !== personId || member.workspaceId !== workspaceId) return [];
  return member.role === "manager"
    ? MANAGER_ACTIONS
    : member.role === "contributor"
      ? CONTRIBUTOR_ACTIONS
      : member.role === "viewer"
        ? VIEW_ACTIONS
        : [];
}
export function administrator(state: IdentityAuthority, personId: string): boolean {
  const m = state.members[personId];
  return m?.status === "active" && (m.role === "owner" || m.role === "admin");
}
export function managesPrincipal(state: IdentityAuthority, personId: string, principal: AgentPrincipal): boolean {
  return (
    administrator(state, personId) ||
    (principal.sponsor.kind === "person" &&
      principal.sponsor.id === personId &&
      state.members[personId]?.status === "active")
  );
}
export function effectiveActions(
  state: IdentityAuthority,
  principal: AgentPrincipal,
  grant: AgentGrant,
  organizationCeiling: string[],
  workspacePolicy: string[],
  now: number,
  execution?: AgentExecution,
  constraints = {},
) {
  if (
    principal.organizationId !== state.organization.id ||
    principal.status !== "active" ||
    grant.principalId !== principal.id ||
    !Number.isFinite(now) ||
    !Number.isFinite(grant.expiresAt) ||
    grant.expiresAt <= now ||
    !validConstraints(grant.constraints) ||
    !validConstraints(constraints) ||
    state.workspaces[grant.workspaceId]?.status !== "active" ||
    state.workspaces[grant.workspaceId]?.organizationId !== state.organization.id
  )
    return [];
  if (
    execution &&
    (execution.status !== "active" ||
      execution.principalId !== principal.id ||
      execution.workspaceId !== grant.workspaceId ||
      humanActions(state, execution.ownerPersonId, grant.workspaceId).length === 0)
  )
    return [];
  const sponsor =
    principal.sponsor.kind === "organization"
      ? principal.sponsor.id === state.organization.id
        ? organizationCeiling
        : []
      : principal.sponsor.kind === "person"
        ? humanActions(state, principal.sponsor.id, grant.workspaceId)
        : [];
  const executionActions = (constraints as { actions?: string[] }).actions;
  return grant.actions.filter(
    (a) =>
      DELEGABLE_ACTIONS.includes(a) &&
      organizationCeiling.includes(a) &&
      workspacePolicy.includes(a) &&
      sponsor.includes(a) &&
      (!grant.constraints.actions || grant.constraints.actions.includes(a)) &&
      (!executionActions || executionActions.includes(a)),
  );
}
