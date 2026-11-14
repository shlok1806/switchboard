import type { PersonActor, PolicyResource, VerifiedExecution } from "../../shared/src/m1";

export interface MutationPermit {
  id: string;
  actor: PersonActor | VerifiedExecution;
  action: string;
  resource: PolicyResource;
  requestId: string;
  generation: number;
  policyRevision: number;
  issuedAt: number;
  expiresAt: number;
}
export interface PermitBinding {
  actor: MutationPermit["actor"];
  action: string;
  resource: PolicyResource;
  requestId: string;
  generation: number;
  policyRevision: number;
}
function actorKey(actor: MutationPermit["actor"]) {
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
  ]);
}
/** Instantiate only for managed Channels. Receipt must come directly from Organization RPC. */
export class LocalMutationPermits {
  constructor(private sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS managed_permits (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
  }
  install(permit: MutationPermit) {
    // Never replace a consumed permit on delayed/replayed receipt.
    this.sql.exec(
      "INSERT OR IGNORE INTO managed_permits VALUES(?,?)",
      permit.id,
      JSON.stringify({ permit, used: false }),
    );
  }
  /** Inside the SAME transactionSync as local state reread, write, audit and outbox. No await. */
  consume(permitId: string, binding: PermitBinding, now = Date.now()): boolean {
    const row = this.sql.exec<{ body: string }>("SELECT body FROM managed_permits WHERE id=?", permitId).toArray()[0];
    if (!row) return false;
    const { permit, used } = JSON.parse(row.body) as { permit: MutationPermit; used: boolean };
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
      permit.policyRevision !== binding.policyRevision
    )
      return false;
    this.sql.exec("UPDATE managed_permits SET body=? WHERE id=?", JSON.stringify({ permit, used: true }), permitId);
    return true;
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
