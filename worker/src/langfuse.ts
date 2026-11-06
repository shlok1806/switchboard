// A Channel's Langfuse project (ADR 0044): the one row that names it, and the client
// that reads it. The row holds the host, the public key, the secret key sealed with a
// key derived from SESSION_SECRET (secret-box.ts) and the project Langfuse named when
// it was connected. Only `connection` leaves this module for a route: it has no key.
//
// The client only sends GETs, to two of Langfuse's public API paths: the project the
// keys belong to (checked when the owner connects) and the Metrics API v2 (the
// Connector's costs tool). Langfuse's project keys could also ingest; nothing here does.

import type { LangfuseConnection } from "../../shared/src/index";
import { LANGFUSE_KEY_END, oneLine } from "../../shared/src/index";
import { open, seal } from "./secret-box";

export const LANGFUSE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS langfuse_project (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    host TEXT NOT NULL,
    public_key TEXT NOT NULL,
    secret_sealed TEXT NOT NULL,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    connected_by TEXT NOT NULL,
    connected_at TEXT NOT NULL
  );
`;

/** What SESSION_SECRET's key for the Langfuse secret is derived for. */
const PURPOSE = "langfuse secret key v1";
/** How long one call to Langfuse may take. */
const TIMEOUT_MS = 15_000;

/** The Channel's row, as the Worker reads it: the secret key still sealed. */
export interface StoredLangfuse {
  host: string;
  publicKey: string;
  secretSealed: string;
  project: { id: string; name: string };
  connectedBy: string;
  connectedAt: string;
}

/** A project's host and keys, opened for one call. */
export interface LangfuseKeys {
  host: string;
  publicKey: string;
  secretKey: string;
}

type Row = {
  host: string;
  public_key: string;
  secret_sealed: string;
  project_id: string;
  project_name: string;
  connected_by: string;
  connected_at: string;
};

/** The one row of a Channel's Langfuse project. */
export class LangfuseProject {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(LANGFUSE_SCHEMA);
  }

  get(): StoredLangfuse | null {
    const row = this.sql.exec<Row>("SELECT * FROM langfuse_project WHERE id = 1").toArray()[0];
    if (row === undefined) return null;
    return {
      host: row.host,
      publicKey: row.public_key,
      secretSealed: row.secret_sealed,
      project: { id: row.project_id, name: row.project_name },
      connectedBy: row.connected_by,
      connectedAt: row.connected_at,
    };
  }

  set(stored: StoredLangfuse): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO langfuse_project
         (id, host, public_key, secret_sealed, project_id, project_name, connected_by, connected_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      stored.host,
      stored.publicKey,
      stored.secretSealed,
      stored.project.id,
      stored.project.name,
      stored.connectedBy,
      stored.connectedAt,
    );
  }

  /** True when there was a project to remove. */
  remove(): boolean {
    return this.sql.exec("DELETE FROM langfuse_project RETURNING id").toArray().length > 0;
  }
}

/** What anyone on the Channel may see of it: the host, the public key's end and the project. */
export function connection(stored: StoredLangfuse): LangfuseConnection {
  return {
    host: stored.host,
    publicKeyEnd: stored.publicKey.slice(-LANGFUSE_KEY_END),
    project: stored.project,
    connectedBy: stored.connectedBy,
    connectedAt: stored.connectedAt,
  };
}

export function sealSecretKey(secret: string, repo: string, secretKey: string): Promise<string> {
  return seal(secret, PURPOSE, repo, secretKey);
}

/** The stored project's keys, or null when its secret key no longer opens (SESSION_SECRET changed). */
export async function openKeys(secret: string, repo: string, stored: StoredLangfuse): Promise<LangfuseKeys | null> {
  const secretKey = await open(secret, PURPOSE, repo, stored.secretSealed);
  return secretKey === null ? null : { host: stored.host, publicKey: stored.publicKey, secretKey };
}

/** A GET of Langfuse's public API at `path` (`/api/public/...`), with the project's Basic auth. */
export async function langfuseGet(keys: LangfuseKeys, path: string, query?: Record<string, string>): Promise<Response> {
  const url = new URL(`${keys.host}${path}`);
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  return fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${btoa(`${keys.publicKey}:${keys.secretKey}`)}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Why Langfuse did not answer, in words a Person or the asker's model passes on. Never the secret key. */
export async function langfuseRefusal(response: Response, keys: LangfuseKeys): Promise<string> {
  const status = response.status;
  if (status === 401 || status === 403) {
    return `Langfuse at ${keys.host} refused the Channel's keys (${status}). The Channel's owner can connect them again on the Dashboard's Settings page.`;
  }
  if (status === 429) {
    const after = Number(response.headers.get("retry-after"));
    const wait = Number.isFinite(after) && after > 0 ? `in ${Math.ceil(after)} seconds` : "in a minute";
    return `Langfuse's rate limit for this project is used up. Ask again ${wait}.`;
  }
  if (status >= 500) return `Langfuse at ${keys.host} failed (${status}). Ask again in a minute.`;
  let message = "";
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    const said = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "";
    message = oneLine(said.split(keys.secretKey).join("[secret key]"), 300);
  } catch {
    // Not JSON: the status says enough.
  }
  return `Langfuse at ${keys.host} answered ${status}${message === "" ? "." : `: ${message}`}`;
}

/** Why a call to Langfuse never got an answer. */
export function unreachable(keys: LangfuseKeys, error: unknown): string {
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return timedOut
    ? `Langfuse at ${keys.host} did not answer within ${TIMEOUT_MS / 1000} seconds. Ask again in a minute.`
    : `Could not reach Langfuse at ${keys.host}. Check the host, or ask again in a minute.`;
}

/** The project the keys belong to: what connecting checks, so wrong keys are refused before they are kept. */
export async function projectOf(
  keys: LangfuseKeys,
): Promise<{ ok: true; project: { id: string; name: string } } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await langfuseGet(keys, "/api/public/projects");
  } catch (error) {
    return { ok: false, reason: unreachable(keys, error) };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: `Langfuse at ${keys.host} refused these keys. Check that they are the project's.` };
  }
  if (!response.ok) return { ok: false, reason: await langfuseRefusal(response, keys) };
  let project: { id?: unknown; name?: unknown } | undefined;
  try {
    project = ((await response.json()) as { data?: { id?: unknown; name?: unknown }[] }).data?.[0];
  } catch {
    project = undefined;
  }
  if (typeof project?.id !== "string" || typeof project.name !== "string") {
    return {
      ok: false,
      reason: `${keys.host} did not answer as Langfuse does. Check the host, and use a project's keys, not an organization's.`,
    };
  }
  return { ok: true, project: { id: project.id, name: oneLine(project.name, 100) } };
}
