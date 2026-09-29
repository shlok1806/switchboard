import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import type { JoinCredentials } from "@shared/index";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { HttpChannelSource } from "@/data/http";
import { JoinScreen } from "@/components/domain/join";
import { channelBase, loadCredentials, saveCredentials, wantsMock } from "@/lib/session";
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

type Boot = { kind: "starting" } | { kind: "join"; error?: string; initial?: Partial<JoinCredentials> } | { kind: "ready"; store: ChannelStore };

/**
 * Picks the data source. Production builds use the live Channel on the same
 * origin and ask for the join secret and a Person name first. `?mock=1` (and
 * `npm run dev`, unless VITE_LIVE is set) runs the simulated Channel, which is
 * loaded on demand so it never ships in the live path.
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
    const saved = loadCredentials();
    setBoot(saved ? { kind: "ready", store: new ChannelStore(new HttpChannelSource(channelBase(), saved)) } : { kind: "join" });
  }, []);

  const join = async (credentials: JoinCredentials): Promise<string | null> => {
    const source = new HttpChannelSource(channelBase(), credentials);
    const result = await source.join();
    if (!result.ok) return result.reason;
    saveCredentials(credentials);
    setBoot({ kind: "ready", store: new ChannelStore(source) });
    return null;
  };

  if (boot.kind === "starting") return null;
  if (boot.kind === "join") return <JoinScreen initial={boot.initial} error={boot.error} onJoin={join} />;
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
