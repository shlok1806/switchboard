// Secret masking: a pure function at the Proxy boundary. Each row is a sample the
// laptop might send, and what may leave it.

import { describe, expect, it } from "vitest";
import { maskSecrets } from "../src/proxy/mask";

const ANTHROPIC = "sk-ant-api03-Q2x9vR7kLmN4pT8wZ1yB6cD3fG5hJ0aE-xYzAbCdEfGh";
const OPENAI = "sk-Tq8Zx3Lm9Vn2Bc7Kd4Hf1Js6Pw0Rt5Yg";
const OPENAI_PROJECT = "sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB",
  "aFDrBz9vFqU4yT0h3u8f1FfJk2cpHtHgk9hUQJcoVoZsAuHPR4c9hK9FzNnPaS8Z",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
// Switchboard's own credentials, shaped the way worker/src/session.ts mints them: a
// Person session `v1.<base64url JSON payload>.<base64url HMAC-SHA256>`, and an Agent
// token `sba_` and 32 random bytes in base64url.
const SESSION = `v1.${Buffer.from(
  JSON.stringify({ kind: "session", sub: "octocat", iat: 1790000000, exp: 1792592000 }),
).toString("base64url")}.${Buffer.alloc(32, 7).toString("base64url")}`;
const AGENT_TOKEN = `sba_${Buffer.alloc(32, 9).toString("base64url")}`;

const cases: { name: string; input: string; output: string; count: number }[] = [
  { name: "Anthropic key", input: `key ${ANTHROPIC} here`, output: "key sk-ant-**** here", count: 1 },
  { name: "OpenAI key", input: `use ${OPENAI}`, output: "use sk-****", count: 1 },
  { name: "OpenAI project key", input: OPENAI_PROJECT, output: "sk-proj-****", count: 1 },
  { name: "GitHub classic token", input: "ghp_1234567890abcdefghijABCDEFGHIJ123456", output: "ghp_****", count: 1 },
  { name: "GitHub OAuth token", input: "gho_1234567890abcdefghijABCDEFGHIJ123456", output: "gho_****", count: 1 },
  {
    name: "GitHub fine-grained token",
    input: "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789",
    output: "github_pat_****",
    count: 1,
  },
  { name: "AWS access key ID", input: "id AKIAIOSFODNN7EXAMPLE end", output: "id AKIA**** end", count: 1 },
  { name: "AWS temporary key ID", input: "ASIAY34FZKBOKMUTVV7A", output: "ASIA****", count: 1 },
  { name: "Slack bot token", input: "xoxb-123456789012-1234567890123-AbCdEfGhIjKl", output: "xoxb-****", count: 1 },
  { name: "Slack user token", input: "xoxp-123456789012-abcdefghij", output: "xoxp-****", count: 1 },
  { name: "Stripe live key", input: "sk_live_51H8abcdefghijklmnopqrstuv", output: "sk_live_****", count: 1 },
  { name: "Stripe restricted key", input: "rk_live_51H8abcdefghijklmnop", output: "rk_live_****", count: 1 },
  { name: "JWT", input: `Bearer ${JWT}`, output: "Bearer eyJ****", count: 1 },
  {
    name: "PEM private key block",
    input: `before\n${PEM}\nafter`,
    output: "before\n-----BEGIN RSA PRIVATE KEY-----****-----END RSA PRIVATE KEY-----\nafter",
    count: 1,
  },
  {
    name: "PEM block with JSON-escaped newlines",
    input: JSON.stringify(PEM).slice(1, -1),
    output: "-----BEGIN RSA PRIVATE KEY-----****-----END RSA PRIVATE KEY-----",
    count: 1,
  },
  { name: "env line ending in _KEY", input: "FOO_KEY=abc123def456", output: "FOO_KEY=****", count: 1 },
  { name: "env line SECRET", input: "SECRET=hunter2hunter2", output: "SECRET=****", count: 1 },
  {
    name: "env line with TOKEN",
    input: "export GITHUB_TOKEN=somevalue99",
    output: "export GITHUB_TOKEN=****",
    count: 1,
  },
  { name: "env line PASSWORD, quoted", input: 'DB_PASSWORD="p@ss word"', output: 'DB_PASSWORD="****"', count: 1 },
  {
    name: "env lines inside a JSON request body",
    input: JSON.stringify({ content: 'cat .env\nDB_PASSWORD="p@ss word"\nSTRIPE_KEY=abc123def\nPORT=1' }),
    output: JSON.stringify({ content: 'cat .env\nDB_PASSWORD="****"\nSTRIPE_KEY=****\nPORT=1' }),
    count: 2,
  },
  {
    name: "an env line inside a JSON string value",
    input: '{"type":"text_delta","text":"DB_PASSWORD=hunter2hunter2"}',
    output: '{"type":"text_delta","text":"DB_PASSWORD=****"}',
    count: 1,
  },
  { name: "YAML-style secret", input: "API_SECRET: s3cr3tvalue", output: "API_SECRET: ****", count: 1 },
  { name: "JSON key holding a secret", input: '{"apiKey": "abcdef123456"}', output: '{"apiKey": "****"}', count: 1 },
  {
    name: "a key inside an env line is masked once",
    input: `ANTHROPIC_API_KEY=${ANTHROPIC}`,
    output: "ANTHROPIC_API_KEY=sk-ant-****",
    count: 1,
  },
  {
    name: "several secrets on several lines",
    input: `OPENAI_API_KEY=${OPENAI}\nAWS=AKIAIOSFODNN7EXAMPLE\nPORT=8080`,
    output: "OPENAI_API_KEY=sk-****\nAWS=AKIA****\nPORT=8080",
    count: 2,
  },
  {
    name: "Switchboard Person session in the CLI's config file",
    input: JSON.stringify({ url: "https://sb.example", repo: "o/r", session: SESSION, person: "octocat" }),
    output: JSON.stringify({ url: "https://sb.example", repo: "o/r", session: "v1.****", person: "octocat" }),
    count: 1,
  },
  { name: "Switchboard Agent token", input: `Bearer ${AGENT_TOKEN}`, output: "Bearer sba_****", count: 1 },
  {
    name: "Switchboard tokens after JSON-escaped newlines",
    input: JSON.stringify(`token:\n${AGENT_TOKEN}\n${SESSION}`).slice(1, -1),
    output: "token:\\nsba_****\\nv1.****",
    count: 2,
  },
  {
    name: "keys alone on their lines in a JSON-escaped file",
    input: JSON.stringify("cat keys\nghp_1234567890abcdefghijABCDEFGHIJ123456\n\tAKIAIOSFODNN7EXAMPLE").slice(1, -1),
    output: "cat keys\\nghp_****\\n\\tAKIA****",
    count: 2,
  },
  // Left alone.
  {
    name: "a key-like word inside another word",
    input: "xghp_1234567890abcdefghijABCDEFGHIJ",
    output: "xghp_1234567890abcdefghijABCDEFGHIJ",
    count: 0,
  },
  { name: "version numbers", input: "upgrade from v1.2.3 to v1.10", output: "upgrade from v1.2.3 to v1.10", count: 0 },
  {
    name: "v1. paths and hosts",
    input: "GET /api/v1.json via v1.example.com",
    output: "GET /api/v1.json via v1.example.com",
    count: 0,
  },
  {
    name: "a v1. string that is not a whole session",
    input: "v1.eyJhbGciOiJIUzI1NiJ9.short and v1.eyJ.x",
    output: "v1.eyJhbGciOiJIUzI1NiJ9.short and v1.eyJ.x",
    count: 0,
  },
  { name: "an sba_ word", input: "sba_config and sba_tooShort123", output: "sba_config and sba_tooShort123", count: 0 },
  {
    name: "plain prose",
    input: "The key idea is to keep tokens small.",
    output: "The key idea is to keep tokens small.",
    count: 0,
  },
  { name: "prose with a colon", input: "the token: refresh it later", output: "the token: refresh it later", count: 0 },
  { name: "numeric setting", input: "MAX_TOKENS=4096", output: "MAX_TOKENS=4096", count: 0 },
  { name: "token counts in JSON", input: '{"output_tokens":42}', output: '{"output_tokens":42}', count: 0 },
  { name: "boolean setting", input: "USE_SECRET=true", output: "USE_SECRET=true", count: 0 },
  { name: "shell variable reference", input: "TOKEN=$GITHUB_TOKEN", output: "TOKEN=$GITHUB_TOKEN", count: 0 },
  { name: "a name that only contains a secret word", input: "MONKEY=banana", output: "MONKEY=banana", count: 0 },
  { name: "an already masked value", input: "sk-ant-****", output: "sk-ant-****", count: 0 },
  { name: "a short sk- word", input: "sk-learn is a library", output: "sk-learn is a library", count: 0 },
];

describe("secret masking", () => {
  it.each(cases)("$name", ({ input, output, count }) => {
    expect(maskSecrets(input)).toEqual({ text: output, count });
  });

  it("is idempotent", () => {
    for (const { input } of cases) {
      const once = maskSecrets(input).text;
      expect(maskSecrets(once)).toEqual({ text: once, count: 0 });
    }
  });
});

describe("secret masking, right after escapes and encodings", () => {
  const GITHUB = "ghp_1234567890abcdefghijABCDEFGHIJ123456";
  const AWS = "AKIAIOSFODNN7EXAMPLE";
  const tokens: [string, string][] = [
    [ANTHROPIC, "sk-ant-****"],
    [OPENAI, "sk-****"],
    [GITHUB, "ghp_****"],
    [AWS, "AKIA****"],
    [JWT, "eyJ****"],
    [SESSION, "v1.****"],
    [AGENT_TOKEN, "sba_****"],
  ];
  // What can sit right before a token in what the proxy reads: JSON escapes, an ANSI
  // color from terminal output (raw or JSON-escaped), URL encoding, an identifier's `_`.
  const before = [
    "\\f",
    "\\b",
    "\\u0022",
    "\\u003d",
    "\x1b[31m",
    "\x1b[0;1m",
    "\\u001b[31m",
    "%22",
    "%3D",
    "%20",
    "%0A",
    "MY_",
  ];
  for (const prefix of before) {
    it(`masks a token right after ${JSON.stringify(prefix)}`, () => {
      for (const [token, masked] of tokens) {
        expect(maskSecrets(`x ${prefix}${token} y`), `${prefix}${token.slice(0, 8)}`).toEqual({
          text: `x ${prefix}${masked} y`,
          count: 1,
        });
      }
    });
  }

  it("leaves a key-like word that is part of another word", () => {
    for (const text of [
      "xghp_1234567890abcdefghijABCDEFGHIJ",
      "desk-booking-application-service-v2",
      "the risk-adjusted-return-calculation-module",
      "FAKIAIOSFODNN7EXAMPLE",
      "seyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefgh",
    ]) {
      expect(maskSecrets(text)).toEqual({ text, count: 0 });
    }
  });
});

describe("secret masking time", () => {
  /** Masks `text`, and how long it took, in ms. */
  function timed(text: string): number {
    const started = performance.now();
    maskSecrets(text);
    return performance.now() - started;
  }

  // Each grew with the square of its length: seconds at these sizes. A raw request body
  // can hold a minified file or a long dotted blob, and the proxy waits on the mask.
  it.each([
    ["a dotted blob", "a.".repeat(35_000)],
    ["repeated session prefixes", "v1.eyJA".repeat(20_000)],
    ["a dashed blob", "a-".repeat(35_000)],
    ["chained assignments", "a=".repeat(50_000)],
    ["chained quoted assignments", 'a="'.repeat(30_000)],
    ["unfinished JWTs", "eyJAAAAA.".repeat(15_000)],
    ["unfinished key blocks", "-----BEGIN RSA PRIVATE KEY-----\n".repeat(3_000)],
    ["key prefixes", "sk-ant-x sk-x ghp_x AKIA xoxb- ".repeat(5_000)],
  ])("stays linear on %s", (_name, text) => {
    expect(timed(text)).toBeLessThan(500);
  });
});
