// Who may use a Channel (ADR 0007), on the Channel's side:
//
// - Membership: a Person gets in only with write access to the Channel's repo,
//   read from GitHub with the App's installation token. The answer is cached here
//   for at most MEMBERSHIP_TTL_MS per Person, so someone removed from the repo is
//   refused within minutes. When GitHub cannot be reached, a Person let in within
//   the last GRACE_MS stays in; anyone else waits.
// - Agent tokens: `switchboard run` trades its Person session for a token bound to
//   one Agent. Only the token's SHA-256 is stored. Every token of an Agent is
//   deleted when it goes Gone.

import type { AgentId, PersonName } from "../../shared/src/index";
import type { Credential } from "./auth";
import { APP_NOT_CONFIGURED, canWrite, type GitHub } from "./github/index";
import { newAgentToken, tokenHash } from "./session";

/** How long a membership answer is trusted before GitHub is asked again. */
export const MEMBERSHIP_TTL_MS = 5 * 60 * 1000;
/** How long a Person let in stays in while GitHub cannot be reached. */
const GRACE_MS = 60 * 60 * 1000;

export const ACCESS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS channel_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    person TEXT PRIMARY KEY,
    allowed INTEGER NOT NULL,
    checked_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_tokens (
    hash TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    person TEXT NOT NULL,
    issued_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_tokens_by_agent ON agent_tokens (agent);
`;

/** Who a Channel call is from, once admitted. `agent` is set for an Agent token. */
export interface Admitted {
  person: PersonName;
  agent?: AgentId;
}

export type AdmitResult = ({ ok: true } & Admitted) | { ok: false; status: 401 | 403 | 503; reason: string };

type MemberRow = { person: string; allowed: number; checked_at: number };
type TokenRow = { hash: string; agent: string; person: string; issued_at: number };

export interface AccessHost {
  sql: SqlStorage;
  /** The Channel repo's GitHub, or null when the App is not configured. */
  gitHub(): GitHub | null;
  /** Called when a Person is found to have lost access, so their open streams close. */
  refused(person: PersonName): void;
}

export class Access {
  constructor(private readonly host: AccessHost) {
    host.sql.exec(ACCESS_SCHEMA);
  }

  /** The repo this Channel is for, once the Worker has said. */
  repo(): string | null {
    return (
      this.host.sql.exec<{ value: string }>("SELECT value FROM channel_meta WHERE key = 'repo'").toArray()[0]?.value ??
      null
    );
  }

  /** Records the Channel's repo; the Worker names it on every call. */
  setRepo(repo: string): void {
    if (this.repo() !== repo)
      this.host.sql.exec("INSERT OR REPLACE INTO channel_meta (key, value) VALUES ('repo', ?)", repo);
  }

  /**
   * Admits a caller: its Agent token must be live, and its Person must have write
   * access to the repo. `dev` is the dev-only fake sign-in, under which a Channel
   * without GitHub lets everyone in.
   */
  async admit(credential: Credential, dev: boolean, fresh = false): Promise<AdmitResult> {
    let admitted: Admitted;
    if (credential.kind === "agent") {
      const row = this.host.sql
        .exec<TokenRow>("SELECT * FROM agent_tokens WHERE hash = ?", credential.tokenHash)
        .toArray()[0];
      if (row === undefined) {
        return {
          ok: false,
          status: 401,
          reason: "This Agent token was revoked (its Agent went Gone) or never issued. Register the Agent again.",
        };
      }
      admitted = { person: row.person, agent: row.agent as AgentId };
    } else {
      admitted = { person: credential.person };
    }
    const member = await this.checkMember(admitted.person, dev, fresh);
    return member.ok ? { ok: true, ...admitted } : member;
  }

  /** Whether `person` may use the Channel, asking GitHub when the cached answer is old. */
  async checkMember(
    person: PersonName,
    dev: boolean,
    fresh = false,
  ): Promise<{ ok: true } | { ok: false; status: 403 | 503; reason: string }> {
    const now = Date.now();
    const row = this.host.sql.exec<MemberRow>("SELECT * FROM members WHERE person = ?", person).toArray()[0];
    if (!fresh && row !== undefined && now - row.checked_at < MEMBERSHIP_TTL_MS)
      return this.answer(person, row.allowed === 1);

    const gitHub = this.host.gitHub();
    if (gitHub === null) {
      // Only the dev-only fake sign-in runs a Channel without GitHub.
      return dev ? { ok: true } : { ok: false, status: 503, reason: APP_NOT_CONFIGURED };
    }
    let allowed: boolean;
    try {
      allowed = canWrite(await gitHub.permission(person));
    } catch (error) {
      console.error(`Membership check for ${person} failed`, error);
      if (row?.allowed === 1 && now - row.checked_at < GRACE_MS) return { ok: true };
      return { ok: false, status: 503, reason: "Could not check your access to the repo with GitHub. Try again." };
    }
    this.host.sql.exec(
      "INSERT OR REPLACE INTO members (person, allowed, checked_at) VALUES (?, ?, ?)",
      person,
      allowed ? 1 : 0,
      now,
    );
    if (!allowed && row?.allowed === 1) this.host.refused(person);
    return this.answer(person, allowed);
  }

  /** Re-checks each Person in `persons` whose answer is due, closing the streams of anyone refused. */
  async recheck(persons: Iterable<PersonName>): Promise<void> {
    for (const person of persons) {
      const result = await this.checkMember(person, false);
      if (!result.ok && result.status === 403) this.host.refused(person);
    }
  }

  /** A new token for Agent `agent` of `person`. Returned once; only its hash is kept. */
  async issueAgentToken(agent: AgentId, person: PersonName): Promise<string> {
    const token = newAgentToken();
    this.host.sql.exec(
      "INSERT INTO agent_tokens (hash, agent, person, issued_at) VALUES (?, ?, ?, ?)",
      await tokenHash(token),
      agent,
      person,
      Date.now(),
    );
    return token;
  }

  /** Revokes every token of Agent `agent`. True when there were some. */
  revokeAgent(agent: AgentId): boolean {
    return this.host.sql.exec("DELETE FROM agent_tokens WHERE agent = ? RETURNING hash", agent).toArray().length > 0;
  }

  private answer(person: PersonName, allowed: boolean): { ok: true } | { ok: false; status: 403; reason: string } {
    const repo = this.repo() ?? "the repo";
    return allowed
      ? { ok: true }
      : {
          ok: false,
          status: 403,
          reason: `${person} does not have write access to ${repo}, so cannot join its Channel.`,
        };
  }
}
