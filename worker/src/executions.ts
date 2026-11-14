import type { AgentConstraints, ExecutionCredentialMetadata } from "../../shared/src/m1";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export async function secretDigest(secret: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
}
/** Fixed-size digest comparison; no early exits based on secret bytes. */
export function equalDigest(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) return false;
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}
export function parseCredential(value: string) {
  const parts = value.split(".");
  const [, organizationId = "", credentialId = "", secret = ""] = parts;
  if (parts.length !== 4 || parts[0] !== "m1" || !UUID.test(organizationId) || !UUID.test(credentialId)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  const bytes = Uint8Array.from(atob(`${secret.replaceAll("-", "+").replaceAll("_", "/")}=`), (c) => c.charCodeAt(0));
  if (bytes.length !== 32 || encode(bytes) !== secret) return null;
  return { organizationId, credentialId, secret };
}
export async function prepareCredential(organizationId: string) {
  const id = crypto.randomUUID();
  const secret = encode(crypto.getRandomValues(new Uint8Array(32)));
  return { id, digest: Array.from(await secretDigest(secret)), token: `m1.${organizationId}.${id}.${secret}` };
}
export function credentialExpiry(now: number, lifetime: number | undefined, grantExpiry: number): number | null {
  const duration = lifetime ?? HOUR;
  if (
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    duration > DAY ||
    !Number.isSafeInteger(grantExpiry) ||
    grantExpiry <= now
  )
    return null;
  return Math.min(now + duration, grantExpiry);
}
export function validConstraints(value: AgentConstraints): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => key === "actions") &&
    (value.actions === undefined || (Array.isArray(value.actions) && value.actions.every((a) => typeof a === "string")))
  );
}
export interface StoredCredential extends ExecutionCredentialMetadata {
  digest: number[];
}
