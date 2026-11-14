import { DurableObject } from "cloudflare:workers";
import type { NativeOrganization, NativeResult, PersonActor } from "../../shared/src/m1";
import { validPerson } from "./policy";

/** Singleton internal identity seam. Only verified GitHub numeric identities enter resolve(). */
export class IdentityDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS identities (github TEXT PRIMARY KEY, person TEXT NOT NULL UNIQUE, login TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates (person TEXT NOT NULL, organization TEXT NOT NULL, PRIMARY KEY(person,organization));
      CREATE TABLE IF NOT EXISTS creations (scope TEXT PRIMARY KEY, name TEXT NOT NULL, organization TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS creation_limits (person TEXT PRIMARY KEY, day INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, github TEXT NOT NULL, organization TEXT NOT NULL);`);
  }
  resolve(githubId: string, login: string): PersonActor | null {
    if (!/^[1-9][0-9]{0,19}$/.test(githubId) || typeof login !== "string" || !/^[a-zA-Z0-9-]{1,39}$/.test(login))
      return null;
    return this.ctx.storage.transactionSync(() => {
      const old = this.ctx.storage.sql
        .exec<{ person: string }>("SELECT person FROM identities WHERE github=?", githubId)
        .toArray()[0];
      const personId = old?.person ?? crypto.randomUUID();
      this.ctx.storage.sql.exec(
        "INSERT INTO identities VALUES(?,?,?) ON CONFLICT(github) DO UPDATE SET login=excluded.login",
        githubId,
        personId,
        login,
      );
      return { kind: "person", personId, githubId };
    });
  }
  personForGithub(githubId: string): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ person: string }>("SELECT person FROM identities WHERE github=?", githubId)
        .toArray()[0]?.person ?? null
    );
  }
  associated(actor: PersonActor): boolean {
    return (
      validPerson(actor) &&
      this.ctx.storage.sql
        .exec("SELECT person FROM identities WHERE github=? AND person=?", actor.githubId, actor.personId)
        .toArray().length === 1
    );
  }
  async createOrganization(
    actor: PersonActor,
    name: string,
    key: string,
    requestId: string,
  ): Promise<NativeResult<NativeOrganization>> {
    if (
      !this.associated(actor) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 200 ||
      typeof key !== "string" ||
      !key.trim() ||
      key.length > 128 ||
      typeof requestId !== "string" ||
      !requestId ||
      requestId.length > 100
    )
      return { ok: false, status: 400, reason: "invalid_creation", policyRevision: 0 };
    const reserved = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM creations WHERE scope IN (SELECT scope FROM creations WHERE expires<=? LIMIT 100)",
        Date.now(),
      );
      const scope = JSON.stringify([actor.personId, key]);
      const old = this.ctx.storage.sql
        .exec<{ name: string; organization: string }>("SELECT name,organization FROM creations WHERE scope=?", scope)
        .toArray()[0];
      if (old) return old.name === name ? old.organization : null;
      const day = Math.floor(Date.now() / 86_400_000);
      const limit = this.ctx.storage.sql
        .exec<{ day: number; count: number }>("SELECT day,count FROM creation_limits WHERE person=?", actor.personId)
        .toArray()[0];
      if (limit?.day === day && limit.count >= 10) return "rate_limited";
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO creation_limits VALUES(?,?,?)",
        actor.personId,
        day,
        limit?.day === day ? limit.count + 1 : 1,
      );
      const id = crypto.randomUUID();
      this.ctx.storage.sql.exec("INSERT INTO creations VALUES(?,?,?,?)", scope, name, id, Date.now() + 86_400_000);
      return id;
    });
    if (reserved === "rate_limited")
      return { ok: false, status: 403, reason: "creation_rate_limited", policyRevision: 0 };
    if (!reserved) return { ok: false, status: 409, reason: "idempotency_conflict", policyRevision: 0 };
    const org = this.env.ORGANIZATION.getByName(reserved);
    using result = await org.initialize(reserved, name, actor, requestId);
    if (result.ok) await org.repairDirectory();
    // Forward data, not the RPC result's disposer/capability, across a second RPC boundary.
    return result.ok
      ? { ok: true, value: { ...result.value }, policyRevision: result.policyRevision }
      : { ok: false, status: result.status, reason: result.reason, policyRevision: result.policyRevision };
  }
  /** Internal outbox sink, never authority. Even fabricated candidates disclose nothing. */
  indexCandidate(person: string, organization: string) {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO candidates VALUES(?,?)", person, organization);
  }
  async organizations(
    actor: PersonActor,
    after = "",
  ): Promise<{ organizations: NativeOrganization[]; next: string | null }> {
    if (!this.associated(actor) || typeof after !== "string" || after.length > 36)
      return { organizations: [], next: null };
    const candidates = this.ctx.storage.sql
      .exec<{ organization: string }>(
        "SELECT organization FROM candidates WHERE person=? AND organization>? ORDER BY organization LIMIT 50",
        actor.personId,
        after,
      )
      .toArray();
    const organizations: NativeOrganization[] = [];
    for (const { organization } of candidates) {
      // Failure propagates closed; no stale-index fallback or metadata disclosure.
      using current = await this.env.ORGANIZATION.getByName(organization).metadata(actor);
      if (current) organizations.push(structuredClone(current));
    }
    return { organizations, next: candidates.length === 50 ? (candidates.at(-1)?.organization ?? null) : null };
  }
  routeInvitation(id: string, githubId: string, organizationId: string) {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO invitations VALUES(?,?,?)", id, githubId, organizationId);
  }
  invitationOrganization(actor: PersonActor, id: string): string | null {
    if (!this.associated(actor)) return null;
    return (
      this.ctx.storage.sql
        .exec<{ organization: string }>(
          "SELECT organization FROM invitations WHERE id=? AND github=?",
          id,
          actor.githubId,
        )
        .toArray()[0]?.organization ?? null
    );
  }
}
