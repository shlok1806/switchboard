// The check every keystroke from the Channel passes before it reaches the session
// (ADR 0021). The Channel is not trusted here: a frame passes only when a key this
// machine's Person allowed signed it, for this Agent and this run of the wrapper, with a
// sequence number it has not used.

import { webcrypto } from "node:crypto";
import {
  attachKeyFingerprint,
  fromBase64,
  signedInput,
  TERMINAL_INPUT_MAX,
  type TerminalInputFrame,
} from "../../../shared/src/index";
import type { AttachList } from "./attach-keys";

export type GateResult =
  | { ok: true; text: string; person: string; fingerprint: string; first: boolean }
  | { ok: false; fingerprint: string; reason: string };

export interface GateOptions {
  /** The Person who runs this wrapper: their keys are the owner's keys. */
  owner: string;
  agent: () => string | null;
  /** This run's nonce, sent in every screen frame. */
  nonce: string;
  /** The allow list, read again for each frame so a revoke takes effect at once. */
  list: () => Promise<AttachList>;
  /** Whether the CLI shows a permission dialog now. */
  promptOpen: () => boolean;
}

export class AttachGate {
  private readonly seqs = new Map<string, number>();
  private readonly typed = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: GateOptions) {}

  /** Checks frames one at a time, in the order they came, so typed text keeps its order. */
  check(frame: TerminalInputFrame): Promise<GateResult> {
    const result = this.queue.then(() => this.checkOne(frame));
    this.queue = result.catch(() => {});
    return result;
  }

  private async checkOne(frame: TerminalInputFrame): Promise<GateResult> {
    const spki = fromBase64(frame.key);
    const fingerprint = spki === null ? "" : await attachKeyFingerprint(spki);
    const refuse = (reason: string): GateResult => ({ ok: false, fingerprint, reason });
    const agent = this.options.agent();
    if (agent === null || frame.agent !== agent) return refuse("this wrapper does not run that Agent");
    if (spki === null) return refuse("the key is not base64");
    if (typeof frame.text !== "string" || frame.text.length === 0 || frame.text.length > TERMINAL_INPUT_MAX)
      return refuse(`input is 1 to ${TERMINAL_INPUT_MAX} characters`);
    if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) return refuse("bad sequence number");

    let list: AttachList;
    try {
      list = await this.options.list();
    } catch (error) {
      return refuse(`the allow list could not be read: ${(error as Error).message}`);
    }
    const allowed = list.keys.find(
      (k) => k.fingerprint === fingerprint && (k.agent === undefined || k.agent === agent),
    );
    if (!allowed) return refuse(`key ${fingerprint} is not allowed to type into ${agent}`);

    const signature = typeof frame.sig === "string" ? fromBase64(frame.sig) : null;
    if (
      signature === null ||
      !(await verify(spki, signature, signedInput(agent, this.options.nonce, frame.seq, frame.text)))
    )
      return refuse("the signature does not match");

    const last = this.seqs.get(fingerprint) ?? -1;
    if (frame.seq <= last) return refuse("a sequence number already used");

    const owner = allowed.person === this.options.owner;
    if (!owner && !list.attachersAnswerPrompts && this.options.promptOpen())
      return refuse("a permission prompt is open, and only its owner answers prompts here");

    this.seqs.set(fingerprint, frame.seq);
    const first = !this.typed.has(fingerprint);
    this.typed.add(fingerprint);
    return { ok: true, text: frame.text, person: allowed.person, fingerprint, first };
  }
}

async function verify(
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
