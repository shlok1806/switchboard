// The secret check a shared skill must pass (ADR 0050), on the laptop before a skill
// leaves it and again on the Channel. It refuses a file only for a value that looks
// like a real credential:
//
// - a token in a format the masker knows (mask.ts: GitHub, Anthropic, OpenAI, AWS
//   access keys, private key blocks and the rest), unless it is a placeholder; or
// - a long, high-entropy value given to a secret-sounding name (`API_KEY=...`).
//
// Placeholders, references and identifiers are not credentials: `...`, `my-key`,
// `required`, an ARN, a path, `$TOKEN`, `process.env.TOKEN`, `crypto.randomUUID()`, and
// AWS's documented example keys. The masker (mask.ts) stays as eager as it is: a live
// terminal screen must lose anything that may be a secret, a skill only what is one.

import { SECRET_FORMATS, secretName } from "./mask";

/** A credential found in a file: what it looks like, and the line it is on (from 1). */
export interface SecretFound {
  kind: string;
  line: number;
}

/**
 * Parts of a value that say it is a stand-in: `xxxx`, `...`, `****`, `<token>`, `{{ key }}`,
 * and the words docs use for one. AWS's documented example keys end in EXAMPLE.
 */
const PLACEHOLDER =
  /x{4,}|X{4,}|0{8,}|\.\.\.|…|\*{3,}|<[^>]*>|\{\{|\}\}|\$\{|example|placeholder|your[-_ ]?|redacted|dummy|sample|changeme|replace[-_]?me|fake|insert|token[-_]?here|key[-_]?here/i;

/** Values that point at a secret instead of holding it: env references, paths, ARNs, URLs, calls. */
const REFERENCE =
  /^(?:\$|%|&|@|#|\/|\.\.?\/|~\/|arn:|https?:\/\/|file:|process\.|os\.|env\.|import\.meta|secrets\.|vars\.|ssm:|resolve:)|\(|\$\{/i;

/** Bits of entropy per character, over the characters `value` uses. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether `value` is made of words and short numbers (`my-app-key-2024`, `/myapp/api-key`), as a name is. */
function wordy(value: string): boolean {
  const parts = value.split(/[-_./:+=,|]+/).filter((part) => part !== "");
  return parts.length > 0 && parts.every((part) => /^(?:[A-Za-z][a-z]*|[A-Z]+|\d{1,8})$/.test(part));
}

/**
 * Whether a value given to a secret-sounding name looks like a real credential: at least
 * 20 characters with no space, letters and digits mixed, high entropy (3.2 bits a
 * character, or 2.8 for hex), and none of a
 * placeholder, a reference or a name made of words.
 */
export function credentialValue(value: string): boolean {
  if (value.length < 20 || value.length > 4096 || /\s/.test(value)) return false;
  if (PLACEHOLDER.test(value) || REFERENCE.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;
  if (wordy(value)) return false;
  // An expression in code: `a ? b : c`, `x || y`.
  if (/[?|&!]/.test(value)) return false;
  if (encodedText(value)) return false;
  // A dotted identifier names a value in code: `crypto5.default.bytes`, `option2.name`.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false;
  // A run of one character, or a short pattern repeated, is a stand-in.
  if (new Set(value).size < 10) return false;
  // Random hex has 16 symbols to draw on, so less entropy per character than random base64.
  return /^[0-9a-f-]+$/i.test(value) ? entropy(value) >= 2.8 : entropy(value) >= 3.2;
}

/**
 * Whether `value` is base64 of plain text, as a sample nonce (`dGhlIHNhbXBsZSBub25jZQ`, "the
 * sample nonce") or a paging token (`eyJvZmZzZXQiOjEwMH0=`) is. Random bytes, as a key is, decode to binary.
 */
function encodedText(value: string): boolean {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  let decoded: string;
  try {
    decoded = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return false;
  }
  if (decoded.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i);
    if ((code >= 0x20 && code < 0x7f) || code === 0x0a || code === 0x09) printable += 1;
  }
  return printable / decoded.length >= 0.95;
}

/** Whether a token the masker's formats matched is a stand-in rather than a credential. */
function placeholderToken(match: string): boolean {
  // The prefix that names the format (`ghp_`, `sk-ant-`, `AKIA`) says nothing; the rest does.
  const rest = match.replace(
    /^(?:sk-ant-|sk-|[sr]k_(?:live|test)_|gh[pousr]_|github_pat_|AKIA|ASIA|xox[abeposr]-|eyJ)/,
    "",
  );
  return PLACEHOLDER.test(rest) || new Set(rest).size < 8;
}

/** Whether a private key block holds a key: a body of base64 long enough to be one, not `...`. */
function realKeyBlock(block: string): boolean {
  const body = block
    .replace(/-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/g, "")
    .replace(/\\[nrt]/g, "")
    .replace(/\s+/g, "");
  return body.length >= 64 && !PLACEHOLDER.test(body) && /^[A-Za-z0-9+/=:,-]+$/.test(body);
}

/**
 * `name = value`, `name: value`, `"name": "value"`, `name := value`, `name => value`, but
 * not a comparison (`==`). The value is double, single or back quoted, or bare up to a
 * space or punctuation; a bare value right before `(` is a call.
 */
const ASSIGNMENT =
  /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_.-]{0,127})\\?["']?[ \t]*(?:=>|:=|=(?!=)|:)[ \t]*(?:\\?"([^"\\\n]*)\\?"|'([^'\\\n]*)'|`([^`\n]*)`|([^\s"'`\\,;{}()[\]<>=]+)(?![(\w]))/g;

/** The last word of a name that says it holds something about a secret, not the secret: `keyId`, `s3KeyName`, `tokenLength`. */
const ABOUT_A_SECRET = new Set([
  "id",
  "ids",
  "name",
  "names",
  "path",
  "file",
  "length",
  "count",
  "size",
  "type",
  "code",
  "url",
  "uri",
  "arn",
  "header",
  "field",
  "prefix",
  "format",
  "expires",
  "expiry",
  "ttl",
  "endpoint",
  "region",
  "version",
  "usage",
]);

/** Words that make a token a position in a listing, not a credential: `nextToken`, `pageToken`. */
const PAGING = new Set(["next", "page", "pagination", "continuation", "cursor", "marker", "sync"]);

/** Whether `name` says it holds a secret itself: `API_KEY`, `clientSecret`, but not `keyId` or `nextToken`. */
function holdsSecret(name: string): boolean {
  if (!secretName(name)) return false;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-.]+/)
    .filter((word) => word !== "");
  return !ABOUT_A_SECRET.has(words.at(-1) ?? "") && !words.some((word) => PAGING.has(word));
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line += 1;
  return line;
}

/**
 * The first credential in `text`, or null. `formatsOnly` reads only the token formats:
 * for a binary file, read as Latin-1, where an assignment means nothing.
 */
export function findSecret(text: string, { formatsOnly = false }: { formatsOnly?: boolean } = {}): SecretFound | null {
  const first: { at: { kind: string; index: number } | null } = { at: null };
  const found = (kind: string, index: number) => {
    if (first.at === null || index < first.at.index) first.at = { kind, index };
  };
  for (const { kind, pattern } of SECRET_FORMATS) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const index = match.index ?? 0;
      if (first.at !== null && index >= first.at.index) break;
      const whole = match[0];
      if (
        kind === "a private key"
          ? !realKeyBlock(whole)
          : kind === "a password in a URL"
            ? !credentialValue(match[3] ?? "")
            : placeholderToken(whole)
      ) {
        continue;
      }
      found(kind, index);
      break;
    }
  }
  if (!formatsOnly) {
    for (const match of text.matchAll(ASSIGNMENT)) {
      const index = match.index ?? 0;
      if (first.at !== null && index >= first.at.index) break;
      const name = match[1] ?? "";
      const value = match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
      if (holdsSecret(name) && credentialValue(value)) {
        // Placed at the value's end, so a known token in it is named by its format instead.
        found(`a value given to ${name}`, index + match[0].length - 1);
        break;
      }
    }
  }
  const at = first.at;
  return at === null ? null : { kind: at.kind, line: lineAt(text, at.index) };
}
