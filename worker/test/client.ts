// How the tests reach the Worker the way real clients do (ADR 0007): every Channel
// API call goes to `/r/<owner>/<repo>/api/...` with a credential, a Person session
// or an Agent token.
//
// The tests call the Worker as `http://localhost`, with DEV_FAKE_GITHUB on
// (vitest.config.ts): a Channel without a GitHub installed then lets every signed-in
// Person in, as the dev-only fake sign-in does under `wrangler dev`. A test that
// installs a FakeGitHub gets the real membership check against it. Tests of the
// production path call as `https://switchboard.test` instead.

import { env } from "cloudflare:test";
import type { AgentId, AgentResponse } from "../../shared/src/index";
import { signSession } from "../src/session";

/** The Channel most tests use: the repo FakeGitHub mirrors. */
export const REPO = "shlok1806/switchboard";
/** A second repo ALLOWED_REPOS lets have a Channel, for routing tests. */
export const OTHER_REPO = "shlok1806/other";
/** Local, so the dev-only fake sign-in rules apply. */
export const BASE = "http://localhost";
/** A deployed Worker's origin: the dev-only fake sign-in is off there. */
export const PROD_BASE = "https://switchboard.test";
export const SESSION_SECRET = "test-session-secret-at-least-32-characters-long";

/**
 * The URL for `path`: a Channel API path (`/api/...`) goes under the Channel of
 * `repo`; the webhook and sign-in routes (`/api/github/webhook`, `/auth/...`) are
 * shared by every Channel and stay where they are.
 */
export function url(path: string, repo = REPO, base = BASE): string {
  const shared = path.startsWith("/auth/") || path.startsWith("/api/github/webhook");
  return shared || !path.startsWith("/api/") ? `${base}${path}` : `${base}/r/${repo}${path}`;
}

const sessions = new Map<string, Promise<string>>();

/** A Person session for GitHub login `person`, as sign-in hands out. */
export function sessionFor(person: string): Promise<string> {
  let session = sessions.get(person);
  if (session === undefined) {
    session = signSession(SESSION_SECRET, person);
    sessions.set(person, session);
  }
  return session;
}

const agentTokens = new Map<AgentId, string>();

/** Keeps the Agent token a registration answered with, as the wrapper does. */
export function remember(answer: AgentResponse): AgentResponse {
  if (answer.token !== undefined) agentTokens.set(answer.agent.id, answer.token);
  return answer;
}

/** The latest token issued to Agent `id`. */
export function tokenOf(id: AgentId): string {
  const token = agentTokens.get(id);
  if (token === undefined) throw new Error(`No token was issued to ${id} in this test`);
  return token;
}

/** Who a call is made as: a Person with their session, or an Agent with its token. */
export type As = { person: string; agent?: AgentId };

/** The `Authorization` value for `as`. */
export async function bearer(as: As | string): Promise<string> {
  const who = typeof as === "string" ? { person: as } : as;
  return `Bearer ${who.agent === undefined ? await sessionFor(who.person) : tokenOf(who.agent)}`;
}

/** The query a WebSocket upgrade sends its credential in. */
export async function streamQuery(as: As | string, extra: Record<string, string> = {}): Promise<URLSearchParams> {
  const credential = (await bearer(as)).slice("Bearer ".length);
  return new URLSearchParams({ token: credential, ...extra });
}

/** The Channel Durable Object of `repo`. */
export function channelStub(repo = REPO) {
  return env.CHANNEL.get(env.CHANNEL.idFromName(repo));
}

/** Forgets every Agent token between tests; the Channels were reset too. */
export function forgetTokens(): void {
  agentTokens.clear();
}
