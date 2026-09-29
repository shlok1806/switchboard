import type { JoinCredentials } from "@shared/index";

const KEY = "switchboard.join";

/** The join secret and Person name this browser remembers, if any. */
export function loadCredentials(): JoinCredentials | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<JoinCredentials>;
    return typeof parsed.secret === "string" && typeof parsed.person === "string"
      ? { secret: parsed.secret, person: parsed.person }
      : null;
  } catch {
    return null;
  }
}

export function saveCredentials(credentials: JoinCredentials): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(credentials));
  } catch {
    /* storage blocked: the Person joins again next visit */
  }
}

export function clearCredentials(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

/** Forget the remembered secret and name, and go back to the join screen. */
export function leaveChannel(): void {
  clearCredentials();
  window.location.reload();
}

/**
 * The mock Channel runs with `?mock=1` (demos), or in `npm run dev` unless
 * VITE_LIVE is set. Production builds use the live Channel.
 */
export function wantsMock(): boolean {
  if (new URLSearchParams(window.location.search).get("mock") === "1") return true;
  return import.meta.env.DEV && !import.meta.env.VITE_LIVE;
}

/** Where the Channel API lives: the same origin as the Dashboard unless VITE_CHANNEL_URL says otherwise. */
export function channelBase(): string {
  return (import.meta.env.VITE_CHANNEL_URL as string | undefined) ?? "";
}
