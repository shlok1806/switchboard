import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Test values for the Worker secrets that wrangler.jsonc marks required.
process.env.JOIN_SECRET = "test-join-secret";
process.env.JEV_API_KEY = "unused-in-tests";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
