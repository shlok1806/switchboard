// `switchboard login --url <channel url>`: signs the Person in with GitHub's device
// flow (ADR 0007) and saves a Switchboard session for the Channel.
//
// The Channel URL is the Dashboard's: `https://<worker>/<owner>/<repo>`. A bare
// Worker URL works too when the Worker has exactly one Channel repo, or with
// `--repo <owner>/<repo>`.
//
// The Worker runs the flow with the Switchboard GitHub App: the CLI shows the code,
// opens nothing, and polls until the Person has entered it at GitHub. The Worker
// checks the Person has write access to the repo before it hands out a session.
//
// `--dev-login <github login>` uses the dev-only fake sign-in instead, which only a
// local `wrangler dev` with DEV_FAKE_GITHUB answers.

import type {
  AuthConfigResponse,
  DeviceCodeResponse,
  DeviceTokenResponse,
  DevSessionResponse,
  ErrorResponse,
} from "../../shared/src/index";
import { channelKey } from "../../shared/src/index";
import { ChannelClient } from "./channel-client";
import { type Config, writeConfig } from "./config";

export interface LoginOptions {
  url: string;
  repo?: string;
  devLogin?: string;
  /** Where messages for the Person go. */
  say: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Waits between polls; tests make it short. */
  sleep?: (ms: number) => Promise<void>;
}

export class LoginError extends Error {}

async function post<T>(origin: string, path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new LoginError(`Could not reach ${origin}: ${(error as Error).message}`);
  }
  const answer = (await response.json().catch(() => ({ ok: false, reason: response.statusText }))) as T | ErrorResponse;
  if (!response.ok) throw new LoginError((answer as ErrorResponse).reason || `HTTP ${response.status}`);
  return answer as T;
}

/** The Worker's origin and the Channel's repo, from `--url` and `--repo`. */
export async function resolveChannel(rawUrl: string, rawRepo?: string): Promise<{ origin: string; repo: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LoginError(`Not a URL: ${rawUrl}`);
  }
  const fromPath = url.pathname.replace(/^\/+|\/+$/g, "");
  const named = rawRepo ?? (fromPath.length > 0 ? fromPath : undefined);
  if (named !== undefined) {
    const repo = channelKey(named);
    if (repo === null) throw new LoginError(`"${named}" is not a GitHub repo (owner/name).`);
    return { origin: url.origin, repo };
  }
  let config: AuthConfigResponse;
  try {
    const response = await fetch(`${url.origin}/auth/config`, { signal: AbortSignal.timeout(20_000) });
    config = (await response.json()) as AuthConfigResponse;
  } catch (error) {
    throw new LoginError(`Could not reach ${url.origin}: ${(error as Error).message}`);
  }
  const [only, ...more] = config.repos;
  if (only === undefined || more.length > 0) {
    throw new LoginError(
      "Say which Channel: use the Dashboard's URL, https://<host>/<owner>/<repo>, or add --repo <owner>/<repo>.",
    );
  }
  return { origin: url.origin, repo: only };
}

/** Signs in, checks the session works by joining the Channel, and saves it. Returns the config path. */
export async function login(options: LoginOptions): Promise<{ path: string; config: Config }> {
  const { origin, repo } = await resolveChannel(options.url, options.repo);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let answer: { session: string; person: string };
  if (options.devLogin !== undefined) {
    answer = await post<DevSessionResponse>(origin, "/auth/dev/session", { login: options.devLogin, repo });
  } else {
    const device = await post<DeviceCodeResponse>(origin, "/auth/device/code", {});
    options.say(
      `To sign in to ${repo} with GitHub, open ${device.verificationUri} and enter the code ${device.userCode}.`,
    );
    options.say("Waiting for you to approve it on GitHub...");
    let interval = Math.max(1, device.interval) * 1000;
    const deadline = Date.now() + device.expiresIn * 1000;
    for (;;) {
      if (Date.now() > deadline) throw new LoginError("The code expired. Run the login again.");
      await sleep(interval);
      const poll = await post<DeviceTokenResponse>(origin, "/auth/device/token", {
        deviceCode: device.deviceCode,
        repo,
      });
      if (poll.ok) {
        answer = poll;
        break;
      }
      if (poll.slowDown) interval += 5000;
    }
  }

  const config: Config = { url: origin, repo, session: answer.session, person: answer.person };
  // Joining checks the session works for this Channel before it is saved.
  const joined = await new ChannelClient({ url: origin, repo, credential: answer.session }).join();
  const path = await writeConfig({ ...config, person: joined.person.name }, options.env);
  return { path, config: { ...config, person: joined.person.name } };
}
