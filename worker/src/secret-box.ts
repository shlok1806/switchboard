// Sealing a Channel's secret at rest (ADR 0044): AES-256-GCM under a key derived from
// SESSION_SECRET with HKDF-SHA256, one key per purpose. The Channel's repo is the
// additional data, so a sealed value copied into another Channel's row does not open.
// A sealed value is `v1.<iv>.<ciphertext>`, both base64url.
//
// Rotating SESSION_SECRET makes every sealed value unreadable: its owner connects again.

import { base64url, fromBase64url } from "./session";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function boxKey(secret: string, purpose: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("switchboard secret box"), info: encoder.encode(purpose) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** `plain`, sealed for `purpose` in the Channel of `repo`. */
export async function seal(secret: string, purpose: string, repo: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(repo) },
    await boxKey(secret, purpose),
    encoder.encode(plain),
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

/** What `seal` sealed, or null when it was sealed with another secret, purpose or repo, or was changed. */
export async function open(secret: string, purpose: string, repo: string, sealed: string): Promise<string | null> {
  const [version, ivText, bodyText, ...extra] = sealed.split(".");
  if (version !== "v1" || ivText === undefined || bodyText === undefined || extra.length > 0) return null;
  const iv = fromBase64url(ivText);
  const body = fromBase64url(bodyText);
  if (iv === null || body === null) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(repo) },
      await boxKey(secret, purpose),
      body,
    );
    return decoder.decode(plain);
  } catch {
    return null;
  }
}
