// Secret masking for the Proxy Capture. It runs on the laptop, before a Proxy
// Event leaves it, in both Proxy modes. It is a pure function over text: it finds
// common key formats and env-style assignments, keeps the part that says what kind
// of secret it is (`sk-ant-`, `AKIA`, `GITHUB_TOKEN=`) and masks the rest.

import { AGENT_TOKEN_PREFIX } from "../../../shared/src/index";

/** What every masked value is replaced with. */
export const MASK = "****";

export interface Masked {
  text: string;
  /** How many secrets were masked. */
  count: number;
}

type Rule = { pattern: RegExp; replace: (match: string, ...groups: string[]) => string | null };

/** Keeps `prefix` and masks the rest. */
const keepPrefix = (prefix: string) => () => `${prefix}${MASK}`;

/** Words that mark a variable as holding a secret, as a whole part of its name. */
const SECRET_WORDS = new Set([
  "key",
  "keys",
  "apikey",
  "secret",
  "secrets",
  "token",
  "tokens",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
]);

/** Values in an assignment that are not secrets: numbers, booleans, placeholders, already masked. */
function harmlessValue(value: string): boolean {
  return (
    /^-?\d+(\.\d+)?$/.test(value) ||
    /^(true|false|null|none|undefined)$/i.test(value) ||
    value.startsWith("$") ||
    value.includes(MASK) ||
    value.length < 3
  );
}

/** Whether a variable name says it holds a secret: `FOO_KEY`, `SECRET`, `githubToken`, `DB_PASSWORD`. */
function secretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-.]+/);
  return words.some((word) => SECRET_WORDS.has(word));
}

/**
 * `pattern`, matched only where it starts a word. A JSON-escaped newline, tab or
 * carriage return (`\n`) counts as a word break too: a raw request body holds the
 * files an Agent read that way, so a key alone on its line follows an `n`.
 */
function token(pattern: RegExp): RegExp {
  return new RegExp(`(?:(?<![A-Za-z0-9_])|(?<=\\\\[nrt]))${pattern.source}`, "g");
}

const RULES: Rule[] = [
  // PEM private key blocks, whatever the key type. Newlines may be real or JSON-escaped.
  {
    pattern: /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
    replace: (_match, kind = "") => `-----BEGIN ${kind}PRIVATE KEY-----${MASK}-----END ${kind}PRIVATE KEY-----`,
  },
  // Anthropic, before OpenAI: both start with `sk-`.
  { pattern: token(/sk-ant-[A-Za-z0-9_-]{8,}/), replace: keepPrefix("sk-ant-") },
  // OpenAI, including project, service account and admin keys.
  {
    pattern: token(/sk-((?:proj|svcacct|admin)-)?[A-Za-z0-9_-]{20,}/),
    replace: (_match, kind = "") => `sk-${kind}${MASK}`,
  },
  // Stripe secret and restricted keys.
  {
    pattern: token(/([sr]k_(?:live|test)_)[A-Za-z0-9]{10,}/),
    replace: (_match, prefix = "") => `${prefix}${MASK}`,
  },
  // GitHub tokens: personal, OAuth, user-to-server, server-to-server, refresh, fine-grained.
  { pattern: token(/(gh[pousr]_)[A-Za-z0-9]{20,}/), replace: (_match, prefix = "") => `${prefix}${MASK}` },
  { pattern: token(/github_pat_[A-Za-z0-9_]{20,}/), replace: keepPrefix("github_pat_") },
  // AWS access key IDs (long-term and temporary).
  { pattern: token(/(AKIA|ASIA)[0-9A-Z]{16}\b/), replace: (_match, prefix = "") => `${prefix}${MASK}` },
  // Slack tokens: bot, user, app-level, refresh, legacy.
  {
    pattern: token(/(xox[abeposr]-)[A-Za-z0-9-]{10,}/),
    replace: (_match, prefix = "") => `${prefix}${MASK}`,
  },
  // Switchboard's own credentials (worker/src/session.ts), which an Agent can read from
  // its Person's config or its own session files. A Person session is `v1.`, a
  // base64url JSON payload and a base64url HMAC-SHA256 (43 characters); an Agent token
  // is the Agent token prefix and 32 random bytes in base64url (43 characters).
  {
    pattern: token(/v1\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/),
    replace: keepPrefix("v1."),
  },
  {
    pattern: token(new RegExp(`${AGENT_TOKEN_PREFIX}[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`)),
    replace: keepPrefix(AGENT_TOKEN_PREFIX),
  },
  // JWTs: three base64url parts, the first two JSON objects.
  {
    pattern: token(/eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/),
    replace: keepPrefix("eyJ"),
  },
];

/**
 * Env-style assignments: `FOO_KEY=value`, `export SECRET="value"`, `DB_PASSWORD: value`,
 * `"apiKey": "value"`. The name keeps; the value is masked. A backslash ends the value,
 * so JSON-escaped newlines (`\n`) do not run into the next line.
 */
const ASSIGNMENT =
  /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_.-]*)(\\?["']?[ \t]*[=:][ \t]*)(?:(\\?")([^"\\\n]*)\\?"|'([^'\\\n]*)'|([^\s"'\\,;{}()[\]]+))/g;

function maskAssignments(text: string): Masked {
  let count = 0;
  const out = text.replace(
    ASSIGNMENT,
    (
      match: string,
      name: string,
      separator: string,
      open?: string,
      double?: string,
      single?: string,
      bare?: string,
    ) => {
      const value = double || single || bare || "";
      const head = name.length + separator.length;
      const secret =
        secretName(name) &&
        !harmlessValue(value) &&
        // A colon (YAML, JSON) counts only after a quoted JSON key or a SHOUTING_NAME,
        // so prose like "the key: fix it" is left alone.
        (!separator.includes(":") || /^\\?["']/.test(separator) || /^[A-Z0-9_]+$/.test(name));
      if (!secret) {
        // Not a secret here, but its value may hold one: `"text":"DB_PASSWORD=..."`.
        const inner = maskAssignments(match.slice(head));
        count += inner.count;
        return match.slice(0, head) + inner.text;
      }
      count += 1;
      // Quotes are kept as they were, JSON-escaped (`\"`) or not.
      const quote = open ? open : single !== undefined ? "'" : "";
      return `${match.slice(0, head)}${quote}${MASK}${quote}`;
    },
  );
  return { text: out, count };
}

/** Masks every detected secret in `text`. */
export function maskSecrets(text: string): Masked {
  let count = 0;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      // The callback gets the groups, then the offset and the whole string (no named groups are used).
      const groups = rest.slice(0, -2).map((g) => (typeof g === "string" ? g : ""));
      const replaced = rule.replace(match, ...groups);
      if (replaced === null || replaced === match) return match;
      count += 1;
      return replaced;
    });
  }
  const assignments = maskAssignments(out);
  return { text: assignments.text, count: count + assignments.count };
}
