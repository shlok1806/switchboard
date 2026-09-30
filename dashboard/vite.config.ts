import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
    // with SWITCHBOARD_WORKER=http://localhost:8787 and VITE_CHANNEL_URL=/.
    proxy: process.env.SWITCHBOARD_WORKER
      ? {
          // Each Channel's API (/r/<owner>/<repo>/api), sign-in (/auth) and the webhook (/api).
          "/r": { target: process.env.SWITCHBOARD_WORKER, ws: true, changeOrigin: true },
          "/auth": { target: process.env.SWITCHBOARD_WORKER, changeOrigin: true },
          "/api": { target: process.env.SWITCHBOARD_WORKER, changeOrigin: true },
        }
      : undefined,
  },
});
