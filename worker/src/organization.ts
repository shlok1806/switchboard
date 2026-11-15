import { DurableObject } from "cloudflare:workers";
import type { PersonName } from "../../shared/src/index";
import type {
  AdminAuditRecord,
  AgentConstraints,
  AgentExecution,
  AgentGrant,
  AgentPrincipal,
  BindingOperation,
  IdentityCommand,
  IdentityMutation,
  IdentityValue,
  MembershipInvitation,
  NativeMutation,
  NativeOrganization,
  NativeResult,
  NativeWorkspace,
  OrganizationCommand,
  OrganizationMembership,
  PersonActor,
  PolicyResource,
  VerifiedExecution,
  WorkspaceMembership,
} from "../../shared/src/m1";
import { channelRepo } from "./auth";
import {
  credentialExpiry,
  equalDigest,
  parseCredential,
  prepareCredential,
  type StoredCredential,
  secretDigest,
  validConstraints,
} from "./executions";
import { managedOutcome, OUTCOME_BATCH_SIZE, outcomeAuditId } from "./managed-outcomes";
import {
  decide,
  type OwnerConsent,
  POLICY_ACTIONS,
  type PolicyContext,
  PRIVATE_ACTIONS,
  validPerson,
  workspaceParent,
} from "./policy";
import { type MutationPermit, resourceKey } from "./policy-permits";
import { administrator, DELEGABLE_ACTIONS, effectiveActions, humanActions, managesPrincipal } from "./principals";

const DAY = 86_400_000;
export interface ChannelAuthorization {
  actor: PersonActor | { token: string };
  action: string;
  resource: PolicyResource;
  generation: number;
  requestId: string;
  targetExecutionId?: string;
  credentialExpiresAt?: number;
}
interface State {
  organization: NativeOrganization;
  members: Record<string, OrganizationMembership>;
  workspaces: Record<string, NativeWorkspace>;
  workspaceMembers: Record<string, Record<string, WorkspaceMembership>>;
  invitations: Record<string, MembershipInvitation>;
}
type MutationValue =
  | NativeOrganization
  | NativeWorkspace
  | OrganizationMembership
  | WorkspaceMembership
  | MembershipInvitation;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function text(value: unknown, max = 200): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function orgRole(value: unknown) {
  return value === "owner" || value === "admin" || value === "member";
}
function workspaceRole(value: unknown) {
  return value === "manager" || value === "contributor" || value === "viewer";
}

/** Internal RPC aggregate. HTTP must resolve identity before invoking these methods. */
export class Organization extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS aggregate (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creation (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replay (scope TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, body TEXT NOT NULL, bucket TEXT UNIQUE, count INTEGER NOT NULL DEFAULT 1, last_timestamp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS binding_operations (id TEXT PRIMARY KEY, scope TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS binding_reservations (workspace TEXT PRIMARY KEY, repo TEXT UNIQUE NOT NULL, operation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS principals (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executions (id TEXT PRIMARY KEY, body TEXT NOT NULL, constraints_body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS identity_policy (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_credentials (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS redemption_codes (digest TEXT PRIMARY KEY, body TEXT NOT NULL, retain_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_consents (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mutation_permits (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, expires INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS directory_outbox (person TEXT PRIMARY KEY, generation TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_request_decision ON audit(json_extract(body, '$.requestId'), json_extract(body, '$.reason'), json_extract(body, '$.policyRevision'));`);
  }
  private load(): State | undefined {
    const row = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").toArray()[0];
    return row ? (JSON.parse(row.body) as State) : undefined;
  }
  private save(state: State) {
    // Any authority change cancels every outstanding authorization from older revisions.
    this.ctx.storage.sql.exec("DELETE FROM mutation_permits WHERE revision<>?", state.organization.policyRevision);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO aggregate VALUES(1, ?)", JSON.stringify(state));
  }
  /** Directory reserves a random org id before calling; repeat initialization never mutates it. */
  initialize(id: string, name: string, actor: PersonActor, requestId: string): NativeResult<NativeOrganization> {
    if (!validPerson(actor) || !text(name) || !this.env.ORGANIZATION.idFromName(id).equals(this.ctx.id))
      return { ok: false, status: 400, reason: "invalid_creation", policyRevision: 0 };
    return this.ctx.storage.transactionSync(() => {
      const old = this.load();
      if (old)
        return old.members[actor.personId]?.role === "owner" && old.members[actor.personId]?.status === "active"
          ? (JSON.parse(
              this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM creation WHERE id=1").one().body,
            ) as NativeResult<NativeOrganization>)
          : { ok: false, status: 403, reason: "creation_conflict", policyRevision: 0 };
      const now = Date.now();
      const organization: NativeOrganization = { id, name, status: "active", createdAt: now, policyRevision: 1 };
      this.save({
        organization,
        members: {
          [actor.personId]: {
            personId: actor.personId,
            role: "owner",
            status: "active",
            grantedBy: actor.personId,
            grantedAt: now,
          },
        },
        workspaces: {},
        workspaceMembers: {},
        invitations: {},
      });
      this.ctx.storage.sql.exec(
        "INSERT INTO creation VALUES(1,?)",
        JSON.stringify({ ok: true, value: organization, policyRevision: 1 }),
      );
      this.enqueue(actor.personId);
      this.audit(
        actor,
        "organization.create",
        { kind: "organization", organizationId: id, id },
        true,
        "created",
        1,
        requestId,
      );
      return { ok: true, value: organization, policyRevision: 1 };
    });
  }
  private identityRow<T>(table: string, id: string): T | undefined {
    const row = this.ctx.storage.sql.exec<{ body: string }>(`SELECT body FROM ${table} WHERE id=?`, id).toArray()[0];
    return row ? (JSON.parse(row.body) as T) : undefined;
  }
  private identityWrite(table: string, id: string, value: unknown) {
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO ${table} VALUES(?,?)`, id, JSON.stringify(value));
  }
  private identityCeiling(id: string): string[] {
    return this.identityRow<string[]>("identity_policy", id) ?? [];
  }
  private grantFor(principal: string, workspace: string) {
    return this.identityRow<AgentGrant>("grants", canonical([principal, workspace]));
  }
  async mutateIdentity(input: IdentityMutation): Promise<NativeResult<IdentityValue>> {
    const initial = this.load();
    if (!initial) return { ok: false, status: 404, reason: "not_found", policyRevision: 0 };
    const c = input.command;
    const prepared =
      c.kind === "execution.start" || c.kind === "execution.rotate" || c.kind === "execution.redeem"
        ? await prepareCredential(initial.organization.id)
        : undefined;
    const code =
      c.kind === "execution.start" && c.mode === "redemption" ? crypto.randomUUID() + crypto.randomUUID() : undefined;
    const codeDigest =
      code || c.kind === "execution.redeem"
        ? Array.from(await secretDigest(code ?? (c.kind === "execution.redeem" ? c.code : "")), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join("")
        : undefined;
    const fingerprint =
      input.requestFingerprint ??
      Array.from(await secretDigest(canonical([c, input.expectedRevision])), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    return this.ctx.storage.transactionSync(() => {
      this.cleanup();
      const state = this.load();
      if (!state) return { ok: false, status: 404, reason: "not_found", policyRevision: 0 };
      const now = Date.now(),
        revision = state.organization.policyRevision;
      const actor = input.actor;
      const execution = "executionId" in c ? this.identityRow<AgentExecution>("executions", c.executionId) : undefined;
      const principalId = "principalId" in c ? c.principalId : execution?.principalId;
      const principal = principalId ? this.identityRow<AgentPrincipal>("principals", principalId) : undefined;
      const workspaceId = "workspaceId" in c ? c.workspaceId : execution?.workspaceId;
      const resource: PolicyResource = {
        kind: workspaceId ? "workspace" : "organization",
        organizationId: state.organization.id,
        id: workspaceId ?? state.organization.id,
      };
      const refuse = (reason: string, status: 400 | 403 | 409 | 410 = 403): NativeResult<IdentityValue> => {
        this.audit(
          actor,
          c.kind,
          resource,
          false,
          reason,
          revision,
          text(input.requestId, 100) ? input.requestId : "invalid",
        );
        return { ok: false, status, reason, policyRevision: revision };
      };
      if (!validPerson(actor) || !text(input.key, 128) || !text(input.requestId, 100))
        return refuse("invalid_request", 400);
      let redemption:
        | {
            personId: string;
            executionId: string;
            expiresAt: number;
            used: boolean;
            generation: number;
            lifetimeMs?: number;
          }
        | undefined;
      if (c.kind === "execution.redeem") {
        const row = this.ctx.storage.sql
          .exec<{ body: string }>("SELECT body FROM redemption_codes WHERE digest=?", codeDigest ?? "")
          .toArray()[0];
        redemption = row ? JSON.parse(row.body) : undefined;
        if (!redemption || redemption.personId !== actor.personId || redemption.executionId !== c.executionId)
          return refuse("CODE_INVALID", 400);
        if (redemption.used) return refuse("CODE_USED", 409);
        if (redemption.expiresAt <= now) return refuse("CODE_EXPIRED", 410);
        if (execution?.credentialGeneration !== redemption.generation) return refuse("CODE_INVALID", 400);
      }
      if (state.members[actor.personId]?.status !== "active") return refuse("action_denied");
      if (
        workspaceId &&
        (workspaceParent(workspaceId) !== state.organization.id || state.workspaces[workspaceId]?.status !== "active")
      )
        return refuse("resource_denied");
      if (
        ("principalId" in c || "executionId" in c) &&
        (!principal || principal.organizationId !== state.organization.id)
      )
        return refuse("resource_denied");
      if ("executionId" in c && !execution) return refuse("resource_denied");
      const admin = administrator(state, actor.personId);
      const actions = workspaceId ? humanActions(state, actor.personId, workspaceId) : [];
      const permits = (action: string) =>
        decide(actor, action, resource, this.context(state, actor, workspaceId, false, true)).decision === "allow";
      if (principal && !managesPrincipal(state, actor.personId, principal)) return refuse("sponsor_authority_required");
      if (c.kind === "principal.create") {
        if (
          !text(c.displayName) ||
          !Array.isArray(c.capabilities) ||
          c.capabilities.length > 32 ||
          !c.capabilities.every((v) => text(v, 100))
        )
          return refuse("invalid_principal", 400);
        if (
          !c.sponsor ||
          (c.sponsor.kind === "organization"
            ? !admin || c.sponsor.id !== state.organization.id
            : c.sponsor.kind !== "person" || c.sponsor.id !== actor.personId)
        )
          return refuse("sponsor_denied");
        if (
          !admin &&
          !Object.keys(state.workspaces).some((w) => humanActions(state, actor.personId, w).includes("agent.register"))
        )
          return refuse("action_denied");
      } else if (c.kind === "identity.policy") {
        if (!admin || !Array.isArray(c.actions) || !c.actions.every((a) => DELEGABLE_ACTIONS.includes(a)))
          return refuse("policy_denied");
      } else if (c.kind === "grant.put" || c.kind === "grant.revoke") {
        if (!permits("agent.grant.manage")) return refuse("action_denied");
      } else if (c.kind === "execution.start" || c.kind === "execution.rotate" || c.kind === "execution.redeem") {
        if (!permits("agent.execution.start") || principal?.status !== "active") return refuse("start_denied");
      } else if (c.kind === "execution.revoke") {
        if (!permits("agent.execution.revoke")) return refuse("action_denied");
      } else if (c.kind !== "principal.update") return refuse("unknown_command", 400);
      const scope = canonical(["identity", actor.personId, input.key]);
      const replay = this.ctx.storage.sql
        .exec<{ fingerprint: string; result: string }>(
          "SELECT fingerprint,result FROM replay WHERE scope=? AND expires>?",
          scope,
          now,
        )
        .toArray()[0];
      if (replay)
        return replay.fingerprint === fingerprint
          ? (JSON.parse(replay.result) as NativeResult<IdentityValue>)
          : refuse("idempotency_conflict", 409);
      if (
        c.kind !== "principal.create" &&
        c.kind !== "execution.start" &&
        c.kind !== "execution.redeem" &&
        input.expectedRevision === undefined
      )
        return refuse("revision_required", 409);
      if (input.expectedRevision !== undefined && input.expectedRevision !== revision)
        return refuse("stale_revision", 409);
      const value: IdentityValue = {};
      if (c.kind === "principal.create") {
        const p: AgentPrincipal = {
          id: `${state.organization.id}:${crypto.randomUUID()}`,
          organizationId: state.organization.id,
          sponsor: c.sponsor,
          displayName: c.displayName,
          capabilities: c.capabilities,
          status: "active",
          createdBy: actor.personId,
          createdAt: now,
        };
        this.identityWrite("principals", p.id, p);
        value.principal = p;
      } else if (c.kind === "principal.update" && principal) {
        c.displayName ??= principal.displayName;
        c.status ??= principal.status;
        if (
          !text(c.displayName) ||
          !["active", "disabled", "revoked"].includes(c.status) ||
          principal.status === "revoked"
        )
          return refuse("invalid_principal", 400);
        principal.displayName = c.displayName;
        principal.status = c.status;
        this.identityWrite("principals", principal.id, principal);
        value.principal = principal;
      } else if (c.kind === "identity.policy") {
        this.identityWrite("identity_policy", workspaceId ?? state.organization.id, [...new Set(c.actions)]);
      } else if (c.kind === "grant.revoke" && principal && workspaceId) {
        this.ctx.storage.sql.exec("DELETE FROM grants WHERE id=?", canonical([principal.id, workspaceId]));
      } else if (c.kind === "grant.put" && principal && workspaceId) {
        if (
          !Array.isArray(c.actions) ||
          c.actions.length > 32 ||
          !validConstraints(c.constraints) ||
          !Number.isSafeInteger(c.expiresAt) ||
          c.expiresAt <= now
        )
          return refuse("invalid_grant", 400);
        const grant: AgentGrant = {
          principalId: principal.id,
          workspaceId,
          actions: [...new Set(c.actions)],
          constraints: c.constraints,
          grantedBy: actor.personId,
          expiresAt: c.expiresAt,
          policyRevision: revision + 1,
        };
        const allowed = effectiveActions(
          state,
          principal,
          { ...grant, constraints: {} },
          this.identityCeiling(state.organization.id),
          this.identityCeiling(workspaceId),
          now,
        );
        if (
          grant.actions.some((a) => !allowed.includes(a) || !actions.includes(a)) ||
          c.constraints.actions?.some((a) => !grant.actions.includes(a))
        )
          return refuse("delegation_denied");
        this.identityWrite("grants", canonical([principal.id, workspaceId]), grant);
        value.grant = grant;
      } else if (
        (c.kind === "execution.start" || c.kind === "execution.rotate" || c.kind === "execution.redeem") &&
        principal &&
        workspaceId &&
        prepared
      ) {
        const grant = this.grantFor(principal.id, workspaceId);
        const constraints =
          c.kind === "execution.start"
            ? (c.constraints ?? {})
            : (JSON.parse(
                this.ctx.storage.sql
                  .exec<{ constraints_body: string }>(
                    "SELECT constraints_body FROM executions WHERE id=?",
                    execution?.id ?? "",
                  )
                  .one().constraints_body,
              ) as AgentConstraints);
        const expiresAt = grant
          ? credentialExpiry(
              now,
              c.kind === "execution.redeem" ? redemption?.lifetimeMs : c.lifetimeMs,
              grant.expiresAt,
            )
          : null;
        if (
          !grant ||
          !expiresAt ||
          !validConstraints(constraints) ||
          !effectiveActions(
            state,
            principal,
            grant,
            this.identityCeiling(state.organization.id),
            this.identityCeiling(workspaceId),
            now,
            undefined,
            constraints,
          ).length
        )
          return refuse("grant_or_lifetime_denied", 400);
        if (c.kind === "execution.start" && !text(c.cli, 80)) return refuse("invalid_cli", 400);
        if (
          execution &&
          (execution.status !== "active" ||
            (c.kind !== "execution.rotate" && c.kind !== "execution.redeem") ||
            (c.kind === "execution.rotate" && c.expectedGeneration !== execution.credentialGeneration))
        )
          return refuse("stale_generation", 409);
        const e: AgentExecution = execution ?? {
          id: `${state.organization.id}:${crypto.randomUUID()}`,
          principalId: principal.id,
          workspaceId,
          ownerPersonId: actor.personId,
          cli: c.kind === "execution.start" ? c.cli : "",
          startedAt: now,
          lastSeen: now,
          status: "active",
          credentialGeneration: 0,
        };
        if (c.kind === "execution.start" && c.registration) {
          if (
            state.workspaces[workspaceId]?.channel !== c.registration.channel ||
            !c.registration.agentId ||
            !c.registration.sessionId
          )
            return refuse("registration_denied");
          e.legacyAgentId = c.registration.agentId;
          e.sessionReference = c.registration.sessionId;
          e.legacyChannel = c.registration.channel;
        }
        e.credentialGeneration++;
        const credential: StoredCredential = {
          id: prepared.id,
          executionId: e.id,
          principalId: principal.id,
          workspaceId,
          generation: e.credentialGeneration,
          expiresAt,
          digest: prepared.digest,
        };
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO executions VALUES(?,?,?)",
          e.id,
          JSON.stringify(e),
          JSON.stringify(constraints),
        );
        if (code && codeDigest) {
          this.ctx.storage.sql.exec(
            "INSERT INTO redemption_codes VALUES(?,?,?)",
            codeDigest,
            JSON.stringify({
              personId: actor.personId,
              executionId: e.id,
              expiresAt: now + 60_000,
              used: false,
              generation: e.credentialGeneration,
              lifetimeMs: c.kind === "execution.start" ? c.lifetimeMs : undefined,
            }),
            now + 60_000 + DAY,
          );
          value.code = code;
        } else {
          this.identityWrite("execution_credentials", credential.id, credential);
          if (redemption && codeDigest)
            this.ctx.storage.sql.exec(
              "UPDATE redemption_codes SET body=?,retain_until=? WHERE digest=?",
              JSON.stringify({ ...redemption, used: true }),
              now + DAY,
              codeDigest,
            );
        }
        const { digest: _digest, ...metadata } = credential;
        value.execution = e;
        if (!code) value.credential = metadata;
        if (!code) value.secret = prepared.token;
      } else if (c.kind === "execution.revoke" && execution) {
        execution.status = "revoked";
        execution.endedAt = now;
        this.ctx.storage.sql.exec("UPDATE executions SET body=? WHERE id=?", JSON.stringify(execution), execution.id);
        value.execution = execution;
      } else return refuse("invalid_command", 400);
      state.organization.policyRevision++;
      this.save(state);
      this.audit(
        actor,
        c.kind,
        resource,
        true,
        "identity_committed",
        state.organization.policyRevision,
        input.requestId,
        undefined,
        value.execution
          ? { kind: "execution", id: value.execution.id }
          : value.principal
            ? { kind: "principal", id: value.principal.id }
            : principal
              ? { kind: "principal", id: principal.id }
              : undefined,
      );
      const { secret: _secret, code: _code, ...metadata } = value;
      const result: NativeResult<IdentityValue> = {
        ok: true,
        value: metadata,
        policyRevision: state.organization.policyRevision,
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO replay VALUES(?,?,?,?)",
        scope,
        fingerprint,
        JSON.stringify(result),
        now + DAY,
      );
      return { ...result, value };
    });
  }
  identityCatalog(actor: PersonActor, after = "") {
    const state = this.load();
    if (!state || !validPerson(actor) || state.members[actor.personId]?.status !== "active") return null;
    const resource: PolicyResource = {
      kind: "organization",
      organizationId: state.organization.id,
      id: state.organization.id,
    };
    const context = this.context(state, actor, undefined, true, true);
    const admin = decide(actor, "agent.view", resource, context).decision === "allow";
    const own =
      decide(actor, "agent.view", { ...resource, ownerPersonId: actor.personId }, context).decision === "allow";
    const visibleWorkspaces = Object.keys(state.workspaces).filter(
      (workspaceId) =>
        decide(
          actor,
          "agent.view",
          { kind: "workspace", organizationId: state.organization.id, id: workspaceId },
          { ...this.context(state, actor, workspaceId, false, true), managedPolicy: true },
        ).decision === "allow",
    );
    // Filter and keyset LIMIT in SQL: never load the entire principal catalog before pagination.
    const items = this.ctx.storage.sql
      .exec<{ body: string }>(
        `SELECT body FROM principals WHERE id>? AND (
        ?=1 OR (?=1 AND json_extract(body, '$.sponsor.kind')='person' AND json_extract(body, '$.sponsor.id')=?) OR
        EXISTS(SELECT 1 FROM grants WHERE json_extract(grants.body, '$.principalId')=principals.id AND
          json_extract(grants.body, '$.workspaceId') IN (SELECT value FROM json_each(?)))
      ) ORDER BY id LIMIT 101`,
        after,
        admin ? 1 : 0,
        own ? 1 : 0,
        actor.personId,
        JSON.stringify(visibleWorkspaces),
      )
      .toArray()
      .map((row) => JSON.parse(row.body) as AgentPrincipal);
    return {
      items: items.slice(0, 100),
      next: items.length > 100 ? items[99]?.id : null,
      policyRevision: state.organization.policyRevision,
    };
  }
  identityGrant(actor: PersonActor, workspaceId: string, principalId: string) {
    const state = this.load();
    const p = this.identityRow<AgentPrincipal>("principals", principalId);
    if (
      !state ||
      !validPerson(actor) ||
      !p ||
      !managesPrincipal(state, actor.personId, p) ||
      !humanActions(state, actor.personId, workspaceId).includes("agent.grant.manage") ||
      decide(
        actor,
        "agent.grant.manage",
        { kind: "workspace", organizationId: state.organization.id, id: workspaceId },
        this.context(state, actor, workspaceId, false, true),
      ).decision !== "allow"
    )
      return null;
    return this.grantFor(principalId, workspaceId) ?? null;
  }
  async auditExecutionDenial(token: string, requestId: string, action: IdentityCommand["kind"]) {
    const actor = await this.verifyExecution(token);
    if (!actor || !text(requestId, 100)) return;
    this.ctx.storage.transactionSync(() => {
      const state = this.load();
      if (state)
        this.audit(
          actor,
          action,
          { kind: "workspace", organizationId: state.organization.id, id: actor.workspaceId },
          false,
          "human_required",
          state.organization.policyRevision,
          requestId,
        );
    });
  }
  async executionPrincipal(token: string) {
    const actor = await this.verifyExecution(token);
    if (!actor) return null;
    const state = this.load();
    const execution = this.identityRow<AgentExecution>("executions", actor.executionId);
    const principal = this.identityRow<AgentPrincipal>("principals", actor.principalId);
    const grant = this.grantFor(actor.principalId, actor.workspaceId);
    const parsed = parseCredential(token);
    const credential = parsed ? this.identityRow<StoredCredential>("execution_credentials", parsed.credentialId) : null;
    const row = this.ctx.storage.sql
      .exec<{ constraints_body: string }>("SELECT constraints_body FROM executions WHERE id=?", actor.executionId)
      .toArray()[0];
    if (!state || !execution || !principal || !grant || !credential || !row) return null;
    const context: PolicyContext = {
      available: true,
      organizationId: state.organization.id,
      policyRevision: state.organization.policyRevision,
      workspaceActive: state.workspaces[actor.workspaceId]?.status === "active",
      managedPolicy: true,
      verifiedExecution: actor,
      executionAuthority: {
        state,
        execution,
        principal,
        grant,
        credentialExpiresAt: credential.expiresAt,
        organizationCeiling: this.identityCeiling(state.organization.id),
        workspacePolicy: this.identityCeiling(actor.workspaceId),
        constraints: JSON.parse(row.constraints_body) as AgentConstraints,
      },
    };
    return decide(
      actor,
      "agent.view",
      { kind: "workspace", organizationId: state.organization.id, id: actor.workspaceId },
      context,
    ).decision === "allow"
      ? principal
      : null;
  }
  touchRegisteredExecution(executionId: string, agentId: string): void {
    this.ctx.storage.transactionSync(() => {
      const execution = this.identityRow<AgentExecution>("executions", executionId);
      if (!execution || execution.legacyAgentId !== agentId || execution.status !== "active") return;
      execution.lastSeen = Date.now();
      this.ctx.storage.sql.exec("UPDATE executions SET body=? WHERE id=?", JSON.stringify(execution), executionId);
    });
  }

  registeredExecutionOwnedBy(executionId: string, personId: string): boolean {
    return this.identityRow<AgentExecution>("executions", executionId)?.ownerPersonId === personId;
  }

  /** Internal Channel lifecycle notification, never exposed as a credential endpoint. */
  endRegisteredExecution(executionId: string, agentId: string): boolean {
    try {
      this.ctx.storage.transactionSync(() => {
        const state = this.load();
        const execution = this.identityRow<AgentExecution>("executions", executionId);
        if (
          !state ||
          !execution ||
          execution.legacyAgentId !== agentId ||
          !execution.legacyChannel ||
          execution.status !== "active"
        )
          return;
        execution.status = "ended";
        execution.endedAt = Date.now();
        execution.credentialGeneration++;
        this.ctx.storage.sql.exec("UPDATE executions SET body=? WHERE id=?", JSON.stringify(execution), executionId);
        state.organization.policyRevision++;
        this.save(state);
        this.audit(
          { kind: "execution", principalId: execution.principalId, executionId, workspaceId: execution.workspaceId },
          "execution.end",
          { kind: "workspace", organizationId: state.organization.id, id: execution.workspaceId },
          true,
          "session_gone",
          state.organization.policyRevision,
          crypto.randomUUID(),
          undefined,
          { kind: "execution", id: executionId },
        );
      });
      return true;
    } catch {
      return false;
    }
  }

  async verifyExecution(token: string): Promise<VerifiedExecution | null> {
    const parsed = parseCredential(token);
    if (!parsed) return null;
    const digest = await secretDigest(parsed.secret);
    // Linked legacy executions also require a live matching Channel association.
    // Perform that await before re-reading every mutable authorization row below.
    const hint = this.identityRow<StoredCredential>("execution_credentials", parsed.credentialId);
    if (!hint || !equalDigest(digest, new Uint8Array(hint.digest)) || hint.expiresAt <= Date.now()) return null;
    const linked = this.identityRow<AgentExecution>("executions", hint.executionId);
    if (linked?.legacyChannel && linked.legacyAgentId) {
      try {
        if (
          !(await this.env.CHANNEL.getByName(linked.legacyChannel).registeredExecutionActive(
            linked.legacyAgentId as import("../../shared/src/index").AgentId,
            linked.id,
          ))
        )
          return null;
      } catch {
        return null;
      }
    }
    const state = this.load();
    if (!state || state.organization.id !== parsed.organizationId) return null;
    const credential = this.identityRow<StoredCredential>("execution_credentials", parsed.credentialId);
    if (
      !credential ||
      credential.id !== parsed.credentialId ||
      !equalDigest(digest, new Uint8Array(credential.digest)) ||
      credential.expiresAt <= Date.now()
    )
      return null;
    const execution = this.identityRow<AgentExecution>("executions", credential.executionId);
    const principal = this.identityRow<AgentPrincipal>("principals", credential.principalId);
    const grant = this.grantFor(credential.principalId, credential.workspaceId);
    if (
      !execution ||
      !principal ||
      !grant ||
      execution.id !== credential.executionId ||
      workspaceParent(execution.id) !== state.organization.id ||
      workspaceParent(principal.id) !== state.organization.id ||
      execution.credentialGeneration !== credential.generation ||
      execution.workspaceId !== credential.workspaceId ||
      execution.principalId !== credential.principalId
    )
      return null;
    const constraints = JSON.parse(
      this.ctx.storage.sql
        .exec<{ constraints_body: string }>("SELECT constraints_body FROM executions WHERE id=?", execution.id)
        .one().constraints_body,
    ) as AgentConstraints;
    const actions = effectiveActions(
      state,
      principal,
      grant,
      this.identityCeiling(state.organization.id),
      this.identityCeiling(execution.workspaceId),
      Date.now(),
      execution,
      constraints,
    );
    if (!actions.length) return null;
    return {
      kind: "execution",
      actions,
      executionId: execution.id,
      principalId: principal.id,
      workspaceId: execution.workspaceId,
    };
  }
  /** Self-only permission explanation; no foreign grant or private-target metadata. */
  permissions(
    actor: PersonActor,
    workspaceId: string,
  ): NativeResult<Record<string, { decision: string; reason: string }>> {
    const state = this.load();
    const revision = state?.organization.policyRevision ?? 0;
    if (!state || !validPerson(actor))
      return { ok: false, status: 403, reason: "resource_denied", policyRevision: revision };
    const resource: PolicyResource = { kind: "workspace", organizationId: state.organization.id, id: workspaceId };
    const context = { ...this.context(state, actor, workspaceId), managedPolicy: true };
    if (decide(actor, "workspace.read", resource, context).decision !== "allow")
      return { ok: false, status: 403, reason: "resource_denied", policyRevision: revision };
    return {
      ok: true,
      value: Object.fromEntries(
        POLICY_ACTIONS.map((action) => {
          const { decision, reason } = decide(actor, action, resource, context);
          return [action, { decision, reason }];
        }),
      ),
      policyRevision: revision,
    };
  }

  /** Resolve target ownership from enrolled executions, never from resource/body owner claims. */
  private consentTarget(workspaceId: string, targetId: string, channel?: string): AgentExecution | undefined {
    const rows = this.ctx.storage.sql
      .exec<{ body: string }>(
        "SELECT body FROM executions WHERE json_extract(body, '$.workspaceId')=? AND json_extract(body, '$.legacyAgentId')=? AND json_extract(body, '$.status')='active' ORDER BY json_extract(body, '$.startedAt') DESC LIMIT 1",
        workspaceId,
        targetId,
      )
      .toArray();
    const execution = rows[0] ? (JSON.parse(rows[0].body) as AgentExecution) : undefined;
    return execution && (!channel || execution.legacyChannel === channel) ? execution : undefined;
  }

  /** Owner-only, action/recipient/target-bound consent; replay cannot renew expired consent. */
  async mutateConsent(input: {
    actor: PersonActor;
    workspaceId: string;
    id?: string;
    body: Record<string, unknown>;
    key: string;
    requestId: string;
    remove: boolean;
    expectedRevision?: number;
  }): Promise<NativeResult<{ id: string }>> {
    const fingerprint = Array.from(
      await secretDigest(canonical([input.body, input.remove, input.expectedRevision])),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    return this.ctx.storage.transactionSync(() => {
      const state = this.load();
      const revision = state?.organization.policyRevision ?? 0;
      const deny = (reason: string, status: 400 | 403 | 409 = 403): NativeResult<{ id: string }> => ({
        ok: false,
        status,
        reason,
        policyRevision: revision,
      });
      if (!state || !validPerson(input.actor) || !text(input.key, 128) || !text(input.requestId, 100))
        return deny("invalid_request", 400);
      const prior = input.id
        ? this.ctx.storage.sql
            .exec<{ body: string }>("SELECT body FROM owner_consents WHERE id=?", input.id)
            .toArray()[0]
        : undefined;
      const body = input.remove && prior ? (JSON.parse(prior.body) as OwnerConsent) : input.body;
      const targetId = "targetId" in body ? body.targetId : undefined;
      const action = body.action;
      if (typeof targetId !== "string" || typeof action !== "string" || !PRIVATE_ACTIONS.includes(action))
        return deny("invalid_consent", 400);
      const target = this.consentTarget(input.workspaceId, targetId);
      const resource: PolicyResource = {
        kind: "workspace",
        organizationId: state.organization.id,
        id: input.workspaceId,
        targetId,
        ownerPersonId: target?.ownerPersonId,
      };
      const context = { ...this.context(state, input.actor, input.workspaceId), managedPolicy: true };
      if (
        !target ||
        target.ownerPersonId !== input.actor.personId ||
        decide(input.actor, action, resource, context).decision !== "allow"
      )
        return deny("owner_required");
      const scope = canonical([input.actor.personId, input.workspaceId, input.id ?? "create", "consent", input.key]);
      const replay = this.ctx.storage.sql
        .exec<{ fingerprint: string; result: string; expires: number }>(
          "SELECT fingerprint,result,expires FROM replay WHERE scope=?",
          scope,
        )
        .toArray()[0];
      if (replay && replay.expires > Date.now())
        return replay.fingerprint === fingerprint
          ? (JSON.parse(replay.result) as NativeResult<{ id: string }>)
          : deny("idempotency_conflict", 409);
      if (input.remove && input.expectedRevision !== revision) return deny("revision_conflict", 409);
      const id = input.id ?? crypto.randomUUID();
      if (input.remove) this.ctx.storage.sql.exec("DELETE FROM owner_consents WHERE id=?", id);
      else {
        const { recipient, expiresAt } = input.body;
        if (
          Object.keys(input.body).some((k) => !["targetId", "action", "recipient", "expiresAt"].includes(k)) ||
          typeof recipient !== "string" ||
          state.members[recipient]?.status !== "active" ||
          state.workspaceMembers[input.workspaceId]?.[recipient]?.status !== "active" ||
          typeof expiresAt !== "number" ||
          !Number.isSafeInteger(expiresAt) ||
          expiresAt <= Date.now() ||
          expiresAt > Date.now() + DAY
        )
          return deny("invalid_consent", 400);
        const consent: OwnerConsent = {
          ownerPersonId: input.actor.personId,
          personId: recipient,
          workspaceId: input.workspaceId,
          targetId,
          action,
          expiresAt,
        };
        this.ctx.storage.sql.exec("INSERT INTO owner_consents VALUES(?,?)", id, JSON.stringify(consent));
      }
      state.organization.policyRevision++;
      this.save(state);
      this.audit(
        input.actor,
        action,
        resource,
        true,
        input.remove ? "consent_removed" : "consent_granted",
        state.organization.policyRevision,
        input.requestId,
      );
      const result: NativeResult<{ id: string }> = {
        ok: true,
        value: { id },
        policyRevision: state.organization.policyRevision,
      };
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO replay VALUES(?,?,?,?)",
        scope,
        fingerprint,
        JSON.stringify(result),
        Date.now() + DAY,
      );
      return result;
    });
  }

  /** Current facts and exact finalized binding, shared by read decisions and permit issuance. */
  private channelDecision(
    input: ChannelAuthorization,
    verified?: VerifiedExecution | null,
  ): NativeResult<{
    actor: PersonActor | VerifiedExecution;
    deadline: number;
    target?: { principalId: string; executionId: string; ownerPersonId: string };
  }> {
    const state = this.load();
    const revision = state?.organization.policyRevision ?? 0;
    const deny = (
      reason: string,
    ): NativeResult<{
      actor: PersonActor | VerifiedExecution;
      deadline: number;
      target?: { principalId: string; executionId: string; ownerPersonId: string };
    }> => ({
      ok: false,
      status: 403,
      reason,
      policyRevision: revision,
    });
    if (
      !state ||
      !input.resource ||
      input.resource.kind !== "workspace" ||
      !text(input.requestId, 200) ||
      !text(input.resource.channel, 500) ||
      !text(input.resource.targetId, 500) ||
      !text(input.resource.operation, 500)
    )
      return deny("invalid_permit");
    const workspace = state.workspaces[input.resource.id];
    const pending =
      this.ctx.storage.sql
        .exec(
          "SELECT id FROM binding_operations WHERE json_extract(body, '$.workspaceId')=? AND json_extract(body, '$.phase') NOT IN ('done','conflict') LIMIT 1",
          input.resource.id,
        )
        .toArray().length > 0;
    const completed = this.ctx.storage.sql
      .exec<{ body: string }>(
        "SELECT body FROM binding_operations WHERE json_extract(body, '$.workspaceId')=? AND json_extract(body, '$.repo')=? AND json_extract(body, '$.phase')='done' ORDER BY json_extract(body, '$.generation') DESC LIMIT 1",
        input.resource.id,
        input.resource.channel,
      )
      .toArray()[0];
    const operation = completed ? (JSON.parse(completed.body) as BindingOperation) : undefined;
    const linked =
      !pending &&
      operation?.mode === "bind" &&
      operation.generation !== null &&
      operation.generation + 1 === input.generation &&
      workspace?.channel === input.resource.channel;

    if (!linked || !Number.isSafeInteger(input.generation) || input.generation <= 0) return deny("binding_mismatch");
    const actor = verified ?? ("token" in input.actor ? undefined : input.actor);
    if (!actor) return deny("invalid_actor");
    const now = Date.now();
    let context: PolicyContext;
    let deadline = now + 2000;
    if (actor.kind === "person" && input.credentialExpiresAt !== undefined) {
      if (!Number.isFinite(input.credentialExpiresAt)) return deny("credential_expired");
      deadline = Math.min(deadline, input.credentialExpiresAt);
    }
    if (actor.kind === "execution") {
      const execution = this.identityRow<AgentExecution>("executions", actor.executionId);
      const principal = this.identityRow<AgentPrincipal>("principals", actor.principalId);
      const grant = this.grantFor(actor.principalId, actor.workspaceId);
      const parsed = "token" in input.actor ? parseCredential(input.actor.token) : null;
      const credential = parsed
        ? this.identityRow<StoredCredential>("execution_credentials", parsed.credentialId)
        : null;
      if (!execution || !principal || !grant || !credential || credential.generation !== execution.credentialGeneration)
        return deny("execution_scope_denied");
      const row = this.ctx.storage.sql
        .exec<{ constraints_body: string }>("SELECT constraints_body FROM executions WHERE id=?", execution.id)
        .one();
      deadline = Math.min(deadline, credential.expiresAt, grant.expiresAt);
      context = {
        available: true,
        organizationId: state.organization.id,
        policyRevision: revision,
        workspaceActive: workspace?.status === "active",
        managedPolicy: true,
        now,
        verifiedExecution: actor,
        executionAuthority: {
          state,
          execution,
          principal,
          grant,
          credentialExpiresAt: credential.expiresAt,
          organizationCeiling: this.identityCeiling(state.organization.id),
          workspacePolicy: this.identityCeiling(actor.workspaceId),
          constraints: JSON.parse(row.constraints_body) as AgentConstraints,
        },
      };
    } else context = { ...this.context(state, actor, input.resource.id, false, true), managedPolicy: true, now };
    let targetIdentity: { principalId: string; executionId: string; ownerPersonId: string } | undefined;
    if (input.action === "agent.view" && input.resource.targetId !== "agents") {
      const target = this.consentTarget(input.resource.id, input.resource.targetId ?? "", input.resource.channel);
      if (
        !target ||
        target.id !== input.targetExecutionId ||
        state.members[target.ownerPersonId]?.status !== "active" ||
        state.workspaceMembers[input.resource.id]?.[target.ownerPersonId]?.status !== "active"
      )
        return deny("target_enrollment_required");
      const principal = this.identityRow<AgentPrincipal>("principals", target.principalId);
      const grant = this.grantFor(target.principalId, input.resource.id);
      if (
        !principal ||
        !grant ||
        effectiveActions(
          state,
          principal,
          grant,
          this.identityCeiling(state.organization.id),
          this.identityCeiling(input.resource.id),
          now,
          target,
        ).length === 0
      )
        return deny("target_enrollment_required");
      targetIdentity = { principalId: target.principalId, executionId: target.id, ownerPersonId: target.ownerPersonId };
    }
    if (PRIVATE_ACTIONS.includes(input.action)) {
      const target = this.consentTarget(input.resource.id, input.resource.targetId ?? "", input.resource.channel);
      if (!target || actor.kind !== "person" || input.targetExecutionId !== target.id)
        return deny("owner_consent_required");
      if (input.resource.ownerPersonId && input.resource.ownerPersonId !== target.ownerPersonId)
        return deny("owner_mismatch");
      input = { ...input, resource: { ...input.resource, ownerPersonId: target.ownerPersonId } };
      const consent = this.ctx.storage.sql
        .exec<{ body: string }>(
          "SELECT body FROM owner_consents WHERE json_extract(body, '$.ownerPersonId')=? AND json_extract(body, '$.personId')=? AND json_extract(body, '$.workspaceId')=? AND json_extract(body, '$.targetId')=? AND json_extract(body, '$.action')=? AND json_extract(body, '$.expiresAt')>? ORDER BY json_extract(body, '$.expiresAt') DESC LIMIT 1",
          target.ownerPersonId,
          actor.personId,
          input.resource.id,
          input.resource.targetId,
          input.action,
          now,
        )
        .toArray()[0];
      if (consent) {
        context.consent = JSON.parse(consent.body) as OwnerConsent;
        deadline = Math.min(deadline, context.consent.expiresAt);
      }
    }
    const decision = decide(actor, input.action, input.resource, context);
    if (decision.decision !== "allow" || deadline <= now) return deny(decision.reason);
    return {
      ok: true,
      value: { actor, deadline, ...(targetIdentity ? { target: targetIdentity } : {}) },
      policyRevision: revision,
    };
  }

  /** Internal RPC: callers resolve native Persons or pass execution credentials for fresh verification. */
  async authorizeChannelRead(input: ChannelAuthorization) {
    const verified = "token" in input.actor ? await this.verifyExecution(input.actor.token) : undefined;
    // Read-only attenuation: this RPC never issues permission for mutation/control.
    if (
      ![
        "workspace.read",
        "task.read",
        "agent.view",
        "channel.update.read",
        "channel.history.read",
        "agent.private_transcript.read",
        "agent.private_screen.read",
      ].includes(input.action)
    )
      return { ok: false as const, status: 403 as const, reason: "read_action_required", policyRevision: 0 };
    const result = this.channelDecision(input, verified);
    if (!result.ok || PRIVATE_ACTIONS.includes(input.action))
      this.audit(
        verified ?? ("token" in input.actor ? undefined : input.actor),
        input.action,
        input.resource,
        result.ok,
        result.ok ? "private_read_authorized" : result.reason,
        result.policyRevision,
        input.requestId,
      );
    return result;
  }

  /** Internal authority RPC; HTTP adapters must resolve the Person, never accept body actors. */
  async issueMutationPermit(input: ChannelAuthorization): Promise<NativeResult<MutationPermit>> {
    const verified = "token" in input.actor ? await this.verifyExecution(input.actor.token) : undefined;
    return this.ctx.storage.transactionSync(() => {
      const result = this.channelDecision(input, verified);
      if (!result.ok) return result;
      const { actor, deadline } = result.value;
      const revision = result.policyRevision;
      const now = Date.now();
      const deny = (reason: string): NativeResult<MutationPermit> => ({
        ok: false,
        status: 403,
        reason,
        policyRevision: revision,
      });
      // These foundations cover Channel local commits; lifecycle/admin writes stay in their existing Org transactions.
      if (
        ![
          "task.claim",
          "task.update",
          "channel.update.write",
          "agent.directive.send",
          "agent.handoff.cross_owner",
        ].includes(input.action)
      )
        return deny("unsupported_permit_action");
      if (deadline <= now) return deny("permit_expired");
      const permit: MutationPermit = {
        id: crypto.randomUUID(),
        actor,
        action: input.action,
        resource: input.resource,
        requestId: input.requestId,
        generation: input.generation,
        policyRevision: revision,
        issuedAt: now,
        expiresAt: deadline,
      };
      // Resource serialization is deliberately bounded to known identifiers, not arbitrary request content.
      if (resourceKey(input.resource).length > 2000) return deny("invalid_resource");
      this.ctx.storage.sql.exec(
        "INSERT INTO mutation_permits VALUES(?,?,?,?)",
        permit.id,
        revision,
        deadline,
        JSON.stringify(permit),
      );
      this.audit(
        actor,
        input.action,
        input.resource,
        true,
        "permit_issued",
        revision,
        input.requestId,
        undefined,
        undefined,
        permit.id,
      );
      return { ok: true, value: permit, policyRevision: revision };
    });
  }
  /** Internal audit sink. Historical outcomes confer no present content or mutation authority. */
  recordChannelOutcomes(batch: import("./managed-outcomes").ManagedOutcome[]): string[] {
    if (!Array.isArray(batch) || batch.length < 1 || batch.length > OUTCOME_BATCH_SIZE) return [];
    // An unverifiable historical row cannot poison unrelated evidence in the batch.
    // Each acknowledgment still follows its own atomic, fully validated audit append.
    const seen = new Map<string, string>();
    for (const candidate of batch) {
      if (!candidate || typeof candidate !== "object") continue;
      const outcome = managedOutcome(candidate.table, candidate.id, candidate);
      if (!outcome) continue;
      const id = outcomeAuditId(outcome);
      const body = canonical(outcome);
      if (seen.has(id) && seen.get(id) !== body) return [];
      seen.set(id, body);
    }
    return batch.flatMap((candidate) => this.#recordChannelOutcome(candidate));
  }
  #recordChannelOutcome(candidate: import("./managed-outcomes").ManagedOutcome): string[] {
    const batch = [candidate];
    const state = this.load();
    if (!state || !this.env.ORGANIZATION.idFromName(state.organization.id).equals(this.ctx.id)) return [];
    const records: { id: string; body: string; at: number }[] = [];
    for (const candidate of batch) {
      if (!candidate || typeof candidate !== "object") return [];
      const outcome = managedOutcome(candidate.table, candidate.id, candidate);
      if (
        !outcome ||
        outcome.resource.organizationId !== state.organization.id ||
        workspaceParent(outcome.resource.id) !== state.organization.id ||
        !state.workspaces[outcome.resource.id] ||
        !POLICY_ACTIONS.includes(outcome.action)
      )
        return [];
      // Accept historical commits after revocation/unlink, but never from a foreign Channel.
      const linked = this.ctx.storage.sql
        .exec(
          "SELECT id FROM binding_operations WHERE json_extract(body, '$.workspaceId')=? AND json_extract(body, '$.repo')=? AND json_extract(body, '$.mode')='bind' AND json_extract(body, '$.phase')='done' LIMIT 1",
          outcome.resource.id,
          outcome.resource.channel,
        )
        .toArray().length;
      if (!linked) return [];
      const actor = outcome.actor;
      if (actor.kind === "person") {
        if (!state.members[actor.personId]) return [];
      } else if (actor.kind === "execution") {
        const execution = this.identityRow<AgentExecution>("executions", actor.executionId);
        if (
          !execution ||
          execution.principalId !== actor.principalId ||
          execution.workspaceId !== outcome.resource.id ||
          actor.workspaceId !== outcome.resource.id
        )
          return [];
      } else return [];
      // Correlate to a decision actually issued here. The internal sink cannot mint authority.
      // Pre-export rows used permit id as their key; recover its request id while retained.
      const permit = this.identityRow<MutationPermit>("mutation_permits", outcome.id);
      const requestId = permit?.requestId ?? outcome.requestId;
      const decisions = this.ctx.storage.sql
        .exec<{ body: string }>(
          "SELECT body FROM audit WHERE json_extract(body, '$.requestId')=? AND json_extract(body, '$.reason')='permit_issued' AND json_extract(body, '$.policyRevision')=? LIMIT 10",
          requestId,
          outcome.policyRevision,
        )
        .toArray();
      if (
        !decisions.some(({ body }) => {
          const decision = JSON.parse(body) as AdminAuditRecord;
          return (
            (outcome.table === "managed_outcome_outbox"
              ? decision.mutationId === outcome.id || (!decision.mutationId && permit?.id === outcome.id)
              : outcome.id === requestId) &&
            decision.action === outcome.action &&
            canonical(decision.actor) === canonical(outcome.actor) &&
            canonical(decision.resource) === canonical(outcome.resource) &&
            decision.timestamp <= outcome.at
          );
        })
      )
        return [];
      const id = outcomeAuditId(outcome);
      const denied = ["local_restriction_denied", "update_budget_exhausted", "pr_failed"].includes(outcome.outcome);
      const record: AdminAuditRecord = {
        id,
        timestamp: outcome.at,
        requestId,
        ...(outcome.table === "managed_outcome_outbox" ? { mutationId: outcome.id } : {}),
        actor,
        action: outcome.action,
        resource: outcome.resource,
        policyRevision: outcome.policyRevision,
        decision: denied ? "deny" : "allow",
        outcome:
          outcome.outcome.startsWith("external_") || outcome.outcome.startsWith("pr_")
            ? (outcome.outcome as AdminAuditRecord["outcome"])
            : denied
              ? "denied"
              : "committed",
        reason: `channel_outcome:${outcome.outcome}`,
      };
      const body = canonical(record);
      const existing = this.ctx.storage.sql
        .exec<{ body: string }>("SELECT body FROM audit WHERE id=?", id)
        .toArray()[0];
      // Conflicting replay never overwrites an immutable audit fact or acknowledges it.
      if ((existing && existing.body !== body) || records.some((record) => record.id === id && record.body !== body))
        return [];
      records.push({ id, body, at: outcome.at });
    }
    return this.ctx.storage.transactionSync(() => {
      for (const record of records)
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO audit VALUES(?,?,?,?,1,?)",
          record.id,
          record.at,
          record.body,
          null,
          record.at,
        );
      return records.map((record) => record.id);
    });
  }
  private enqueue(person: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO directory_outbox VALUES(?,?) ON CONFLICT(person) DO UPDATE SET generation=excluded.generation",
      person,
      crypto.randomUUID(),
    );
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 1000));
  }
  override async alarm() {
    try {
      this.ctx.storage.transactionSync(() => this.cleanup());
      await this.repairDirectory();
    } finally {
      const pending = this.ctx.storage.sql.exec("SELECT person FROM directory_outbox LIMIT 1").toArray().length;
      await this.ctx.storage.setAlarm(Date.now() + (pending ? 60_000 : DAY));
    }
  }
  private audit(
    actor: unknown,
    action: string,
    resource: PolicyResource,
    allowed: boolean,
    reason: string,
    revision: number,
    requestId: string,
    command?: OrganizationCommand,
    identityTarget?: AdminAuditRecord["target"],
    mutationId?: string,
  ) {
    const now = Date.now();
    // One redacted denial per actor/action/resource/reason/minute bounds amplification.
    // Execution actors reach this seam only from internal authenticated adapters.
    // Retain attribution only when the referenced authoritative association matches.
    const candidate =
      actor && typeof actor === "object" && "kind" in actor && actor.kind === "execution"
        ? (actor as Partial<VerifiedExecution>)
        : undefined;
    const execution =
      candidate && typeof candidate.executionId === "string"
        ? this.identityRow<AgentExecution>("executions", candidate.executionId)
        : undefined;
    const safeActor: AdminAuditRecord["actor"] = validPerson(actor)
      ? { kind: "person", personId: actor.personId }
      : execution &&
          execution.id === candidate?.executionId &&
          execution.principalId === candidate.principalId &&
          execution.workspaceId === candidate.workspaceId
        ? {
            kind: "execution",
            executionId: execution.id,
            principalId: execution.principalId,
            workspaceId: execution.workspaceId,
          }
        : { kind: "unknown" };
    const bucket = allowed
      ? null
      : canonical([safeActor, action.slice(0, 80), resource.id.slice(0, 100), reason, Math.floor(now / 60_000)]);
    const record: AdminAuditRecord = {
      id: crypto.randomUUID(),
      timestamp: now,
      requestId: requestId.slice(0, 100),
      actor: safeActor,
      action: action.slice(0, 80),
      resource: { ...resource, id: resource.id.slice(0, 100) },
      decision: allowed ? "allow" : "deny",
      outcome: allowed ? "committed" : "denied",
      reason,
      policyRevision: revision,
      ...(mutationId ? { mutationId: mutationId.slice(0, 100) } : {}),
      target:
        identityTarget ??
        (command && "personId" in command
          ? { kind: "person", id: command.personId }
          : command?.kind === "invitation.accept"
            ? { kind: "invitation", id: command.invitationId }
            : undefined),
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO audit VALUES(?,?,?,?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1,last_timestamp=excluded.last_timestamp",
      record.id,
      now,
      JSON.stringify(record),
      bucket,
      now,
    );
  }
  private cleanup() {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM mutation_permits WHERE id IN (SELECT id FROM mutation_permits WHERE expires<=? LIMIT 100)",
      now,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM redemption_codes WHERE digest IN (SELECT digest FROM redemption_codes WHERE retain_until<=? LIMIT 100)",
      now,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM replay WHERE scope IN (SELECT scope FROM replay WHERE expires<=? LIMIT 100)",
      now,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM audit WHERE id IN (SELECT id FROM audit WHERE timestamp<? LIMIT 100)",
      now - 90 * DAY,
    );
  }
  private context(
    state: State,
    actor: PersonActor,
    workspaceId?: string,
    metadataOnly = false,
    identityPolicy = false,
  ) {
    return {
      available: true,
      organizationId: state.organization.id,
      policyRevision: state.organization.policyRevision,
      organizationMembership: state.members[actor.personId],
      workspaceMembership: workspaceId ? state.workspaceMembers[workspaceId]?.[actor.personId] : undefined,
      workspaceActive: workspaceId ? state.workspaces[workspaceId]?.status === "active" : undefined,
      metadataOnly,
      identityPolicy,
    };
  }
  async mutate(input: NativeMutation): Promise<NativeResult<MutationValue>> {
    const invitationTarget =
      input.command.kind === "invitation.create" && input.command.workspaceId
        ? await this.env.IDENTITY_DIRECTORY.getByName("directory-v1").personForGithub(input.command.githubId)
        : null;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input.requestFingerprint ?? canonical([input.command, input.expectedRevision])),
    );
    const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return this.ctx.storage.transactionSync(() => {
      this.cleanup();
      const state = this.load();
      if (!state) return { ok: false, status: 404, reason: "not_found", policyRevision: 0 };
      const { actor, command: c } = input;
      const revision = state.organization.policyRevision;
      const workspaceId = "workspaceId" in c ? c.workspaceId : undefined;
      const workspaceResource = workspaceId;
      const resource: PolicyResource = {
        kind: workspaceResource ? "workspace" : "organization",
        organizationId: state.organization.id,
        id: workspaceResource ? workspaceId : state.organization.id,
      };
      const refuse = (reason: string, status: 400 | 403 | 409 = 403): NativeResult<MutationValue> => {
        this.audit(
          actor,
          c.kind,
          resource,
          false,
          reason,
          revision,
          typeof input.requestId === "string" ? input.requestId : "invalid",
        );
        return { ok: false, status, reason, policyRevision: revision };
      };
      if (!validPerson(actor) || !text(input.key, 128) || !text(input.requestId, 100))
        return refuse("invalid_request", 400);
      if (workspaceId && (workspaceParent(workspaceId) !== state.organization.id || !state.workspaces[workspaceId]))
        return refuse("resource_denied");
      const action =
        c.kind === "organization.rename"
          ? "organization.manage"
          : c.kind === "organization.member" || (c.kind === "invitation.create" && !workspaceId)
            ? "organization.member.manage"
            : c.kind === "workspace.create"
              ? "workspace.create"
              : c.kind === "workspace.update"
                ? "workspace.manage"
                : c.kind === "workspace.member" || c.kind === "invitation.create"
                  ? "workspace.member.manage"
                  : "invitation.accept";
      const invitation = c.kind === "invitation.accept" ? state.invitations[c.invitationId] : undefined;
      if (c.kind === "invitation.accept") {
        if (!invitation || invitation.githubId !== actor.githubId) return refuse("invitation_denied");
      } else if (decide(actor, action, resource, this.context(state, actor, workspaceId)).decision !== "allow")
        return refuse("action_denied");
      const scope = canonical([actor.personId, input.key]);
      const replay = this.ctx.storage.sql
        .exec<{ fingerprint: string; result: string }>(
          "SELECT fingerprint,result FROM replay WHERE scope=? AND expires>?",
          scope,
          Date.now(),
        )
        .toArray()[0];
      if (replay)
        return replay.fingerprint === fingerprint
          ? (JSON.parse(replay.result) as NativeResult<MutationValue>)
          : refuse("idempotency_conflict", 409);
      if (input.expectedRevision !== undefined && input.expectedRevision !== revision)
        return refuse("stale_revision", 409);
      if (
        (c.kind === "organization.rename" ||
          c.kind === "workspace.update" ||
          c.kind === "organization.member" ||
          c.kind === "workspace.member") &&
        input.expectedRevision === undefined
      )
        return refuse("revision_required", 400);
      const now = Date.now();
      let value: MutationValue;
      switch (c.kind) {
        case "organization.rename":
          if (!text(c.name)) return refuse("invalid_name", 400);
          state.organization.name = c.name;
          value = state.organization;
          break;
        case "organization.member": {
          if (!orgRole(c.role) || !["active", "revoked"].includes(c.status)) return refuse("invalid_membership", 400);
          if (!validPerson({ ...actor, personId: c.personId })) return refuse("invalid_person", 400);
          const existing = state.members[c.personId];
          // New org membership requires invitee acceptance; no direct enrollment.
          if (!existing || (existing.status !== "active" && c.status === "active"))
            return refuse("invitation_required");
          if ((existing.role === "owner" || c.role === "owner") && state.members[actor.personId]?.role !== "owner")
            return refuse("owner_required");
          if (
            existing.role === "owner" &&
            (c.role !== "owner" || c.status !== "active") &&
            Object.values(state.members).filter((m) => m.role === "owner" && m.status === "active").length === 1
          )
            return refuse("last_owner");
          value = state.members[c.personId] = {
            personId: c.personId,
            role: c.role,
            status: c.status,
            grantedBy: actor.personId,
            grantedAt: now,
          };
          this.enqueue(c.personId);
          break;
        }
        case "workspace.create": {
          if (
            !text(c.name) ||
            typeof c.description !== "string" ||
            c.description.length > 2000 ||
            c.acceptManager !== true
          )
            return refuse("invalid_workspace_or_acceptance", 400);
          const id = `${state.organization.id}:${crypto.randomUUID()}`;
          value = state.workspaces[id] = {
            id,
            organizationId: state.organization.id,
            name: c.name,
            description: c.description,
            visibility: "private",
            status: "active",
            createdAt: now,
          };
          state.workspaceMembers[id] = {
            [actor.personId]: {
              personId: actor.personId,
              workspaceId: id,
              role: "manager",
              status: "active",
              grantedBy: actor.personId,
              grantedAt: now,
              reason: "creator_accepted",
            },
          };
          break;
        }
        case "workspace.update": {
          if (
            !text(c.name) ||
            typeof c.description !== "string" ||
            c.description.length > 2000 ||
            !["active", "archived"].includes(c.status)
          )
            return refuse("invalid_workspace", 400);
          const w = state.workspaces[c.workspaceId];
          if (!w) return refuse("resource_denied");
          Object.assign(w, { name: c.name, description: c.description, status: c.status });
          value = w;
          break;
        }
        case "workspace.member": {
          if (!workspaceRole(c.role) || !["active", "revoked"].includes(c.status) || !text(c.reason, 500))
            return refuse("invalid_membership", 400);
          if (!validPerson({ ...actor, personId: c.personId })) return refuse("invalid_person", 400);
          if (state.members[c.personId]?.status !== "active") return refuse("organization_membership_required");
          const members = state.workspaceMembers[c.workspaceId];
          if (!members) return refuse("resource_denied");
          value = members[c.personId] = {
            personId: c.personId,
            workspaceId: c.workspaceId,
            role: c.role,
            status: c.status,
            grantedBy: actor.personId,
            grantedAt: now,
            reason: c.reason,
          };
          break;
        }
        case "invitation.create": {
          if (
            !/^[1-9][0-9]{0,19}$/.test(c.githubId) ||
            !orgRole(c.organizationRole) ||
            (c.organizationRole === "owner" && state.members[actor.personId]?.role !== "owner") ||
            (c.workspaceId ? !workspaceRole(c.workspaceRole) : c.workspaceRole !== undefined)
          )
            return refuse("invalid_invitation", 400);
          // Workspace managers may invite existing org members, never enroll or promote org members.
          if (
            c.workspaceId &&
            !["owner", "admin"].includes(state.members[actor.personId]?.role ?? "") &&
            (!invitationTarget ||
              state.members[invitationTarget]?.status !== "active" ||
              state.members[invitationTarget]?.role !== c.organizationRole)
          )
            return refuse("organization_membership_required");
          value = {
            id: `${state.organization.id}:${crypto.randomUUID()}`,
            organizationId: state.organization.id,
            githubId: c.githubId,
            organizationRole: c.organizationRole,
            workspaceId: c.workspaceId,
            workspaceRole: c.workspaceRole,
            createdBy: actor.personId,
            expiresAt: now + 7 * DAY,
          };
          state.invitations[value.id] = value;
          this.enqueue(actor.personId);
          break;
        }
        case "invitation.accept": {
          if (!invitation || invitation.acceptedAt || invitation.expiresAt <= now)
            return refuse("invitation_expired_or_consumed", 409);
          // Recheck inviter authority: revocation/demotion cannot preserve an outstanding escalation.
          const inviter = state.members[invitation.createdBy];
          if (
            inviter?.status !== "active" ||
            (!["owner", "admin"].includes(inviter.role) &&
              (!invitation.workspaceId ||
                state.members[actor.personId]?.status !== "active" ||
                state.members[actor.personId]?.role !== invitation.organizationRole ||
                decide(
                  { ...actor, personId: invitation.createdBy },
                  "workspace.member.manage",
                  { kind: "workspace", organizationId: state.organization.id, id: invitation.workspaceId },
                  this.context(state, { ...actor, personId: invitation.createdBy }, invitation.workspaceId),
                ).decision !== "allow")) ||
            (invitation.organizationRole === "owner" && inviter.role !== "owner")
          )
            return refuse("inviter_authority_lost");
          const existing = state.members[actor.personId];
          // Conflicting active roles require an explicit membership change, never a hidden demotion.
          if (existing?.status === "active" && existing.role !== invitation.organizationRole)
            return refuse("membership_role_conflict");
          if (existing?.status !== "active")
            state.members[actor.personId] = {
              personId: actor.personId,
              role: invitation.organizationRole,
              status: "active",
              grantedBy: invitation.createdBy,
              grantedAt: now,
            };
          if (invitation.workspaceId && invitation.workspaceRole) {
            const members = state.workspaceMembers[invitation.workspaceId];
            if (!members || state.workspaces[invitation.workspaceId]?.status !== "active")
              return refuse("workspace_inactive");
            members[actor.personId] = {
              personId: actor.personId,
              workspaceId: invitation.workspaceId,
              role: invitation.workspaceRole,
              status: "active",
              grantedBy: invitation.createdBy,
              grantedAt: now,
              reason: "invitation_accepted",
            };
          }
          invitation.acceptedAt = now;
          this.enqueue(actor.personId);
          value = invitation;
          break;
        }
        default:
          return refuse("unknown_command", 400);
      }
      state.organization.policyRevision++;
      this.save(state);
      this.audit(
        actor,
        c.kind,
        c.kind === "workspace.create"
          ? { kind: "workspace", organizationId: state.organization.id, id: (value as NativeWorkspace).id }
          : resource,
        true,
        "committed",
        state.organization.policyRevision,
        input.requestId,
        c,
      );
      const result: NativeResult<MutationValue> = {
        ok: true,
        value,
        policyRevision: state.organization.policyRevision,
      };
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO replay VALUES(?,?,?,?)",
        scope,
        fingerprint,
        JSON.stringify(result),
        now + DAY,
      );
      return result;
    });
  }
  private bindingAllowed(state: State, actor: PersonActor, workspaceId: string): boolean {
    return (
      validPerson(actor) &&
      workspaceParent(workspaceId) === state.organization.id &&
      !!state.workspaces[workspaceId] &&
      decide(
        actor,
        "workspace.manage",
        { kind: "workspace", organizationId: state.organization.id, id: workspaceId },
        this.context(state, actor, workspaceId),
      ).decision === "allow"
    );
  }
  private loadBinding(id: string): BindingOperation | null {
    const row = this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM binding_operations WHERE id=?", id)
      .toArray()[0];
    return row ? (JSON.parse(row.body) as BindingOperation) : null;
  }
  private saveBinding(operation: BindingOperation) {
    this.ctx.storage.sql.exec(
      "UPDATE binding_operations SET body=? WHERE id=?",
      JSON.stringify(operation),
      operation.id,
    );
  }
  /** Polling is metadata only; it never resumes a mutation without fresh dual authority. */
  bindingOperation(actor: PersonActor, id: string): BindingOperation | null {
    const state = this.load();
    const operation = this.loadBinding(id);
    if (!state || !operation || !validPerson(actor)) return null;
    if (
      operation.actor.personId === actor.personId ||
      decide(
        actor,
        "organization.manage",
        { kind: "organization", organizationId: state.organization.id, id: state.organization.id },
        this.context(state, actor),
      ).decision === "allow"
    )
      return operation;
    return null;
  }
  /** Native HTTP adapter supplies only the authenticated signed-session login. */
  async coordinateBinding(input: {
    actor: PersonActor;
    login: string;
    workspaceId: string;
    repo: string;
    mode: "bind" | "unbind";
    key: string;
    requestId: string;
    operationId?: string;
    expectedRevision?: number;
    acknowledgeLegacyAccess?: boolean;
  }): Promise<NativeResult<BindingOperation>> {
    const { actor, workspaceId, mode, key, requestId } = input;
    let operationId: string | undefined;
    const state = this.load();
    const resource: PolicyResource = {
      kind: "workspace",
      organizationId: state?.organization.id ?? "",
      id: workspaceId,
    };
    const refuse = (status: 400 | 403 | 409 | 503, reason: string): NativeResult<BindingOperation> => {
      const revision = this.load()?.organization.policyRevision ?? 0;
      this.audit(actor, `channel.${mode}`, resource, false, reason, revision, requestId);
      return { ok: false, status, reason, policyRevision: revision, ...(operationId ? { operationId } : {}) };
    };
    if (!state || !this.bindingAllowed(state, actor, workspaceId)) return refuse(403, "workspace_manage_required");
    const repo = channelRepo(this.env, input.repo);
    if (
      !repo ||
      repo !== input.repo ||
      !text(key, 128) ||
      !text(requestId, 100) ||
      !/^[a-zA-Z0-9-]{1,39}$/.test(input.login) ||
      !["bind", "unbind"].includes(mode)
    )
      return refuse(400, "invalid_binding");
    if (mode === "unbind" && input.acknowledgeLegacyAccess !== true)
      return refuse(400, "legacy_access_warning_required");
    const channel = this.env.CHANNEL.getByName(repo);
    if (!(await channel.bindingOwner(repo, input.login as PersonName, actor.githubId)))
      return refuse(403, "fresh_repo_admin_required");
    // Reservation and replay are serialized with workspace authority, never with cached GitHub admission.
    const reserved = this.ctx.storage.transactionSync((): NativeResult<BindingOperation> => {
      const current = this.load();
      if (!current || !this.bindingAllowed(current, actor, workspaceId))
        return refuse(403, "workspace_manage_required");
      const scope = canonical([actor.personId, workspaceId, key]);
      const replay = this.ctx.storage.sql
        .exec<{ body: string }>("SELECT body FROM binding_operations WHERE scope=?", scope)
        .toArray()[0];
      const old = input.operationId
        ? this.loadBinding(input.operationId)
        : replay
          ? (JSON.parse(replay.body) as BindingOperation)
          : null;
      if (old) {
        if (
          old.actor.personId !== actor.personId ||
          old.workspaceId !== workspaceId ||
          old.repo !== repo ||
          old.mode !== mode ||
          (replay && (JSON.parse(replay.body) as BindingOperation).id !== old.id)
        )
          return refuse(409, "operation_conflict");
        return { ok: true, value: old, policyRevision: current.organization.policyRevision };
      }
      if (input.operationId) return refuse(409, "operation_conflict");
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.organization.policyRevision)
        return refuse(409, "stale_revision");
      const linked = current.workspaces[workspaceId]?.channel;
      if ((mode === "bind" && linked) || (mode === "unbind" && linked !== repo)) return refuse(409, "binding_conflict");
      const held = this.ctx.storage.sql
        .exec("SELECT workspace FROM binding_reservations WHERE workspace=? OR repo=? LIMIT 1", workspaceId, repo)
        .toArray();
      if (held.length) return refuse(409, "binding_conflict");
      const operation: BindingOperation = {
        id: `${current.organization.id}:${crypto.randomUUID()}`,
        actor,
        workspaceId,
        repo,
        mode,
        phase: "reserved",
        generation: null,
        key,
        ...(mode === "unbind" ? { warning: "Unbinding restores legacy repository access." } : {}),
      };
      this.ctx.storage.sql.exec("INSERT INTO binding_reservations VALUES(?,?,?)", workspaceId, repo, operation.id);
      this.ctx.storage.sql.exec(
        "INSERT INTO binding_operations VALUES(?,?,?)",
        operation.id,
        scope,
        JSON.stringify(operation),
      );
      this.audit(
        actor,
        `channel.${mode}.reserve`,
        resource,
        true,
        "reserved",
        current.organization.policyRevision,
        requestId,
      );
      return { ok: true, value: operation, policyRevision: current.organization.policyRevision };
    });
    if (!reserved.ok) return reserved;
    operationId = reserved.value.id;
    try {
      let operation = reserved.value;
      if (operation.phase === "done") return reserved;
      if (operation.phase === "conflict") return refuse(409, "channel_binding_conflict");
      if (operation.generation === null) {
        using snapshot = await channel.bindingState();
        operation = this.ctx.storage.transactionSync(() => {
          const stored = this.loadBinding(operation.id);
          if (!stored) throw new Error("Missing binding operation");
          if (stored.generation === null) {
            stored.generation = snapshot.generation;
            this.saveBinding(stored);
          }
          return stored;
        });
      }
      const expected = operation.generation;
      if (expected === null) return refuse(503, "binding_recovery_required");
      const advance = (from: BindingOperation["phase"], to: BindingOperation["phase"]): BindingOperation | null =>
        this.ctx.storage.transactionSync(() => {
          const current = this.load();
          const stored = this.loadBinding(operation.id);
          if (!current || !stored || !this.bindingAllowed(current, actor, workspaceId)) return null;
          if (stored.phase !== from) return stored;
          if (to === "committed") {
            const workspace = current.workspaces[workspaceId];
            if (!workspace) return null;
            if (mode === "bind") workspace.channel = repo;
            else delete workspace.channel;
            current.organization.policyRevision++;
            this.save(current);
            this.audit(
              actor,
              `channel.${mode}`,
              resource,
              true,
              "committed",
              current.organization.policyRevision,
              requestId,
            );
          }
          stored.phase = to;
          this.saveBinding(stored);
          if (to === "done") {
            this.audit(
              actor,
              `channel.${mode}.complete`,
              resource,
              true,
              "both_sides_agree",
              current.organization.policyRevision,
              requestId,
            );
            this.ctx.storage.sql.exec("DELETE FROM binding_reservations WHERE operation=?", stored.id);
          }
          return stored;
        });
      if (operation.phase === "reserved") {
        using prepared = await channel.transitionBinding(
          "prepare",
          workspaceId,
          operation.id,
          expected,
          mode === "unbind",
        );
        if (!prepared.ok) return refuse(503, "binding_recovery_required");
        if (!prepared.accepted) {
          // A losing CAS has made no Channel change. Release only our own reservation;
          // keep the terminal conflict journal so changed-key retries cannot revive it.
          this.ctx.storage.transactionSync(() => {
            const stored = this.loadBinding(operation.id);
            if (stored?.phase === "reserved") {
              stored.phase = "conflict";
              this.saveBinding(stored);
              this.ctx.storage.sql.exec("DELETE FROM binding_reservations WHERE operation=?", stored.id);
            }
          });
          return refuse(409, "channel_binding_conflict");
        }
        const next = advance("reserved", "prepared");
        if (!next) return refuse(403, "workspace_manage_required");
        operation = next;
      }
      if (operation.phase === "prepared") {
        const next = advance("prepared", "committed");
        if (!next) return refuse(403, "workspace_manage_required");
        operation = next;
      }
      if (operation.phase === "committed") {
        // Lost authority leaves the local pending fence closed for an authorized retry.
        const current = this.load();
        if (!current || !this.bindingAllowed(current, actor, workspaceId))
          return refuse(403, "workspace_manage_required");
        using finished = await channel.transitionBinding(
          "finish",
          workspaceId,
          operation.id,
          expected + 1,
          mode === "unbind",
        );
        if (!finished.ok) return refuse(503, "binding_recovery_required");
        if (!finished.accepted) return refuse(409, "channel_binding_conflict");
        const next = advance("committed", "done");
        if (!next) return refuse(403, "workspace_manage_required");
        operation = next;
      }
      return { ok: true, value: operation, policyRevision: this.load()?.organization.policyRevision ?? 0 };
    } catch {
      return {
        ok: false,
        status: 503,
        reason: "binding_recovery_required",
        policyRevision: this.load()?.organization.policyRevision ?? 0,
        operationId,
      };
    }
  }

  /** Active membership is checked even for directory candidates and direct ID reads. */
  metadata(actor: PersonActor): NativeOrganization | null {
    const state = this.load();
    if (validPerson(actor) && state?.members[actor.personId]?.status === "active") return state.organization;
    if (state)
      this.audit(
        actor,
        "organization.metadata.read",
        { kind: "organization", organizationId: state.organization.id, id: state.organization.id },
        false,
        "membership_required",
        state.organization.policyRevision,
        crypto.randomUUID(),
      );
    return null;
  }
  workspace(actor: PersonActor, id: string, metadataOnly = false): NativeWorkspace | null {
    const state = this.load();
    if (!state || !validPerson(actor)) return null;
    const resource: PolicyResource = { kind: "workspace", organizationId: state.organization.id, id };
    if (decide(actor, "workspace.read", resource, this.context(state, actor, id, metadataOnly)).decision !== "allow") {
      this.audit(
        actor,
        "workspace.read",
        resource,
        false,
        "workspace_denied",
        state.organization.policyRevision,
        crypto.randomUUID(),
      );
      return null;
    }
    return state.workspaces[id] ?? null;
  }
  auditRecords(actor: PersonActor, after = 0, afterId = ""): AdminAuditRecord[] | null {
    const state = this.load();
    if (
      !state ||
      !validPerson(actor) ||
      decide(
        actor,
        "organization.manage",
        { kind: "organization", organizationId: state.organization.id, id: state.organization.id },
        this.context(state, actor),
      ).decision !== "allow"
    )
      return null;
    return this.ctx.storage.sql
      .exec<{ body: string; count: number; last_timestamp: number }>(
        "SELECT body,count,last_timestamp FROM audit WHERE (timestamp>? OR (timestamp=? AND id>?)) AND timestamp>=? ORDER BY timestamp,id LIMIT 100",
        after,
        after,
        afterId,
        Date.now() - 90 * DAY,
      )
      .toArray()
      .map((row) => ({
        ...(JSON.parse(row.body) as AdminAuditRecord),
        count: row.count,
        lastTimestamp: row.last_timestamp,
      }));
  }
  /** Bounded metadata catalogs; authority is rechecked on every page. */
  catalog(actor: PersonActor, kind: "workspaces" | "members" | "workspace-members", workspaceId?: string, after = "") {
    const state = this.load();
    if (!state || !validPerson(actor) || !this.metadata(actor)) return null;
    if (kind !== "workspaces") {
      const resource: PolicyResource = {
        kind: workspaceId ? "workspace" : "organization",
        organizationId: state.organization.id,
        id: workspaceId ?? state.organization.id,
      };
      if (
        decide(
          actor,
          workspaceId ? "workspace.member.manage" : "organization.member.manage",
          resource,
          this.context(state, actor, workspaceId),
        ).decision !== "allow"
      )
        return null;
    }
    const entries =
      kind === "workspaces"
        ? Object.entries(state.workspaces).filter(([id]) => this.workspace(actor, id, true) !== null)
        : kind === "members"
          ? Object.entries(state.members)
          : Object.entries(state.workspaceMembers[workspaceId ?? ""] ?? {});
    const page = entries
      .filter(([id]) => id > after)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 51);
    return {
      items: page.slice(0, 50).map(([, value]) => value),
      next: page.length > 50 ? (page[49]?.[0] ?? null) : null,
      policyRevision: state.organization.policyRevision,
    };
  }
  /** Derived candidates can be stale; directory always rechecks metadata(). */
  async repairDirectory(): Promise<void> {
    const state = this.load();
    if (!state) return;
    const batch = this.ctx.storage.sql
      .exec<{ person: string; generation: string }>("SELECT person,generation FROM directory_outbox LIMIT 100")
      .toArray();
    const directory = this.env.IDENTITY_DIRECTORY.getByName("directory-v1");
    for (const invitation of Object.values(state.invitations)) {
      if (!invitation.acceptedAt && invitation.expiresAt > Date.now())
        await directory.routeInvitation(invitation.id, invitation.githubId, state.organization.id);
    }
    for (const { person, generation } of batch) {
      await directory.indexCandidate(person, state.organization.id);
      this.ctx.storage.sql.exec("DELETE FROM directory_outbox WHERE person=? AND generation=?", person, generation);
    }
  }
}
