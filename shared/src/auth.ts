/**
 * Identity and routing (ADR 0007). A Person is a GitHub account, signed in with the
 * Switchboard GitHub App: the Dashboard through GitHub's web flow, the CLI through
 * its device flow. Either way the Worker answers with a Switchboard session. A
 * Person gets into a Channel only with write access to its repo.
 *
 * One Channel per repo. Its routes live under the repo:
 *
 *   /<owner>/<repo>                   the Dashboard
 *   /r/<owner>/<repo>/api/...         the Channel API
 *   /auth/...                         sign-in, shared by every Channel
 *   /api/github/webhook               GitHub's deliveries, routed by repository
 *
 * Every Channel API call carries one credential:
 * - a Person session: the `sb_session` cookie (the Dashboard) or
 *   `Authorization: Bearer <session>` (the CLI);
 * - an Agent token: `Authorization: Bearer <token>`, issued to the wrapper when it
 *   registers the Agent, bound to that one Agent and revoked when it goes Gone.
 * A WebSocket upgrade, which cannot carry headers from every client, may send the
 * bearer as `?token=` instead.
 */

import type { PersonName } from "./domain";

/** The cookie that holds the Dashboard's Switchboard session. */
export const SESSION_COOKIE = "sb_session";

/** Agent tokens start with this, so the Worker can tell them from Person sessions. */
export const AGENT_TOKEN_PREFIX = "sba_";

/**
 * A GitHub login, lowercased: letters, digits and single hyphens, 1 to 39
 * characters, not starting or ending with a hyphen. It is a Person's name
 * everywhere, and the first part of each of their Agent IDs.
 */
export const LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

/** A GitHub login as a Person name, or null when it is not one. Logins are case-insensitive. */
export function personFromLogin(login: string): PersonName | null {
  const name = login.trim().toLowerCase();
  return LOGIN_PATTERN.test(name) ? name : null;
}

/** `owner/name`, as GitHub allows them. */
export const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** The Channel key for a repo: `owner/name`, lowercased. Null when it is not a repo name. */
export function channelKey(repo: string): string | null {
  const key = repo.trim().toLowerCase();
  if (!REPO_PATTERN.test(key)) return null;
  const name = key.split("/")[1] ?? "";
  return name === "." || name === ".." ? null : key;
}

/** Where a Channel's API lives, relative to the Worker's origin: `/r/<owner>/<repo>`. */
export function channelApiBase(repo: string): string {
  return `/r/${repo}`;
}

/** `GET /auth/config`: what sign-in can do on this deployment. */
export interface AuthConfigResponse {
  /** False when the GitHub App or the session secret is not set up yet. */
  configured: boolean;
  /** Why sign-in is off, when it is. */
  reason?: string;
  /** Repos a Channel may be opened for; empty means any repo the App is installed on. */
  repos: string[];
  /** True when the dev-only fake GitHub sign-in answers here (`wrangler dev` only). */
  devSignIn: boolean;
}

/** `POST /auth/device/code`: starts GitHub's device flow for the CLI. */
export interface DeviceCodeResponse {
  deviceCode: string;
  /** The code the Person types at `verificationUri`. */
  userCode: string;
  verificationUri: string;
  /** Seconds between polls. */
  interval: number;
  /** Seconds until the code expires. */
  expiresIn: number;
}

/** `POST /auth/device/token`: one poll. `repo` is the Channel the CLI signs in to. */
export interface DeviceTokenRequest {
  deviceCode: string;
  repo: string;
}

export type DeviceTokenResponse =
  /** The Person has not entered the code yet; `slowDown` asks for a longer interval. */
  { ok: false; pending: true; slowDown?: boolean } | { ok: true; session: string; person: PersonName; repo: string };

/** `POST /auth/dev/session`: the dev-only fake sign-in for the CLI. */
export interface DevSessionRequest {
  login: string;
  repo: string;
}

export interface DevSessionResponse {
  ok: true;
  session: string;
  person: PersonName;
  repo: string;
}

/** Why the Dashboard's web sign-in came back without a session: `?signin=<code>`. */
export type SignInProblem = "not-configured" | "not-a-member" | "denied" | "expired" | "failed" | "not-allowed";
