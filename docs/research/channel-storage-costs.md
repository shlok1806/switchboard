# Making the Channel cheaper to run

Research for: "figure out how to make this cheaper for reads and writes, what other services to use or methods to use, make it cheaper", without a bigger plan as the answer. Prices and limits were read from each provider's own pages on **2026-10-28** (see [Sources](#sources)); none come from memory. Row costs per message come from `worker/test/rows-read.test.ts` on the seeded test Channel after this run's fixes.

## Short answer

1. After this run's fixes, **rows written** is the limit that binds, not rows read. The free plan allows 100,000 rows written a day for the whole Cloudflare account, so every Channel on the hosted Worker shares it.
2. An actively coding Agent writes about **4,660 rows an hour** today and about **2,860** after the two changes being built. That is about 21 and 35 Agent-hours a day on the free plan, so 5 Agents for 8 hours (40 Agent-hours) do not fit even after both changes.
3. The fix that makes 5 and 20 Agents fit is to **store one row per Agent turn** for the low-value Events: tool calls, commands, turn ends, the turn's model record and rule Drops. They still stream live to the Dashboard and the Relay. Updates, Claims, Tasks, Directives and Jev Verdicts keep their own rows. That brings it to about **430 rows an hour** (about 230 Agent-hours a day), and 20 Agents for 8 hours use about 69% of the free allowance.
4. Moving off Cloudflare gets rid of the meters but adds operations work. A self-hosted `workerd` on a $4 VPS runs the same Worker code. It is the fallback, not the first step. Hosted databases (Turso, Neon, Supabase) charge by a different meter and add a network hop under code that runs SQL synchronously, so they are not recommended.
5. A solo local mode (the Channel on the Person's own laptop) costs nothing to run. It does not conflict with ADR 0004, which is about several Persons, but it needs an ADR of its own.

For reference, not as the recommendation: Workers Paid is $5 a month and includes 50 million rows written a month. 20 Agents for 8 hours on 22 days use about 16 million today ([Workers pricing][wk-pricing]).

## 1. What an Agent-hour costs

An Agent-hour is one hour of an actively coding Agent: about 360 tool calls, 30 turns, 390 model requests and 120 heartbeats, which is about 1,000 WebSocket messages plus the heartbeats.

**Assumptions not measured here:** 1 tool call in 6 edits a file (60 edits an hour), with 4 other live Agents and no overlap. The Agent's own row is written about 50 times an hour (context changes, usage changes, the last-seen flush every 200 s). Updates, Claims, Wakes and other own-row Events add about 50 rows. After the first change, the wrapper sends one proxy message per turn rather than one per model call.

### Rows written per Agent-hour

| Source | Per hour | Rows each (measured) | Today | After the two changes |
|---|---|---|---|---|
| `tool.call` / `command` (hook) | 360 | 5 | 1,800 | 1,800 |
| `file.edit`: its own row | 60 | 5 | 300 | 300 |
| `file.edit`: one rule-Drop `verdict` (ADR 0030) | 60 | 3 | 180 | 180 |
| `file.edit`: `touched_files` upsert | 60 | 3 | 180 | 180 |
| `turn.end` | 30 | 5 | 150 | 150 |
| Model record (`proxy.digest`) | 390, then 30 | 5 | 1,950 | 150 |
| Heartbeat with nothing changed | 120, then 0 | 0 | 0 | 0 |
| Agent row (estimate) | | | ~50 | ~50 |
| Own-row Events: Updates, Claims, Wakes (estimate) | | | ~50 | ~50 |
| **Total** | | | **~4,660** | **~2,860** |

The 5 rows of a stored Event are its row, its UUID index, the `AUTOINCREMENT` counter and the partial history indexes it falls under (`events_by_agent`, `events_by_task`). Index rows are billed as rows written ([SQLite storage API][do-sql]). A code comment in `worker/src/channel.ts` records that a Channel's busiest day before ADR 0030 was 51,000 rows written, which is about 11 Agent-hours at today's rate.

### Rows read, requests, duration and storage per Agent-hour

| Meter | Today | After the two changes | Notes |
|---|---|---|---|
| Rows read | 5,100 to 14,100 | 2,100 to 11,100 | Heartbeat ~10 each, hook message 5, model record ~5 (assumed equal to a hook message). The upper bound adds a Relay pass per edit at the test's 150-row budget. Stream open 21 and Agent Summary 79 are per use. |
| Worker requests | ~120 | ~0 | HTTP heartbeats. WebSocket upgrades and Dashboard API calls are per use. |
| Durable Object requests | 176 (20:1) or 1,240 (1:1) | 38 (20:1) or 760 (1:1) | 120 HTTP heartbeats, plus 1,000 WebSocket messages and 120 keepalive pings. Later: 640 messages and 120 pings. See the note below. |
| Duration (GB-s) | ~1.3 (estimate) | ~1 (estimate) | ~10 ms per message at 128 MB. Hibernatable idle time is not billed ([lifecycle][do-lifecycle]). |
| Storage | ~0.5 MB (estimate) | ~0.25 MB (estimate) | From payload caps (500-character hook text, 4,000-character model reply). Measure with a bounded `sum(length(payload))` over the last 10,000 `seq`, not a full scan. |

**The 20:1 note.** Cloudflare applies "a 20:1 ratio ... to incoming WebSocket messages" for request billing, and charges nothing "for outgoing WebSocket messages, nor for incoming WebSocket protocol pings" ([DO pricing][do-pricing]). The page does not say whether the ratio also applies to the free plan's 100,000 requests a day, so this doc gives both bounds. The app-level `"ping"` text frame that `setWebSocketAutoResponse` answers does not wake the object or bill duration ([DO state API][do-state]). It is still an incoming message, though, so assume it counts as one.

### Free plan limits and how many Agent-hours fit

| Meter | Free plan, per account per day | Agent-hours/day today | After the two changes |
|---|---|---|---|
| SQLite rows written | 100,000 | **~21** | **~35** |
| SQLite rows read | 5,000,000 | ≥ 354 | ≥ 450 |
| Durable Object requests | 100,000 | 568 (20:1) / 80 (1:1) | 2,630 (20:1) / 131 (1:1) |
| Workers requests | 100,000 | ~830 | not binding |
| Duration | 13,000 GB-s | ~10,000 | not binding |
| SQLite storage | 5 GB total | grows ~0.5 MB per Agent-hour, forever | ~0.25 MB per Agent-hour |

Free limits reset at 00:00 UTC, and once one is exceeded, "further operations of that type will fail with an error" ([DO pricing][do-pricing]). The limits page lists 10 GB per object in its table but "1 GB on the Free plan" in its FAQ ([DO limits][do-limits]). Plan for 1 GB per Channel until that is resolved.

### 1, 5 and 20 Agents, 8 hours a day

| Agents | Agent-hours/day | Rows written today | After the two changes | After per-turn batches (stage 2) |
|---|---|---|---|---|
| 1 | 8 | 37k (37%) | 23k (23%) | 3.4k (3%) |
| 5 | 40 | 186k (186%): stops after ~4 h | 114k (114%): stops after ~7 h | 17k (17%) |
| 20 | 160 | 746k: stops after ~1 h | 458k: stops after ~2 h | 69k (69%) |

If the free request allowance counts each WebSocket message as a full request (1:1), 20 Agents also exceed Durable Object requests after the two changes (122k a day). Stage 2b below covers that.

## 2. Options within Cloudflare

| Option | What it does to cost | Fit |
|---|---|---|
| **Per-turn batch rows** for low-value Events | ~2,860 → ~430 rows written per Agent-hour. Fewer rows to read back too. | **Yes. Biggest saving.** |
| Hot tail in SQLite, older history to R2 as gzip segments | Storage only. Rows written go *up* when old rows are deleted ("Deletes are counted as rows written", [DO pricing][do-pricing]). R2 free tier: 10 GB-month, 1M Class A and 10M Class B operations a month, no egress charges ([R2 pricing][r2-pricing]). Needs an R2 subscription through checkout ([R2 get started][r2-start]). | Yes, later, once a Channel nears 1 GB. |
| Plain retention (delete low-value batches after N days) | Same delete cost as R2 without the archive. 30 days at 20 Agents is ~0.9 GB stored plainly, or ~0.35 GB if batches are gzipped (estimates). | Simpler alternative to R2. |
| Workers Analytics Engine | Free: 100,000 data points written and 10,000 read queries a day. "Currently, you will not be billed" ([AE pricing][ae-pricing]). 20 blobs and 20 doubles per point, kept 3 months ([AE limits][ae-limits]). | Yes, for per-model-call token and cost numbers once the first change stores one record per turn (20 Agents × 8 h × 390 = 62k points a day). Not for the feed. |
| Workers KV | Free: 1,000 keys written a day ([KV pricing][kv-pricing]), 1 write a second per key ([KV limits][kv-limits]). | No. 100× fewer writes than SQLite. |
| D1 | Same meters and same free numbers as Durable Object SQLite (5M read, 100k written a day) ([D1 pricing][d1-pricing]). Listed as its own allowance. | No. A remote hop under synchronous code, and the same price. |
| Durable Object KV API instead of SQL | KV methods "store and query data in a hidden SQLite table" and are billed as rows read and written ([DO pricing][do-pricing], [SQLite storage API][do-sql]). | No. A lean SQL table with fewer indexes saves the same rows. |
| Drop `AUTOINCREMENT` and the per-Event UUID index | −2 of the 5 rows per stored Event. On existing Channels it needs a full table rebuild, which on the free plan takes days of the budget. | Build the batch table lean instead; leave `events` as is. |
| WebSocket message billing | Incoming at 1/20 of a request, outgoing free, protocol pings free ([DO pricing][do-pricing]). The Dashboard stream is outgoing, so it is free. | Already cheap. The outlier is terminal watching: up to 8 frames a second is 28,800 incoming messages per watched hour (1,440 requests at 20:1, 28,800 at 1:1). |
| Hibernation | Already used. Idle hibernatable time is not billed, and auto-responses do not wake the object ([lifecycle][do-lifecycle], [DO state API][do-state]). `setTimeout` waits and open outbound fetches keep the object awake. | Keep. Duration does not bind. |

### How the per-turn batch should work

- **What goes in a batch:** `tool.call`, `command`, `turn.end`, the turn's model record, `file.edit` as history, and the rule-Drop `verdict`. Updates, Claims, Tasks, Directives, Jev and addressed Verdicts, Memory Notes and `touched_files` stay as they are, because the Relay, the status comment and Takeovers look them up one by one.
- **Live behaviour does not change:** each Event is still broadcast to the Dashboard, and each `file.edit` still goes to the Relay and `touched_files` on arrival. Only the storage changes.
- **Where the batch is assembled:** in the wrapper socket's attachment, which survives hibernation and costs no rows ([WebSocket best practices][do-ws]; 16,384 bytes at most). The Channel writes one `batch` row when the turn ends, when the attachment nears 12 KB, or after 60 s, and sends `hook.ack` only after that write. The wrapper already resends every unacknowledged message after a reconnect (`connected()` in `cli/src/hooks/capture.ts`), so a deploy that drops the attachment loses nothing. To spot a resend after a flush whose ack was lost, the Channel checks the Agent's last `batch` row (1 row read).
- **Storing it as a `batch` Event in the existing `events` table** keeps one `seq` space for stream cursors and reuses `events_by_agent` and `events_by_task`. That costs ~5 rows per turn, 150 an hour.
- **Rows per Agent-hour after batching:** 150 (batches) + 180 (`touched_files`) + ~50 (Agent row) + ~50 (own-row Events) ≈ **430**.

## 3. Outside Cloudflare

| Host | Free tier or cheapest price | What the Channel would need | Latency and reliability |
|---|---|---|---|
| **`workerd` on a small VPS** | DigitalOcean Basic: $4.00/month, 512 MiB, 500 GiB transfer, IPv4 included ([DO droplets][dov-pricing]). Hetzner CX23: €5.99/month excl. VAT, 20 TB, EU only, but every cloud plan showed "currently unavailable" when read ([Hetzner][hz-cost]); its cheapest US plan was CPX11 at €17.99 ([Hetzner][hz-reg]). | Same Worker code. `durableObjectStorage: localDisk` keeps each object in a `.sqlite` file, marked "EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE", and objects "are always local to one instance" ([workerd.capnp][workerd-capnp]). Alarms have a SQLite-backed scheduler ([alarm-scheduler.h][workerd-alarm]). The README warns workerd "is not a hardened sandbox" for untrusted code ([workerd][workerd]); here the only code is ours. Add Caddy for TLS, systemd, and Litestream to R2 for backups ([Litestream][litestream], [S3-compatible guide][litestream-s3]). Jev and GitHub are plain HTTPS calls (`worker/src/relay/jev.ts`), so they work from anywhere. | A Durable Object also lives in one location, so write latency is about the same. You own patching, disks, TLS and backups instead of Cloudflare's 30-day PITR ([SQLite storage API][do-sql]). |
| Oracle Always Free | Ampere A1: 2 OCPUs, 12 GB, 200 GB block storage, 10 TB egress a month ([Oracle][oracle]). | As above. | Oracle may reclaim an instance that for 7 days has p95 CPU, network and (on A1) memory all under 20% ([Oracle][oracle]). A quiet Channel server fits that description. |
| Google Cloud Always Free | One `e2-micro` in us-west1, us-central1 or us-east1, 30 GB disk, **1 GB egress a month** ([GCP free tier][gcp-free]). | As above. | Too little egress: broadcasting every Event to ~22 sockets at 20 Agents is ~0.7 GB a day (estimate). |
| Render free | Spins down after 15 min with no traffic, and "Free web services cannot" keep a persistent disk ([Render free][render-free]). | Not possible: SQLite would be lost on every restart. | |
| Fly.io | No free tier. shared-cpu-1x is $2.19/month at 256 MB, volumes $0.15/GB-month ([Fly.io pricing][fly-pricing]). | As for a VPS. | |
| Turso | Free: 500M rows read and **10M rows written a month**, 5 GB. Developer plan $4.99 ([Turso pricing][turso]). | Every `sql.exec` becomes a remote async call. The Channel's single-object, synchronous transactions would have to be rewritten. | A network round trip per query from the Worker. The monthly write pool (~330k a day on average) is about 3× Cloudflare's daily one, but it is the same kind of meter. |
| Neon | Free: 100 CU-hours per project, 1 GB storage per project, always suspends after 5 min idle ([Neon pricing][neon]). | Postgres over the network, plus the same rewrite. | Cold starts after 5 min idle. Still needs a server for the WebSockets. |
| Supabase | Free: 500 MB database, 2M Realtime messages a month, 200 connections, paused after 1 week inactive ([Supabase pricing][supabase]). | Postgres plus Realtime for the fan-out. | 20 Agents send more than 2M messages a month, and 500 MB fills in months. |

**`workerd` or a Node port?** Self-hosted `workerd` runs the code unchanged, and the test suite already runs on it through `@cloudflare/vitest-pool-workers`. A Node port would have to re-create `ctx.storage.sql` cursors, `acceptWebSocket` with tags and attachments, auto-responses, alarms and the Durable Object's input and output gates. The gates are what make the Channel's handlers safe to run one after another. Getting them right is the risky part, so prefer `workerd`.

## 4. A local mode for one laptop

| | |
|---|---|
| **How** | `wrangler dev --persist-to <dir>` keeps Durable Object data in `.wrangler/state` or the given directory, and `--ip` "defaults to `localhost`" ([wrangler dev][wrangler-dev], [local data][local-data]). A shipped mode would run the bundled `workerd` with `localDisk` storage behind a `switchboard channel up` command. The Dashboard is served by the same Worker (`ASSETS`), so it is local too. |
| **Cost** | Zero cloud cost: no meters. |
| **Sign-in** | The localhost-only dev sign-in (`DEV_FAKE_GITHUB`) already exists. A solo mode can trust the one local Person. |
| **GitHub** | Outbound calls work (Tasks mirror Issues, branches, pull requests). It needs either the Person's own token or the App's key on the laptop. Webhooks cannot reach localhost: Issue changes still arrive through the 5-minute reconcile (`RECONCILE_INTERVAL_MS`), but push and merge Events need polling or a tunnel. |
| **What is lost** | Agents on other machines and other Persons, the Dashboard from another device, instant webhooks, and Cloudflare's PITR (use Litestream or the laptop's own backups). The Channel stops when the laptop sleeps, but so do its Agents. |
| **ADR 0004** | ADR 0004 rejected a laptop server so that "the other Person doesn't depend on that laptop being awake", and a Relay per machine because cross-machine overlap needs every Claim and file in one place. A solo Channel has one Person and one machine, so neither reason applies. **No conflict, but it is a new deployment mode:** record it in an ADR that scopes 0004 to Channels with more than one Person. |
| **Syncing when others join** | Tasks need no sync, because both sides mirror GitHub. Updates are a few an hour and can be forwarded. Claims cannot be synced after the fact: "at most one holder per Task" needs a single authority, so the local Channel would have to forward each Claim to the hosted one and wait for the answer. File overlap across machines (ADR 0004's most valuable Interrupt) needs `touched_files` on the hosted Channel too. That hybrid would write ~280 rows per Agent-hour to the hosted Channel, about what stage 2 writes anyway, with a split-brain risk on top. **Not recommended.** Use local mode for solo work and development, and switch to the hosted Channel when a second Person joins. |

## 5. Recommendation

Ranked by cost saved per unit of work, then risk. "Fits" means 8-hour days on the free plan; "Cost" is per month at 5 and 20 Agents.

| # | Stage | Rows written per Agent-hour | Fits 5 / 20 Agents | Cost 5 / 20 Agents | Work | Risk |
|---|---|---|---|---|---|---|
| 1 | **The two in-flight changes**: one record per model turn, liveness from the auto-answered ping | 4,660 → 2,860; −120 requests and −1,200 rows read | No (114%) / No (458%) | Free stops daily. Paid would be ~$5 / ~$5.25. | In progress | Low |
| 2 | **Per-turn batch rows** (section 2) | 2,860 → ~430 | **Yes (17%) / Yes (69%)** | **$0 / $0** | Medium to large | Medium: every history read path changes |
| 2b | Only if the free allowance counts messages 1:1: send the keepalive ping every 60 s instead of 30 s (Gone is 600 s), and coalesce hook messages over ~2 s | Requests 760 → ~500 per Agent-hour | DO requests: 20 Agents ~80k/day | $0 | Small | Low |
| 3 | Retention or R2 cold segments, once a Channel nears 1 GB | +~150 deferred deletes, run under a daily budget | Yes / Yes (~93% on archive days, so spread it) | $0: R2 stays inside 10 GB-month | Medium | Low to medium |
| 4 | Solo local mode (section 4) | unmetered | One laptop only | $0 | Medium | Low (opt-in) |
| F | Fallback if the account outgrows ~230 active Agent-hours a day even after stage 2: `workerd` on a VPS | unmetered | Yes / Yes | $4.00 (DigitalOcean) or $0 (Oracle, with the reclaim risk) | Medium, plus ongoing operations | Medium: `localDisk` is experimental |

**What each stage changes in the code**

- **Stage 1:** the wrapper's proxy sends one record per turn, and the Channel stores it as one Event. `AgentLink` stops its HTTP heartbeat timer. Context and usage readings move onto the socket. The presence alarm reads `getWebSocketAutoResponseTimestamp` instead of heartbeat rows.
- **Stage 2:**
  - `worker/src/hook-capture.ts` and `channel.ts`: split `insert` into broadcast now and store later. Buffer low-value kinds in the socket attachment, write one `batch` Event per turn, and ack after the write.
  - `worker/src/relay/relay.ts`: the rule-Drop `verdict` goes into the batch.
  - History reads (`/api/events` paging, stream replay, Agent Summary, `dashboard/src/data/history.ts`): expand batches.
  - `worker/test/rows-read.test.ts`: new budgets.
  - Docs: an ADR amending ADR 0030, and CONTEXT.md's **Event** (an Event may be stored inside a batch).
- **Stage 3:**
  - An `archive` job on the shared alarm: gzip old batches with `CompressionStream`, put one object per Channel per day in R2, then delete the rows under a daily budget, as `index_builds` already does.
  - `/api/events?before=` falls through to R2.
  - An `r2_buckets` binding in `worker/wrangler.jsonc`.
- **Stage 4:** a CLI command that runs `workerd` or `wrangler dev` with persistence and a local sign-in, GitHub through the Person's token, and polling for pushes and merges, plus the new ADR.

**Analytics Engine** is an optional addition to stage 1. It keeps per-model-call token and cost figures for the Accounts panel without storing a row per call.

## To measure before building

- Whether the free plan's 100,000 Durable Object requests a day apply the 20:1 WebSocket ratio. Check the account's billable usage for one day against the message count. This decides whether stage 2b is needed.
- Real stored bytes per Event type: a bounded `sum(length(payload))` over the newest 10,000 `seq`.
- The real share of tool calls that edit files, and how often the Agent row changes, using the `rows()` meter in `rows-read.test.ts`.
- Whether `DROP TABLE` is metered per row. It is not documented. If it is not, per-day tables would make stage 3's deletes nearly free.
- Whether the per-object cap on the free plan is 1 GB or 10 GB ([DO limits][do-limits] says both).

## Sources

All read on 2026-10-28. "Updated" is the page's own last-updated date, where it shows one.

| Ref | Page | Updated |
|---|---|---|
| [do-pricing] | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) | 2026-10-18 |
| [do-limits] | [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) | 2026-06-01 |
| [do-sql] | [SQLite-backed Durable Object storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) | 2026-09-21 |
| [do-state] | [Durable Object state API](https://developers.cloudflare.com/durable-objects/api/state/) | 2026-09-30 |
| [do-ws] | [Durable Objects WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) | 2026-09-30 |
| [do-lifecycle] | [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) | 2026-10-15 |
| [do-notes] | [Durable Objects release notes](https://developers.cloudflare.com/durable-objects/release-notes/) (20:1 ratio 2024-04-01; free plan 2025-04-07) | |
| [wk-pricing] | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) | 2026-10-02 |
| [wk-limits] | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) | 2026-10-12 |
| [r2-pricing] | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) | 2026-10-26 |
| [r2-start] | [R2 get started](https://developers.cloudflare.com/r2/get-started/) | 2026-04-21 |
| [d1-pricing] | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) | 2026-04-21 |
| [kv-pricing] | [Workers KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) | 2026-04-21 |
| [kv-limits] | [Workers KV limits](https://developers.cloudflare.com/kv/platform/limits/) | 2026-10-08 |
| [ae-pricing] | [Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) | 2026-04-23 |
| [ae-limits] | [Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) | 2026-04-23 |
| [wrangler-dev] | [Wrangler Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/) | 2026-10-26 |
| [local-data] | [Local data](https://developers.cloudflare.com/workers/development-testing/local-data/) | 2026-06-25 |
| [workerd] | [workerd README](https://github.com/cloudflare/workerd) (latest release v1.20261028.1, published 2026-10-28) | |
| [workerd-capnp] | [workerd.capnp, `durableObjectStorage`](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp) | main |
| [workerd-alarm] | [alarm-scheduler.h](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/alarm-scheduler.h) | main |
| [turso] | [Turso pricing](https://turso.tech/pricing) | |
| [neon] | [Neon pricing](https://neon.com/pricing) | |
| [supabase] | [Supabase pricing](https://supabase.com/pricing) | |
| [dov-pricing] | [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets) | |
| [hz-cost] | [Hetzner Cloud cost-optimized](https://www.hetzner.com/cloud/cost-optimized) | |
| [hz-reg] | [Hetzner Cloud regular performance](https://www.hetzner.com/cloud/regular-performance) | |
| [fly-pricing] | [Fly.io pricing](https://docs.fly.io/about/pricing) | |
| [oracle] | [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) | |
| [gcp-free] | [Google Cloud free features](https://docs.cloud.google.com/free/docs/free-cloud-features) | 2026-10-27 |
| [render-free] | [Render free instances](https://render.com/docs/free) | |
| [litestream] | [Litestream](https://litestream.io/) (v0.5.x) | |
| [litestream-s3] | [Litestream S3-compatible guide](https://litestream.io/guides/s3-compatible/) (names Cloudflare R2) | |

[do-pricing]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[do-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/
[do-sql]: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
[do-state]: https://developers.cloudflare.com/durable-objects/api/state/
[do-ws]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[do-lifecycle]: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
[do-notes]: https://developers.cloudflare.com/durable-objects/release-notes/
[wk-pricing]: https://developers.cloudflare.com/workers/platform/pricing/
[wk-limits]: https://developers.cloudflare.com/workers/platform/limits/
[r2-pricing]: https://developers.cloudflare.com/r2/pricing/
[r2-start]: https://developers.cloudflare.com/r2/get-started/
[d1-pricing]: https://developers.cloudflare.com/d1/platform/pricing/
[kv-pricing]: https://developers.cloudflare.com/kv/platform/pricing/
[kv-limits]: https://developers.cloudflare.com/kv/platform/limits/
[ae-pricing]: https://developers.cloudflare.com/analytics/analytics-engine/pricing/
[ae-limits]: https://developers.cloudflare.com/analytics/analytics-engine/limits/
[wrangler-dev]: https://developers.cloudflare.com/workers/wrangler/commands/workers/
[local-data]: https://developers.cloudflare.com/workers/development-testing/local-data/
[workerd]: https://github.com/cloudflare/workerd
[workerd-capnp]: https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp
[workerd-alarm]: https://github.com/cloudflare/workerd/blob/main/src/workerd/server/alarm-scheduler.h
[turso]: https://turso.tech/pricing
[neon]: https://neon.com/pricing
[supabase]: https://supabase.com/pricing
[dov-pricing]: https://www.digitalocean.com/pricing/droplets
[hz-cost]: https://www.hetzner.com/cloud/cost-optimized
[hz-reg]: https://www.hetzner.com/cloud/regular-performance
[fly-pricing]: https://docs.fly.io/about/pricing
[oracle]: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
[gcp-free]: https://docs.cloud.google.com/free/docs/free-cloud-features
[render-free]: https://render.com/docs/free
[litestream]: https://litestream.io/
[litestream-s3]: https://litestream.io/guides/s3-compatible/
