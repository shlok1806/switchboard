import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Test values for the Worker secrets that wrangler.jsonc marks required. They are
// passed as bindings too, so a developer's .dev.vars (which holds the real
// JEV_API_KEY for `wrangler dev`) never replaces them.
const secrets = {
  JOIN_SECRET: "test-join-secret",
  // Tests use a Jev stand-in (test/setup.ts). Set JEV_API_KEY to also run the
  // opt-in smoke test against the real Jev (test/jev-live.test.ts).
  JEV_API_KEY: process.env.JEV_API_KEY ?? "",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  // Tests use an in-memory GitHub. Set GITHUB_TOKEN to also run the read-only
  // test against the real repo (test/github-live.test.ts).
  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
};
Object.assign(process.env, secrets);

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: secrets } })],
  test: { setupFiles: ["./test/setup.ts"] },
});
