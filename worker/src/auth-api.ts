// Sign-in with GitHub (ADR 0007). Shared by every Channel; each sign-in names the
// repo whose Channel it is for, and only a Person with write access to that repo
// gets a session.
//
//   GET  /auth/config                    what sign-in can do here (AuthConfigResponse)
//   GET  /auth/github/start?repo=o/r     the Dashboard: off to GitHub's web flow
//   GET  /auth/github/callback           back from GitHub: the session cookie, then the Dashboard
//   POST /auth/device/code               the CLI: starts GitHub's device flow
//   POST /auth/device/token              the CLI: one poll; a session once the Person approved
//   POST /auth/signout                   clears the Dashboard's session cookie
//   GET  /auth/dev/signin?login=&repo=   dev only: the fake sign-in for the Dashboard
//   POST /auth/dev/session               dev only: the fake sign-in for the CLI and the tests
//
// Sign-in is off, and says "GitHub App not configured", until the App's secrets
// and SESSION_SECRET are set. The dev-only routes answer 404 unless DEV_FAKE_GITHUB
// is "true" and the request came to localhost (`wrangler dev`).

import type {
  AuthConfigResponse,
  DeviceTokenResponse,
  DevSessionResponse,
  PersonName,
  SignInProblem,
} from "../../shared/src/index";
import { personFromLogin, SESSION_COOKIE } from "../../shared/src/index";
import { allowedRepos, channelRepo, cookie, devMode, readCookie, sessionSecret } from "./auth";
import { APP_NOT_CONFIGURED, missingAppSecrets, signInFor } from "./github/index";
import { fail, json, readJson } from "./http";
import { base64url, SESSION_TTL_SECONDS, signPayload, signSession, verifyPayload } from "./session";

/** The short-lived cookie that ties GitHub's callback to the browser that started the sign-in. */
const STATE_COOKIE = "sb_oauth";
const STATE_TTL_SECONDS = 10 * 60;

/** The routes this module answers, or null. */
export function isAuthRoute(pathname: string): boolean {
  return pathname.startsWith("/auth/");
}

/** Why GitHub sign-in is off, or null when it is on. The dev-only fake sign-in does not need it. */
function notConfigured(env: Env, dev: boolean): string | null {
  // A sign-in the tests installed stands in for the App.
  const missing = signInFor(env) === null ? missingAppSecrets(env) : [];
  if (sessionSecret(env, dev) === null) missing.push("SESSION_SECRET");
  return missing.length === 0 ? null : `${APP_NOT_CONFIGURED} Missing: ${missing.join(", ")}.`;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 302, headers });
}

/** Back to the Dashboard of `repo` (or the start page), saying why sign-in did not happen. */
function problem(repo: string | null, code: SignInProblem, cookies: string[] = []): Response {
  return redirect(repo === null ? `/?signin=${code}` : `/${repo}?signin=${code}`, cookies);
}

function sessionCookie(session: string): string {
  return cookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS);
}

type Channels = (repo: string) => DurableObjectStub<import("./channel").Channel>;

/**
 * Admits `person` to the Channel of `repo` now, asking GitHub rather than any
 * cached answer: sign-in is where membership is checked first.
 */
async function member(
  channels: Channels,
  repo: string,
  person: PersonName,
  dev: boolean,
): Promise<{ ok: true } | { ok: false; status: 403 | 401 | 503; reason: string }> {
  const admitted = await channels(repo).admit(repo, { kind: "session", person }, dev, true);
  return admitted.ok ? { ok: true } : admitted;
}

export async function handleAuthRoute(request: Request, url: URL, env: Env, channels: Channels): Promise<Response> {
  const dev = devMode(env, url);
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case "GET /auth/config": {
      const reason = notConfigured(env, dev);
      return json<AuthConfigResponse>({
        configured: reason === null,
        ...(reason === null ? {} : { reason }),
        repos: allowedRepos(env),
        devSignIn: dev,
      });
    }
    case "POST /auth/signout":
      return new Response(null, { status: 204, headers: { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) } });
    case "GET /auth/github/start":
      return startWebFlow(url, env, dev);
    case "GET /auth/github/callback":
      return finishWebFlow(request, url, env, dev, channels);
    case "POST /auth/device/code":
      return startDeviceFlow(env, dev);
    case "POST /auth/device/token":
      return pollDeviceFlow(request, env, dev, channels);
    case "GET /auth/dev/signin":
    case "POST /auth/dev/session":
      if (!dev) return fail(404, "Not found.");
      return devSignIn(request, url, env, channels);
    default:
      return fail(404, "Not found.");
  }
}

async function startWebFlow(url: URL, env: Env, dev: boolean): Promise<Response> {
  const repo = channelRepo(env, url.searchParams.get("repo") ?? "");
  if (repo === null) return problem(null, "not-allowed");
  const signIn = signInFor(env);
  const secret = sessionSecret(env, dev);
  if (notConfigured(env, dev) !== null || signIn === null || secret === null) return problem(repo, "not-configured");
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = base64url(nonceBytes);
  const state = await signPayload(secret, {
    kind: "oauth-state",
    repo,
    nonce,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  });
  return redirect(signIn.authorizeUrl(state, `${url.origin}/auth/github/callback`), [
    cookie(STATE_COOKIE, nonce, STATE_TTL_SECONDS, "/auth/github"),
  ]);
}

async function finishWebFlow(
  request: Request,
  url: URL,
  env: Env,
  dev: boolean,
  channels: Channels,
): Promise<Response> {
  const clearState = cookie(STATE_COOKIE, "", 0, "/auth/github");
  const secret = sessionSecret(env, dev);
  const signIn = signInFor(env);
  if (secret === null || signIn === null) return problem(null, "not-configured", [clearState]);
  const state = await verifyPayload(secret, url.searchParams.get("state") ?? "");
  const repo = typeof state?.repo === "string" ? channelRepo(env, state.repo) : null;
  if (state === null || state.kind !== "oauth-state" || repo === null) return problem(null, "failed", [clearState]);
  if (typeof state.exp !== "number" || state.exp * 1000 < Date.now()) return problem(repo, "expired", [clearState]);
  // The callback must reach the browser that started this sign-in.
  if (readCookie(request, STATE_COOKIE) !== state.nonce) return problem(repo, "failed", [clearState]);
  if (url.searchParams.get("error") === "access_denied") return problem(repo, "denied", [clearState]);
  const code = url.searchParams.get("code");
  if (!code) return problem(repo, "failed", [clearState]);

  let person: PersonName | null;
  try {
    const userToken = await signIn.exchangeCode(code, `${url.origin}/auth/github/callback`);
    person = personFromLogin(await signIn.userLogin(userToken));
  } catch (error) {
    console.error("GitHub sign-in failed", error);
    return problem(repo, "failed", [clearState]);
  }
  if (person === null) return problem(repo, "failed", [clearState]);
  const admitted = await member(channels, repo, person, dev);
  if (!admitted.ok) {
    return problem(repo, admitted.status === 403 ? "not-a-member" : "not-configured", [clearState]);
  }
  return redirect(`/${repo}`, [clearState, sessionCookie(await signSession(secret, person))]);
}

async function startDeviceFlow(env: Env, dev: boolean): Promise<Response> {
  const reason = notConfigured(env, dev);
  const signIn = signInFor(env);
  if (reason !== null || signIn === null) return fail(503, reason ?? APP_NOT_CONFIGURED);
  try {
    return json(await signIn.startDevice());
  } catch (error) {
    return fail(502, (error as Error).message);
  }
}

async function pollDeviceFlow(request: Request, env: Env, dev: boolean, channels: Channels): Promise<Response> {
  const reason = notConfigured(env, dev);
  const signIn = signInFor(env);
  const secret = sessionSecret(env, dev);
  if (reason !== null || signIn === null || secret === null) return fail(503, reason ?? APP_NOT_CONFIGURED);
  const body = await readJson(request);
  const repo = typeof body.repo === "string" ? channelRepo(env, body.repo) : null;
  if (repo === null) return fail(404, "There is no Channel for that repo here.");
  if (typeof body.deviceCode !== "string" || body.deviceCode.length === 0) return fail(400, 'Send "deviceCode".');

  let person: PersonName | null;
  try {
    const poll = await signIn.pollDevice(body.deviceCode);
    if (!poll.ok) {
      if (poll.pending) return json<DeviceTokenResponse>({ ok: false, pending: true, slowDown: poll.slowDown });
      return fail(poll.error === "failed" ? 502 : 400, poll.reason);
    }
    person = personFromLogin(await signIn.userLogin(poll.userToken));
  } catch (error) {
    return fail(502, `GitHub sign-in failed: ${(error as Error).message}`);
  }
  if (person === null) return fail(502, "GitHub answered with a login Switchboard cannot use.");
  const admitted = await member(channels, repo, person, dev);
  if (!admitted.ok) return fail(admitted.status, admitted.reason);
  return json<DeviceTokenResponse>({ ok: true, session: await signSession(secret, person), person, repo });
}

/** The dev-only fake sign-in: any login, still subject to the membership check. */
async function devSignIn(request: Request, url: URL, env: Env, channels: Channels): Promise<Response> {
  const secret = sessionSecret(env, true) ?? "";
  const browser = request.method === "GET";
  const input = browser ? Object.fromEntries(url.searchParams) : await readJson(request);
  const repo = typeof input.repo === "string" ? channelRepo(env, input.repo) : null;
  const person = typeof input.login === "string" ? personFromLogin(input.login) : null;
  if (repo === null)
    return browser ? problem(null, "not-allowed") : fail(404, "There is no Channel for that repo here.");
  if (person === null) return browser ? problem(repo, "failed") : fail(400, '"login" must be a GitHub login.');
  const admitted = await member(channels, repo, person, true);
  if (!admitted.ok) {
    return browser
      ? problem(repo, admitted.status === 403 ? "not-a-member" : "failed")
      : fail(admitted.status, admitted.reason);
  }
  const session = await signSession(secret, person);
  if (browser) return redirect(`/${repo}`, [sessionCookie(session)]);
  return json<DevSessionResponse>({ ok: true, session, person, repo });
}
