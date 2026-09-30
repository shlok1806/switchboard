// Who is calling (ADR 0007). Every Channel API call carries one credential: a
// Person session (the Dashboard's cookie, or the CLI's bearer) or an Agent token
// (the wrapper's bearer). The Worker checks what it can alone, a session's
// signature, and the Channel Durable Object checks the rest: that the Agent token
// is live and that the Person still has write access to the repo.

import type { PersonName } from "../../shared/src/index";
import { AGENT_TOKEN_PREFIX, channelKey, SESSION_COOKIE } from "../../shared/src/index";
import { DEV_SESSION_SECRET, MIN_SESSION_SECRET_LENGTH, tokenHash, verifySession } from "./session";

declare global {
  interface Env {
    /** Signs Person sessions. Unset until set up: sign-in is then off. */
    SESSION_SECRET?: string;
    /**
     * "true" turns on the fake GitHub sign-in, for `wrangler dev` and the tests only.
     * Even then it answers only requests to localhost. Never set it in production.
     */
    DEV_FAKE_GITHUB?: string;
  }
}

/** A credential as the Channel checks it. */
export type Credential = { kind: "session"; person: PersonName } | { kind: "agent"; tokenHash: string };

export type CredentialResult =
  | { ok: true; credential: Credential; viaCookie: boolean }
  | { ok: false; status: 401 | 403 | 503; reason: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a request was made to this machine: `wrangler dev`, never a deployed Worker. */
export function isLocal(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith(".localhost");
}

/**
 * The dev-only fake GitHub sign-in is on: the explicit DEV_FAKE_GITHUB var, and a
 * request to localhost. A deployed Worker is never reached as localhost, so it is
 * off in production even if the var were set by mistake.
 */
export function devMode(env: Env, url: URL): boolean {
  return env.DEV_FAKE_GITHUB === "true" && isLocal(url);
}

/** The secret sessions are signed with, or null when sign-in is not set up. */
export function sessionSecret(env: Env, dev: boolean): string | null {
  const secret = env.SESSION_SECRET ?? "";
  if (secret.length >= MIN_SESSION_SECRET_LENGTH) return secret;
  return dev ? DEV_SESSION_SECRET : null;
}

/** Repos a Channel may be opened for (ALLOWED_REPOS, comma-separated), lowercased. Empty means any. */
export function allowedRepos(env: Env): string[] {
  return (env.ALLOWED_REPOS ?? "")
    .split(",")
    .map((repo) => channelKey(repo))
    .filter((repo): repo is string => repo !== null);
}

/** The Channel key for `repo` when a Channel may exist for it here, else null. */
export function channelRepo(env: Env, repo: string): string | null {
  const key = channelKey(repo);
  if (key === null) return null;
  const allowed = allowedRepos(env);
  return allowed.length === 0 || allowed.includes(key) ? key : null;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/** A `Set-Cookie` value: HttpOnly, Secure and SameSite=Lax always. `maxAge` 0 clears it. */
export function cookie(name: string, value: string, maxAge: number, path = "/"): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Reads the caller's credential: `Authorization: Bearer`, the session cookie, or,
 * for a WebSocket upgrade (which cannot carry headers from every client), `?token=`.
 * A cookie-carried call that changes something, or opens the stream, must come
 * from the Dashboard's own origin.
 */
export async function readCredential(request: Request, url: URL, env: Env): Promise<CredentialResult> {
  const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  const header = request.headers.get("Authorization");
  const bearer = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : upgrade
      ? url.searchParams.get("token")
      : null;
  const fromCookie = bearer ? null : readCookie(request, SESSION_COOKIE);
  const token = bearer || fromCookie;
  if (!token) return { ok: false, status: 401, reason: "Sign in with GitHub first." };

  if (token.startsWith(AGENT_TOKEN_PREFIX)) {
    return { ok: true, credential: { kind: "agent", tokenHash: await tokenHash(token) }, viaCookie: false };
  }
  const secret = sessionSecret(env, devMode(env, url));
  if (secret === null) return { ok: false, status: 503, reason: "Sign-in is not set up: GitHub App not configured." };
  const person = await verifySession(secret, token);
  if (person === null)
    return { ok: false, status: 401, reason: "Your session expired or is not valid. Sign in again." };
  if (fromCookie !== null && (upgrade || request.method !== "GET")) {
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) {
      return { ok: false, status: 403, reason: "Cross-site request refused." };
    }
  }
  return { ok: true, credential: { kind: "session", person }, viaCookie: fromCookie !== null };
}
