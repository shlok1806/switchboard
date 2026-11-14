import { DurableObject } from "cloudflare:workers";
import type { PersonName } from "../../shared/src/index";
import type {
  AdminAuditRecord,
  BindingOperation,
  MembershipInvitation,
  NativeMutation,
  NativeOrganization,
  NativeResult,
  NativeWorkspace,
  OrganizationCommand,
  OrganizationMembership,
  PersonActor,
  PolicyResource,
  WorkspaceMembership,
} from "../../shared/src/m1";
import { channelRepo } from "./auth";
import { decide, validPerson, workspaceParent } from "./policy";

const DAY = 86_400_000;
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
      CREATE TABLE IF NOT EXISTS directory_outbox (person TEXT PRIMARY KEY, generation TEXT NOT NULL);`);
  }
  private load(): State | undefined {
    const row = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM aggregate WHERE id=1").toArray()[0];
    return row ? (JSON.parse(row.body) as State) : undefined;
  }
  private save(state: State) {
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
  ) {
    const now = Date.now();
    // One redacted denial per actor/action/resource/reason/minute bounds amplification.
    const safeActor: AdminAuditRecord["actor"] = validPerson(actor)
      ? { kind: "person", personId: actor.personId }
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
      target:
        command && "personId" in command
          ? { kind: "person", id: command.personId }
          : command?.kind === "invitation.accept"
            ? { kind: "invitation", id: command.invitationId }
            : undefined,
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
      "DELETE FROM replay WHERE scope IN (SELECT scope FROM replay WHERE expires<=? LIMIT 100)",
      now,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM audit WHERE id IN (SELECT id FROM audit WHERE timestamp<? LIMIT 100)",
      now - 90 * DAY,
    );
  }
  private context(state: State, actor: PersonActor, workspaceId?: string, metadataOnly = false) {
    return {
      available: true,
      organizationId: state.organization.id,
      policyRevision: state.organization.policyRevision,
      organizationMembership: state.members[actor.personId],
      workspaceMembership: workspaceId ? state.workspaceMembers[workspaceId]?.[actor.personId] : undefined,
      workspaceActive: workspaceId ? state.workspaces[workspaceId]?.status === "active" : undefined,
      metadataOnly,
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
