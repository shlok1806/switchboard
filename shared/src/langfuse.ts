// A Channel's Langfuse project (ADR 0044): the repo's own Langfuse, which the
// Connector's costs tool reads live. The Channel's owner connects it with the project's
// host and its public and secret keys. The secret key is write-only: no route returns
// it, and what the Dashboard reads back is the host, the public key's last 4 characters
// and the project's name.

import type { PersonName } from "./domain";

export const LANGFUSE_SETTINGS_PATH = "/api/settings/langfuse";

/** Langfuse Cloud's regions, as its docs name them. Any other https host is a self-hosted Langfuse. */
export const LANGFUSE_CLOUD_HOSTS: readonly { host: string; label: string }[] = [
  { host: "https://cloud.langfuse.com", label: "Langfuse Cloud, EU" },
  { host: "https://us.cloud.langfuse.com", label: "Langfuse Cloud, US" },
  { host: "https://hipaa.cloud.langfuse.com", label: "Langfuse Cloud, HIPAA" },
];

/** How many characters of the public key are shown once it is saved. */
export const LANGFUSE_KEY_END = 4;
const MAX_HOST_LENGTH = 200;
const MAX_KEY_LENGTH = 200;

/** A connected project as anyone on the Channel may see it: never its secret key. */
export interface LangfuseConnection {
  /** The Langfuse host, such as `https://cloud.langfuse.com`. */
  host: string;
  /** The public key's last 4 characters. */
  publicKeyEnd: string;
  /** The project the keys belong to, as Langfuse named it when it was connected. */
  project: { id: string; name: string };
  connectedBy: PersonName;
  connectedAt: string;
}

/** `GET /api/settings/langfuse`. `canManage` is true for the Channel's owner, who may connect, replace and remove it. */
export interface LangfuseSettingsResponse {
  langfuse: LangfuseConnection | null;
  canManage: boolean;
}

/** `PUT /api/settings/langfuse`: connects a project, or replaces the one connected. */
export interface ConnectLangfuseRequest {
  host: string;
  publicKey: string;
  secretKey: string;
}

/**
 * A Langfuse host as the Channel keeps it: an https origin, with the path a self-hosted
 * Langfuse may sit under, and no trailing slash. Plain http only for this machine.
 */
export function cleanLangfuseHost(raw: string): string | null {
  if (raw.length > MAX_HOST_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The body of a connect, checked: a host and a key pair shaped as Langfuse issues them. */
export function cleanLangfuseConnect(
  body: Record<string, unknown>,
): { ok: true; connect: ConnectLangfuseRequest } | { ok: false; reason: string } {
  const { host, publicKey, secretKey } = body;
  if (typeof host !== "string" || typeof publicKey !== "string" || typeof secretKey !== "string") {
    return { ok: false, reason: 'A Langfuse project needs "host", "publicKey" and "secretKey".' };
  }
  const cleanHost = cleanLangfuseHost(host);
  if (cleanHost === null) {
    return {
      ok: false,
      reason: "The host must be an https address such as https://cloud.langfuse.com, with no query or credentials.",
    };
  }
  const pk = publicKey.trim();
  const sk = secretKey.trim();
  const keyShape = /^[\x21-\x7e]+$/;
  if (!pk.startsWith("pk-lf-") || pk.length > MAX_KEY_LENGTH || !keyShape.test(pk)) {
    return { ok: false, reason: 'The public key is the one that starts with "pk-lf-".' };
  }
  if (!sk.startsWith("sk-lf-") || sk.length > MAX_KEY_LENGTH || !keyShape.test(sk)) {
    return { ok: false, reason: 'The secret key is the one that starts with "sk-lf-".' };
  }
  return { ok: true, connect: { host: cleanHost, publicKey: pk, secretKey: sk } };
}
