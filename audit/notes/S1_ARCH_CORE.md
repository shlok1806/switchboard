# S1 — Phase 1 baseline reading and architecture areas 1–7

Audit date: 2026-11-12. Repository: shlok1806/switchboard; supplied branch `bulletin`; read-only `git log -1` confirms HEAD `fe392689db002edb058eca9b6047be577c5bb656` (merge of #181). All source citations below are relative to that checkout. This report is the sole output of this workstream. No repository files, credentials, remotes or dependencies were changed; no network calls, tests, builds, installs, deployment or write-producing git commands were run.

Evidence notation: **[FACT-CODE]** means source inspected; **[FACT-TEST]** means assertions inspected in a named test, not that the test ran or passed; **[DOC-ONLY]** means documentation evidence alone; **[INFERENCE]** means a conclusion from cited implementation; **[RECOMMENDATION]** means proposed follow-up. “Implemented and verified” means code plus proving test assertions in source only. Baseline execution remains the manager's responsibility. None of the test evidence here establishes production behaviour, real-provider interoperability, or a passing baseline. Existing `baseline_logs/` were not used to infer pass/fail.

## 0. Phase 1 baseline, inventory and lifecycle

### 0.1 Repository and runtime

[FACT-CODE] The principal packages are `cli/` (Node terminal wrapper), `worker/` (Cloudflare HTTP entrypoint and Channel Durable Object), `shared/` (source-only TypeScript domain/wire contracts), and `dashboard/` (React/Vite human interface). The executable maps to `dist/switchboard.js` built from `cli/src/main.ts`; hooks have a separate bundled entrypoint (`cli/package.json:7-16`, scripts `build`/`prepare`). Worker fetch is `worker/src/index.ts:372-373`; its persistent object is exported there at line 56 and instantiated by repo name at lines 64-65. Shared exports its TS index directly (`shared/package.json:6-9`). Dashboard has its own application root (`dashboard/src/main.tsx:1`, `dashboard/src/App.tsx:1`). There is no root package.json in this checkout (file inventory search), so commands are package-local.

[FACT-CODE] Node engine is **>=22.13** (`cli/package.json:10-12`); CI selects Node **22** independently for worker, CLI and dashboard (`.github/workflows/ci.yml:23`, `:39`, `:64`). CLI runtime dependencies include node-pty, MCP SDK, xterm/headless, ws and zod (`cli/package.json:26-32`); the worker declares development tooling including the Cloudflare Vitest pool, Wrangler, tsx, TypeScript and Vitest (`worker/package.json:16-27`); shared declares no dependency block (`shared/package.json:1-10`). Dashboard uses React 19, Radix, dnd-kit, virtualization and Vite/Tailwind tooling (`dashboard/package.json:16-50`). These are manifest requirements, not a claim that every native runtime works on this audit machine.

[DOC-ONLY] README additionally requires git, a GitHub account with write access, and at least one supported coding CLI (`README.md:10-11`). Its installation path is `npm ci`, `npm install -g .` in cli, then `switchboard login --url ...` and `switchboard run claude|codex|gemini` in the Channel repo (`README.md:17-29`, `:55-79`). The four-column support table explicitly includes Cursor (`README.md:333-341`). Git push must be noninteractive (`README.md:49-53`). GitHub App setup documents web/device OAuth, issue/sub-issue/dependency/push/PR webhooks and installation permissions (`docs/github-app-setup.md:18-67`). These setup statements have not been tested against the hosted service.

[FACT-CODE] Wrangler selects `src/index.ts`, compatibility date 2026-08-15, static `ASSETS` from `./site`, and a single **CHANNEL** Durable Object binding of class **Channel** using `new_sqlite_classes` migration v1 (`worker/wrangler.jsonc:4-23`). Its build command calls `scripts/build-site.ts` (`:15-18`). No D1, KV, R2, Queues or Workers AI binding is declared: inspected the complete config and searched `rg -n 'd1_databases|kv_namespaces|r2_buckets|queues|"ai"' worker/wrangler.jsonc` (no matches). This is a configuration finding, not proof those services can never be added elsewhere.

[FACT-CODE] Configured operational controls are ALLOWED_REPOS (three repos), Gone after 600 seconds, Relay threshold 0.6 and minimum interrupt interval 20 seconds, Host live cap 20, lead subtree cap 5, 300 memory notes per UTC day, 200 Brief writes and 200 artifact publishes per day, transcript wait 10 seconds, history wait 3 seconds, spawn wait 45 seconds, Directive attach wait 5 seconds, Quiet claims after 4 hours (`worker/wrangler.jsonc:24-63`). Required secret *names* include JEV_API_KEY and GITHUB_WEBHOOK_SECRET; App/session secret names and configuration failure behaviour are described at `:64-71`. No secret values were read.

[FACT-CODE] Documented executable checks are CLI `npm run typecheck`, `npm run lint`, `npm test` (the last builds first); worker `npm run typecheck`, `npm run lint`, `npm test`; dashboard `npm run lint`, `npm run build`, `npm test`, `npm run shots` (`cli/package.json:13-19`, `worker/package.json:6-14`, `dashboard/package.json:6-14`). CI runs those combinations and installs all three packages for CLI e2e (`.github/workflows/ci.yml:26-55`, `:67-76`). Main-only deployment depends on all three jobs and checks latest main before deploying (`:87-145`). These commands were read, never executed. Local worker dev is wrapped by `scripts/dev-worker.ts` through `worker/package.json:7`; fake GitHub is explicitly localhost-only in `worker/src/auth.ts:33-43`.

[DOC-ONLY] Repository agent guidance uses the CONTEXT glossary and relevant ADRs (`docs/agents/domain.md:5-9`, `:41-51`), maps five triage labels (`docs/agents/triage-labels.md:5-11`), and describes a GitHub-native wayfinder frontier procedure (`docs/agents/issue-tracker.md:38-45`). Those instructions are not evidence of a server scheduler. The shared-message standing rule is in `AGENTS.md:19-25`; actual authority exceptions are discussed in areas 1 and 6.

### 0.2 Main module map

Each row names implementation symbols or a module's exported contract, with its purpose; finer-grained route and storage references follow in the area sections.

| Module/entrypoint | Purpose and evidence |
|---|---|
| CLI `main` / `runCli` | Command dispatch and session wrapper; `cli/src/main.ts:1`, `cli/src/run.ts:1`, PTY spawn `:1166-1175`. |
| `login`, `chooseChannel`, config | Device login, same-Worker session reuse and channel choice; `cli/src/login.ts:104-165`, `cli/src/channel-choice.ts:84-107`, `cli/src/config.ts:39-62`. |
| `ChannelClient`, `AgentLink` | HTTP/stream transport, registration, token transition, heartbeats and recovery; `cli/src/channel-client.ts:224-263`, `cli/src/agent-link.ts:125-197`. |
| `CliAdapter` and four adapters | Per-provider session planning and hooks/MCP installation; `cli/src/clis/adapter.ts:1`, `cli/src/clis/index.ts:1`, Claude `cli/src/clis/claude.ts:65-79`, Codex `cli/src/clis/codex.ts:320-368`, Cursor `cli/src/clis/cursor.ts:205-280`, Gemini `cli/src/clis/gemini.ts:110-170` (all under cli/src/clis). |
| `SwitchboardTools`, `createMcpServer`, `prepareSessionTools` | Local stdio agent tools and private credential handover; `cli/src/mcp-server.ts:494-608`, `:994-1014`, `cli/src/mcp-config.ts:67-105`. |
| task worktrees | Repo validation, branch checkout/push and recovery; `cli/src/task-worktree.ts:134-182`, `cli/src/mcp-server.ts:514-558`. |
| capture/proxy | Hook normalization, shell edit snapshots and API traffic readers; `cli/src/hooks/capture.ts:1`, `cli/src/hooks/shell-edits.ts:1`, `cli/src/proxy/capture.ts:1`, `cli/src/proxy/anthropic.ts:1`, `cli/src/proxy/openai-responses.ts:1`, `cli/src/proxy/gemini.ts:1`. |
| next turn, memory, interrupts, Wake | Queues/digests, guarded PTY injection and idle starts; `cli/src/next-turn.ts:1`, `cli/src/memory.ts:1`, `cli/src/interrupts.ts:521`, `cli/src/wake.ts:46`. |
| Host and local store | Machine-side launch supervision, local limits, retained per-call history; `cli/src/host/supervisor.ts:1`, `cli/src/host/check.ts:98-117`, `cli/src/local-store.ts:1`. |
| Worker fetch and auth | Route parsing/admission, OAuth and signed credentials; `worker/src/index.ts:272-359`, `worker/src/auth-api.ts:94-120`, `worker/src/session.ts:76-99`. |
| `Channel` | Shared composition, alarms, RPC methods, sockets, event sequence/storage/broadcast; `worker/src/channel.ts:490-570`, `:1839-1915`, `:2279-2363`. |
| access/roster | Membership cache, token issuance/revocation, Agent identity/presence; `worker/src/access.ts:92-194`, `worker/src/agents.ts:252`, `:650-733`. |
| Tasks/Claims/StaleClaims/Branches | Issue mirroring, exclusive holds, takeover and PR lifecycle; `worker/src/tasks.ts:86-110`, `worker/src/claims.ts:112-161`, `worker/src/stale-claims.ts:122-197`, `worker/src/branches.ts:89-153`. |
| Relay / HttpJev / deliveries | Overlap, verdict decisions and framed routing; `worker/src/relay/relay.ts:254-327`, `worker/src/relay/jev.ts:66-85`, `worker/src/relay/delivery.ts:169-206`. |
| Directives / Memory / Wakes | Instruction delivery, indexed shared notes, wake accounting; `worker/src/directives.ts:102-130`, `worker/src/memory.ts:65-150`, `worker/src/wakes.ts:33-65`. |
| GitHub adapters | App authentication, installation-token REST, webhook reading and compare diffs; `worker/src/github/app.ts:118`, `worker/src/github/rest.ts:1`, `worker/src/github/webhook.ts:1`, `worker/src/github/diff.ts:1`. |
| remote MCP connector | Separate read-only Channel/GitHub/Brief/costs tools; `worker/src/mcp/server.ts:61`, `worker/src/mcp/tools.ts:117`. |
| shared contracts | Domain, auth, claims, agents, channel, hooks, proxy, relay, memory and wake types; `shared/src/index.ts:1`, `shared/src/domain.ts:1`, `shared/src/wakes.ts:24-50`. |
| scripts | `build-site.ts` builds dashboard/static fallback; `dev-worker.ts` supervises local Wrangler; `channel.ts` administers history indexes (`scripts/build-site.ts:1`, `scripts/dev-worker.ts:1`, `scripts/channel.ts:1`). |


[FACT-CODE] Complete source/script filename inventory (each file cited at line 1; purposes of main modules are mapped above). Files are grouped by directory to make the package boundaries reviewable; node_modules, generated outputs and credentials are excluded.

- **cli/src — 78 files**: `cli/src/account-label.ts:1`; `cli/src/agent-link.ts:1`; `cli/src/approvals.ts:1`; `cli/src/artifacts-command.ts:1`; `cli/src/artifacts.ts:1`; `cli/src/channel-choice.ts:1`; `cli/src/channel-client.ts:1`; `cli/src/channel-net.ts:1`; `cli/src/channel-socket.ts:1`; `cli/src/claude-session.ts:1`; `cli/src/clis/adapter.ts:1`; `cli/src/clis/claude.ts:1`; `cli/src/clis/codex-route.ts:1`; `cli/src/clis/codex-tools.ts:1`; `cli/src/clis/codex.ts:1`; `cli/src/clis/cursor.ts:1`; `cli/src/clis/gemini-route.ts:1`; `cli/src/clis/gemini-tools.ts:1`; `cli/src/clis/gemini.ts:1`; `cli/src/clis/index.ts:1`; `cli/src/config.ts:1`; `cli/src/dataset/command.ts:1`; `cli/src/dataset/outcomes.ts:1`; `cli/src/dataset/parse.ts:1`; `cli/src/dataset/schema.ts:1`; `cli/src/dataset/sources.ts:1`; `cli/src/dataset/sync.ts:1`; `cli/src/hooks/capture.ts:1`; `cli/src/hooks/hook-command.ts:1`; `cli/src/hooks/shell-edits.ts:1`; `cli/src/hooks/summarize.ts:1`; `cli/src/host/allow.ts:1`; `cli/src/host/check.ts:1`; `cli/src/host/commands.ts:1`; `cli/src/host/files.ts:1`; `cli/src/host/launchd.ts:1`; `cli/src/host/supervisor.ts:1`; `cli/src/interrupts.ts:1`; `cli/src/keepalive.ts:1`; `cli/src/librarian.ts:1`; `cli/src/local-store.ts:1`; `cli/src/login.ts:1`; `cli/src/main.ts:1`; `cli/src/mcp-config.ts:1`; `cli/src/mcp-server.ts:1`; `cli/src/memory.ts:1`; `cli/src/model-watch.ts:1`; `cli/src/next-turn.ts:1`; `cli/src/onboarding.ts:1`; `cli/src/presence.ts:1`; `cli/src/proxy/anthropic.ts:1`; `cli/src/proxy/api.ts:1`; `cli/src/proxy/capture.ts:1`; `cli/src/proxy/gemini.ts:1`; `cli/src/proxy/openai-responses.ts:1`; `cli/src/proxy/options.ts:1`; `cli/src/proxy/server.ts:1`; `cli/src/proxy/turn.ts:1`; `cli/src/proxy/websocket.ts:1`; `cli/src/rename.ts:1`; `cli/src/run.ts:1`; `cli/src/session-context.ts:1`; `cli/src/session-settings.ts:1`; `cli/src/skills-command.ts:1`; `cli/src/skills.ts:1`; `cli/src/task-worktree.ts:1`; `cli/src/terminal/attach-keys.ts:1`; `cli/src/terminal/gate.ts:1`; `cli/src/terminal/keyboard.ts:1`; `cli/src/terminal/paste.ts:1`; `cli/src/terminal/presence.ts:1`; `cli/src/terminal/screen.ts:1`; `cli/src/transcript.ts:1`; `cli/src/usage/limits.ts:1`; `cli/src/usage/schedule.ts:1`; `cli/src/usage/session.ts:1`; `cli/src/usage/watch.ts:1`; `cli/src/wake.ts:1`.
- **worker/src — 67 files**: `worker/src/access.ts:1`; `worker/src/agents-api.ts:1`; `worker/src/agents.ts:1`; `worker/src/alarms.ts:1`; `worker/src/artifacts-api.ts:1`; `worker/src/artifacts.ts:1`; `worker/src/ask.ts:1`; `worker/src/auth-api.ts:1`; `worker/src/auth.ts:1`; `worker/src/branches-api.ts:1`; `worker/src/branches.ts:1`; `worker/src/brief-api.ts:1`; `worker/src/brief.ts:1`; `worker/src/channel.ts:1`; `worker/src/claims-api.ts:1`; `worker/src/claims.ts:1`; `worker/src/directives-api.ts:1`; `worker/src/directives.ts:1`; `worker/src/github/app.ts:1`; `worker/src/github/code-webhook.ts:1`; `worker/src/github/diff.ts:1`; `worker/src/github/index.ts:1`; `worker/src/github/rest.ts:1`; `worker/src/github/steps.ts:1`; `worker/src/github/types.ts:1`; `worker/src/github/webhook.ts:1`; `worker/src/hook-capture.ts:1`; `worker/src/hosts-api.ts:1`; `worker/src/hosts.ts:1`; `worker/src/http.ts:1`; `worker/src/index.ts:1`; `worker/src/langfuse.ts:1`; `worker/src/librarian-api.ts:1`; `worker/src/librarian.ts:1`; `worker/src/mcp/brief.ts:1`; `worker/src/mcp/costs.ts:1`; `worker/src/mcp/format.ts:1`; `worker/src/mcp/github.ts:1`; `worker/src/mcp/grants.ts:1`; `worker/src/mcp/oauth.ts:1`; `worker/src/mcp/pages.ts:1`; `worker/src/mcp/paths.ts:1`; `worker/src/mcp/server.ts:1`; `worker/src/mcp/since.ts:1`; `worker/src/mcp/tokens.ts:1`; `worker/src/mcp/tools.ts:1`; `worker/src/memory-api.ts:1`; `worker/src/memory.ts:1`; `worker/src/proxy-capture.ts:1`; `worker/src/relay/delivery.ts:1`; `worker/src/relay/jev.ts:1`; `worker/src/relay/overlap.ts:1`; `worker/src/relay/relay.ts:1`; `worker/src/search-words.ts:1`; `worker/src/secret-box.ts:1`; `worker/src/session.ts:1`; `worker/src/settings-api.ts:1`; `worker/src/skills-api.ts:1`; `worker/src/skills.ts:1`; `worker/src/stale-claims.ts:1`; `worker/src/status-comment.ts:1`; `worker/src/takeover-api.ts:1`; `worker/src/tasks-api.ts:1`; `worker/src/tasks.ts:1`; `worker/src/terminal.ts:1`; `worker/src/usage.ts:1`; `worker/src/wakes.ts:1`.
- **shared/src — 30 files**: `shared/src/agent-context.ts:1`; `shared/src/agents.ts:1`; `shared/src/approvals.ts:1`; `shared/src/artifacts.ts:1`; `shared/src/auth.ts:1`; `shared/src/branches.ts:1`; `shared/src/brief.ts:1`; `shared/src/channel.ts:1`; `shared/src/claims.ts:1`; `shared/src/describe.ts:1`; `shared/src/directives.ts:1`; `shared/src/domain.ts:1`; `shared/src/escapes.ts:1`; `shared/src/history.ts:1`; `shared/src/hooks.ts:1`; `shared/src/hosts.ts:1`; `shared/src/index.ts:1`; `shared/src/langfuse.ts:1`; `shared/src/librarian.ts:1`; `shared/src/mask.ts:1`; `shared/src/memory.ts:1`; `shared/src/proxy.ts:1`; `shared/src/relay.ts:1`; `shared/src/secrets.ts:1`; `shared/src/skills.ts:1`; `shared/src/summary.ts:1`; `shared/src/terminal.ts:1`; `shared/src/transcript.ts:1`; `shared/src/usage.ts:1`; `shared/src/wakes.ts:1`.
- **scripts — 3 files**: `scripts/build-site.ts:1`; `scripts/channel.ts:1`; `scripts/dev-worker.ts:1`.

### 0.3 Test-source inventory

The counts below come from `rg -c '^\s*(it|test)(\.[A-Za-z_]+)*\s*\('` per test source, ignoring node_modules. They count direct it()/test() declaration lines, including skipped/conditional declarations where matching; they are neither assertion counts nor executed-case totals (parameterization can differ). Zero means a test-named source has no direct matching declaration. Shared has no independent test directory; shared behaviour is exercised from consumer packages. Every count cites that file's first matching declaration, or line 1 for zero.


**cli**: 35 test files.

- `cli/test/account-label.test.ts:26` — 6.
- `cli/test/agent-link.test.ts:51` — 3.
- `cli/test/approvals.test.ts:23` — 17.
- `cli/test/artifacts.test.ts:25` — 9.
- `cli/test/channel-choice.test.ts:123` — 14.
- `cli/test/claude-session.test.ts:27` — 9.
- `cli/test/clis.test.ts:22` — 10.
- `cli/test/dataset.test.ts:233` — 10.
- `cli/test/e2e.test.ts:476` — 94.
- `cli/test/help.test.ts:13` — 1.
- `cli/test/host-allow.test.ts:42` — 5.
- `cli/test/host-check.test.ts:48` — 15.
- `cli/test/host-frames.test.ts:62` — 1.
- `cli/test/host.test.ts:18` — 4.
- `cli/test/interrupts.test.ts:12` — 56.
- `cli/test/local-store.test.ts:58` — 4.
- `cli/test/mask.test.ts:180` — 7.
- `cli/test/memory.test.ts:34` — 9.
- `cli/test/model-watch.test.ts:14` — 6.
- `cli/test/next-turn.test.ts:72` — 2.
- `cli/test/proxy-apis.test.ts:136` — 10.
- `cli/test/proxy-parsers.test.ts:76` — 27.
- `cli/test/proxy.test.ts:165` — 13.
- `cli/test/read-channel.test.ts:27` — 1.
- `cli/test/rename.test.ts:29` — 3.
- `cli/test/secrets.test.ts:64` — 3.
- `cli/test/session-context.test.ts:23` — 7.
- `cli/test/session-settings.test.ts:26` — 8.
- `cli/test/shell-edits.test.ts:65` — 14.
- `cli/test/summarize.test.ts:17` — 7.
- `cli/test/task-worktree.test.ts:12` — 7.
- `cli/test/terminal.test.ts:86` — 60.
- `cli/test/transcript.test.ts:15` — 15.
- `cli/test/usage.test.ts:20` — 19.
- `cli/test/wake.test.ts:44` — 10.

Direct declaration total: **486**.

**worker**: 33 test files.

- `worker/test/agents.test.ts:147` — 33.
- `worker/test/artifacts.test.ts:101` — 13.
- `worker/test/ask-channel.test.ts:314` — 15.
- `worker/test/ask-github.test.ts:163` — 7.
- `worker/test/branches.test.ts:121` — 14.
- `worker/test/brief.test.ts:107` — 10.
- `worker/test/channel.test.ts:131` — 8.
- `worker/test/claims.test.ts:84` — 19.
- `worker/test/costs.test.ts:180` — 10.
- `worker/test/cross-person.test.ts:35` — 24.
- `worker/test/directives.test.ts:175` — 19.
- `worker/test/github-app.test.ts:83` — 4.
- `worker/test/github-live.test.ts:21` — 1.
- `worker/test/handoff.test.ts:143` — 6.
- `worker/test/history-indexes.test.ts:29` — 3.
- `worker/test/history.test.ts:108` — 6.
- `worker/test/hooks.test.ts:173` — 10.
- `worker/test/hosts.test.ts:36` — 17.
- `worker/test/identity.test.ts:121` — 23.
- `worker/test/jev-live.test.ts:30` — 1.
- `worker/test/librarian.test.ts:150` — 12.
- `worker/test/memory.test.ts:127` — 9.
- `worker/test/proxy.test.ts:201` — 10.
- `worker/test/relay.test.ts:358` — 35.
- `worker/test/roles.test.ts:51` — 12.
- `worker/test/rows-read.test.ts:311` — 16.
- `worker/test/rows-written.test.ts:167` — 2.
- `worker/test/skills.test.ts:99` — 12.
- `worker/test/stale-claims.test.ts:136` — 13.
- `worker/test/tasks.test.ts:101` — 14.
- `worker/test/terminal.test.ts:127` — 14.
- `worker/test/transcript.test.ts:123` — 7.
- `worker/test/usage.test.ts:112` — 7.

Direct declaration total: **406**.

**dashboard**: 29 test files.

- `dashboard/test/activity.test.tsx:130` — 19.
- `dashboard/test/agents-view.test.tsx:76` — 12.
- `dashboard/test/artifacts.test.tsx:130` — 15.
- `dashboard/test/attach-key.test.ts:12` — 10.
- `dashboard/test/brief.test.tsx:68` — 5.
- `dashboard/test/canvas-layout.test.ts:46` — 12.
- `dashboard/test/canvas-view.test.tsx:92` — 10.
- `dashboard/test/context.test.tsx:18` — 2.
- `dashboard/test/focus-motion.test.tsx:57` — 4.
- `dashboard/test/handoff.test.tsx:86` — 5.
- `dashboard/test/host-sharing.test.tsx:64` — 2.
- `dashboard/test/memory-hosts.test.tsx:62` — 13.
- `dashboard/test/now-view.test.tsx:58` — 3.
- `dashboard/test/orb.test.tsx:80` — 2.
- `dashboard/test/palette-channels.test.tsx:42` — 1.
- `dashboard/test/palette.test.tsx:69` — 9.
- `dashboard/test/queue.test.ts:36` — 7.
- `dashboard/test/router.test.tsx:16` — 11.
- `dashboard/test/settings.test.tsx:45` — 5.
- `dashboard/test/sign-in-code.test.tsx:45` — 4.
- `dashboard/test/skills.test.tsx:80` — 5.
- `dashboard/test/start-agent.test.tsx:69` — 13.
- `dashboard/test/states.test.tsx:49` — 12.
- `dashboard/test/tasks.test.tsx:124` — 15.
- `dashboard/test/terminal-screen.test.tsx:29` — 3.
- `dashboard/test/terminal-stream.test.ts:84` — 3.
- `dashboard/test/usage.test.tsx:12` — 3.
- `dashboard/test/use-mobile.test.tsx:26` — 2.
- `dashboard/test/worker-proxy.test.ts:73` — 3.

Direct declaration total: **210**.

**shared**: 0 test files.


Direct declaration total: **0**.

### 0.4 ADR index (all files present)

[FACT-CODE] File inventory contains **47** ADRs, numbered 0001–0029 and 0037–0054. “Found” below means a corresponding implementation was located, not exhaustive conformance certification for out-of-scope UI/skills/dataset ADRs. [DOC-ONLY] Titles and decisions are from the cited ADR; [FACT-CODE] the final column identifies the implementing symbol/module. Several ADRs still say “proposed” despite implementation; code/test status in sections 1–7 takes precedence over that label.

| ADR / title and document evidence | One-line decision | Implementation located |
|---|---|---|
| 0001 — Tasks mirror GitHub Issues one-to-one, with per-field ownership (`docs/adr/0001-tasks-mirror-github-issues-with-field-ownership.md:1`) | Mirror GitHub-owned fields; keep local claims/status. | Found: `worker/src/tasks.ts:96`; corresponding module above/below. |
| 0002 — Stale Claims never expire on their own (`docs/adr/0002-stale-claims-never-auto-expire.md:1`) | Keep stale holds until human takeover. | Found: `worker/src/stale-claims.ts:122`; corresponding module above/below. |
| 0003 — Relay Verdicts come from Jev, not a general LLM (`docs/adr/0003-relay-verdicts-use-jev.md:1`) | Use typed Jev verdicts; transport differs from ADR. | Found: `worker/src/relay/jev.ts:74`; corresponding module above/below. |
| 0004 — The channel and the Relay run centrally on Cloudflare (`docs/adr/0004-central-relay-hosted-on-cloudflare.md:1`) | Central per-repo DO; local history later supersedes full central storage. | Found: `worker/src/index.ts:64`; corresponding module above/below. |
| 0005 — Agents inform each other; only People instruct (`docs/adr/0005-agents-inform-only-people-instruct.md:1`) | Frame Agent content as information; lead exception in 0018. | Found: `worker/src/relay/delivery.ts:169`; corresponding module above/below. |
| 0006 — One branch and PR per Task (`docs/adr/0006-one-branch-and-pr-per-task.md:1`) | Use one task branch/worktree and closing PR. | Found: `cli/src/mcp-server.ts:502`; corresponding module above/below. |
| 0007 — A Person is a GitHub account; one Channel per repo; one GitHub App for sign-in and writes (`docs/adr/0007-github-identity-one-channel-per-repo.md:1`) | Use GitHub identity, membership and scoped Agent tokens. | Found: `worker/src/access.ts:92`; corresponding module above/below. |
| 0008 — One CLI login serves every Channel on a Worker; each command picks its Channel (`docs/adr/0008-one-login-serves-every-channel.md:1`) | Reuse one Worker session across selected repos. | Found: `cli/src/channel-choice.ts:84`; corresponding module above/below. |
| 0009 — Nicknames change on a live Agent; each Agent shows the login it runs under (`docs/adr/0009-live-nicknames-and-account-labels.md:1`) | Live rename and optional non-authoritative account labels. | Found: `worker/src/agents.ts:478`; corresponding module above/below. |
| 0010 — Each Agent shows the model it runs on, as its requests ask for it (`docs/adr/0010-show-the-model-each-agent-runs-on.md:1`) | Report model changes from captured requests. | Found: `worker/src/agents.ts:497`; corresponding module above/below. |
| 0011 — Each Agent reports its account's usage, as Claude Code's own `/usage` says it (`docs/adr/0011-show-each-accounts-usage-from-claude-codes-own-usage.md:1`) | Report account usage separately from session activity. | Found: `worker/src/usage.ts:1`; corresponding module above/below. |
| 0012 — Each Agent shows its current context and brief from its own session (`docs/adr/0012-show-each-agents-context-from-its-session.md:1`) | Report current context from local session files. | Found: `cli/src/session-context.ts:1`; corresponding module above/below. |
| 0013 — Answering an Agent's permission prompts away from its terminal (`docs/adr/0013-answering-an-agents-permission-prompts-away-from-its-terminal.md:1`) | Show pending approval without silently granting it. | Found: `worker/src/agents.ts:520`; corresponding module above/below. |
| 0014 — Denying a Claude Code permission prompt from the Channel (`docs/adr/0014-denying-a-claude-code-permission-prompt-from-the-channel.md:1`) | Allow Claude remote deny through owned wrapper. | Found: `worker/src/agents.ts:542`; corresponding module above/below. |
| 0015 — Hosts start and stop Agents with no window (`docs/adr/0015-hosts-start-and-stop-agents-with-no-window.md:1`) | Run supervised headless Agents on Hosts. | Found: `cli/src/host/supervisor.ts:1`; corresponding module above/below. |
| 0016 — One design system for the Dashboard and the canvas (`docs/adr/0016-one-design-system-for-the-dashboard-and-the-canvas.md:1`) | Share dashboard design tokens; later amended. | Found: `dashboard/src/styles/tokens.css:1`; corresponding module above/below. |
| 0017 — A Host trusts only its own install-time limits (`docs/adr/0017-a-host-trusts-only-its-own-install-time-limits.md:1`) | Enforce Host roots and modes locally. | Found: `cli/src/host/check.ts:98`; corresponding module above/below. |
| 0018 — A Person may make one of their Agents a lead (`docs/adr/0018-a-person-may-make-an-agent-a-lead.md:1`) | Delegate subtree control only to Person-granted leads. | Found: `worker/src/channel.ts:993`; corresponding module above/below. |
| 0019 — Agents share memory on the Channel (`docs/adr/0019-agents-share-memory-on-the-channel.md:1`) | Store explicit notes; pull redacted live transcripts. | Found: `worker/src/memory.ts:65`; corresponding module above/below. |
| 0020 — The canvas is a view of the Channel (`docs/adr/0020-the-canvas-is-a-view-of-the-channel.md:1`) | Render canvas from shared Channel state. | Found: `dashboard/src/views/CanvasView.tsx:1`; corresponding module above/below. |
| 0021 — A live terminal that the owning wrapper guards (`docs/adr/0021-a-live-terminal-the-owning-wrapper-guards.md:1`) | Guard live terminal access on owning wrapper. | Found: `cli/src/terminal/gate.ts:1`; corresponding module above/below. |
| 0022 — One typist holds an Agent's keyboard (`docs/adr/0022-one-typist-holds-an-agents-keyboard.md:1`) | Permit one keyboard holder at a time. | Found: `cli/src/terminal/keyboard.ts:1`; corresponding module above/below. |
| 0023 — The Dashboard has one signal colour (`docs/adr/0023-the-dashboard-has-one-signal-colour.md:1`) | Use one signal colour; later design revisions apply. | Found: `dashboard/src/styles/tokens.css:1`; corresponding module above/below. |
| 0024 — Agents carry context to each other (`docs/adr/0024-agents-carry-context-to-each-other.md:1`) | Share summaries, prioritized memory and handoff context. | Found: `worker/src/channel.ts:927`; corresponding module above/below. |
| 0025 — A Directive waits briefly for its wrapper to attach (`docs/adr/0025-a-directive-waits-briefly-for-its-wrapper-to-attach.md:1`) | Persist brief Directive attach holds. | Found: `worker/src/directives.ts:201`; corresponding module above/below. |
| 0026 — Addressed Updates (`docs/adr/0026-addressed-updates.md:1`) | Deliver explicit addressee Updates at least as Queue. | Found: `worker/src/relay/relay.ts:207`; corresponding module above/below. |
| 0027 — Cursor CLI on the Channel (`switchboard run cursor`) (`docs/adr/0027-cursor-cli-on-the-channel.md:1`) | Add Cursor adapter with explicit unsupported capabilities. | Found: `cli/src/clis/cursor.ts:205`; corresponding module above/below. |
| 0028 — Cross-Person Host control, Paused Agents and a current roster (`docs/adr/0028-cross-person-host-control-and-paused-agents.md:1`) | Locally authorize shared Hosts and keep paused sessions. | Found: `cli/src/host/check.ts:60`; corresponding module above/below. |
| 0029 — Codex Agents wake; Gemini CLI Agents do not yet (`docs/adr/0029-codex-agents-wake-gemini-cli-agents-do-not-yet.md:1`) | Enable Codex Wake; leave Gemini disabled. | Found: `cli/src/clis/codex.ts:325`; corresponding module above/below. |
| 0037 — Per-call Events stay on the machine that made them (`docs/adr/0037-per-call-events-stay-on-their-machine.md:1`) | Keep per-call records locally; retain shared state centrally. | Found: `worker/src/channel.ts:2290`; corresponding module above/below. |
| 0038 — A first-run guide in the terminal (`docs/adr/0038-a-first-run-guide-in-the-terminal.md:1`) | Show terminal onboarding once per Person/machine. | Found: `cli/src/onboarding.ts:1`; corresponding module above/below. |
| 0039 — Persons share skills on the Channel (`docs/adr/0039-persons-share-skills-on-the-channel.md:1`) | Share versioned skills with controlled writes. | Found: `cli/src/skills.ts:1`; corresponding module above/below. |
| 0040 — Ask the Channel: a read-only MCP connector any app can add (`docs/adr/0040-ask-the-channel-a-read-only-mcp-connector.md:1`) | Expose distinct read-only OAuth MCP connector. | Found: `worker/src/mcp/server.ts:61`; corresponding module above/below. |
| 0041 — The Connector's github tool reads GitHub live, through the App (`docs/adr/0041-the-connectors-github-tool-reads-github-live.md:1`) | Read GitHub live through App for connector. | Found: `worker/src/mcp/github.ts:1`; corresponding module above/below. |
| 0042 — The Brief: short pages Agents keep on where the repo stands, and the brief tool (`docs/adr/0042-the-brief-agents-keep-of-the-repo.md:1`) | Let Agents maintain versioned Brief pages. | Found: `worker/src/brief.ts:1`; corresponding module above/below. |
| 0043 — A search matches any of its words, those matching more first (`docs/adr/0043-a-search-matches-any-of-its-words.md:1`) | Search by any query word. | Found: `worker/src/memory.ts:49`; corresponding module above/below. |
| 0044 — The costs tool reads the repo's own Langfuse, with a key only the owner sets (`docs/adr/0044-the-costs-tool-reads-the-repos-own-langfuse.md:1`) | Read repo Langfuse metrics live. | Found: `worker/src/mcp/costs.ts:1`; corresponding module above/below. |
| 0045 — A librarian Agent keeps the Brief current, and can write nothing else (`docs/adr/0045-a-librarian-agent-keeps-the-brief-current.md:1`) | Constrain one librarian to Brief maintenance. | Found: `cli/src/librarian.ts:1`; corresponding module above/below. |
| 0046 — A librarian spawn never ends as a plain Agent (`docs/adr/0046-a-librarian-spawn-never-ends-as-a-plain-agent.md:1`) | Keep librarian spawn identity across failure/retry. | Found: `worker/src/librarian.ts:1`; corresponding module above/below. |
| 0047 — An Agent's state shows a thinking orb (`docs/adr/0047-an-agents-state-shows-a-thinking-orb.md:1`) | Show thinking state in the UI. | Found: `dashboard/src/components/domain/state.tsx:1`; corresponding module above/below. |
| 0048 — A silent socket is replaced (`docs/adr/0048-a-silent-socket-is-replaced.md:1`) | Replace sockets after missing traffic/pongs. | Found: `cli/src/keepalive.ts:38`; corresponding module above/below. |
| 0049 — The Dashboard is a desk in five sections (`docs/adr/0049-the-dashboard-is-a-desk-in-five-sections.md:1`) | Organize dashboard into five desk sections. | Found: `dashboard/src/components/shell/nav.tsx:1`; corresponding module above/below. |
| 0050 — A shared skill holds any files, up to 64 MB, and is refused only for a real secret (`docs/adr/0050-a-skill-is-any-files-of-any-size.md:1`) | Chunk versioned arbitrary skill files. | Found: `worker/src/skills.ts:1`; corresponding module above/below. |
| 0051 — A shared skill leaves out its installed packages (`docs/adr/0051-a-shared-skill-leaves-out-its-installed-packages.md:1`) | Exclude installed packages from shared skills. | Found: `cli/src/skills.ts:1`; corresponding module above/below. |
| 0052 — One bad Channel cannot take the machine down (`docs/adr/0052-one-bad-channel-cannot-take-the-machine-down.md:1`) | Bound connections, retries and local dev lifetime. | Found: `cli/src/channel-client.ts:276`; corresponding module above/below. |
| 0053 — Artifacts: HTML pages shared on the Channel and shown in a sandbox (`docs/adr/0053-artifacts-html-pages-shown-in-a-sandbox.md:1`) | Share HTML artifacts under sandboxed rendering. | Found: `worker/src/artifacts-api.ts:1`; corresponding module above/below. |
| 0054 — A local Dataset of the owner's own sessions, linked to how they turned out (`docs/adr/0054-a-local-dataset-of-the-owners-own-sessions.md:1`) | Collect redacted owner-only local session Dataset. | Found: `cli/src/dataset/sync.ts:1`; corresponding module above/below. |

[DOC-ONLY] ADRs 0034/0035 are referenced as not-yet-committed in `docs/adr/0039-persons-share-skills-on-the-channel.md:3`; that does not establish their implementation or current agreed specification. Search: `rg --files docs/adr` plus `rg -n '0030|0031|0032|0033|0034|0035|0036' docs/adr` finds references but no corresponding numbered files. The index does not invent seven missing decisions.

### 0.5 End-to-end coding Agent lifecycle

1. **Person sign-in.** [FACT-CODE] `login()` starts `/auth/device/code` and polls `/auth/device/token`, then saves the session (`cli/src/login.ts:131-165`; config write `cli/src/config.ts:62`). Worker `handleAuthRoute` dispatches device and browser flows (`worker/src/auth-api.ts:94-120`); browser callback checks state cookie, exchanges the code, checks membership and issues a signed session (`:157-192`). `signSession` creates an HMAC-signed 30-day Person credential (`worker/src/session.ts:17`, `:76-86`). The Channel's `Access.checkMember` caches GitHub permissions in `members` (`worker/src/access.ts:118-148`). This is a Worker-wide Person session, not an Agent identity.
2. **Choose and join.** [FACT-CODE] `chooseChannel()` chooses explicit repo, environment, directory origin or default (`cli/src/channel-choice.ts:84-107`). `ChannelClient.join()` posts the Person session to `/r/<owner>/<repo>/api/join` (`cli/src/channel-client.ts:224-227`). Worker `handleJoin` calls `Channel.join`; `channelOf` selects the DO named by repo (`worker/src/index.ts:64-79`). Person rows are `persons(name,time_zone,joined_at)` (`worker/src/channel.ts:490-494`). Startup validates the target checkout (`cli/src/task-worktree.ts:134-162`), before the PTY launches (`cli/src/run.ts:1166-1175`).
3. **Register session, narrow credential.** [FACT-CODE] `AgentLink.registerNow()` sends session ID/CLI/cwd and optional metadata (`cli/src/agent-link.ts:156-195`) via `ChannelClient.register` (`cli/src/channel-client.ts:231-237`), `POST /api/agents` through `handleAgentRoute` (`worker/src/index.ts:330`, `worker/src/agents-api.ts:1`). `Channel.registerAgent` calls roster registration (`worker/src/channel.ts:815-845`); token issuance in `Channel.registerAgent` calls `Access.issueAgentToken` (`worker/src/channel.ts:855`, `worker/src/access.ts:179-189`). Agent metadata is in `agents` (`worker/src/agents.ts:79-104`). The MCP process receives only the Agent ID/token file, via `prepareSessionTools.setAgent` (`cli/src/mcp-config.ts:99-105`), and the stream reopens under Agent credentials. Resume uses the same logical Agent ID; collision handling is explicit (`cli/src/agent-link.ts:125-135`).
4. **Presence.** [FACT-CODE] `IdleWatch` derives live/idle from terminal output inactivity (`cli/src/presence.ts:22-44`); `AgentLink.start` heartbeats (`cli/src/agent-link.ts:215-217`), `ChannelClient.heartbeat` posts its own Agent route (`cli/src/channel-client.ts:239-255`), `Channel.heartbeat` updates roster and returns pending items (`worker/src/channel.ts:941-950`, `:972-982`). `AgentRoster.expireSilent` decides Gone (`worker/src/agents.ts:708-733`); the Channel marks claims stale, revokes tokens and closes sockets (`worker/src/channel.ts:554-559`). Roster updates and Events broadcast to subscribers (`worker/src/agents.ts:828-838`, `worker/src/channel.ts:2360-2363`).
5. **Discover and claim.** [FACT-CODE] The injected MCP `list_tasks` reads `/api/tasks` and filters optional status locally (`cli/src/mcp-server.ts:494-499`). Worker Task route calls `Channel.listTasks` (`worker/src/tasks-api.ts:36-47`), then `Tasks.list` runs initial sync/read (`worker/src/tasks.ts:166-171`). `claim_task` posts the issue-number claim route (`cli/src/mcp-server.ts:502-506`), matched by `claims-api` (`worker/src/claims-api.ts:3-5`), through `Channel.claimTask` (`worker/src/channel.ts:743-745`) to `Claims.claim` (`worker/src/claims.ts:112-161`). That synchronous decision writes Task JSON, emits `claim`, updates status history, then mirrors GitHub. `Tasks.write` stores and broadcasts `task` (`worker/src/tasks.ts:420-432`); `Channel.insert` stores/broadcasts the Event and schedules Relay (`worker/src/channel.ts:2314-2336`).
6. **Work on branch/worktree.** [FACT-CODE] After the claim succeeds, MCP `openBranch` invokes local `openTaskWorktree`, then reports the branch to the Worker (`cli/src/mcp-server.ts:514-525`). `Channel.recordBranch` calls `Branches.record` (`worker/src/channel.ts:756-758`); `task.branch` records the result (`worker/src/branches.ts:75-81`). The tool returns a guide telling the Agent where to work; it does not move the already-running CLI process to another cwd (`cli/src/mcp-server.ts:919-925`, PTY cwd `cli/src/run.ts:1166-1171`). Hooks/proxy/tool calls provide observation; no filesystem sandbox is created by the Claim itself.
7. **Updates and received messages.** [FACT-CODE] `post_update` → `/api/updates` → `handlePostUpdate` → `Channel.postUpdate` → `append/insert` → stored Event/broadcast → `Relay.consider` (`cli/src/mcp-server.ts:575-578`, `worker/src/index.ts:145-162`, `worker/src/channel.ts:1148-1181`, `:2279-2336`). Relay generates recipient-specific deliveries; WS sends them to wrappers or register/heartbeat drains stored queues (`worker/src/relay/relay.ts:266-277`, `worker/src/channel.ts:972-982`). Next-turn hooks or `read_channel`, and capable adapters' guarded Interrupt/Wake path, add framed context (`cli/src/run.ts:704-740`, `cli/src/mcp-server.ts:904-925`).
8. **Finish/release/end.** [FACT-CODE] `finish_task` reads Task, recovers branch if necessary, pushes committed branch, calls finish API; `Channel.finishTask` delegates to `Branches.finish`, which creates a closing PR and moves Task to review (`cli/src/mcp-server.ts:582-593`, `worker/src/channel.ts:762-763`, `worker/src/branches.ts:89-153`). Issue close from GitHub later makes it done (`worker/src/tasks.ts:335-361`). `release_task` independently frees the hold (`cli/src/mcp-server.ts:561-565`, `worker/src/claims.ts:164-195`). Session exit calls link end (`cli/src/run.ts:1283`); ending the session does not release unfinished work, it makes the Agent Gone and claim stale (area 3).

## 1. Identity, membership, registration and authentication

**Status: Implemented and verified.** This status applies to GitHub-based membership, scoped session/Agent credentials and local Host limits, with the source-test and live-service limits below.

### How it works / data model

[FACT-CODE] A Person's trusted identity is the normalized GitHub login; Agent identity combines that Person with CLI/session suffix, not a self-asserted account label (`worker/src/agents.ts:252-285`; `CONTEXT.md:159-180` defines the terms). Four-character Agent identifiers may collide; registration rejects a different full session occupying one ID, while wrapper-picked sessions retry up to five choices (`cli/src/agent-link.ts:125-135`). Agent roster persists identity, presence and metadata (`worker/src/agents.ts:79-104`). Channel-local `persons` stores timezone/join time (`worker/src/channel.ts:490-494`). GitHub permission determines membership, with write/maintain/admin admitted through `canWrite` (`worker/src/access.ts:133-148`, `worker/src/github/types.ts:1`).

[FACT-CODE] `channel_meta` stores repo, `members` stores allowed/check time, `agent_tokens` stores hash/Agent/Person/issued time, plus a migrated librarian bit (`worker/src/access.ts:22-38`, `:63-69`). Session payload names Person and expiry and is HMAC authenticated (`worker/src/session.ts:52-86`); Agent tokens use 32 random bytes and SHA-256 storage (`:90-99`). `readCredential` accepts bearer or session cookie, with origin checking for cookie writes/upgrades (`worker/src/auth.ts:88-111`); cookie construction specifies HttpOnly, Secure and SameSite (`:78-85`). `channelRepo` lowercases/validates and gates by ALLOWED_REPOS (`:54-66`). Credentials are re-admitted against each Channel, so a Worker-wide Person session does not bypass per-repo access (`worker/src/index.ts:272-280`).

[FACT-CODE] Membership answers cache for five minutes; a previously allowed member gets up to one hour of outage grace, without admitting a new unknown member (`worker/src/access.ts:18-20`, `:124-147`). Live streams are rechecked through `Access.recheck`; refusal closes Person sockets (`:171-175`, `worker/src/channel.ts:533-536`). Going Gone deletes every Agent token and closes its tagged sockets (`worker/src/channel.ts:554-559`). Resumption must obtain a fresh token from the Person-session registration path (`cli/src/agent-link.ts:156-195`). This is revocation by Agent lifecycle, not a separate timed token expiry table.

[FACT-CODE] A Host is a Person-owned machine connection; it authenticates as its Person, not a new organization principal. Host sockets have their own tag and receive host-specific requests instead of the general stream (`worker/src/channel.ts:1847-1859`). Local `checkSpawn`, `checkFolderAndMode` and `mayRequest` verify request shape, realpath roots, maximum mode and locally allowed requesters (`cli/src/host/check.ts:60-80`, `:98-117`, `:133-155`). The code only accepts `claude-code` for Host spawning (`:140`), even though terminal wrappers support four CLIs. Account Label is a display hint resolved locally from explicit flag/environment or masked provider metadata (`cli/src/account-label.ts:20`, `:73`; distinction `CONTEXT.md:211-216`). Broader usage telemetry can include full email by its own design, so ADR 0009's account-label privacy statement must not be generalized to every telemetry field (`worker/src/channel.ts:958-963`).

### API / tests

[FACT-CODE] Sign-in endpoints are enumerated at `worker/src/auth-api.ts:5-14` and dispatched at `:94-120`: browser start/callback, device code/token/session, signout, local fake signin/session and config. Agent register/list, heartbeat/end, nickname/model/proxy-mode and related routes are in `worker/src/agents-api.ts:1`; guarded HTTP dispatch allows Agent reads and self-actions but rejects acting for a different Agent (`worker/src/index.ts:283-324`). MCP `rename`/`list_agents` act with the session Agent token (`cli/src/mcp-server.ts:597-615`); Person CLI commands include login, whoami, run, rename and host (`cli/src/main.ts:1`, `README.md:274-294`). The separate remote connector exposes only `channel`, `github`, `brief`, `costs` (`worker/src/mcp/tools.ts:117`), not the Agent's mutating stdio tools.

[FACT-TEST] `worker/test/identity.test.ts:339-357`, **“are issued when the Person's session registers an Agent, and act as that Agent”**, asserts own update actor/capture plus successful read/heartbeat/claim/release HTTP statuses. **“cannot send Directives, act as the Person, or touch other Agents”** at `:359-385` asserts 403 for a list of ordinary-Agent impersonation/control routes and no Directive recorded. **“stop working when the Agent goes Gone, and resuming issues a new one”** at `:388-418` asserts socket close 4001, rejected revoked token and a different replacement token. These assertions prove scoped-credential mechanics under test fixtures, not that all delegated roles are forbidden.

[FACT-TEST] Membership scheduling/outage/revocation test declarations are `worker/test/identity.test.ts:285`, `:311`, `:321` (**“re-checks write access at most every 5 minutes...”**, **“keeps a recent member in while GitHub cannot be reached...”**, **“closes the stream of someone who lost access...”**). Host root/symlink/mode tests at `cli/test/host-check.test.ts:48-80` explicitly include **“refuses a link inside a root that points out of it”** and **“refuses a mode looser than this Host's...”**. Channel-choice tests assert origin precedence, default changes preserving session, and origin credential confinement (`cli/test/channel-choice.test.ts:123-172`, `:196-245`). These are source evidence; none ran in this audit.

### Documentation differences / limitations / searches

[FACT-CODE] ADR 0018's delegated lead exception is implemented: `Channel.sendDirective` admits a Person or a lead with a target in its subtree (`worker/src/channel.ts:993-1021`). Thus “Agents cannot send Directives” in early ADR 0007/CONTEXT is an incomplete statement for current role-aware code (`docs/adr/0007-github-identity-one-channel-per-repo.md:9`, `CONTEXT.md:171-172`). Nickname is mutable and channel-unique in code (`worker/src/agents.ts:478-495`, `:614-636`), while immutable IDs carry event attribution. Local Host limits remain the machine boundary even if Channel metadata is widened (`cli/src/host/check.ts:1-6`, `:98-117`), consistent with ADR 0017 despite its “proposed” label.

[INFERENCE] Present identity/membership is repo-centric, not a vendor-neutral organization/account hierarchy: the explicit persisted keys are repo, GitHub login, Agent and Host, and broad readers share Channel access (`worker/src/access.ts:22-38`, `worker/src/channel.ts:490-494`). Search `rg -n 'organization|tenant|principal|service.account|policy' worker/src cli/src shared/src worker/test cli/test` finds GitHub/provider/config references; no separate organization-policy admission path was established by this audit. This is a scoped finding, not a claim that the word “organization” never occurs. [RECOMMENDATION] For the proposed work layer, define company/vendor principals and least-privilege policy at the existing admission boundary before adding new execution authority (`worker/src/index.ts:272-324`).

## 2. Channels, Tasks, Claims, dependencies and Subtasks

**Status: Implemented and verified.** Scope: repo Channels, issue mirroring, task fields and claim lifecycle; not every historical closed issue being materialized.

### How it works / storage / API

[FACT-CODE] Channel identity is `CHANNEL.idFromName(repo)` (`worker/src/index.ts:64-65`); separate repo objects keep shared state apart. `Tasks` creates `tasks(number PRIMARY KEY,data)` and `task_sync(key,value)`, adds holder_agent plus indexes for holder lookups and claimed Tasks (`worker/src/tasks.ts:131-163`). Task JSON carries GitHub title/body/labels, open blockers, parent/subtask numbers/count, checklist Steps/count and URL (`:86-110`); Claim, status, branch and PR remain Switchboard-owned during sync (`:335-344`). There is no separate SQL claims table in this implementation; a Task has one optional Claim object in its JSON (`worker/src/claims.ts:139-145`, `worker/src/tasks.ts:426-430`).

[FACT-CODE] `ensureSynced` does initial reconcile, then schedules subsequent reads (`worker/src/tasks.ts:213-222`); reconcile runs every five minutes and pools eight GitHub reads (`:39-43`, `:259-277`). Signed webhooks route issue/sub-issue/dependency changes by repo (`worker/src/tasks-api.ts:78-109`). Refresh also visits parent and affected blocking relations (`worker/src/tasks.ts:280-307`). Subtasks are actual separate Issues; Steps derive from Markdown checkboxes (`:98-108`). Task creation first creates a GitHub issue (`:181-188`). Closing an existing Task's Issue generates `task.done` attributed to the GitHub closer; reopen resets status (`:335-370`).

[FACT-CODE] API: GET/POST `/api/tasks`, GET `/api/tasks/:number` (`worker/src/tasks-api.ts:29-47`); POST task claim/release/steps complete (`worker/src/claims-api.ts:3-6`), branch/finish through `worker/src/branches-api.ts:1`; takeover through `worker/src/takeover-api.ts:1`. MCP tools include `list_tasks`, `claim_task`, `release_task`, `complete_step`, `finish_task`, `post_update` (`cli/src/mcp-server.ts:494-593`). Stream emits `task` snapshots and `event` records (`worker/src/tasks.ts:432`, `worker/src/channel.ts:2334`). GitHub status writes assign the holder's Person and maintain a single status comment; failures become `mirror.failed` without rolling back the local claim (`worker/src/claims.ts:150-160`, `:340-361`).

### Tests / differences / limits

[FACT-TEST] **“shows each open Issue as a Task, with Subtasks under their parent, Steps and blockers”**, `worker/test/tasks.test.ts:101-155`, asserts parent/child relation, closed child count, parsed checkbox Steps, open-only blockers and task.create Events. It also explicitly asserts that closed issues never seen open are absent. **“updates a Task when its Issue is edited on GitHub”** (`:179-202`), **“adds a Subtask under its parent...”** (`:204-216`), **“shows a blocker added on GitHub...”** (`:218-228`) and **“repairs missed webhooks: edits, new Issues and closes”** (`:268-290`) cover fixture-driven sync. They do not establish real GitHub delivery reliability.

[FACT-TEST] **“opens a pull request that closes the Issue and names the Agent, and puts the Task in review”**, `worker/test/branches.test.ts:178-215`, checks PR data and review state against the fake GitHub. **“assigns the holder's Person, labels status:claimed and posts one status comment, then undoes it on release”**, `worker/test/claims.test.ts:267-300`, checks mirrored fields; identity test **“is one comment per Issue, edited in place, re-posted when deleted, and shows the last Update”**, `worker/test/identity.test.ts:469-504`, covers stable comment identity/recreation in fixtures.

[DOC-ONLY] “Every Issue is a Task” (`docs/adr/0001-tasks-mirror-github-issues-with-field-ownership.md:3`) is broader than current initialization: `Tasks.apply` intentionally ignores an unknown closed Issue (`worker/src/tasks.ts:321-324`), as the test explicitly proves. [FACT-CODE] Finishing does not immediately close the issue; it opens a closing PR and sets review (`worker/src/branches.ts:89-153`), consistent with ADR 0006 and more precise than early ADR 0001's “closes ... when ... done” (`docs/adr/0001-tasks-mirror-github-issues-with-field-ownership.md:7`).

[INFERENCE] The model can coordinate independently claimed issue Tasks, but dependencies/Steps are not a general executable DAG: the claim gate uses open blocker numbers, and Steps are holder-owned checklist items (`worker/src/claims.ts:134-136`, `:198-237`). Searches: `rg -n 'subtask|subIssue|blockedBy|dependenc|parseSteps' worker/src shared/src worker/test cli/test`; native relationships and tests were found. `rg -n 'CREATE TABLE.*claim|transaction' worker/src/claims.ts worker/src/tasks.ts` did not reveal a relational claim table or explicit claim transaction. No claim of absent dependency support is warranted.

## 3. Atomic claims, conflicts and stale recovery

**Status: Implemented and verified.** Exclusive holds, repeat-claim idempotence and manual stale takeover are implemented; file exclusivity and autonomous expiry are different concerns.

### Atomic path / storage / API

[FACT-CODE] `Claims.claim` first awaits initial task sync; after that it resolves caller/target, reads current Task, checks done/held/blockers, then writes Claim with **no intervening await** (`worker/src/claims.ts:112-147`). This synchronous DO stretch is the mutual-exclusion mechanism. The one Task row per issue and one JSON Claim property constrain representation (`worker/src/tasks.ts:133-135`, `:426-430`); there is no SQL UNIQUE claim-holder constraint or explicit transaction spanning GitHub. GitHub mirroring occurs later and is serialized by `Tasks.exclusive`'s promise chain (`worker/src/claims.ts:150-160`, `:348-361`; `worker/src/tasks.ts:239-243`). [INFERENCE] Atomicity here protects the local decision against a competing claim, not an atomic distributed commit across Cloudflare, GitHub and the laptop.

[FACT-CODE] Same holder claiming again succeeds without another mutation; another holder gets 409 and identity, including stale-specific human takeover wording (`worker/src/claims.ts:123-136`). Person claim-for-Agent only accepts that Person's own known Agent; Agent can name only itself (`:242-259`). Release/Step mutation permit holder or an Agent holder's Person (`:263-283`). The claim-for-Agent check does not include the Gone-target refusal that takeover has (`:250-259` versus `worker/src/stale-claims.ts:217-227`); [INFERENCE] this deserves a targeted review for fresh claims assigned directly to already-Gone Agents, rather than assuming all assignment paths share the takeover preconditions.

[FACT-CODE] Presence changes mark existing held claims stale on Gone and recover them if the same Agent returns before takeover (`worker/src/stale-claims.ts:73-86`). Blocker changes flag a held claim instead of discarding it (`:94-117`). `takeover` refuses Agent callers, requires an actually stale unfinished held Task, and validates own-person/live-Agent target before its synchronous write (`:122-157`). It records previous holder, completed Steps, last Update; queues LostClaim in `lost_claims(event PRIMARY KEY,agent,seq,data)` (`:40-46`, `:158-175`). `takeLostClaims` deletes/returns those rows once (`:203-208`); register/heartbeat includes them (`worker/src/channel.ts:972-981`). APIs remain claim/release/steps, takeover and Agent presence/end routes; wire consequences include claim.refused, claim.stale/recovered/blocked/unblocked, takeover and lostClaims responses (`worker/src/claims-api.ts:3-6`, `worker/src/stale-claims.ts:79-85`, `:103-116`, `:160-175`).

### Tests / documentation / limitations

[FACT-TEST] **“lets exactly one of two concurrent Claims win, and the other names the holder”**, `worker/test/claims.test.ts:84-103`, sends concurrent HTTP calls with Promise.all, asserts [200,409], persisted winning holder and exactly one claim Event. This proves a genuine competing-request scenario in the DO test environment, not merely sequential claim rejection. It is still a two-caller test rather than a broad load/stress proof. **“changes nothing when the holder claims again”** (`:131-141`) and **“lets a Person claim for their own Agent, but not for another Person's”** (`:177-192`) cover retry/target rules.

[FACT-TEST] **“is marked Stale when the Agent goes silent, and stays held indefinitely without a Takeover”**, `worker/test/stale-claims.test.ts:174-201`, advances past ten minutes and four simulated weekly alarms; asserts hold survives and another Agent gets 409. “Indefinitely” is stronger than finite testing: assertions establish four simulated weeks plus the inspected absence of automatic release in this path. **“moves a Stale Claim to the Person, with a hand-off Event, and mirrors it to GitHub”** (`:233-292`) and **“is told when it resumes, once, and no longer holds the Task”** (`:399-422`) exercise recovery. **“keeps the Takeover when GitHub fails...”** (`:381-397`) establishes local durability despite mirror failure in the fake service.

[FACT-CODE] Paused is distinct from Gone: no running process is required to retain fresh claims under the pause mechanism (`worker/src/agents.ts:767-795`; `docs/adr/0028-cross-person-host-control-and-paused-agents.md:1` specifies the change). [INFERENCE] Human intervention after loss of a machine is a deliberate availability tradeoff, not an incomplete timeout job (`worker/src/stale-claims.ts:122-149`). Exclusive claims do not prevent two differently claimed Tasks editing the same file; Relay overlap offers notification rather than a filesystem write lock (`worker/src/relay/relay.ts:287-305`).

[INFERENCE] A separate review concern exists around `Branches.finish`: it awaits external PR creation and subsequently checks only that the Task exists, is not done and still has a claim; it does **not** compare the reread holder with the original holder despite its comment saying “still held the same way” (`worker/src/branches.ts:112-129`). A release/reclaim during that await could therefore make the originally opened PR/review transition describe an outdated holder. This is a code-derived potential race, not a reproduced failure; the concurrent-claim test does not cover it. [RECOMMENDATION] Add a holder/branch consistency check and a deferred-GitHub race test before treating finish as having the same atomic guarantee as claim.

Searches: `rg -n 'expire|takeover|stale|recovered' worker/src cli/src worker/test cli/test` finds the explicit non-expiry/takeover implementation; `rg -n 'transaction|UNIQUE|PRIMARY KEY' worker/src/claims.ts worker/src/tasks.ts worker/src/stale-claims.ts` establishes the actual local storage constraints. No auto-expiry behaviour is attributed to the system.

## 4. Claude Code, Codex, Cursor and Gemini CLI integrations

**Status: Partially implemented.** All four have concrete adapters and MCP/hook paths, but feature parity and real-CLI validation differ explicitly.

### Execution, capture and per-agent surface

[FACT-CODE] `runCli` prepares hooks, private MCP directory and adapter-specific settings, then spawns the selected executable through node-pty (`cli/src/run.ts:1029-1101`, `:1166-1175`). `prepareSessionTools` runs this same binary as `switchboard mcp`, passes chosen repo/cwd and private Agent/next-turn file paths; token file is atomically renamed into place with mode 0600 (`cli/src/mcp-config.ts:67-105`). Tool capture is explicit Agent API interaction, hook capture observes CLI events, proxy capture observes supported model API traffic; these are separate sources (`worker/src/channel.ts:562-570`, `CONTEXT.md:129-139`). MCP success is not equivalent to hooks being trusted or proxy routing being supported.

| CLI | Session injection / capture | Delivery capability and important limits |
|---|---|---|
| Claude Code | Session settings + separate MCP JSON, optional Anthropic upstream proxy (`cli/src/clis/claude.ts:52-79`). | Interrupt/Wake, remote deny and Stop/compaction note nudges enabled; skill writes separately prompt (`:24-33`). |
| Codex | `-c` TOML hooks/MCP and optional openai_base_url override; environment points hooks to wrapper socket (`cli/src/clis/codex.ts:160-190`, `:356-368`). | Interrupt/Wake enabled, Stop nudge enabled, remote deny disabled; idle-clearing conservatively false (`:320-338`). Hook trust can force read_channel fallback (`:371-373`). |
| Cursor CLI | Temporary merged project `.cursor/hooks.json` and `.cursor/mcp.json`, backup/restore; `cursor-agent create-chat` session planning (`cli/src/clis/cursor.ts:1-18`, `:228-277`). | Interrupts/Wake/proxy/remote deny/nudges false (`:205-218`); sessionStart context, later read_channel. This adapter writes project config during normal product use, unlike the other adapters' temporary settings files. Nothing of that was executed during this audit. |
| Gemini CLI | Temporary system-settings JSON via GEMINI_CLI_SYSTEM_SETTINGS_PATH, hooks translated to common vocabulary; optional Gemini/Code Assist proxy route (`cli/src/clis/gemini.ts:74-102`, `:129-170`). | Interrupts/Wake/remote deny/nudges false, proxy true, hook-derived session (`:110-125`). Stand-in coverage is not real Gemini CLI interoperability evidence. |

[FACT-CODE] Codex hook translation normalizes shell tools and apply_patch into per-file changes (`cli/src/clis/codex.ts:200-251`); Gemini normalizes BeforeTool/AfterTool and tool field names (`cli/src/clis/gemini.ts:74-94`); Cursor maps camelCase lifecycle names (`cli/src/clis/cursor.ts:54-64`). Shell capture snapshots call worktree rather than assuming tool names reveal edits (`cli/src/hooks/shell-edits.ts:1`). [DOC-ONLY] README lists limitations for background commands, commands escaping to another worktree, 1.5-second snapshot budget, 1MB file reading and 200 reported files (`README.md:343-374`). These documented limits matter when interpreting touched-files/Relay completeness; this audit did not benchmark them.

[FACT-CODE] Proxy startup is optional and can fail while allowing the agent CLI to continue (`cli/src/run.ts:912-939`). Readers exist for Anthropic Messages, OpenAI Responses (including WS) and Gemini (`cli/src/proxy/anthropic.ts:1`, `cli/src/proxy/openai-responses.ts:1`, `cli/src/proxy/websocket.ts:1`, `cli/src/proxy/gemini.ts:1`). [DOC-ONLY] Custom Codex providers and Gemini Vertex run without capture (`README.md:392-398`); Cursor has no private API reader (`docs/adr/0027-cursor-cli-on-the-channel.md:40-42`). Proxy absence does not imply missing Switchboard tools.

### Tests / differences / searches

[FACT-TEST] `cli/test/clis.test.ts:47-70`, **“installs every hook with the same command, and the MCP server, as TOML, asking before each skill write”**, inspects generated Codex configuration; `:72-95`, **“reads a shell call, and an apply_patch as one edit per file”**, checks translation. Cursor **“plans sessions from --resume and create-chat for new ones”** (`:135-145`) and **“reads Cursor hooks as Claude Code's and answers sessionStart”** (`:147-166`) test planning/format conversion. Gemini **“reads Gemini's hook and tool names as Claude Code's”** (`:181`) is adapter-level source evidence. None of those asserts a running real vendor CLI accepted its generated configuration.

[FACT-TEST] E2e sources exercise stand-in sessions: Codex **“registers a Codex session by the end of its thread ID, reports its hooks, gives it the tools, and resumes it”** (`cli/test/e2e.test.ts:3234`), **“hands queued items over through read_channel while Codex's hooks are untrusted...”** (`:3418`), Gemini **“registers a Gemini CLI session from its hooks, and labels its Interrupts downgraded”** (`:3472`), and Gemini API capture fixture cases (`:3639`, `:3679`). These test names should not be read as evidence that production Codex/Gemini versions ran in this audit. README explicitly calls Gemini unverified against the real CLI (`README.md:849-860`).

[INFERENCE] Integration maturity is highest where adapter features are enabled and exercised, but a single overall “all vendors work equivalently” statement would be false (`cli/src/clis/claude.ts:24-33`, `cli/src/clis/codex.ts:325-338`, `cli/src/clis/cursor.ts:210-217`, `cli/src/clis/gemini.ts:115-124`). Host execution also remains Claude-only (`cli/src/host/check.ts:140`). Searches for the stated gaps: `rg -n 'cursor|proxy|interrupts|wakes|remoteDeny|memoryNudges' cli/src/clis cli/src/proxy cli/test worker/test`; findings include positive adapter code and explicit false capabilities, not an assumed absence from a README omission. [RECOMMENDATION] Preserve this capability interface when adding vendor support; validate real idle prompt, dialog and hook behaviour before enabling background typing (`cli/src/clis/adapter.ts:1`, `docs/adr/0029-codex-agents-wake-gemini-cli-agents-do-not-yet.md:37-45`).

## 5. Task discovery and autonomous selection

**Status: Partially implemented.** Discovery and Agent-initiated claims exist; a general server-side autonomous task-selection policy was not established.

### Tools, prompts, data and choice ownership

[FACT-CODE] `SwitchboardTools.listTasks(status?)` reads all Tasks through the authenticated API and optionally filters by status; it does not score, allocate or claim them (`cli/src/mcp-server.ts:494-499`). `listAgents` combines roster and Tasks to describe who is holding work, framing the result as information (`:597-608`). `read_channel` supplies recent Events and next-turn notices (`:904-925`); memory search/recent and summaries provide context named by MCP instructions (`:1003-1008`). GET Task storage is the same `tasks` table; there is no separate discovered-work queue involved in this path (`worker/src/tasks.ts:166-178`).

[FACT-CODE] MCP instructions say to claim before work, use the Task's worktree, complete Steps, post Updates, commit and finish, and release work not being finished (`cli/src/mcp-server.ts:1000-1005`). `claim_task` accepts a selected issue number from its caller (`:502-506`); the Worker enforces held/done/blocker conditions (`worker/src/claims.ts:123-136`). A Person can claim for themselves or one own Agent (`:242-259`). [INFERENCE] Task selection is therefore made by a Person or by an Agent following its Person/lead instructions; the server validates the requested claim instead of selecting the next Task centrally. The Relay selects notification timing, not the work assignment (`worker/src/relay/jev.ts:26-38`).

[DOC-ONLY] Agent triage labels include ready-for-agent/ready-for-human (`docs/agents/triage-labels.md:7-11`) and the wayfinder doc specifies “first in map order” among unblocked/unassigned children (`docs/agents/issue-tracker.md:41-44`). [FACT-CODE] The claim gate does not require ready-for-agent or forbid ready-for-human; it checks done, ownership and blockers (`worker/src/claims.ts:123-137`). Thus the documentation is workflow advice, not a centrally enforced label policy. [INFERENCE] The product direction's decentralized initiative is compatible with current caller-selected claims, but current logic alone does not impose organization-wide selection constraints.

### Tests / limits / searches

[FACT-TEST] `worker/test/tasks.test.ts:101-155`, **“shows each open Issue as a Task...”**, proves discoverable Task data/relationships including the ready-for-agent label. It does not prove an Agent chose that Task autonomously. `worker/test/claims.test.ts:84-103`, **“lets exactly one of two concurrent Claims win...”**, proves server exclusivity after callers choose; it does not demonstrate productive task-selection reasoning. `cli/test/read-channel.test.ts:27`, **“reads an older page when the newest is all Verdicts, and returns the latest Events asked for”**, targets history retrieval rather than selection quality.

[INFERENCE] No general autonomous selection scheduler was found in the traced Task list/claim path. Searches performed over both source and tests: `rg -n 'dispatch|select.*task|assign.*task|scheduler|auto.?claim|ready-for-agent|list_tasks' worker/src cli/src worker/test cli/test` and `rg -n 'frontier|next.task|pick.*task' worker/src cli/src worker/test cli/test`. Hits include list_tasks, triage label fixtures and librarian reading Tasks, rather than an allocation engine. Librarian has its own fixed maintenance purpose (`cli/src/librarian.ts:1`, `cli/src/mcp-server.ts:990-992`); it is not evidence of a general Task orchestrator.

[RECOMMENDATION] If company policy must constrain which agents can discover or claim which work, extend GET Task visibility and `Claims.claim` authorization rather than relying on MCP prose or triage labels (`worker/src/tasks-api.ts:36-47`, `worker/src/claims.ts:112-147`). The existing atomic claim decision is the enforcement location, while tools can remain vendor-neutral.

## 6. Updates, Directives, Events and Memory Notes

**Status: Implemented and verified.** Structured message types, note indexes/caps and authority framing have implementation and proving tests. Prompt-injection immunity is not established by these mechanisms.

### Messages / persistence / API

[FACT-CODE] `postUpdate` resolves authenticated actor, validates addressees including no self-address and only known Agent IDs, appends `update` with optional Task/to list and asynchronously updates issue status (`worker/src/channel.ts:1148-1181`). HTTP validates length/Task/addressee shape before calling it (`worker/src/index.ts:145-162`). `post_update` tool passes these fields explicitly (`cli/src/mcp-server.ts:575-578`). Updates inform; they do not acquire Directive authority merely because a Person wrote one (`worker/src/relay/delivery.ts:45-50`, `shared/src/wakes.ts:73-79`).

[FACT-CODE] Directives are recorded as a named sender and target, delivered directly rather than via Jev (`worker/src/directives.ts:102-130`). A Person can send them; a lead may only instruct within its delegated subtree (`worker/src/channel.ts:993-1007`). Durable queue/hold tables are `directive_deliveries` and `directive_holds`, indexed by Agent/seq and expiration (`worker/src/directives.ts:35-51`). Records carry Person and optionally lead identity (`:111-118`). The raw text is instruction-bearing only under that authenticated message type; inherited authority is not inferred by parsing arbitrary Agent text.

[FACT-CODE] Durable shared Events have unique ID, ordered seq, timestamp, type, actor, capture, task/turn and JSON payload (`worker/src/channel.ts:176-190`). `insert` assigns order, deduplicates ID, broadcasts and notifies Relay (`:2290-2336`). Local Events take a different branch: recent in-memory cache and stream, not central Events storage (`:2293-2312`). `seq` is time in microseconds or previous+1, not event count (`:2347-2357`). This distinction supersedes the early “central every Event” model, and matters for audit retention: per-call history may require a connected source machine (`docs/adr/0037-per-call-events-stay-on-their-machine.md:3`, `worker/src/channel.ts:1699-1776`).

[FACT-CODE] Memory notes are Agent-only (`worker/src/channel.ts:1189-1199`). They create a memory.note Event and indexed note copy. SQL structures are memory_notes(seq PK,author,task,note), indexes by author/task, memory_tags(tag,seq PK), contentless FTS5(text,files), and memory_days(day PK,notes) (`worker/src/memory.ts:15-33`). `Memory.admit` caps per Channel UTC day and returns 429 when used (`:65-81`), configured to 300 (`worker/wrangler.jsonc:39-40`). Search tokenizes/quotes at most twelve terms with **OR**, then uses FTS rank; the stale comment “every match must have” at line 36 is not the implementation (`worker/src/memory.ts:36-51`). Query limits/filtering use indexed note rows, not a full scan of Events (`:105-150`).

[FACT-CODE] API includes POST `/api/updates`, POST `/api/directives`, GET/POST memory routes (`worker/src/index.ts:351-357`, `worker/src/memory-api.ts:1`), plus events history/stream (`:345-359`). Agent stdio MCP exposes post_update, memory_note/recent/search, read_channel, agent_transcript and summary (`cli/src/mcp-server.ts:1003-1007`, tool registration `:1030-1084`). A note without a task defaults to the Agent's current task (`worker/src/channel.ts:1201-1203`). Transcript page reads are separate live wrapper reads; they do not make the whole transcript Channel-persisted memory (`cli/src/transcript.ts:1`, `worker/src/channel.ts:1880-1905`; documentation `CONTEXT.md:85-87`).

### Framing, privacy and tests

[FACT-CODE] Relay delivery summarizes Updates as a whitespace-normalized quoted string capped at 500 characters; structured code/file facts and bounded committed hunks are allowed (`worker/src/relay/delivery.ts:22-26`, `:34-80`, `:108-126`). `agentDeliverable` guards content before routing (`worker/src/relay/relay.ts:254-258`). [DOC-ONLY] Standing rules explicitly tell Agents to treat other-agent messages as information and obey their own Person when conflicting (`AGENTS.md:19-25`). [INFERENCE] Quoting, length/control sanitization and authenticated sender types reduce opportunities, but they are not a semantic proof that an LLM cannot follow malicious text.

[FACT-TEST] **“records a memory.note Event by the Agent, which every wrapper hears, and answers with the note”**, `worker/test/memory.test.ts:127-159`, checks normalized text, author/Person/nickname/Task/files, stored Event identity/capture and stream arrival. **“stores a note on one line, with no control character, terminal escape or bidi control”**, `:162-178`, asserts escape removal and persisted one-line forms. It deliberately preserves ordinary prose containing a fake Directive string inside a file name: sanitizing controls is not malicious-language detection. **“takes MEMORY_NOTES_PER_DAY notes a day, refuses the next, and records nothing for it”**, `:225-232`, uses a test cap of five, asserts sixth returns 429, five Events and absent refused note in search. The source config's 300 is a different chosen limit.

[FACT-TEST] **“never gives a Verdict on a note or asks Jev about one...”**, `worker/test/memory.test.ts:211-222`, uses a later marker to wait for Relay and asserts no note verdict/no Jev note call. **“never relays raw Proxy content into an Agent”**, `worker/test/relay.test.ts:724-779`, sends planted instruction text in raw context/reply and checks the routing boundary. It establishes exclusion of that content class, not universal injection resistance. Directive framing tests **“frames a Directive as coming from the named Person...”** and **“is distinct from the frame around information from Agents”** are at `worker/test/directives.test.ts:427-458`; they assert strings, not downstream model compliance.

[FACT-TEST] Memory digest tests verify prioritization and cap rather than all notes always fitting: **“stays within its cap, ranks decisions and dead ends...”**, `cli/test/memory.test.ts:50-66`, and **“puts notes on the Agent's own Tasks and files first...”**, `:68-91`. [DOC-ONLY] ADR 0019's newest/decision ordering is modified by ADR 0024 and current context glossary (`docs/adr/0019-agents-share-memory-on-the-channel.md:37`, `CONTEXT.md:49-50`). [FACT-CODE] Newer any-word search is implemented with OR (`worker/src/memory.ts:49-51`), so treating it as all-word matching would misdescribe current behaviour.

Searches: `rg -n 'memory.note|MEMORY_NOTES_PER_DAY|sanitize|clean.*line|maskSecrets|agentDeliverable|STANDING_RULE|Directive from' worker/src cli/src shared/src worker/test cli/test` finds both defensive code and tests. `rg -n 'moderation|prompt.injection|injection' worker/src cli/src worker/test cli/test` did not establish an independent semantic content approval service. [RECOMMENDATION] Describe this as layered framing and capability isolation, and add adversarial multi-message evaluation if a stronger policy guarantee is required; keep enforcement on authenticated routes (`worker/src/index.ts:283-324`).

## 7. Relay, event routing, notifications and Wake

**Status: Implemented and verified.** Scope: rule/Jev verdicts, queue/downgrade paths, Directive holds, capable-adapter Wake and socket recovery. Vendor-specific disabled delivery remains an area 4 limitation.

### Rules, Jev and delivery state

[FACT-CODE] `Channel.insert` broadcasts an Event then calls `Relay.consider`, which skips unrelayed types, applies deliverable filtering and schedules asynchronous work via waitUntil (`worker/src/channel.ts:2334-2336`, `worker/src/relay/relay.ts:254-263`). Plans with no overlapping files/symbols and no addressed reason produce rule Drop without Jev; others go through a bounded four-call limiter (`worker/src/relay/relay.ts:79-91`, `:287-305`). Addressing covers explicit Update `to`, own Claim changes, takeover and held Tasks (`:207-224`). [INFERENCE] This is selective notification routing, not a central LLM orchestrator choosing or executing Tasks.

[FACT-CODE] Jev is **TypeSafe's external decision-model API** in current code: `HttpJev.verdict` POSTs state plus a typed drop/queue/interrupt question to `https://api.typesafe.ai/v1/systemone`, model `jev-latest`, with configured API-key authentication (`worker/src/relay/jev.ts:22-38`, `:66-85`). It is an external model service; source calls it a decision model rather than a general conversational LLM. Its internals, calibration, current hosting and actual price cannot be established offline from this repository. [DOC-ONLY] ADR 0003 names `typesafe/jev` on Workers AI and asserts cheaper/faster/calibrated behaviour; ADR 0004 says it is a binding (`docs/adr/0003-relay-verdicts-use-jev.md:3`, `docs/adr/0004-central-relay-hosted-on-cloudflare.md:3`). Those transport/cost claims must not be repeated as current verified infrastructure: `worker/wrangler.jsonc:19-23` declares ASSETS/CHANNEL, while source explicitly uses HTTP.

[FACT-CODE] Jev absent/error/timeout (5 seconds) yields fallback Queue, retaining state/error metadata (`worker/src/relay/relay.ts:309-327`). Returned probabilities are parsed/validated (`worker/src/relay/jev.ts:43-62`). Interrupts below threshold become Queue; delivered interrupts also depend on adapter capability, attached wrapper, minimum interval and wrapper acknowledgement (`worker/src/relay/relay.ts:329-430`). Config defaults here are 0.6 and 20 seconds (`worker/wrangler.jsonc:31-34`). Explicitly addressed Update Drop is raised to Queue (`worker/src/relay/relay.ts:329-355`); addressees can be Gone and retrieve later, while unrelated live Agents still take the normal overlap path (`worker/src/relay/relay.ts:207-224`, `worker/src/relay/relay.ts:480-531`).

[FACT-CODE] SQL tables are deliveries(id PK,agent,seq,data), agent/seq index and interrupts(agent PK,at) (`worker/src/relay/relay.ts:64-75`). Queued deliveries are capped at 200 per Agent (`:84-85`). `takeDeliveries` destructively drains on register/heartbeat; WS ack deletes specific recipient items (`:266-277`, `worker/src/channel.ts:972-981`). Wrapper delivery messages, interrupt/result and directive/result frames implement receipt/typing distinctions (`worker/src/channel.ts:1894-1903`). [INFERENCE] This is not an end-to-end exactly-once model-consumption protocol: server-side DELETE RETURNING occurs before the HTTP answer is guaranteed received, and a PTY “typed” answer is not proof the model read or acted (`worker/src/relay/relay.ts:267-272`, `worker/src/directives.ts:170-175`). There is also a finite pending cap, so “never loses” in Relay's overview is bounded by actual storage policy (`worker/src/relay/relay.ts:11-13`, `:84-85`).

### Directives and Wake

[FACT-CODE] Directives bypass Jev and Relay's interrupt rate limit. If capable Agent has no attached wrapper but is not Gone, `Directives.hold` persists it for attach deadline; attach drains holds in order, deadline moves them to queue, paused/incapable/Gone cases queue directly (`worker/src/directives.ts:102-159`, `:201-218`). A wrapper refusal or no answer produces queued delivery with reason (`:221-253`). Tables distinguish durable holds from in-memory awaiting-typing promises (`:35-51`, `:91-93`). API is POST directives; WS types include directive.interrupt, directive.result, directives, directive.ack, interrupt.attach/attached (`worker/src/directives.ts:192`, `:252`, `worker/src/channel.ts:1897-1903`).

[FACT-CODE] Wake is wrapper-driven and only created for adapters with `wakes` enabled (`cli/src/run.ts:722-740`). `wakesAgent` accepts an addressed Update or file-overlap delivery; Directives always qualify in Waker's held-items path (`shared/src/wakes.ts:32-39`, `cli/src/wake.ts:46`). A one-second settle combines notices (`cli/src/wake.ts:19`), and `InterruptTyper` applies input/dialog/session guards (`cli/src/interrupts.ts:521`). Cap is three Wakes in ten minutes without intervening Person prompt/Directive (`shared/src/wakes.ts:27-30`); cap Update says why subsequent notices wait (`:59-64`). Wake frame explains the Person did not type this and says end the turn if nothing pertains to their assigned task (`:73-79`). Channel Wakes verifies named verdicts were queued for that Agent and named Directives target it before recording (`worker/src/wakes.ts:33-51`); it rate-limits cap Updates in memory (`:55-65`).

[FACT-CODE] Claude/Codex enable Wake; Cursor/Gemini do not (`cli/src/clis/claude.ts:28`, `cli/src/clis/codex.ts:329`, `cli/src/clis/cursor.ts:212`, `cli/src/clis/gemini.ts:118`). Codex without trusted hooks also cannot safely infer turn end; its queued fallback is read_channel (`cli/src/clis/codex.ts:371-373`, `cli/src/run.ts:704-716`). [INFERENCE] Wake is bounded reactive initiative for already-delivered work/context, not autonomous polling/choosing the next available Task. Memory notes do not invoke this Relay/Wake path (`worker/test/memory.test.ts:211-222`).

### Socket recovery, tests, limitations and searches

[FACT-CODE] Channel automatically answers LIVE_PING/LIVE_PONG without waking the DO (`worker/src/channel.ts:530-531`). CLI keepalive sends every 30 seconds, treats any incoming frame as activity, and gives up after 2.5 intervals; interval-timer checks normally notice at about 90 seconds (`cli/src/keepalive.ts:10-18`, `:38-57`). `ChannelClient` also bounds handshake time, reconnects with backoff and resets on a working pong (`cli/src/channel-client.ts:276-323`). ADR 0052 extends ADR 0048 to destroy failed sockets and contain repeated failures (`docs/adr/0052-one-bad-channel-cannot-take-the-machine-down.md:1`, implementation `cli/src/channel-net.ts:38`, `cli/src/channel-client.ts:276-323`). HTTP presence can remain fresh while a socket fails, so “Live Agent” is not sufficient proof of message/read reachability (`docs/adr/0048-a-silent-socket-is-replaced.md:7-9`; independent HTTP heartbeat path `worker/src/channel.ts:941-950`).

[FACT-TEST] **“downgrades an Interrupt below the threshold to a Queue, and pushes one at or above it to the wrapper”**, `worker/test/relay.test.ts:530-573`, asserts 0.55 downgrade and 0.6 delivered interrupt, queue/interrupt recipients, frame and no duplicate next-turn interrupt. This is fake-Jev probability testing, not model calibration. **“queues an Update for its one addressee even when Jev would drop it, and relays it to no one else”**, `:911-942`, asserts recipient Queue with raised reason, unrelated Carol rule Drop and exactly one Jev call. The test's “no one else” depends on Carol sharing no overlap, not a privacy guarantee that an addressed Update can never be relayed to another relevant Agent (normal nonrecipient Relay remains enabled).

[FACT-TEST] Directives **“types a Directive sent between registering and attaching once the wrapper attaches”** (`worker/test/directives.test.ts:300-319`) and **“falls back to the next turn as wrapper-offline when the wrapper does not attach within the bound”** (`:343-357`) cover the attach race/deadline. Wake **“stops at the cap and says so once; the Person's prompt or Directive lets it wake again”**, `cli/test/wake.test.ts:155-168`, proves bounded scheduling under a test typer. E2e sources separately include idle Claude Wake (`cli/test/e2e.test.ts:2752`), Codex Wake (`:3066`), blocked-Stop continuation (`:3093`) and cross-CLI cap (`:3117`); these use stand-ins, not a real-vendor smoke run here.

[FACT-TEST] Socket e2e **“notices the silence, reconnects, and its screen can be read again”** at `cli/test/e2e.test.ts:5028`, plus **“closes each socket the Channel stops answering on, and spaces its new ones out”** (`:5169`) and **“waits out a Channel that takes nothing at all...”** (`:5206`), exercise adversarial test servers. These tests are stronger evidence than the early ADR's reconnect narrative alone, but no execution outcome is claimed.

Searches: `rg -n 'JEV_URL|JEV_MODEL|HttpJev|RELAY_INTERRUPT_THRESHOLD|MAX_PENDING_DELIVERIES|takeDeliveries|interruptAnswered' worker/src worker/test cli/src cli/test`; `rg -n 'wake|WAKE_CAP|wakesAgent|wakes:|keepalive|silentAfterMs|LIVE_PONG' worker/src cli/src shared/src worker/test cli/test`. These find explicit queue, interrupt, wake and reconnect handling. No Workers AI binding was found in the inspected Wrangler binding configuration (section 0). [RECOMMENDATION] Reconcile ADR 0003/0004 infrastructure text with HttpJev, and explicitly document destructive queue handover, retention caps and the difference between typed, received and acted-on (`worker/src/relay/jev.ts:74-85`, `worker/src/relay/relay.ts:267-277`).

## Components for areas 1–7

```text
Person (GitHub login) ---- web/device OAuth ----> Worker /auth
       |                                           |
       | signed Person session                     | GitHub App
       v                                           v
CLI login/run --> ChannelClient --> /r/owner/repo/api --> GitHub permissions/issues/PRs
       |                                 |
       | register -> Agent token          v
       |                      Channel DO (one normalized repo name)
       |                      + Access: members, hashed tokens
       |                      + AgentRoster / Presence / alarms
       |                      + Tasks JSON -> Claims -> StaleClaims
       |                      + Events / Memory / Directives / deliveries
       |                              |             |
       |                 broadcast WS |             +-> Relay rules / overlap
       |                              |                       |
       v                              v                       v
PTY + vendor adapter <---- wrapper stream              HttpJev (TypeSafe API)
 | Claude / Codex                |                           |
 | Cursor / Gemini              +-- queues / interrupt <-----+ verdict
 |                              +-- Directive bypass + attach hold
 +-- hooks + optional proxy ----> Event intake
 +-- injected stdio MCP --------> list/claim/update/note/finish
 +-- task worktree + git -------> branch push -> closing PR
 +-- guarded next-turn / Wake (Claude, Codex; bounded cap)
 +-- local SQLite events.db <--- per-call history (wrapper/Host serves reads)

Host supervisor (Person session) <---- Host-only WS ---- Channel
 + local roots/mode/requester limits
 + Claude-only headless wrapper spawning / pause / resume

Dashboard <---- same Channel API/WS ----> shared state and notifications
Read-only remote MCP connector --------> channel / github / brief / costs
```

[FACT-CODE] Diagram edges summarize the cited lifecycle: Worker admission (`worker/src/index.ts:272-359`), DO storage/broadcast (`worker/src/channel.ts:2290-2363`), HttpJev (`worker/src/relay/jev.ts:74-85`), private MCP (`cli/src/mcp-config.ts:67-105`), PTY (`cli/src/run.ts:1166-1175`) and local Host limits (`cli/src/host/check.ts:98-140`). It is an architecture sketch, not a deployment observation.

## Open questions and uncertainties

- [INFERENCE] What real-provider smoke checks have the manager run for the currently installed Claude/Codex versions, and have Gemini/Cursor limitations changed outside this checkout? Source flags and fixture tests cannot answer that (`cli/src/clis/cursor.ts:210-218`, `cli/src/clis/gemini.ts:115-125`, `README.md:849-860`).
- [INFERENCE] Should claim-for-Agent reject a Gone target or mark its new hold stale immediately? The target check differs from takeover (`worker/src/claims.ts:250-259`, `worker/src/stale-claims.ts:217-227`). No dedicated test proving the desired Gone-target policy was identified by the claim/identity searches.
- [INFERENCE] Can the finish-time holder change race described in area 3 be reproduced, and what review/PR result is intended when the Claim changes during GitHub I/O? Current post-await guard does not compare holder (`worker/src/branches.ts:112-129`).
- [INFERENCE] Is destructive delivery handover acceptable if register/heartbeat's response is lost, and should acknowledgements mean wrapper receipt, successful model-context insertion, or action? Current drain/ack APIs distinguish only some of these (`worker/src/channel.ts:972-981`, `worker/src/relay/relay.ts:267-284`).
- [DOC-ONLY] Are Jev's deployment, calibration and cost assertions still accurate? Early ADR statements conflict with current HTTP transport; only source integration is established here (`docs/adr/0003-relay-verdicts-use-jev.md:3`, `worker/src/relay/jev.ts:22-38`). No network verification was authorized or performed.
- [INFERENCE] What should organization policy mean across GitHub repo membership, delegated leads, external vendor Agents and Person-owned Hosts? Current admission stores repo/login/Agent identity and local Host limits, not a separately established organization policy plane (`worker/src/access.ts:22-38`, `worker/src/channel.ts:993-1021`, `cli/src/host/check.ts:60-117`).
- [INFERENCE] What retention/availability guarantees are required for a future company audit trail? Per-call records live on participant machines, whereas Claims/Updates/Directives/notes are shared durable state (`worker/src/channel.ts:2290-2336`, `CONTEXT.md:37-38`). Central policy with decentralized initiative does not automatically imply centrally durable evidence.
- [INFERENCE] Should the documented triage frontier/ready labels become enforced selection policy, or stay advisory? Claim eligibility currently ignores labels (`docs/agents/issue-tracker.md:43-44`, `worker/src/claims.ts:123-137`).
- [RECOMMENDATION] Obtain manager baseline results separately and attach exact command/results only after execution evidence is available. This report's status vocabulary describes test-evidenced source, never a passing run (`.github/workflows/ci.yml:29-31`, `:53-55`, `:69-76` defines intended checks).
