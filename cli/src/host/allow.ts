// A change to who may use this Host, sent from the owner's Dashboard (ADR 0028). The
// Channel only carries it. This machine applies it only when the browser's attach key
// (ADR 0021) signed it, the key is on this machine's attach.json for the Host's own
// Person, and the change is fresh and new: so a stolen session, or the Channel itself,
// cannot widen a Host (ADR 0017).

import { webcrypto } from "node:crypto";
import {
  attachKeyFingerprint,
  channelKey,
  fromBase64,
  HOST_ALLOW_FRESH_MS,
  LOGIN_PATTERN,
  MAX_HOST_ALLOW,
  signedAllowChange,
} from "../../../shared/src/index";
import type { AttachList } from "../terminal/attach-keys";

export interface AllowContext {
  /** The Host's own Person: only their keys count. */
  owner: string;
  /** The Host's name, and the Channel's repo as `host install` recorded it. */
  host: string;
  repo: string;
  list: AttachList;
  now: number;
  /** The newest `seq` applied per key fingerprint, kept by the caller. */
  seqs: Map<string, number>;
}

export type AllowCheck =
  | { ok: true; allow: string[]; allowChannel: boolean; fingerprint: string }
  | { ok: false; reason: string };

/** Checks a `host.allow` frame as it came off the socket, and says why not when it fails. */
export async function checkAllowChange(frame: Record<string, unknown>, context: AllowContext): Promise<AllowCheck> {
  const { allow, allowChannel, key, at, seq, sig } = frame;
  if (
    !Array.isArray(allow) ||
    allow.length > MAX_HOST_ALLOW ||
    !allow.every((l): l is string => typeof l === "string" && LOGIN_PATTERN.test(l)) ||
    typeof allowChannel !== "boolean" ||
    typeof key !== "string" ||
    typeof sig !== "string" ||
    !Number.isSafeInteger(at) ||
    !Number.isSafeInteger(seq)
  ) {
    return { ok: false, reason: "the change is malformed" };
  }
  const spki = fromBase64(key);
  const signature = fromBase64(sig);
  if (spki === null || signature === null) return { ok: false, reason: "the key or signature is not base64" };
  const fingerprint = await attachKeyFingerprint(spki);
  const repo = channelKey(context.repo) ?? context.repo;
  const trusted = context.list.keys.some(
    (k) =>
      k.fingerprint === fingerprint &&
      k.person === context.owner &&
      k.agent === undefined &&
      (k.repo === undefined || k.repo === repo),
  );
  if (!trusted) {
    return {
      ok: false,
      reason: `this browser's key ${fingerprint} is not trusted on this machine. Run \`switchboard attach allow ${fingerprint}\` here, then try again`,
    };
  }
  const age = Math.abs(context.now - (at as number));
  if (age > HOST_ALLOW_FRESH_MS) return { ok: false, reason: "the change is too old (or this machine's clock is off)" };
  const message = signedAllowChange(repo, context.host, at as number, seq as number, allow, allowChannel);
  if (!(await verifies(spki, signature, message))) return { ok: false, reason: "the signature does not match" };
  if ((seq as number) <= (context.seqs.get(fingerprint) ?? -1))
    return { ok: false, reason: "that change was used already" };
  context.seqs.set(fingerprint, seq as number);
  return { ok: true, allow: [...new Set(allow)].filter((l) => l !== context.owner).sort(), allowChannel, fingerprint };
}

async function verifies(
  spki: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
  message: string,
): Promise<boolean> {
  try {
    const key = await webcrypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    return await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}
