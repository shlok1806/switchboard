import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import type { AuthConfigResponse, SignInProblem } from "@shared/index";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { HttpChannelSource } from "@/data/http";
import { NoChannelScreen, SignInScreen } from "@/components/domain/join";
import { apiBase, channelBase, channelRepo, devSignIn, signIn, wantsMock } from "@/lib/session";
import { initTheme } from "@/lib/theme";

initTheme();

// After a deploy, an open tab may ask for route chunks that no longer exist.
// Reload once to pick up the new build instead of showing a blank view.
// At most one reload per 30 seconds, so a chunk that is truly missing cannot loop.
window.addEventListener("vite:preloadError", (event) => {
  const KEY = "switchboard.reloadedForBuildAt";
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return; // storage blocked: cannot guard against a loop, so do not reload
  }
  event.preventDefault();
  window.location.reload();
});

type Boot =
  | { kind: "starting" }
  | { kind: "no-channel" }
  | { kind: "sign-in"; repo: string; problem?: string; notConfigured?: string; devSignIn: boolean }
  | { kind: "ready"; store: ChannelStore };

/** What a failed sign-in came back with (`?signin=`), in words. */
const SIGN_IN_PROBLEM: Record<SignInProblem, string> = {
  "not-configured": "GitHub App not configured.",
  "not-a-member": "That GitHub account does not have write access to this repo. Ask its owner to add you.",
  denied: "Sign-in was cancelled on GitHub.",
  expired: "The sign-in took too long. Try again.",
  failed: "GitHub sign-in did not work. Try again.",
  "not-allowed": "This Switchboard has no Channel for that repo.",
};

/** Reads `?signin=` once and takes it off the URL, so a reload does not show it again. */
function takeSignInProblem(): string | undefined {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("signin") as SignInProblem | null;
  if (code === null) return undefined;
  url.searchParams.delete("signin");
  window.history.replaceState(null, "", url);
  return SIGN_IN_PROBLEM[code] ?? SIGN_IN_PROBLEM.failed;
}

async function authConfig(): Promise<AuthConfigResponse | null> {
  try {
    const res = await fetch(`${channelBase()}/auth/config`, { credentials: "include" });
    return res.ok ? ((await res.json()) as AuthConfigResponse) : null;
  } catch {
    return null;
  }
}

/**
 * Picks the data source. Production builds use the live Channel of the repo in the
 * path, `/<owner>/<repo>`, signed in with GitHub (ADR 0007): the session is an
 * HttpOnly cookie, so joining is how the Dashboard learns whether it has one.
 * `?mock=1` (and `npm run dev`, unless VITE_LIVE is set) runs the simulated
 * Channel, which is loaded on demand so it never ships in the live path.
 */
function Root() {
  const [boot, setBoot] = useState<Boot>({ kind: "starting" });

  useEffect(() => {
    if (wantsMock()) {
      const speed = Number(new URLSearchParams(window.location.search).get("speed") ?? "1");
      void import("@/data/mock/mockSource").then(({ MockChannelSource }) =>
        setBoot({
          kind: "ready",
          store: new ChannelStore(new MockChannelSource({ speed: Number.isFinite(speed) && speed > 0 ? speed : 1 })),
        }),
      );
      return;
    }
    const problem = takeSignInProblem();
    const repo = channelRepo();
    void (async () => {
      if (repo === null) {
        // At `/`: open the one Channel this Switchboard has, if there is just one.
        const config = await authConfig();
        const [only, ...more] = config?.repos ?? [];
        if (only !== undefined && more.length === 0) {
          window.location.replace(`/${only}${problem ? window.location.search : ""}`);
          return;
        }
        setBoot({ kind: "no-channel" });
        return;
      }
      const joined = problem ? null : await HttpChannelSource.join(apiBase(repo), repo);
      if (joined?.ok) {
        setBoot({ kind: "ready", store: new ChannelStore(joined.source) });
        return;
      }
      const config = await authConfig();
      const notConfigured = config?.configured === false && !config.devSignIn ? (config.reason ?? "") : undefined;
      // A missing or expired session just asks to sign in; anything else says why.
      const reason = joined && joined.status !== 401 && joined.status !== 503 ? joined.reason : undefined;
      setBoot({
        kind: "sign-in",
        repo,
        problem: problem ?? reason,
        notConfigured: notConfigured === "" ? "Its secrets are not set on this Worker yet." : notConfigured,
        devSignIn: config?.devSignIn ?? false,
      });
    })();
  }, []);

  if (boot.kind === "starting") return null;
  if (boot.kind === "no-channel") return <NoChannelScreen />;
  if (boot.kind === "sign-in") {
    const { repo } = boot;
    return (
      <SignInScreen
        repo={repo}
        problem={boot.problem}
        notConfigured={boot.notConfigured}
        onSignIn={() => signIn(repo)}
        onDevSignIn={boot.devSignIn ? (login) => devSignIn(repo, login) : undefined}
      />
    );
  }
  return (
    <ChannelProvider store={boot.store}>
      <App />
    </ChannelProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
