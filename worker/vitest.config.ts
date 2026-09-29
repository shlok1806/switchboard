import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Test values for the Worker secrets that wrangler.jsonc marks required.
process.env.JOIN_SECRET = "test-join-secret";
process.env.JEV_API_KEY = "unused-in-tests";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
// Tests use an in-memory GitHub. Set GITHUB_TOKEN to also run the read-only test
// against the real repo (test/github-live.test.ts).
process.env.GITHUB_TOKEN ??= "";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
