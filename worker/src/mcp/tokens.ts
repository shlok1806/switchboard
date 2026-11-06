// What the read-only connector's sign-in hands out (ADR 0040). Every one is a payload
// signed with SESSION_SECRET (session.ts) and told apart by its `kind`, so none of
// them is ever taken for another, and none for a Person session, whose check takes
// `kind: "session"` only. Only refresh tokens have a row, their grant (grants.ts).

import type { PersonName } from "../../../shared/src/index";
import { personFromLogin } from "../../../shared/src/index";
import { base64url, signPayload, tokenHash, verifyPayload } from "../session";
import { MCP_SCOPE } from "./paths";

/** An access token lasts an hour; the apps refresh it before then. */
export const ACCESS_TTL_SECONDS = 60 * 60;
/** A refresh token lasts 30 days from its last use. */
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
/** An authorization code is redeemed at once, or never. */
export const CODE_TTL_SECONDS = 60;
/** How long the consent page's Allow button stays good. */
export const CONSENT_TTL_SECONDS = 10 * 60;

/** A registered app: its `client_id` is this, signed (RFC 7591 with nothing stored). */
export interface RegisteredClient {
  name: string;
  redirectUris: string[];
}

/** An authorization request, as checked by the authorize page. */
export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  /** The PKCE S256 challenge. */
  challenge: string;
  state?: string;
  /** The Channel the token is for: its key, `owner/repo` lowercased. */
  repo: string;
  /** Whether the request named its redirect_uri, which the token request must then repeat. */
  redirectGiven: boolean;
}

/** What an access token says. */
export interface AccessGrant {
  person: PersonName;
  repo: string;
  scope: string;
  /** The grant it was issued under, which every MCP call checks is still live. */
  grant: string;
}

/** What a refresh token says. */
export interface RefreshGrant {
  person: PersonName;
  repo: string;
  client: string;
  grant: string;
  generation: number;
}

const now = () => Math.floor(Date.now() / 1000);

/** The payload of `token` if it is a live one of `kind`, else null. */
async function read(secret: string, token: string, kind: string): Promise<Record<string, unknown> | null> {
  const payload = await verifyPayload(secret, token);
  if (payload === null || payload.kind !== kind) return null;
  if (payload.exp !== undefined && (typeof payload.exp !== "number" || payload.exp <= now())) return null;
  return payload;
}

/** A short, fixed-length name for a client, as grants and codes keep it. */
export function clientKey(clientId: string): Promise<string> {
  return tokenHash(clientId);
}

export function signClient(secret: string, client: RegisteredClient): Promise<string> {
  return signPayload(secret, { kind: "mcp-client", name: client.name, redirect_uris: client.redirectUris, iat: now() });
}

export async function readClient(secret: string, clientId: string): Promise<RegisteredClient | null> {
  const payload = await read(secret, clientId, "mcp-client");
  if (payload === null || typeof payload.name !== "string" || !Array.isArray(payload.redirect_uris)) return null;
  const redirectUris = payload.redirect_uris.filter((uri): uri is string => typeof uri === "string");
  return { name: payload.name, redirectUris };
}

/** The consent page's signed copy of the request it shows, for the Person it shows it to. */
export function signConsent(secret: string, person: PersonName, request: AuthorizationRequest): Promise<string> {
  return signPayload(secret, { kind: "mcp-consent", person, ...request, exp: now() + CONSENT_TTL_SECONDS });
}

export async function readConsent(
  secret: string,
  token: string,
): Promise<{ person: PersonName; request: AuthorizationRequest } | null> {
  const p = await read(secret, token, "mcp-consent");
  const person = typeof p?.person === "string" ? personFromLogin(p.person) : null;
  if (
    p === null ||
    person === null ||
    typeof p.clientId !== "string" ||
    typeof p.redirectUri !== "string" ||
    typeof p.challenge !== "string" ||
    typeof p.repo !== "string" ||
    typeof p.redirectGiven !== "boolean" ||
    (p.state !== undefined && typeof p.state !== "string")
  ) {
    return null;
  }
  return {
    person,
    request: {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      challenge: p.challenge,
      repo: p.repo,
      redirectGiven: p.redirectGiven,
      ...(typeof p.state === "string" ? { state: p.state } : {}),
    },
  };
}

/** A code for `request`, allowed by `person`. Its random `jti` becomes the grant's ID. */
export async function signCode(secret: string, person: PersonName, request: AuthorizationRequest): Promise<string> {
  const jti = new Uint8Array(16);
  crypto.getRandomValues(jti);
  return signPayload(secret, {
    kind: "mcp-code",
    jti: base64url(jti),
    person,
    client: await clientKey(request.clientId),
    redirectUri: request.redirectUri,
    redirectGiven: request.redirectGiven,
    challenge: request.challenge,
    repo: request.repo,
    exp: now() + CODE_TTL_SECONDS,
  });
}

export async function readCode(
  secret: string,
  code: string,
): Promise<{
  jti: string;
  person: PersonName;
  client: string;
  redirectUri: string;
  redirectGiven: boolean;
  challenge: string;
  repo: string;
} | null> {
  const p = await read(secret, code, "mcp-code");
  const person = typeof p?.person === "string" ? personFromLogin(p.person) : null;
  if (
    p === null ||
    person === null ||
    typeof p.jti !== "string" ||
    typeof p.client !== "string" ||
    typeof p.redirectUri !== "string" ||
    typeof p.redirectGiven !== "boolean" ||
    typeof p.challenge !== "string" ||
    typeof p.repo !== "string"
  ) {
    return null;
  }
  return {
    jti: p.jti,
    person,
    client: p.client,
    redirectUri: p.redirectUri,
    redirectGiven: p.redirectGiven,
    challenge: p.challenge,
    repo: p.repo,
  };
}

/** Whether `verifier` is the PKCE verifier of S256 `challenge` (RFC 7636). */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest)) === challenge;
}

/** An access token for `person` on the Channel of `repo`, under `grant`, whose MCP endpoint is `audience`. */
export function signAccess(
  secret: string,
  person: PersonName,
  repo: string,
  grant: string,
  audience: string,
): Promise<string> {
  const iat = now();
  return signPayload(secret, {
    kind: "mcp-access",
    sub: person,
    repo,
    grant,
    aud: audience,
    scope: MCP_SCOPE,
    iat,
    exp: iat + ACCESS_TTL_SECONDS,
  });
}

export async function readAccess(secret: string, token: string): Promise<AccessGrant | null> {
  const p = await read(secret, token, "mcp-access");
  const person = typeof p?.sub === "string" ? personFromLogin(p.sub) : null;
  if (
    p === null ||
    person === null ||
    typeof p.repo !== "string" ||
    typeof p.grant !== "string" ||
    p.scope !== MCP_SCOPE
  ) {
    return null;
  }
  return { person, repo: p.repo, scope: p.scope, grant: p.grant };
}

export function signRefresh(secret: string, grant: RefreshGrant): Promise<string> {
  return signPayload(secret, {
    kind: "mcp-refresh",
    sub: grant.person,
    repo: grant.repo,
    client: grant.client,
    grant: grant.grant,
    gen: grant.generation,
    exp: now() + REFRESH_TTL_SECONDS,
  });
}

export async function readRefresh(secret: string, token: string): Promise<RefreshGrant | null> {
  const p = await read(secret, token, "mcp-refresh");
  const person = typeof p?.sub === "string" ? personFromLogin(p.sub) : null;
  if (
    p === null ||
    person === null ||
    typeof p.repo !== "string" ||
    typeof p.client !== "string" ||
    typeof p.grant !== "string" ||
    typeof p.gen !== "number"
  ) {
    return null;
  }
  return { person, repo: p.repo, client: p.client, grant: p.grant, generation: p.gen };
}

/** When a refresh token issued now stops working, in milliseconds, as its grant keeps it. */
export function refreshExpiresAt(): number {
  return (now() + REFRESH_TTL_SECONDS) * 1000;
}
