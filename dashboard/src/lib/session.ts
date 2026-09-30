import { channelApiBase, channelKey } from "@shared/index";

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
