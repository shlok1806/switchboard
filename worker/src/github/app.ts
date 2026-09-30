// The Switchboard GitHub App (ADR 0007, issue #2). One client does everything the
// Worker asks of GitHub:
//
// - Repo reads and writes (Issues, labels, assignees, the status comment, pull
//   requests, compare) with an installation token, so every write shows as
//   `switchboard[bot]`. Tokens are minted from the App's JWT and cached until
//   shortly before they expire.
// - The membership check: a collaborator's permission on the repo, read with the
//   same installation token.
// - Person sign-in: the App's user authorization, as GitHub's web flow for the
//   Dashboard and its device flow for the CLI. The user token is used once, to
//   learn the GitHub login; Switchboard then relies on its own session.
//
// Credentials come from Worker secrets: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY,
// GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET.

import type { DeviceCodeResponse } from "../../../shared/src/index";
import { GitHubApiError, RestGitHub, type TokenSource } from "./rest";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";

/** Refresh an installation token when it has less than this left. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
/** App JWTs live 9 minutes (GitHub allows 10), issued 60 s in the past for clock drift. */
const JWT_LIFETIME_S = 9 * 60;

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  /** The REST API; api.github.com unless a test points elsewhere. */
  api?: string;
  /** Where OAuth lives; github.com unless a test points elsewhere. */
  web?: string;
}

/** A poll of the device flow. */
export type DevicePoll =
  | { ok: true; userToken: string }
  | { ok: false; pending: true; slowDown: boolean }
  | { ok: false; pending: false; error: "expired" | "denied" | "failed"; reason: string };

/** Person sign-in with GitHub. The App implements it; tests install a fake. */
export interface GitHubSignIn {
  /** Where to send the browser for GitHub's web flow. */
  authorizeUrl(state: string, redirectUri: string): string;
  /** Trades the web flow's `code` for a user token. Throws when GitHub refuses. */
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  startDevice(): Promise<DeviceCodeResponse>;
  pollDevice(deviceCode: string): Promise<DevicePoll>;
  /** The GitHub login a user token belongs to. */
  userLogin(userToken: string): Promise<string>;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** DER length octets. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array): Uint8Array {
  return new Uint8Array([tag, ...derLength(content.length), ...content]);
}

/** rsaEncryption's AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }. */
const RSA_ALGORITHM = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/** Wraps a PKCS#1 RSAPrivateKey in the PKCS#8 PrivateKeyInfo Web Crypto imports. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const key = der(0x04, pkcs1);
  const body = new Uint8Array(version.length + RSA_ALGORITHM.length + key.length);
  body.set(version, 0);
  body.set(RSA_ALGORITHM, version.length);
  body.set(key, version.length + RSA_ALGORITHM.length);
  return der(0x30, body);
}

/**
 * Reads the App's private key: PKCS#8 (`BEGIN PRIVATE KEY`), or the PKCS#1 file
 * GitHub downloads (`BEGIN RSA PRIVATE KEY`). Escaped `\n` from a one-line secret work too.
 */
export function readPrivateKey(pem: string): Uint8Array<ArrayBuffer> {
  const text = pem.replace(/\\n/g, "\n").trim();
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END \1?PRIVATE KEY-----/.exec(text);
  if (match?.[2] === undefined) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key (BEGIN PRIVATE KEY or BEGIN RSA PRIVATE KEY).");
  }
  const binary = atob(match[2].replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pkcs8 = match[1] === undefined ? bytes : pkcs1ToPkcs8(bytes);
  return new Uint8Array(pkcs8);
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Installation tokens per `app id + repo`, shared by every GitHubApp in this isolate. */
const installationTokens = new Map<string, CachedToken>();

export class GitHubApp implements GitHubSignIn {
  readonly api: string;
  readonly web: string;
  private key: Promise<CryptoKey> | null = null;
  private jwt: CachedToken | null = null;

  constructor(private readonly credentials: GitHubAppCredentials) {
    this.api = (credentials.api ?? GITHUB_API).replace(/\/+$/, "");
    this.web = (credentials.web ?? GITHUB_WEB).replace(/\/+$/, "");
  }

  /** The repo client for `repo`, acting as the App's installation there. */
  repo(repo: string): RestGitHub {
    const source: TokenSource = {
      token: () => this.installationToken(repo),
      invalidate: () => installationTokens.delete(this.cacheKey(repo)),
    };
    return new RestGitHub(source, repo, this.api);
  }

  /** The App's own JWT (RS256), cached for most of its life. */
  async appJwt(now = Date.now()): Promise<string> {
    if (this.jwt !== null && this.jwt.expiresAt - 60_000 > now) return this.jwt.token;
    this.key ??= crypto.subtle
      .importKey(
        "pkcs8",
        readPrivateKey(this.credentials.privateKey),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      )
      .catch((error: unknown) => {
        this.key = null;
        throw new Error(`GITHUB_APP_PRIVATE_KEY could not be read: ${(error as Error).message}`);
      });
    const key = await this.key;
    const iat = Math.floor(now / 1000) - 60;
    const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const claims = base64url(
      encoder.encode(JSON.stringify({ iat, exp: iat + JWT_LIFETIME_S, iss: this.credentials.appId })),
    );
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${claims}`));
    const token = `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
    this.jwt = { token, expiresAt: (iat + JWT_LIFETIME_S) * 1000 };
    return token;
  }

  /** An installation token for the App's installation on `repo`, minted when the cached one runs low. */
  async installationToken(repo: string, now = Date.now()): Promise<string> {
    const key = this.cacheKey(repo);
    const cached = installationTokens.get(key);
    if (cached !== undefined && cached.expiresAt - TOKEN_MARGIN_MS > now) return cached.token;

    const installation = await this.appRequest(`/repos/${repo}/installation`);
    if (installation.status === 404) {
      throw new GitHubApiError(404, `The Switchboard GitHub App is not installed on ${repo}.`);
    }
    const { id } = await read<{ id: number }>(installation);
    const minted = await this.appRequest(`/app/installations/${id}/access_tokens`, "POST");
    const { token, expires_at } = await read<{ token: string; expires_at: string }>(minted);
    const expiresAt = Date.parse(expires_at);
    installationTokens.set(key, { token, expiresAt: Number.isNaN(expiresAt) ? now + 55 * 60_000 : expiresAt });
    return token;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const query = new URLSearchParams({ client_id: this.credentials.clientId, redirect_uri: redirectUri, state });
    return `${this.web}/login/oauth/authorize?${query}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const answer = await this.oauth("/login/oauth/access_token", {
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    if (typeof answer.access_token !== "string") {
      throw new Error(`GitHub refused the sign-in: ${String(answer.error_description ?? answer.error ?? "no token")}`);
    }
    return answer.access_token;
  }

  async startDevice(): Promise<DeviceCodeResponse> {
    const answer = await this.oauth("/login/device/code", { client_id: this.credentials.clientId });
    const { device_code, user_code, verification_uri, interval, expires_in } = answer;
    if (typeof device_code !== "string" || typeof user_code !== "string" || typeof verification_uri !== "string") {
      throw new Error(
        `GitHub did not start the device flow: ${String(answer.error_description ?? answer.error ?? "no code")}. ` +
          'Is "Enable Device Flow" on in the App settings?',
      );
    }
    return {
      deviceCode: device_code,
      userCode: user_code,
      verificationUri: verification_uri,
      interval: typeof interval === "number" ? interval : 5,
      expiresIn: typeof expires_in === "number" ? expires_in : 900,
    };
  }

  async pollDevice(deviceCode: string): Promise<DevicePoll> {
    const answer = await this.oauth("/login/oauth/access_token", {
      client_id: this.credentials.clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (typeof answer.access_token === "string") return { ok: true, userToken: answer.access_token };
    switch (answer.error) {
      case "authorization_pending":
        return { ok: false, pending: true, slowDown: false };
      case "slow_down":
        return { ok: false, pending: true, slowDown: true };
      case "expired_token":
        return { ok: false, pending: false, error: "expired", reason: "The code expired. Run the login again." };
      case "access_denied":
        return { ok: false, pending: false, error: "denied", reason: "The sign-in was cancelled on GitHub." };
      default:
        return {
          ok: false,
          pending: false,
          error: "failed",
          reason: `GitHub refused the sign-in: ${String(answer.error_description ?? answer.error ?? "unknown error")}`,
        };
    }
  }

  async userLogin(userToken: string): Promise<string> {
    const response = await fetch(`${this.api}/user`, {
      headers: { ...API_HEADERS, Authorization: `Bearer ${userToken}` },
    });
    return (await read<{ login: string }>(response)).login;
  }

  private cacheKey(repo: string): string {
    return `${this.credentials.appId}:${this.api}:${repo.toLowerCase()}`;
  }

  private async appRequest(path: string, method = "GET"): Promise<Response> {
    return fetch(`${this.api}${path}`, {
      method,
      headers: { ...API_HEADERS, Authorization: `Bearer ${await this.appJwt()}` },
    });
  }

  private async oauth(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.web}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams(params),
    });
    if (!response.ok) {
      throw new GitHubApiError(response.status, `GitHub answered ${response.status}: ${await detail(response)}`);
    }
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  }
}

const USER_AGENT = "switchboard-channel";
const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": USER_AGENT,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function detail(response: Response): Promise<string> {
  return (await response.text().catch(() => "")).slice(0, 200);
}

async function read<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new GitHubApiError(response.status, `GitHub answered ${response.status}: ${await detail(response)}`);
  }
  return response.json<T>();
}

/** Which App secrets are missing; empty when the App is fully configured. */
export function missingAppSecrets(env: Env): string[] {
  const names = [
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
  ] as const;
  return names.filter((name) => !env[name]);
}

declare global {
  interface Env {
    /** The Switchboard GitHub App (ADR 0007). Unset until the App is registered: sign-in is then off. */
    GITHUB_APP_ID?: string;
    GITHUB_APP_PRIVATE_KEY?: string;
    GITHUB_APP_CLIENT_ID?: string;
    GITHUB_APP_CLIENT_SECRET?: string;
    /**
     * Where GitHub's web side (OAuth) lives. Unset in production (github.com); the
     * CLI end-to-end test points it at a local stand-in.
     */
    GITHUB_WEB_URL?: string;
  }
}

let cached: { key: string; app: GitHubApp } | null = null;

/** The App, or null while any of its secrets is missing. One per isolate, so its JWT and key are reused. */
export function appFor(env: Env): GitHubApp | null {
  if (missingAppSecrets(env).length > 0) return null;
  const key = [
    env.GITHUB_APP_ID,
    env.GITHUB_APP_CLIENT_ID,
    env.GITHUB_APP_PRIVATE_KEY,
    env.GITHUB_API_URL,
    env.GITHUB_WEB_URL,
  ]
    .map((part) => part ?? "")
    .join("\u0000");
  if (cached?.key === key) return cached.app;
  const app = new GitHubApp({
    appId: env.GITHUB_APP_ID ?? "",
    privateKey: env.GITHUB_APP_PRIVATE_KEY ?? "",
    clientId: env.GITHUB_APP_CLIENT_ID ?? "",
    clientSecret: env.GITHUB_APP_CLIENT_SECRET ?? "",
    ...(env.GITHUB_API_URL ? { api: env.GITHUB_API_URL } : {}),
    ...(env.GITHUB_WEB_URL ? { web: env.GITHUB_WEB_URL } : {}),
  });
  cached = { key, app };
  return app;
}
