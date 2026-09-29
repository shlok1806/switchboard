import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { MockChannelSource } from "@/data/mock/mockSource";
import { HttpChannelSource } from "@/data/http";
import type { ChannelSource } from "@/data/source";
import { initTheme } from "@/lib/theme";

initTheme();

/**
 * Mock by default. Set VITE_CHANNEL_URL (plus VITE_CHANNEL_SECRET and
 * VITE_PERSON) to point the same UI at a real Channel. Use "/" when the
 * Worker serves the Dashboard itself, or behind the dev proxy in vite.config.ts.
 */
function pickSource(): ChannelSource {
  const url = import.meta.env.VITE_CHANNEL_URL as string | undefined;
  if (url) {
    return new HttpChannelSource(url, {
      secret: (import.meta.env.VITE_CHANNEL_SECRET as string | undefined) ?? "",
      person: (import.meta.env.VITE_PERSON as string | undefined) ?? "shlok",
    });
  }
  const speed = Number(new URLSearchParams(window.location.search).get("speed") ?? "1");
  return new MockChannelSource({ speed: Number.isFinite(speed) && speed > 0 ? speed : 1 });
}

const store = new ChannelStore(pickSource());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChannelProvider store={store}>
      <App />
    </ChannelProvider>
  </StrictMode>,
);
