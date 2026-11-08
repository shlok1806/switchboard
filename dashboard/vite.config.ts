import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { workerProxy } from "./worker-proxy.ts";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared": path.resolve(import.meta.dirname, "../shared/src"),
    },
  },
  server: {
    port: 5178,
    // Point the dev server at a running Worker (for example `wrangler dev` on :8787)
    // with SWITCHBOARD_WORKER=http://localhost:8787, VITE_CHANNEL_URL=/ and VITE_LIVE=1.
    proxy: process.env.SWITCHBOARD_WORKER ? workerProxy(process.env.SWITCHBOARD_WORKER) : undefined,
  },
});
