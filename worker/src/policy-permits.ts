import type { IntegrationActor, PersonActor, PolicyResource, VerifiedExecution } from "../../shared/src/m1";
import { MANAGED_OUTCOME_TTL_MS, MANAGED_RECORD_CAP } from "./managed-retention";

export type { IntegrationActor } from "../../shared/src/m1";

type PermitActor = PersonActor | VerifiedExecution | IntegrationActor;
export interface MutationPermit<A extends PermitActor = PersonActor | VerifiedExecution> {
  id: string;
  actor: A;
  action: string;
  resource: PolicyResource;
  requestId: string;
  generation: number;
  policyRevision: number;
  issuedAt: number;
  expiresAt: number;
}
export interface PermitBinding<A extends PermitActor = PersonActor | VerifiedExecution> {
  actor: A;
  action: string;
  resource: PolicyResource;
  requestId: string;
  generation: number;
  policyRevision: number;
}
function actorKey(actor: PermitActor) {
  if (actor.kind === "integration")
    return JSON.stringify([actor.kind, actor.provider, actor.repository, actor.workspaceId, actor.generation]);
  return actor.kind === "person"
    ? `person:${actor.personId}:${actor.githubId}`
    : `execution:${actor.principalId}:${actor.executionId}:${actor.workspaceId}`;
}
export function resourceKey(resource: PolicyResource): string {
  return JSON.stringify([
    resource.kind,
    resource.organizationId,
    resource.id,
    resource.channel ?? null,
    resource.targetId ?? null,
    resource.ownerPersonId ?? null,
    resource.operation ?? null,
    resource.hostId ?? null,
  ]);
}
/** Instantiate only for managed Channels. Receipt must come directly from Organization RPC. */
export class LocalMutationPermits<A extends PermitActor = PersonActor | VerifiedExecution> {
  constructor(private sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS managed_permits (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS managed_policy_floor (id INTEGER PRIMARY KEY CHECK(id=1), workspace TEXT NOT NULL, revision INTEGER NOT NULL)",
    );
  }
  /** Trusted authority observations only. One row, monotonic within a Workspace. */
  observeRevision(workspace: string, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new AuthorityUnavailable();
    this.sql.exec(
      `INSERT INTO managed_policy_floor VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,
      revision=CASE WHEN workspace=excluded.workspace THEN MAX(revision,excluded.revision) ELSE excluded.revision END`,
      workspace,
      revision,
    );
    this.sql.exec(
      "DELETE FROM managed_permits WHERE json_extract(body,'$.permit.resource.id')=? AND json_extract(body,'$.permit.policyRevision') < ? AND json_extract(body,'$.consumedByIntentId') IS NULL",
      workspace,
      this.revisionFloor(workspace),
    );
  }
  revisionFloor(workspace: string): number {
    return (
      this.sql
        .exec<{ revision: number }>("SELECT revision FROM managed_policy_floor WHERE id=1 AND workspace=?", workspace)
        .toArray()[0]?.revision ?? 0
    );
  }
  install(permit: MutationPermit<A>) {
    const existing = this.sql.exec("SELECT id FROM managed_permits WHERE id=?", permit.id).toArray();
    if (existing.length) return;
    const now = Date.now();
    this.sql.exec(
      "DELETE FROM managed_permits WHERE COALESCE(json_extract(body, '$.retainUntil'), json_extract(body, '$.permit.expiresAt'), 0) <= ?",
      now,
    );
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM managed_permits").one().n;
    if (count >= MANAGED_RECORD_CAP) throw new AuthorityUnavailable();
    // Never replace a consumed permit on delayed/replayed receipt.
    this.sql.exec(
      "INSERT OR IGNORE INTO managed_permits VALUES(?,?)",
      permit.id,
      JSON.stringify({ permit, used: false }),
    );
  }
  /** Inside the SAME transactionSync as local state reread, write, audit and outbox. No await. */
  consume(permitId: string, binding: PermitBinding<A>, now = Date.now()): boolean {
    const row = this.sql.exec<{ body: string }>("SELECT body FROM managed_permits WHERE id=?", permitId).toArray()[0];
    if (!row) return false;
    const { permit, used } = JSON.parse(row.body) as { permit: MutationPermit<A>; used: boolean };
    if (
      used ||
      !Number.isFinite(now) ||
      !Number.isFinite(permit.issuedAt) ||
      !Number.isFinite(permit.expiresAt) ||
      permit.expiresAt <= permit.issuedAt ||
      now < permit.issuedAt ||
      now >= permit.expiresAt ||
      permit.expiresAt > permit.issuedAt + 2000 ||
      actorKey(permit.actor) !== actorKey(binding.actor) ||
      permit.action !== binding.action ||
      resourceKey(permit.resource) !== resourceKey(binding.resource) ||
      permit.requestId !== binding.requestId ||
      permit.generation !== binding.generation ||
      permit.policyRevision < this.revisionFloor(permit.resource.id) ||
      permit.policyRevision !== binding.policyRevision
    )
      return false;
    this.sql.exec("UPDATE managed_permits SET body=? WHERE id=?", JSON.stringify({ permit, used: true }), permitId);
    return true;
  }
  /**
   * Install and consume a correlated receipt set in the caller's transactionSync.
   * Throws on any refusal so an earlier consumption and receipt installation roll
   * back together with the local mutation. Bindings must be built from reread
   * local state, never copied from the receipts being checked.
   */
  consumeSet(
    entries: readonly { permit: MutationPermit<A>; binding: PermitBinding<A> }[],
    now = Date.now(),
    intent?: { id: string; expiresAt: number },
  ): void {
    if (entries.length !== 2) throw new AuthorityUnavailable();
    if (
      intent &&
      (!intent.id ||
        intent.id.length > 256 ||
        !Number.isFinite(intent.expiresAt) ||
        intent.expiresAt <= now ||
        intent.expiresAt > now + 30_000)
    )
      throw new AuthorityUnavailable();
    const actions = new Set(entries.map(({ binding }) => binding.action));
    if (!actions.has("agent.execution.start") || !actions.has("agent.handoff.cross_owner"))
      throw new AuthorityUnavailable();
    const first = entries[0];
    if (!first) throw new AuthorityUnavailable();
    if (
      new Set(entries.map(({ permit }) => permit.id)).size !== entries.length ||
      entries.some(
        ({ permit, binding }) =>
          permit.resource.id !== first.binding.resource.id ||
          permit.resource.organizationId !== first.binding.resource.organizationId ||
          actorKey(permit.actor) !== actorKey(first.binding.actor) ||
          permit.policyRevision !== first.binding.policyRevision ||
          permit.generation !== first.binding.generation ||
          permit.requestId !== first.binding.requestId ||
          permit.expiresAt !== first.permit.expiresAt ||
          binding.policyRevision !== first.binding.policyRevision ||
          binding.generation !== first.binding.generation,
      )
    )
      throw new AuthorityUnavailable();
    for (const { permit } of entries) this.install(permit);
    for (const { permit, binding } of entries) {
      if (!this.consume(permit.id, binding, now)) throw new AuthorityUnavailable();
      if (intent) {
        // Correlation survives the receipt deadline, but conveys no authority.
        this.sql.exec(
          "UPDATE managed_permits SET body=? WHERE id=?",
          JSON.stringify({
            permit,
            used: true,
            consumedByIntentId: intent.id,
            consumptionExpiresAt: intent.expiresAt,
            retainUntil: intent.expiresAt + MANAGED_OUTCOME_TTL_MS,
          }),
          permit.id,
        );
      }
    }
  }
  /** Evidence only: TXN-2 must ALSO consume a fresh authority-issued apply permit. */
  consumedByIntent(ids: readonly string[], intentId: string, now = Date.now()): boolean {
    if (ids.length !== 2 || new Set(ids).size !== 2 || !Number.isFinite(now)) return false;
    const actions = new Set<string>();
    for (const id of ids) {
      const row = this.sql.exec<{ body: string }>("SELECT body FROM managed_permits WHERE id=?", id).toArray()[0];
      if (!row) return false;
      const body = JSON.parse(row.body) as {
        permit: MutationPermit<A>;
        used: boolean;
        consumedByIntentId?: string;
        retainUntil?: number;
        consumptionExpiresAt?: number;
      };
      if (
        !body.used ||
        body.consumedByIntentId !== intentId ||
        !Number.isFinite(body.retainUntil) ||
        now >= (body.consumptionExpiresAt ?? body.retainUntil ?? 0)
      )
        return false;
      actions.add(body.permit.action);
    }
    return actions.has("agent.execution.start") && actions.has("agent.handoff.cross_owner");
  }
  invalidate() {
    this.sql.exec("DELETE FROM managed_permits");
  }
}
export class AuthorityUnavailable extends Error {
  readonly status = 503;
  constructor() {
    super("authority_unavailable");
  }
}
/** Reads or permit issuance only. Never install/commit a result after timeout; the remote RPC may finish later. */
export async function authorityRequest<T>(read: () => Promise<T>, timeoutMs = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AuthorityUnavailable()),
          Number.isFinite(timeoutMs) ? Math.max(0, Math.min(2000, timeoutMs)) : 2000,
        );
      }),
    ]);
  } catch {
    throw new AuthorityUnavailable();
  } finally {
    clearTimeout(timer);
  }
}
