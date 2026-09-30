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

// The vars tests rely on, as wrangler.jsonc sets them. A developer's .dev.vars
// overrides vars too (say GITHUB_REPO, pointed at a local stand-in's repo), and
// then every webhook in the tests would be for the wrong repo.
const vars = {
  GITHUB_REPO: "shlok1806/switchboard",
  PRESENCE_GONE_AFTER_SECONDS: "600",
  RELAY_INTERRUPT_THRESHOLD: "0.6",
  RELAY_INTERRUPT_INTERVAL_SECONDS: "20",
  GITHUB_API_URL: "",
  JEV_API_URL: "",
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { ...vars, ...secrets } },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
