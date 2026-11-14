# S3 — registration linkage and CLI compatibility
- Implemented native-authorized registration association and server-derived legacy identity (`worker/src/channel.ts:1062`).
- Organization owns execution/session metadata and lifecycle; Channel stores association/outbox IDs only (`worker/src/organization.ts:421`, `worker/src/channel.ts:1132`).
- Gone invalidates association use synchronously; metadata-only retries finalize termination (`worker/src/channel.ts:602`, `:1217`).
- Added hidden-input native redemption, two-attempt expiry handling and memory-only scoped credentials (`cli/src/principal-config.ts:80`, `:130`).
- Managed HTTP/tool-layer headers and no-fallback streaming guards are implemented (`cli/src/channel-client.ts:152`, `:306`).
- Added six worker cases and six CLI cases in new test files (`worker/test/managed-registration.test.ts:101`, `cli/test/managed-executions.test.ts:30`).
- Worker and CLI typecheck/lint passed; targeted Vitest startup failed with read-only Vite cache errors. Zero tests executed.
- Public linked Channels, managed wrapper runs and streams remain closed until P3; no live managed workflow is claimed.
- Full suites, runtime verification and commits remain manager-owned; detailed deviations/escalations are in P2_IMPLEMENTATION_NOTES.md under S3.
