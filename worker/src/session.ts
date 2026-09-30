// Switchboard's own credentials (ADR 0007), minted after GitHub sign-in:
//
// - A Person session: `v1.<payload>.<signature>`, an HMAC-SHA256 over the payload
//   with SESSION_SECRET. The payload names the GitHub login and when the session
//   expires. It is stateless: a Person who loses write access is refused by the
//   Channel's membership check, not by revoking the session.
// - An Agent token: `sba_` and 32 random bytes. The Channel stores only its
//   SHA-256, bound to one Agent, and deletes it when the Agent goes Gone.

import type { PersonName } from "../../shared/src/index";
import { AGENT_TOKEN_PREFIX, personFromLogin } from "../../shared/src/index";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** How long a Person session lasts. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Sessions minted by the dev-only fake sign-in when SESSION_SECRET is not set (`wrangler dev` only). */
export const DEV_SESSION_SECRET = "switchboard-dev-only-session-secret-never-in-production";

/** The shortest SESSION_SECRET the Worker accepts. */
export const MIN_SESSION_SECRET_LENGTH = 32;

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Signs `payload` (any JSON) as `v1.<payload>.<signature>`. */
export async function signPayload(secret: string, payload: unknown): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`v1.${body}`));
  return `v1.${body}.${base64url(new Uint8Array(mac))}`;
}

/** The payload of a token `signPayload` made with `secret`, or null when the signature does not match. */
export async function verifyPayload(secret: string, token: string): Promise<Record<string, unknown> | null> {
  const [version, body, signature, ...extra] = token.split(".");
  if (version !== "v1" || body === undefined || signature === undefined || extra.length > 0) return null;
  const mac = fromBase64url(signature);
  const bytes = fromBase64url(body);
  if (mac === null || bytes === null) return null;
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), mac, encoder.encode(`v1.${body}`));
  if (!valid) return null;
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A Person session for GitHub login `login`. */
export function signSession(secret: string, login: PersonName, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  return signPayload(secret, { kind: "session", sub: login, iat, exp: iat + SESSION_TTL_SECONDS });
}

/** The Person a session belongs to, or null when it is forged, malformed or expired. */
export async function verifySession(secret: string, token: string, now = Date.now()): Promise<PersonName | null> {
  const payload = await verifyPayload(secret, token);
  if (payload === null || payload.kind !== "session") return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  return typeof payload.sub === "string" ? personFromLogin(payload.sub) : null;
}

/** A new Agent token. Only its hash is ever stored. */
export function newAgentToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${AGENT_TOKEN_PREFIX}${base64url(bytes)}`;
}

/** The SHA-256 of a token, hex, as the Channel stores it. */
export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
