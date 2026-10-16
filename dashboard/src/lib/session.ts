import { channelApiBase, channelKey, type DeviceCodeResponse, type DeviceSessionResponse } from "@shared/index";

/**
 * The Channel this page is for (ADR 0007): the Dashboard lives at `/<owner>/<repo>`.
 * Null at `/`, or on a path that is not a repo.
 */
export function channelRepo(): string | null {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
  return path.split("/").length === 2 ? channelKey(decodeURIComponent(path)) : null;
}

/** Where the Worker lives: the same origin as the Dashboard unless VITE_CHANNEL_URL says otherwise. */
export function channelBase(): string {
  return ((import.meta.env.VITE_CHANNEL_URL as string | undefined) ?? "").replace(/\/+$/, "");
}

/** Where the Channel API of `repo` lives: `<worker>/r/<owner>/<repo>`. */
export function apiBase(repo: string): string {
  return `${channelBase()}${channelApiBase(repo)}`;
}

/** Sends the browser to GitHub to sign in to `repo`'s Channel. */
export function signIn(repo: string): void {
  window.location.assign(`${channelBase()}/auth/github/start?repo=${encodeURIComponent(repo)}`);
}

/** What one poll of the device flow came back with. */
export type DevicePollResult =
  | { kind: "pending"; slowDown: boolean }
  | { kind: "signed-in" }
  | { kind: "failed"; reason: string };

/** The two calls behind "Sign in with a code"; the sign-in screen takes them as a prop. */
export interface DeviceSignIn {
  start(): Promise<DeviceCodeResponse>;
  poll(deviceCode: string, repo: string): Promise<DevicePollResult>;
}

async function reasonOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { reason?: unknown };
    if (typeof body.reason === "string" && body.reason) return body.reason;
  } catch {
    // not JSON: fall through to the status
  }
  return `Switchboard answered ${res.status}.`;
}

/** GitHub's device flow, with no redirect back: the session arrives as this response's cookie. */
export const deviceSignIn: DeviceSignIn = {
  async start() {
    const res = await fetch(`${channelBase()}/auth/device/code`, { method: "POST", credentials: "include" });
    if (!res.ok) throw new Error(await reasonOf(res));
    return (await res.json()) as DeviceCodeResponse;
  },
  async poll(deviceCode, repo) {
    const res = await fetch(`${channelBase()}/auth/device/session`, {
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ deviceCode, repo }),
    });
    if (!res.ok) return { kind: "failed", reason: await reasonOf(res) };
    const body = (await res.json()) as DeviceSessionResponse;
    return body.ok ? { kind: "signed-in" } : { kind: "pending", slowDown: body.slowDown === true };
  },
};

/** The dev-only fake sign-in (`wrangler dev` with DEV_FAKE_GITHUB): signs in as `login`. */
export function devSignIn(repo: string, login: string): void {
  const query = new URLSearchParams({ login, repo });
  window.location.assign(`${channelBase()}/auth/dev/signin?${query}`);
}

/** Clears the session cookie and goes back to the sign-in screen. */
export async function signOut(): Promise<void> {
  try {
    await fetch(`${channelBase()}/auth/signout`, { method: "POST", credentials: "include" });
  } finally {
    window.location.reload();
  }
}

/**
 * The mock Channel runs with `?mock=1` (demos), or in `npm run dev` unless
 * VITE_LIVE is set. Production builds use the live Channel.
 */
export function wantsMock(): boolean {
  if (new URLSearchParams(window.location.search).get("mock") === "1") return true;
  return import.meta.env.DEV && !import.meta.env.VITE_LIVE;
}
