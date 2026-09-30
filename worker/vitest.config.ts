import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Test values for the Worker secrets. They are passed as bindings too, so a
// developer's .dev.vars (which holds the real JEV_API_KEY for `wrangler dev`) never
// replaces them. The GitHub App's secrets are left unset: tests install a
// FakeGitHub (test/fake-github.ts) and a fake sign-in instead.
const secrets = {
  // Tests use a Jev stand-in (test/setup.ts). Set JEV_API_KEY to also run the
  // opt-in smoke test against the real Jev (test/jev-live.test.ts).
  JEV_API_KEY: process.env.JEV_API_KEY ?? "",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  // Must match test/client.ts.
  SESSION_SECRET: "test-session-secret-at-least-32-characters-long",
  GITHUB_APP_ID: "",
  GITHUB_APP_PRIVATE_KEY: "",
  GITHUB_APP_CLIENT_ID: "",
  GITHUB_APP_CLIENT_SECRET: "",
};
Object.assign(process.env, { JEV_API_KEY: secrets.JEV_API_KEY, GITHUB_WEBHOOK_SECRET: secrets.GITHUB_WEBHOOK_SECRET });

// The vars tests rely on. A developer's .dev.vars overrides vars too (say
// ALLOWED_REPOS, pointed at a local stand-in's repo), so every one is pinned here.
const vars = {
  ALLOWED_REPOS: "shlok1806/switchboard,shlok1806/other",
  // The dev-only fake sign-in; the tests call the Worker as localhost (test/client.ts).
  DEV_FAKE_GITHUB: "true",
  PRESENCE_GONE_AFTER_SECONDS: "600",
  RELAY_INTERRUPT_THRESHOLD: "0.6",
  RELAY_INTERRUPT_INTERVAL_SECONDS: "20",
  GITHUB_API_URL: "",
  GITHUB_WEB_URL: "",
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
