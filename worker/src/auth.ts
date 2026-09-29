// Interim identity (issue #1): one shared join secret, and each Person picks
// their own name. Every call carries both; see JoinCredentials in shared/.

import type { PersonName } from "../../shared/src/index";
import { normalizePersonName } from "../../shared/src/index";

const encoder = new TextEncoder();

/** Constant-time comparison of two strings of any length. */
async function secretsMatch(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export type AuthResult = { ok: true; person: PersonName } | { ok: false; status: 400 | 401; reason: string };

/**
 * Reads the join secret and Person name from the headers, or, for WebSocket
 * upgrades (browsers cannot set headers on those), from the query string.
 */
export async function authenticate(request: Request, url: URL, joinSecret: string): Promise<AuthResult> {
  const header = request.headers.get("Authorization");
  const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  const secret = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : isUpgrade
      ? url.searchParams.get("secret")
      : null;
  const rawName = request.headers.get("X-Switchboard-Person") ?? (isUpgrade ? url.searchParams.get("person") : null);

  if (secret === null || !(await secretsMatch(secret, joinSecret))) {
    return { ok: false, status: 401, reason: "Wrong join secret." };
  }
  const person = rawName === null ? null : normalizePersonName(rawName);
  if (person === null) {
    return {
      ok: false,
      status: 400,
      reason: "Pick a name of 1 to 32 characters: letters, digits, '-' or '_', starting with a letter or digit.",
    };
  }
  return { ok: true, person };
}
