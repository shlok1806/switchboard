import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // $TMPDIR can be too long for a unix socket path: the suite then runs under /tmp.
    globalSetup: ["test/short-tmpdir.ts"],
    testTimeout: 60_000,
    hookTimeout: 90_000,
  },
});
