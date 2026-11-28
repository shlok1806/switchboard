# The costs tool reads the repo's own Langfuse, with a key only the owner sets

Status: accepted on 2026-11-06, for #160, the fifth tool of ADR 0040's plan. Builds on ADR 0007 (Membership, checked with GitHub), ADR 0037 (the free plan's rows are the budget), ADR 0040 (the read-only Connector and its tool list) and ADR 0041 (a source read live, answered in words when it cannot answer).

## Context

ADR 0040 planned a `costs(period, by)` tool: what running the repo's product costs, and how that is trending, read live from the repo's own Langfuse project with a per-Channel key, never copied. The owner decided the numbers (#160, 2026-11-06): cost, tokens, calls, errors and latency, by model, by period and by trace name. The first user is Greenroom, whose daemon sends its verifier traces to Langfuse Cloud (Greenroom's daemon ADR 0046): traces named `verifier turn`, generations named `chat` and `describe` with their model, the run id as the session id, and the environment `production` for served runs and `bench` for bench runs.

What sets its shape:

- Langfuse authenticates its public API with HTTP Basic auth: the project's public key as the user and its secret key as the password. Langfuse has no read-only key: a project's key pair can also ingest. So the secret key is the most sensitive thing a Channel has held, and nobody but the Worker should ever read it back.
- No one on a Channel was more than a Member until now. Who may set a key that every Member's questions then spend needs a rule.
- Langfuse's Metrics API v2 (`GET /api/public/v2/metrics`, checked against Langfuse's OpenAPI spec on 2026-11-06) answers aggregate questions over its `observations` view: dimensions such as `providedModelName`, `traceName`, `environment`, `type`, `level` and `isRootObservation`, measures such as `totalCost`, `inputTokens`, `outputTokens`, `totalTokens`, `count` and `latency`, aggregations `sum`, `count` and `p50` to `p99`, and a time dimension by `day` or `week`. Each answer row names its metrics `<aggregation>_<measure>`. v1 (`/api/public/metrics`) is deprecated, and v2 is what Langfuse Cloud and self-hosted Langfuse v4 serve.
- One Connector POST may batch 8 tool calls (ADR 0040), inside a Worker's 50 subrequests.

## Decision

### The Channel Owner connects the Langfuse Project

- A **Channel Owner** is a Person with admin access to the repo on GitHub. It is asked of GitHub on each settings call and never cached: only the owner's own actions need it, and they are rare. Under the dev-only fake sign-in without GitHub, everyone is.
- `PUT /api/settings/langfuse` `{ host, publicKey, secretKey }` connects the project or replaces its keys; `DELETE` removes it; `GET` answers what anyone on the Channel may see of it, `{ langfuse: { host, publicKeyEnd, project, connectedBy, connectedAt } | null, canManage }`. Only a Person's session reaches them: an Agent token is refused as on every route not on its list, and the Connector's token is not a session.
- The host is an https address (plain http only for this machine), with no credentials, query or fragment; any path a self-hosted Langfuse sits under is kept. The keys must start `pk-lf-` and `sk-lf-`, which also catches them pasted the wrong way round.
- Before it keeps the keys, the Worker asks Langfuse which project they belong to (`GET /api/public/projects`). Keys Langfuse refuses, or a host that does not answer as Langfuse does, are refused with 422 and nothing is kept. The project's id and name are kept, for links and so the page can say which project it is.
- The Dashboard's **Channel settings** page (`#/settings`, from the account menu and the phone's More) shows the project, host, `pk-lf-...` with the public key's last 4 characters, "kept sealed, never shown" for the secret key, and who connected it when. Only the owner sees the form, **Replace keys** and **Remove**; everyone else is told the owner connects it.

### The secret key is sealed at rest and never leaves the Worker

- It is kept in one row of the Channel's SQLite, `langfuse_project`, sealed with AES-256-GCM under a key derived from SESSION_SECRET with HKDF-SHA256 for this one purpose (`worker/src/secret-box.ts`). The Channel's repo is the additional data, so a sealed value copied into another Channel does not open. SESSION_SECRET is the secret the Worker already has and already treats as its root (ADR 0040), so this needs no new Worker secret for the owner to set.
- No route returns it: every answer is built from the row's public view, which has no key, and the public key itself goes back only as its last 4 characters. It is opened only for a call to Langfuse, in the Worker, and never logged. An error Langfuse sends back is passed on with the secret key cut out, should Langfuse ever echo it.
- The Worker only ever sends GETs, to those two paths. That the key pair could also ingest is Langfuse's; nothing here does.
- Rotating SESSION_SECRET makes the sealed key unreadable. The tool then says so, and the owner connects the project again. We accepted that over a separate Worker secret that the owner would have to create and keep, since rotating SESSION_SECRET already signs everyone out (ADR 0040) and is rare.

### `costs(period?, by?, environment?)` reads it live

- `period`, in UTC: a span (`24h`, `7d`, `4w`), `today`, `yesterday`, `this week` (from Monday), `last week`, `this month`, `last month`, a month (`2026-10`), a day, or a range of days (`2026-10-01..2026-10-14`). 30 days by default, at most 366. A period ends a millisecond before its end, so the first moment of the next is not counted in both.
- `by`: `model` (the default), `trace` (trace name), `day` (up to 92 days) or `week`.
- `environment`: `production` by default, so a Greenroom question about verifier runs is about served runs; `bench` asks about bench runs. Any Langfuse environment name is taken.
- Three queries over `observations`, in that environment and period, sent at once:
  1. the generations (`type` GENERATION): `sum` of `totalCost`, `inputTokens`, `outputTokens` and `totalTokens`, `count`, and `p50` and `p95` of `latency`, by the grouping;
  2. the errors: observations at `level` ERROR, counted by the grouping;
  3. the traces: root observations (`isRootObservation`), counted, with their latency's p50 and p95, by trace name or time, or one total when grouped by model, which a trace has none of.
- The answer gives the total (cost, generation calls, tokens in and out, traces, errors), then one line per group: cost and its share, calls, tokens, generation latency p50 and p95, errors, and for a trace name its traces and their latency. Groups are sorted by cost, or by time. At most 30 lines and 100 rows per query; the answer says when Langfuse returned its 100 largest groups. It links the project, its traces and its sessions in Langfuse, and says that Langfuse's UI shows the viewer's time zone, so its day edges can differ from these UTC ones.
- With no project connected, the tool says so and where the owner connects one, as an answer, not an error. When Langfuse refuses the keys, has used up the project's rate limit (with `retry-after`), fails, has no Metrics API v2, cannot be reached, or refuses the query, the tool says so in a sentence with `isError`, as the github tool does (ADR 0041).
- Without the asker giving a trace name, the numbers are the environment's. For Greenroom that is its verifier: every generation it sends is inside a `verifier turn`.

## Consequences

- "What did verifier runs cost last month, by model?" is answered from Langfuse's own aggregates, so it matches what Langfuse shows for the same UTC range.
- **Rows per question: none written**; read, the one `langfuse_project` row besides the rows every Connector call reads to admit itself (ADR 0040), and the row is read only when `costs` is called. Connecting writes one row, as does replacing; removing deletes it.
- **Calls per question: three GETs to Langfuse.** A batch of 8 is 24, inside the 50 subrequests. They spend the Langfuse project's own API rate limit, shared with whatever else reads it.
- Only the owner can point the Channel at a Langfuse host, which the Worker then calls with the keys; a Member cannot make the Worker call an address of their choosing.
- A self-hosted Langfuse before v4 has no Metrics API v2; the tool says so. Reading v1 there is an addition when someone needs it.
- Every Member's question reads the project's numbers. Langfuse holds traces with prompts and outputs too; the tool asks only for aggregates, never for a trace's content.

## Verification

- `worker/test/costs.test.ts`, through the settings route and the Connector's endpoint, with Langfuse replaced at its HTTP boundary (`worker/test/fake-langfuse.ts`), which computes each metrics query from the observations a test puts in it: the owner connects and everyone reads the host, project and the public key's end, never the secret key; the row holds the key sealed, and no route the Dashboard or the Connector calls (the settings route, the Channel's reads, `initialize`, `tools/list`, `costs` by every grouping) sends it back; the Connector's token reaches no settings route; a Member cannot connect, replace or remove; refused keys, a host that is not Langfuse and malformed fields keep nothing. The costs tool says when nothing is connected; "last month, by model" returns each model's cost, calls, tokens, latency and errors, leaves out this month and the bench environment, and `bench` answers for itself; by trace name and by day; Langfuse's 429, 401, 404, 502, 400 and an unreachable host come back as sentences; bad periods and groupings are refused; a key sealed under another SESSION_SECRET is said to be unreadable; a question writes no row and sends three GETs with the project's Basic auth.
- `worker/test/ask-channel.test.ts`: the Connector lists `costs` read-only, and calling it writes no row.
- `worker/test/rows-read.test.ts`: a `costs` question reads exactly the admitting rows plus one.
- `dashboard/test/settings.test.tsx` and the screenshot run: a Member sees a connected project with no way to change it, or is told the owner connects one; the owner connects a self-hosted project after Langfuse refused the first keys, replaces the keys, removes the project after a confirmation, and the secret key is gone from the page once saved; a failed read says so and reads again.
- By hand, once merged: the owner connects Greenroom's Langfuse Cloud project and asks "what did verifier runs cost last month, by model?", and compares it with Langfuse's own dashboard for the same range.
