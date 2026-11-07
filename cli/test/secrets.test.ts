// The secret check a shared skill must pass (ADR 0050): a pure function over a file's text.
// It finds real credentials, by their format or as a long random value given to a
// secret-sounding name, and lets through what skills are full of: placeholders, references
// and identifiers. The cases that are not secrets are lines the owner's own skills hold,
// which the masker's rule refused.

import { describe, expect, it } from "vitest";
import { findSecret } from "../../shared/src/secrets";

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB",
  "aFDrBz9vFqU4yT0h3u8f1FfJk2cpHtHgk9hUQJcoVoZsAuHPR4c9hK9FzNnPaS8Z",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

const secrets: { input: string; kind: string; line?: number }[] = [
  { input: "token ghp_R8f2kLq9Zt3Xw7Vn1Bc6Hd4Jm0Ps5Yg2Ue8A", kind: "a GitHub token" },
  { input: "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789", kind: "a GitHub token" },
  { input: "ANTHROPIC_API_KEY=sk-ant-api03-Q2x9vR7kLmN4pT8wZ1yB6cD3fG5hJ0aE-xYzAbCdEfGh", kind: "an Anthropic key" },
  { input: "use sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk", kind: "an OpenAI key" },
  { input: "aws_access_key_id = ASIAY34FZKBOKMUTVV7A", kind: "an AWS access key" },
  { input: "SLACK=xoxb-123456789012-1234567890123-AbCdEfGhIjKl", kind: "a Slack token" },
  { input: `# the key\n\n${PEM}\n`, kind: "a private key", line: 3 },
  { input: "postgres://app:Zq8vT2mK9xLp4Rw7Nb3c@db.internal:5432/app", kind: "a password in a URL" },
  {
    input: 'export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYzT4q9Lm2Vk"',
    kind: "a value given to AWS_SECRET_ACCESS_KEY",
  },
  { input: "config:\n  api_key: 8f3kd92jf83hd72kd93jf8s7q", kind: "a value given to api_key", line: 2 },
  { input: '{ "clientSecret": "Gx7hQ2pL9vR4tY8wK3mN6bZ1" }', kind: "a value given to clientSecret" },
];

const notSecrets: { name: string; input: string }[] = [
  { name: "an ellipsis", input: "export GITHUB_TOKEN=ghp_...\nLANGFUSE_PUBLIC_KEY=pk-lf-..." },
  {
    name: "AWS's documented example keys",
    input: "AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
  { name: "a run of x", input: "GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
  { name: "a word", input: "Key=SERVICE\nHttpTokens=required" },
  { name: "a quoted name", input: 'Key="my-key"\nAPI_KEY: "/myapp/api-key"' },
  { name: "a call", input: 'const key = crypto.randomUUID();\nclient_secret = response.get("clientSecret")' },
  {
    name: "an environment reference",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, kept as written
    input: 'API_KEY="$API_KEY"\nTOKEN=${{ secrets.GITHUB_TOKEN }}\napiKey: process.env.OPENAI_API_KEY_2024',
  },
  { name: "an ARN", input: "SecretKey: arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/api-key-AbCdEf" },
  { name: "a placeholder in angle brackets", input: "TOKEN=<your-token-here>\nsecret: {{ .Values.secretKey }}" },
  {
    name: "a name for a key, not a key",
    input: '"s3KeyName": "certs/certificate2024.p12"\n"nextToken": "eyJvZmZzZXQiOjEwMH0="',
  },
  { name: "a comparison", input: "if (t.keyCode==27||e.key.length===1) return;" },
  {
    name: "a private key block with nothing in it",
    input: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
  },
  { name: "a URL with a word for a password", input: "postgres://user:password@localhost:5432/app" },
];

describe("the skill's secret check", () => {
  it.each(secrets)("finds $kind", ({ input, kind, line = 1 }) => {
    expect(findSecret(input)).toEqual({ kind, line });
  });

  it.each(notSecrets)("lets $name through", ({ input }) => {
    expect(findSecret(input)).toBeNull();
  });

  it("reads a binary file for the token formats only", () => {
    expect(findSecret("\u0000ÿghp_R8f2kLq9Zt3Xw7Vn1Bc6Hd4Jm0Ps5Yg2Ue8A", { formatsOnly: true })?.kind).toBe(
      "a GitHub token",
    );
    expect(findSecret("API_KEY=8f3kd92jf83hd72kd93jf8s7q", { formatsOnly: true })).toBeNull();
  });
});
