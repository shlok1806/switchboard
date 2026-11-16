import type {
  AgentConstraints,
  AgentExecution,
  AgentGrant,
  AgentPrincipal,
  OrganizationMembership,
  PersonActor,
  PolicyResource,
  VerifiedExecution,
  WorkspaceMembership,
} from "../../shared/src/m1";
import {
  CONTRIBUTOR_ACTIONS,
  DELEGABLE_ACTIONS,
  effectiveActions,
  type IdentityAuthority,
  MANAGER_ACTIONS,
  VIEW_ACTIONS,
} from "./principals";

export const PRIVATE_ACTIONS = [
  "agent.private_transcript.read",
  "agent.private_screen.read",
  "agent.directive.send",
  "agent.handoff.cross_owner",
];
export const POLICY_ACTIONS = [
  "organization.manage",
  "organization.member.manage",
  "workspace.create",
  ...MANAGER_ACTIONS,
  ...PRIVATE_ACTIONS,
];
export interface OwnerConsent {
  ownerPersonId: string;
  personId: string;
  workspaceId: string;
  targetId: string;
  action: string;
  expiresAt: number;
}

export interface PolicyContext {
  /** Set only by the Organization internal integration adapter after binding validation. */
  integration?: import("./policy-permits").IntegrationActor;
  /** Fresh authoritative verification, never taken from a request body. */
  verifiedExecution?: VerifiedExecution;
  /** Fresh facts from the authority. Required for managed execution decisions. */
  executionAuthority?: {
    state: IdentityAuthority;
    principal: AgentPrincipal;
    grant: AgentGrant;
    execution: AgentExecution;
    organizationCeiling: string[];
    workspacePolicy: string[];
    constraints: AgentConstraints;
    credentialExpiresAt: number;
  };
  managedPolicy?: boolean;
  now?: number;
  /** Current owner-issued consent row, resolved by the authority; never supplied by a request body. */
  consent?: OwnerConsent;
  /** Existing Lead/Host/librarian/holder predicates may only narrow authority. */
  restrictionsSatisfied?: boolean;
  /** P2 authority opts in; P1 contexts retain their original closed action set. */
  identityPolicy?: boolean;
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
/** Human metadata/lifecycle decisions use authoritative current rows. */
export function decide(actor: unknown, action: string, resource: PolicyResource, context: PolicyContext) {
  const result = (decision: "allow" | "deny", reason: string) => ({
    decision,
    reason,
    policyRevision: context.policyRevision,
  });
  if (!POLICY_ACTIONS.includes(action)) return result("deny", "unknown_action");
  if (context.restrictionsSatisfied === false) return result("deny", "execution_restriction");
  if (!context.available) return result("deny", "authority_unavailable_or_actor_invalid");
  if (
    !resource ||
    typeof resource.id !== "string" ||
    Object.keys(resource).some(
      (key) => !["kind", "id", "organizationId", "channel", "targetId", "ownerPersonId", "operation"].includes(key),
    ) ||
    [resource.channel, resource.targetId, resource.ownerPersonId, resource.operation].some(
      (value) => value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 500),
    ) ||
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
  if (actor && typeof actor === "object" && "kind" in actor && actor.kind === "integration") {
    const scope = context.integration;
    const candidate = actor as import("./policy-permits").IntegrationActor;
    return scope &&
      context.workspaceActive &&
      resource.kind === "workspace" &&
      Object.keys(candidate).every((key) =>
        ["kind", "provider", "repository", "workspaceId", "generation"].includes(key),
      ) &&
      Number.isSafeInteger(candidate.generation) &&
      candidate.generation > 0 &&
      candidate.provider === "github" &&
      candidate.repository === scope.repository &&
      candidate.workspaceId === scope.workspaceId &&
      candidate.generation === scope.generation &&
      resource.id === scope.workspaceId &&
      resource.channel === scope.repository &&
      action === "task.update" &&
      ["github.mirror", "github.code", "github.coordination"].includes(resource.operation ?? "") &&
      typeof resource.targetId === "string" &&
      resource.targetId.length > 0
      ? result("allow", "integration_mirror_only")
      : result("deny", "integration_scope_denied");
  }
  const verified = context.verifiedExecution;
  if (verified && actor && typeof actor === "object" && "kind" in actor && actor.kind === "execution") {
    const a = actor as VerifiedExecution;
    const facts = context.executionAuthority;
    const now = context.now ?? Date.now();
    const actions =
      facts &&
      Number.isFinite(now) &&
      Number.isFinite(facts.credentialExpiresAt) &&
      facts.credentialExpiresAt > now &&
      facts.state.organization.id === context.organizationId &&
      facts.state.organization.policyRevision === context.policyRevision &&
      facts.execution.id === verified.executionId &&
      facts.principal.id === verified.principalId &&
      facts.execution.workspaceId === verified.workspaceId
        ? effectiveActions(
            facts.state,
            facts.principal,
            facts.grant,
            facts.organizationCeiling,
            facts.workspacePolicy,
            now,
            facts.execution,
            facts.constraints,
          )
        : [];
    return a.executionId === verified.executionId &&
      a.principalId === verified.principalId &&
      a.workspaceId === verified.workspaceId &&
      resource.kind === "workspace" &&
      resource.id === verified.workspaceId &&
      context.workspaceActive &&
      DELEGABLE_ACTIONS.includes(action) &&
      verified.actions.includes(action) &&
      (!context.managedPolicy ||
        (workspaceParent(verified.executionId) === context.organizationId &&
          workspaceParent(verified.principalId) === context.organizationId &&
          actions.includes(action)))
      ? result("allow", "scoped_execution")
      : result("deny", "execution_scope_denied");
  }
  if (!validPerson(actor)) return result("deny", "authority_unavailable_or_actor_invalid");
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
    if (
      context.identityPolicy &&
      context.metadataOnly &&
      action === "agent.view" &&
      resource.ownerPersonId === actor.personId
    )
      return result("allow", "owned_principal_metadata");
    return admin &&
      (["organization.manage", "organization.member.manage", "workspace.create"].includes(action) ||
        (context.identityPolicy && ["agent.register", "agent.view"].includes(action)))
      ? result("allow", "organization_administrator")
      : result("deny", "action_denied");
  }
  if (!context.workspaceActive) return result("deny", "workspace_inactive");
  if (
    admin &&
    (["workspace.manage", "workspace.member.manage"].includes(action) ||
      (context.identityPolicy && ["agent.register", "agent.grant.manage", "agent.execution.revoke"].includes(action)) ||
      (action === "workspace.read" && context.metadataOnly))
  )
    return result("allow", "workspace_administration");
  const member = context.workspaceMembership;
  if (
    !member ||
    member.personId !== actor.personId ||
    member.workspaceId !== resource.id ||
    member.status !== "active" ||
    !["manager", "contributor", "viewer"].includes(member.role)
  )
    return result("deny", "workspace_membership_required");
  if (context.managedPolicy) {
    if (PRIVATE_ACTIONS.includes(action)) {
      if (member.role === "viewer" && ["agent.directive.send", "agent.handoff.cross_owner"].includes(action))
        return result("deny", "viewer_read_only");
      const owner = resource.ownerPersonId;
      const consent = context.consent;
      const authorized =
        owner &&
        resource.targetId &&
        (owner === actor.personId ||
          (consent?.ownerPersonId === owner &&
            consent.personId === actor.personId &&
            consent.workspaceId === resource.id &&
            consent.targetId === resource.targetId &&
            consent.action === action &&
            consent.expiresAt > (context.now ?? Date.now())));
      return authorized ? result("allow", "owner_or_consent") : result("deny", "owner_consent_required");
    }
    const actions =
      member.role === "manager"
        ? MANAGER_ACTIONS
        : member.role === "contributor"
          ? CONTRIBUTOR_ACTIONS
          : member.role === "viewer"
            ? VIEW_ACTIONS
            : [];
    return actions.includes(action) ? result("allow", "explicit_membership") : result("deny", "action_denied");
  }
  if (
    (action === "workspace.read" || (context.identityPolicy && action === "agent.view")) &&
    ["manager", "contributor", "viewer"].includes(member.role)
  )
    return result("allow", "explicit_membership");
  return member.role === "manager" &&
    (["workspace.manage", "workspace.member.manage"].includes(action) ||
      (context.identityPolicy &&
        ["agent.register", "agent.grant.manage", "agent.execution.start", "agent.execution.revoke"].includes(action)))
    ? result("allow", "workspace_manager")
    : result("deny", "action_denied");
}
