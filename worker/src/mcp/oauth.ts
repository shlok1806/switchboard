// The read-only connector's sign-in (ADR 0040): an OAuth 2.1 authorization server on
// the Worker, whose issuer is the Worker's origin, backed by the GitHub sign-in the
// Dashboard uses (ADR 0007).
//
//   GET  /.well-known/oauth-protected-resource/r/<owner>/<repo>/mcp   RFC 9728
//   GET  /.well-known/oauth-authorization-server                      RFC 8414
//   POST /oauth/register      dynamic client registration (RFC 7591), stored nowhere
//   GET  /oauth/authorize     checks the request; sign-in with GitHub; the consent page
//   POST /oauth/authorize     the consent page's Allow or Cancel: back to the app
//   POST /oauth/token         a code, or a refresh token, for tokens
//
// Codes and tokens are signed with SESSION_SECRET (tokens.ts); without it every
// endpoint answers 503 and nothing is issued.

import type { PersonName } from "../../../shared/src/index";
import { SESSION_COOKIE } from "../../../shared/src/index";
import { channelRepo, devMode, readCookie, sessionSecret } from "../auth";
import { notConfigured } from "../auth-api";
import type { Channel } from "../channel";
import { signInFor } from "../github/index";
import { verifySession } from "../session";
import { consentPage, devSignInPage, refusalPage } from "./pages";
import {
  AUTHORIZATION_SERVER_METADATA,
  AUTHORIZE_PATH,
  MCP_PATH,
  MCP_SCOPE,
  mcpPath,
  PROTECTED_RESOURCE_METADATA,
  REGISTER_PATH,
  TOKEN_PATH,
} from "./paths";
import {
  ACCESS_TTL_SECONDS,
  type AuthorizationRequest,
  clientKey,
  pkceMatches,
  type RegisteredClient,
  readClient,
  readCode,
  readConsent,
  readRefresh,
  refreshExpiresAt,
  signAccess,
  signClient,
  signCode,
  signConsent,
  signRefresh,
} from "./tokens";

type Channels = (repo: string) => DurableObjectStub<Channel>;

/** The redirect URIs of the apps that add connectors (checked against their docs on 2026-11-06). */
const KNOWN_REDIRECTS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
]);
/** ChatGPT's redirect when it does not use the issuer's `iss`: one path per connector. */
const CHATGPT_CONNECTOR = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME = 100;
const MAX_STATE = 1000;

/** The routes this module answers. */
export function isOAuthRoute(pathname: string): boolean {
  return (
    pathname.startsWith("/oauth/") ||
    pathname === AUTHORIZATION_SERVER_METADATA ||
    pathname.startsWith(`${AUTHORIZATION_SERVER_METADATA}/`) ||
    pathname.startsWith(`${PROTECTED_RESOURCE_METADATA}/`)
  );
}

/** A loopback redirect: Claude Code's, on a port that changes per session (RFC 8252). */
function loopback(uri: URL): boolean {
  return uri.protocol === "http:" && LOOPBACK_HOSTS.has(uri.hostname);
}

function parseUri(raw: string): URL | null {
  try {
    const uri = new URL(raw);
    return uri.hash === "" && uri.username === "" && uri.password === "" ? uri : null;
  } catch {
    return null;
  }
}

/** Whether an app may register `raw` as a redirect URI. */
function allowedRedirect(env: Env, raw: string): boolean {
  const uri = parseUri(raw);
  if (uri === null) return false;
  if (loopback(uri)) return true;
  if (KNOWN_REDIRECTS.has(raw) || CHATGPT_CONNECTOR.test(raw)) return true;
  // Comma-separated in the Worker's vars, matched exactly.
  return (env.MCP_EXTRA_REDIRECT_URIS ?? "")
    .split(",")
    .map((s) => s.trim())
    .some((extra) => extra !== "" && extra === raw);
}

/** Whether `requested` is one of `registered`; a loopback one matches on any port. */
function registeredRedirect(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const want = parseUri(requested);
  if (want === null || !loopback(want)) return false;
  return registered.some((raw) => {
    const have = parseUri(raw);
    return (
      have !== null &&
      loopback(have) &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

/** The Channel a `resource` names: one of this Worker's MCP endpoints. Its key, or null. */
export function resourceRepo(env: Env, origin: string, resource: string): string | null {
  const uri = parseUri(resource);
  if (uri === null || uri.origin !== origin || uri.search !== "") return null;
  const match = MCP_PATH.exec(uri.pathname.replace(/\/$/, ""));
  if (match?.[1] === undefined) return null;
  try {
    return channelRepo(env, decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
};

/** A JSON answer apps may read from a browser too: none of these carries a cookie. */
function open(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store", ...extra } });
}

/** An OAuth error answer (RFC 6749 section 5.2). */
function oauthError(error: string, description: string, status = 400): Response {
  return open({ error, error_description: description }, status);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

/** Back to the app with `params`, and the issuer, as RFC 9207 asks. */
function backToApp(redirectUri: string, origin: string, params: Record<string, string | undefined>): Response {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) target.searchParams.set(key, value);
  target.searchParams.set("iss", origin);
  return redirect(target.toString());
}

export async function handleOAuthRoute(request: Request, url: URL, env: Env, channels: Channels): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const route = `${request.method} ${url.pathname}`;
  if (request.method === "GET" && url.pathname.startsWith(`${PROTECTED_RESOURCE_METADATA}/`)) {
    return resourceMetadata(url, env);
  }
  if (
    request.method === "GET" &&
    (url.pathname === AUTHORIZATION_SERVER_METADATA || url.pathname.startsWith(`${AUTHORIZATION_SERVER_METADATA}/`))
  ) {
    return serverMetadata(url);
  }
  const dev = devMode(env, url);
  const secret = sessionSecret(env, dev);
  if (secret === null) {
    return url.pathname === AUTHORIZE_PATH
      ? refusalPage(
          "Sign-in is not set up",
          "This Switchboard has no SESSION_SECRET yet, so it cannot sign anyone in.",
          503,
        )
      : oauthError("temporarily_unavailable", "Sign-in is not set up: SESSION_SECRET is missing.", 503);
  }
  switch (route) {
    case `POST ${REGISTER_PATH}`:
      return register(request, env, secret);
    case `GET ${AUTHORIZE_PATH}`:
      return authorize(request, url, env, dev, secret, channels);
    case `POST ${AUTHORIZE_PATH}`:
      return decide(request, url, dev, secret, channels);
    case `POST ${TOKEN_PATH}`:
      return token(request, url, env, dev, secret, channels);
    default:
      return oauthError("invalid_request", "Not found.", 404);
  }
}

/** RFC 9728, for one Channel's endpoint: its `resource` is the URL as the Person typed it. */
function resourceMetadata(url: URL, env: Env): Response {
  const path = url.pathname.slice(PROTECTED_RESOURCE_METADATA.length);
  const match = MCP_PATH.exec(path);
  let repo: string | null = null;
  try {
    repo = match?.[1] === undefined ? null : channelRepo(env, decodeURIComponent(match[1]));
  } catch {
    repo = null;
  }
  if (repo === null) return oauthError("invalid_request", "There is no Channel endpoint there.", 404);
  return open({
    resource: `${url.origin}${path}`,
    authorization_servers: [url.origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: `Switchboard: ${repo}`,
    resource_documentation: "https://github.com/shlok1806/switchboard#ask-the-channel",
  });
}

/** RFC 8414. Public clients with PKCE S256 only; the issuer names itself in every redirect. */
function serverMetadata(url: URL): Response {
  return open({
    issuer: url.origin,
    authorization_endpoint: `${url.origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${url.origin}${TOKEN_PATH}`,
    registration_endpoint: `${url.origin}${REGISTER_PATH}`,
    scopes_supported: [MCP_SCOPE, "offline_access"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  });
}

async function register(request: Request, env: Env, secret: string): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "Send the client's metadata as a JSON object.");
  }
  const uris = body.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > MAX_REDIRECT_URIS ||
    !uris.every((uri) => typeof uri === "string")
  ) {
    return oauthError("invalid_redirect_uri", `"redirect_uris" must list 1 to ${MAX_REDIRECT_URIS} URIs.`);
  }
  const refused = uris.find((uri) => !allowedRedirect(env, uri));
  if (refused !== undefined) {
    return oauthError(
      "invalid_redirect_uri",
      `${refused} is not a redirect this Switchboard accepts. It accepts the Claude apps', ChatGPT's and loopback ones.`,
    );
  }
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code"];
  if (!grantTypes.every((g) => g === "authorization_code" || g === "refresh_token")) {
    return oauthError("invalid_client_metadata", "Only the authorization_code and refresh_token grants are offered.");
  }
  const rawName = typeof body.client_name === "string" ? body.client_name.trim() : "";
  const name = rawName === "" ? "An app" : rawName.slice(0, MAX_CLIENT_NAME);
  const client: RegisteredClient = { name, redirectUris: [...new Set(uris as string[])] };
  const clientId = await signClient(secret, client);
  return open(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: MCP_SCOPE,
    },
    201,
  );
}

/**
 * Checks an authorization request. Until the app and its redirect are known good, a
 * problem is shown on a page; after that it goes back to the app (RFC 6749 4.1.2.1).
 */
async function readAuthorization(
  params: URLSearchParams,
  env: Env,
  origin: string,
  secret: string,
): Promise<{ ok: true; request: AuthorizationRequest; client: RegisteredClient } | { ok: false; response: Response }> {
  const clientId = params.get("client_id") ?? "";
  const client = clientId === "" ? null : await readClient(secret, clientId);
  if (client === null) {
    return {
      ok: false,
      response: refusalPage(
        "Unknown app",
        "The app asking to connect did not register with this Switchboard. Remove the connector and add it again.",
        400,
      ),
    };
  }
  const asked = params.get("redirect_uri");
  const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (redirectUri === undefined || !registeredRedirect(client.redirectUris, redirectUri)) {
    return {
      ok: false,
      response: refusalPage("Unknown redirect", "The app asked to be sent back somewhere it did not register.", 400),
    };
  }
  const state = params.get("state") ?? undefined;
  const fail = (error: string, description: string) => ({
    ok: false as const,
    response: backToApp(redirectUri, origin, { error, error_description: description, state }),
  });
  if (state !== undefined && state.length > MAX_STATE) return fail("invalid_request", "state is too long.");
  if (params.get("response_type") !== "code") return fail("unsupported_response_type", 'Only "code" is offered.');
  const challenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method S256 is required.");
  }
  const resource = params.get("resource");
  const repo = resource === null ? null : resourceRepo(env, origin, resource);
  if (repo === null) {
    return fail("invalid_target", "resource must name a Switchboard Channel's MCP endpoint on this Worker.");
  }
  return {
    ok: true,
    client,
    request: { clientId, redirectUri, challenge, repo, ...(state === undefined ? {} : { state }) },
  };
}

/** The Person a browser is signed in as on this Worker, from the Dashboard's session cookie. */
async function signedIn(request: Request, secret: string): Promise<PersonName | null> {
  const session = readCookie(request, SESSION_COOKIE);
  return session === null ? null : verifySession(secret, session);
}

/** Admits `person` to the Channel of `repo`: write access to it, as for every Channel call. */
async function admit(
  channels: Channels,
  repo: string,
  person: PersonName,
  dev: boolean,
  fresh: boolean,
): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const admitted = await channels(repo).admit(repo, { kind: "session", person }, dev, fresh);
  return admitted.ok ? { ok: true } : admitted;
}

async function authorize(
  request: Request,
  url: URL,
  env: Env,
  dev: boolean,
  secret: string,
  channels: Channels,
): Promise<Response> {
  const checked = await readAuthorization(url.searchParams, env, url.origin, secret);
  if (!checked.ok) return checked.response;
  const { request: auth, client } = checked;
  const here = `${url.pathname}${url.search}`;
  const signInUrl = `/auth/github/start?${new URLSearchParams({ repo: auth.repo, return: here })}`;
  const person = await signedIn(request, secret);
  if (person === null) {
    // Through the Dashboard's own GitHub sign-in, then back here.
    if (notConfigured(env, dev) === null) return redirect(signInUrl);
    if (dev && signInFor(env) === null) return devSignInPage(auth.repo, here);
    return refusalPage("Sign-in is not set up", "This Switchboard's GitHub App is not configured yet.", 503);
  }
  const admitted = await admit(channels, auth.repo, person, dev, true);
  if (!admitted.ok) {
    return refusalPage(
      "No access to this Channel",
      admitted.reason,
      admitted.status,
      notConfigured(env, dev) === null ? signInUrl : undefined,
    );
  }
  const target = new URL(auth.redirectUri);
  return consentPage({
    person,
    repo: auth.repo,
    client: client.name,
    redirectHost: target.host,
    loopback: loopback(target),
    request: await signConsent(secret, person, auth),
    switchAccount: signInUrl,
  });
}

/** The consent page's answer. It must come from that page, by the Person it was shown to. */
async function decide(request: Request, url: URL, dev: boolean, secret: string, channels: Channels): Promise<Response> {
  const origin = request.headers.get("Origin");
  // A form post from a page on this Worker; the Origin is left out only by clients that are not browsers.
  if (origin !== null && origin !== url.origin) {
    return refusalPage("Refused", "This answer did not come from Switchboard's own page.", 403);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refusalPage("Refused", "The answer was not a form.", 400);
  }
  const consent = await readConsent(secret, String(form.get("request") ?? ""));
  const person = await signedIn(request, secret);
  if (consent === null || person === null || person !== consent.person) {
    return refusalPage(
      "Start again",
      "This page expired or belongs to another sign-in. Connect from the app again.",
      400,
    );
  }
  const auth = consent.request;
  if (form.get("decision") !== "allow") {
    return backToApp(auth.redirectUri, url.origin, {
      error: "access_denied",
      error_description: "The Person cancelled.",
      state: auth.state,
    });
  }
  const admitted = await admit(channels, auth.repo, person, dev, false);
  if (!admitted.ok) return refusalPage("No access to this Channel", admitted.reason, admitted.status);
  return backToApp(auth.redirectUri, url.origin, { code: await signCode(secret, person, auth), state: auth.state });
}

/** The token request's fields: form-encoded, as RFC 6749 says, or JSON from a lenient client. */
async function tokenParams(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("Content-Type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      return new URLSearchParams(
        Object.entries(body).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])),
      );
    }
    const form = await request.formData();
    return new URLSearchParams(
      [...form.entries()].flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])),
    );
  } catch {
    return null;
  }
}

async function token(
  request: Request,
  url: URL,
  env: Env,
  dev: boolean,
  secret: string,
  channels: Channels,
): Promise<Response> {
  const params = await tokenParams(request);
  if (params === null) return oauthError("invalid_request", "Send the token request form-encoded.");
  const clientId = params.get("client_id") ?? "";
  if (clientId === "" || (await readClient(secret, clientId)) === null) {
    return oauthError("invalid_client", "Unknown client_id. Register the app again.", 401);
  }
  const client = await clientKey(clientId);
  const resource = params.get("resource");
  const grantType = params.get("grant_type");

  let person: PersonName;
  let repo: string;
  let grant: { id: string; generation: number };
  if (grantType === "authorization_code") {
    const code = await readCode(secret, params.get("code") ?? "");
    if (code === null) return oauthError("invalid_grant", "The authorization code is not valid or expired.");
    if (code.client !== client) return oauthError("invalid_grant", "The code was issued to another client.");
    if (params.get("redirect_uri") !== null && params.get("redirect_uri") !== code.redirectUri) {
      return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
    }
    if (!(await pkceMatches(params.get("code_verifier") ?? "", code.challenge))) {
      return oauthError("invalid_grant", "code_verifier does not match the code_challenge.");
    }
    ({ person, repo } = code);
    if (resource !== null && resourceRepo(env, url.origin, resource) !== repo) {
      return oauthError("invalid_target", "resource names another Channel than the code was issued for.");
    }
    const admitted = await admit(channels, repo, person, dev, false);
    if (!admitted.ok) return oauthError("invalid_grant", admitted.reason);
    const started = await channels(repo).startMcpGrant(code.jti, person, client, refreshExpiresAt());
    if (!started.ok) return oauthError("invalid_grant", started.reason);
    grant = { id: code.jti, generation: started.generation };
  } else if (grantType === "refresh_token") {
    const refresh = await readRefresh(secret, params.get("refresh_token") ?? "");
    if (refresh === null) return oauthError("invalid_grant", "The refresh token is not valid or expired.");
    if (refresh.client !== client) return oauthError("invalid_grant", "The refresh token belongs to another client.");
    ({ person, repo } = refresh);
    if (resource !== null && resourceRepo(env, url.origin, resource) !== repo) {
      return oauthError("invalid_target", "resource names another Channel than the refresh token is for.");
    }
    const admitted = await admit(channels, repo, person, dev, false);
    if (!admitted.ok) return oauthError("invalid_grant", admitted.reason);
    const rotated = await channels(repo).rotateMcpGrant(refresh.grant, refresh.generation, client, refreshExpiresAt());
    if (!rotated.ok) return oauthError("invalid_grant", rotated.reason);
    grant = { id: refresh.grant, generation: rotated.generation };
  } else {
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  const audience = `${url.origin}${mcpPath(repo)}`;
  return open(
    {
      access_token: await signAccess(secret, person, repo, audience),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: await signRefresh(secret, {
        person,
        repo,
        client,
        grant: grant.id,
        generation: grant.generation,
      }),
      scope: MCP_SCOPE,
    },
    200,
    { Pragma: "no-cache" },
  );
}
