// The one row a connector's sign-in keeps in its Channel (ADR 0040): its grant.
//
// Access tokens and codes are signed and stored nowhere, but each access token names
// its grant, and every MCP call checks that the grant is live. A grant row makes each
// code single-use (its ID is the code's) and lets refresh tokens rotate: each refresh
// moves the grant to its next generation, and a refresh token of an older one is a
// replay, which ends the grant. An ended grant keeps its row, at generation 0, for as
// long as its code could still be redeemed, so its code cannot start it again; then
// it is pruned with the expired ones. A Person keeps at most a few live grants per
// app: a new sign-in past that ends the oldest.

import type { PersonName } from "../../../shared/src/index";
import { CODE_TTL_SECONDS } from "./tokens";

export const MCP_GRANTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_grants (
    id TEXT PRIMARY KEY,
    person TEXT NOT NULL,
    client TEXT NOT NULL,
    generation INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mcp_grants_by_expiry ON mcp_grants (expires_at);
  CREATE INDEX IF NOT EXISTS mcp_grants_by_owner ON mcp_grants (person, client);
`;

/** The generation of a grant that ended: a replay was seen, or it was over the cap. */
const ENDED = 0;

/** The live grants one Person may keep for one app: a sign-in on each of a few devices. */
export const MAX_GRANTS_PER_CLIENT = 5;

/** How long an ended grant's row stays, so the code that started it cannot start it again. */
const ENDED_KEEP_MS = (CODE_TTL_SECONDS + 60) * 1000;

export type GrantResult = { ok: true; generation: number } | { ok: false; reason: string };

export class McpGrants {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(MCP_GRANTS_SCHEMA);
  }

  /** Whether grant `id` is live: started, not ended, not expired. One read by primary key. */
  live(id: string, now = Date.now()): boolean {
    const row = this.sql
      .exec<{ generation: number; expires_at: number }>(
        "SELECT generation, expires_at FROM mcp_grants WHERE id = ?",
        id,
      )
      .toArray()[0];
    return row !== undefined && row.generation !== ENDED && row.expires_at >= now;
  }

  /**
   * Starts grant `id` for a redeemed code. A code redeemed before is refused, and the
   * grant it started ends, as OAuth asks of a replayed code.
   */
  start(id: string, person: PersonName, client: string, expiresAt: number, now = Date.now()): GrantResult {
    this.prune(now);
    const existing = this.sql.exec<{ id: string }>("SELECT id FROM mcp_grants WHERE id = ?", id).toArray()[0];
    if (existing !== undefined) {
      this.end(id, now);
      return { ok: false, reason: "This authorization code was already used, so its sign-in ended. Sign in again." };
    }
    this.sql.exec(
      "INSERT INTO mcp_grants (id, person, client, generation, expires_at) VALUES (?, ?, ?, 1, ?)",
      id,
      person,
      client,
      expiresAt,
    );
    // Past the cap, the oldest of this Person's grants for this app end.
    const over = this.sql
      .exec<{ id: string }>(
        `SELECT id FROM mcp_grants WHERE person = ? AND client = ? AND generation != ${ENDED}
         ORDER BY rowid DESC LIMIT -1 OFFSET ${MAX_GRANTS_PER_CLIENT}`,
        person,
        client,
      )
      .toArray();
    for (const row of over) this.end(row.id, now);
    return { ok: true, generation: 1 };
  }

  /** Moves grant `id` on from `generation`, for a refresh. An older generation ends the grant. */
  rotate(id: string, generation: number, client: string, expiresAt: number, now = Date.now()): GrantResult {
    this.prune(now);
    const row = this.sql
      .exec<{ generation: number; client: string; expires_at: number }>(
        "SELECT generation, client, expires_at FROM mcp_grants WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (row === undefined || row.expires_at < now || row.generation === ENDED) {
      return { ok: false, reason: "This sign-in ended. Sign in again." };
    }
    if (row.client !== client) return { ok: false, reason: "This refresh token belongs to another client." };
    if (row.generation !== generation) {
      this.end(id, now);
      return { ok: false, reason: "This refresh token was already used, so the sign-in ended. Sign in again." };
    }
    this.sql.exec("UPDATE mcp_grants SET generation = ?, expires_at = ? WHERE id = ?", generation + 1, expiresAt, id);
    return { ok: true, generation: generation + 1 };
  }

  /**
   * Deletes the grants that expired, through the expiry index: it reads only those.
   * Every sign-in and refresh prunes, and connected apps refresh about hourly.
   */
  prune(now = Date.now()): void {
    this.sql.exec("DELETE FROM mcp_grants WHERE expires_at < ?", now);
  }

  /** Ends grant `id`: it keeps its row only as long as its code could be replayed. */
  private end(id: string, now: number): void {
    this.sql.exec(
      "UPDATE mcp_grants SET generation = ?, expires_at = MIN(expires_at, ?) WHERE id = ?",
      ENDED,
      now + ENDED_KEEP_MS,
      id,
    );
  }
}
