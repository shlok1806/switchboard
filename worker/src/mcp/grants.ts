// The one row a connector's sign-in keeps in its Channel (ADR 0040): its grant.
//
// Access tokens and codes are signed and stored nowhere. A grant row makes each code
// single-use (its ID is the code's) and lets refresh tokens rotate: each refresh moves
// the grant to its next generation, and a refresh token of an older one is a replay,
// which ends the grant. An ended grant keeps its row, at generation 0, until it
// expires, so its code cannot start it again. A sign-in writes one row, a refresh
// updates it.

import type { PersonName } from "../../../shared/src/index";

export const MCP_GRANTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_grants (
    id TEXT PRIMARY KEY,
    person TEXT NOT NULL,
    client TEXT NOT NULL,
    generation INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

/** The generation of a grant that ended: a replay was seen. */
const ENDED = 0;

export type GrantResult = { ok: true; generation: number } | { ok: false; reason: string };

export class McpGrants {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(MCP_GRANTS_SCHEMA);
  }

  /**
   * Starts grant `id` for a redeemed code. A code redeemed before is refused, and the
   * grant it started ends, as OAuth asks of a replayed code.
   */
  start(id: string, person: PersonName, client: string, expiresAt: number, now = Date.now()): GrantResult {
    const existing = this.sql.exec<{ id: string }>("SELECT id FROM mcp_grants WHERE id = ?", id).toArray()[0];
    if (existing !== undefined) {
      this.end(id);
      return { ok: false, reason: "This authorization code was already used, so its sign-in ended. Sign in again." };
    }
    // Expired grants go when a new one starts; a Channel has a handful of connected apps.
    this.sql.exec("DELETE FROM mcp_grants WHERE expires_at < ?", now);
    this.sql.exec(
      "INSERT INTO mcp_grants (id, person, client, generation, expires_at) VALUES (?, ?, ?, 1, ?)",
      id,
      person,
      client,
      expiresAt,
    );
    return { ok: true, generation: 1 };
  }

  /** Moves grant `id` on from `generation`, for a refresh. An older generation ends the grant. */
  rotate(id: string, generation: number, client: string, expiresAt: number, now = Date.now()): GrantResult {
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
      this.end(id);
      return { ok: false, reason: "This refresh token was already used, so the sign-in ended. Sign in again." };
    }
    this.sql.exec("UPDATE mcp_grants SET generation = ?, expires_at = ? WHERE id = ?", generation + 1, expiresAt, id);
    return { ok: true, generation: generation + 1 };
  }

  private end(id: string): void {
    this.sql.exec("UPDATE mcp_grants SET generation = ? WHERE id = ?", ENDED, id);
  }
}
