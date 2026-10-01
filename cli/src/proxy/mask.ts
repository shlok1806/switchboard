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
 * `pattern`, matched only where it starts a word: not right after a letter or digit.
 * What the proxy reads also puts a token right after these, which end in one:
 * - JSON escapes, as a raw request body holds the files an Agent read: `\n`, `\t`,
 *   `\r`, `\f`, `\b`, `"`;
 * - an ANSI color from terminal output, raw (`ESC[31m`) or JSON-escaped (`\u001b[31m`);
 * - URL encoding: `%22`, `%3D`, `%20`.
 * An identifier's `_` counts as a break too (`MY_ghp_...`).
 */
function token(pattern: RegExp): RegExp {
  return new RegExp(
    "(?:(?<![A-Za-z0-9])|(?<=\\\\[nrtfb])|(?<=\\\\u00[0-9a-fA-F]{2})|(?<=\\x1b\\[[0-9;]*m)|(?<=\\\\u001[bB]\\[[0-9;]*m)|(?<=%[0-9A-Fa-f]{2}))" +
      pattern.source,
    "g",
  );
}

const RULES: Rule[] = [
  // PEM private key blocks, whatever the key type. Newlines may be real or JSON-escaped.
  // A block is at most 16 KB (an 8192-bit RSA key is about 6.5 KB) and holds no other
  // BEGIN, so a BEGIN with no END looks ahead only that far, and no text is read twice.
  {
    pattern:
      /-----BEGIN ([A-Z0-9 ]{0,40})PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S]){0,16384}?-----END \1PRIVATE KEY-----/g,
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
  // is the Agent token prefix and 32 random bytes in base64url (43 characters). Their
  // exact shape names them, so they are masked wherever they start, whatever is before.
  {
    pattern: /v1\.eyJ[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
    replace: keepPrefix("v1."),
  },
  {
    pattern: new RegExp(`${AGENT_TOKEN_PREFIX}[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`, "g"),
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
const NAME = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_.-]{0,127})(\\?["']?[ \t]*[=:][ \t]*)/g;
/** The value right after a name: double-quoted (JSON-escaped or not), single-quoted, or bare. */
const VALUE = /(?:(\\?")([^"\\\n]*)\\?"|'([^'\\\n]*)'|([^\s"'\\,;{}()[\]]+))/y;

/**
 * Masks the values of secret assignments, in one pass. Each position costs a bounded
 * amount: a name is at most 128 characters (a long dotted or dashed blob could start
 * one after every `.` or `-`), and a value is read only after a secret name, then
 * skipped. Anything else is looked through, so an assignment inside another's value
 * is found too (`"text":"DB_PASSWORD=..."`).
 */
function maskAssignments(text: string): Masked {
  let count = 0;
  let out = "";
  let from = 0;
  const names = new RegExp(NAME.source, "g");
  const values = new RegExp(VALUE.source, "y");
  for (let found = names.exec(text); found !== null; found = names.exec(text)) {
    const [, name = "", separator = ""] = found;
    // A colon (YAML, JSON) counts only after a quoted JSON key or a SHOUTING_NAME,
    // so prose like "the key: fix it" is left alone.
    const named =
      secretName(name) && (!separator.includes(":") || /^\\?["']/.test(separator) || /^[A-Z0-9_]+$/.test(name));
    if (!named) continue;
    values.lastIndex = names.lastIndex;
    const valued = values.exec(text);
    if (!valued) continue;
    const [, open, double, single, bare] = valued;
    if (harmlessValue(double || single || bare || "")) continue;
    count += 1;
    // Quotes are kept as they were, JSON-escaped (`\"`) or not.
    const quote = open ? open : single !== undefined ? "'" : "";
    out += `${text.slice(from, names.lastIndex)}${quote}${MASK}${quote}`;
    from = values.lastIndex;
    names.lastIndex = values.lastIndex;
  }
  return { text: out + text.slice(from), count };
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
