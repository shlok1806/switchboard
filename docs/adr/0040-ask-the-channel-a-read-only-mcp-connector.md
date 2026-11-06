# Ask the Channel: a read-only MCP connector any app can add

Status: accepted on 2026-11-06, for the owner's direction that anyone on a Channel, a developer or someone in the business arm, can ask about the repo's work from the Claude desktop app, ChatGPT or Claude Code and get current, cited answers (#156, with #157 to #160 to follow). Builds on ADR 0004 (one hosted Worker), ADR 0005 (Channel content is information), ADR 0007 (GitHub sign-in, Membership, Switchboard's own signed sessions), ADR 0019 and ADR 0024 (notes and summaries built from rows the Channel keeps) and ADR 0037 (the free plan's rows are the budget).

## Context

Everything a Person needs to answer "what is in progress, and what is stuck?" is on the Channel already: Tasks and their Claims, Updates, Directives, Memory Notes, Presence. Today only the Dashboard shows it, and only an Agent run through `switchboard run` can ask about it, through the stdio MCP server the wrapper gives it. Someone who does not run Agents, or who is away from the repo, has to open the Dashboard and read.

The apps people already ask questions in, the Claude desktop and web apps, ChatGPT and Claude Code, all take a remote MCP server as a connector, and all sign in to it with OAuth. So one remote MCP endpoint per Channel reaches all of them. The asker's own Claude or ChatGPT does the reasoning; the Channel only has to answer bounded reads with references the model can cite.

The constraints are the owner's:

- It is an internal tool: everyone on the Channel sees everything for now.
- The connector is read-only. No tool on it can change the Channel.
- It must not raise rows read or written meaningfully. The free Cloudflare plan is the budget (100,000 rows written and 5 million read a day for the account), and ADR 0037 just brought an Agent-hour down to about 430 rows written.
- No graph database, vector store or server-side LLM.

## Decision

### The whole plan

Ask the Channel is one read-only MCP endpoint per Channel, with a few tools that each answer from one source:

1. `channel(since?, about?)` (#156, this ADR): what the Channel stores, read with bounded, indexed queries.
2. `github` (#157): issues, pull requests, commits, CI runs and repo files, read live through the GitHub App Switchboard already has. Never copied into the Channel, so it costs no rows.
3. `brief(area?)` (#158): a living brief of the repo, a handful of short Markdown pages (an overview, one page per area, one "stuck and not happening" page). Agents write them through their own MCP; the connector only reads them. One row per page plus a short history. The pages link to Tasks, pull requests and ADRs by number, and those links are the knowledge graph.
4. A librarian Agent (#159) keeps the brief current. It is an ordinary Agent on a Host, under its Person's own CLI subscription, so learning costs no API bill.
5. `costs(period, by)` (#160): numbers read live from the repo's own Langfuse project with a per-Channel read-only key. Never copied.

Numbers are read live from their source and never copied into the Channel. There is no graph database, no vector store and no server-side LLM: synthesis is either the asker's own model reading bounded answers, or the brief an Agent wrote.

### One endpoint per Channel, Streamable HTTP, stateless

- The endpoint is `https://<worker>/r/<owner>/<repo>/mcp`, beside the Channel's API (ADR 0007's `/r/` prefix). The repo must be one the Worker allows (`ALLOWED_REPOS`).
- It speaks MCP's Streamable HTTP transport: each JSON-RPC message is a `POST`, answered with `application/json`. It opens no SSE stream and keeps no MCP session, so a `GET` or `DELETE` answers 405. Every call stands alone, which suits a Worker and costs nothing between calls.
- It answers `initialize`, `ping`, `tools/list` and `tools/call`, and takes notifications with 202. It negotiates the protocol versions 2025-11-25, 2025-06-18 and 2025-03-26.
- Tools are a list in one module, each with a name, a schema, MCP's `readOnlyHint` and a function over a read-only view of the Channel. #157, #158 and #160 add to that list.

### Sign-in: OAuth 2.1 on the Worker, backed by the GitHub sign-in

The three clients expect the same thing (checked against their docs on 2026-11-06): a `401` with `WWW-Authenticate: Bearer resource_metadata=...`, protected resource metadata (RFC 9728) whose `resource` is exactly the URL the Person typed, authorization server metadata (RFC 8414), the authorization code flow with PKCE S256, and a client identity through dynamic client registration (RFC 7591) or a Client ID Metadata Document. Claude's apps redirect to `https://claude.ai/api/mcp/auth_callback`, Claude Code to a loopback port that changes per session, ChatGPT to `https://chatgpt.com/connector_platform_oauth_redirect` when the server sends `iss` in its authorization response. Claude and ChatGPT both refresh tokens, and ask public clients' refresh tokens to rotate.

The Worker is its own authorization server, issuer `https://<worker>`:

- `GET /.well-known/oauth-protected-resource/r/<owner>/<repo>/mcp` and `GET /.well-known/oauth-authorization-server`.
- `POST /oauth/register`: dynamic registration with no stored row. The `client_id` is the registration itself (its name and redirect URIs) signed with SESSION_SECRET, so registering costs nothing and a registered client stays valid, as ChatGPT expects of a client it keeps. Clients are public (`token_endpoint_auth_method` `none`). A redirect URI must be one the known clients use: Claude's two callbacks, ChatGPT's, or a loopback address on any port, which is matched without its port as Claude Code needs. `MCP_EXTRA_REDIRECT_URIS` names more, exactly.
- `GET /oauth/authorize`: checks the client, the redirect URI, PKCE S256 and the `resource`, which must be one of this Worker's Channel endpoints and becomes the token's audience. A browser not signed in is sent through the Dashboard's own GitHub web flow (`/auth/github/start` with a `return` back here, the same callback, so the GitHub App needs no new callback URL), which checks Membership with GitHub as every sign-in does and leaves the Dashboard signed in too. Then a consent page names the Person, the Channel, the app and the host it sends the code to, and says the access is read-only. Allowing it is a `POST` from that page, checked for its origin and carrying a signed, ten-minute copy of the request. The redirect carries `code`, `state` and `iss`.
- `POST /oauth/token` (form-encoded): the code (signed, one minute, PKCE-checked, bound to its client, redirect URI and Channel) for an access token and a refresh token, and a refresh token for new ones.

What a token is:

- An **access token** is a signed payload, `kind: "mcp-access"`, naming the Person, the Channel, the audience, the scope `channel:read` and an expiry one hour on. Checking it is an HMAC: no row is read. A Person session's check (`verifySession`) takes `kind: "session"` only, so an access token is refused by every Channel API route, and the endpoint takes no other credential.
- A **refresh token** names a grant and a generation and lasts 30 days from its last use. The grant is one row in the Channel (`mcp_grants`): written when a code is redeemed, which also makes each code single-use, and updated at each refresh, which rotates the token. A refresh token of an older generation is a replay: the grant is deleted, so the whole family stops working.
- Every token request and every MCP call checks Membership through the Channel, cached for five minutes as for every other call (ADR 0007), so someone removed from the repo is refused within minutes, whatever token they hold.
- Everything is signed with the SESSION_SECRET the Worker already has. Without it the endpoints answer 503, "Sign-in is not set up", and issue nothing.

We rejected Cloudflare's `@cloudflare/workers-oauth-provider`. Its MIT licence is fine and it implements all of this, but it keeps clients, grants and tokens in a KV namespace (`OAUTH_KV`). That is a new Cloudflare resource the owner would create and bind, and the free plan's KV allows 1,000 writes a day for the account, which every registration, sign-in and refresh would spend, with a KV read on every call besides. It is also about 270 KB of code in front of the Worker's own routing. Signed, stateless tokens need no new resource, cost no rows per call and reuse the secret and the sign-in the Worker has.

We left out Client ID Metadata Documents for now. Claude and ChatGPT both prefer them only when the authorization server says it supports them, and otherwise register dynamically, which costs this Worker nothing. Supporting them later is an addition to the metadata, not a change to any client.

### Who gets in

"Anyone with access to the Channel's repo" is Membership, unchanged: write access, checked with GitHub at sign-in and every five minutes after (ADR 0007). A Person without it is refused at sign-in, with the reason, before any code is issued. Admitting read-only collaborators is a separate decision: on a public repo everyone can read, so "read access" would let any GitHub account in, and it needs its own rule. Everyone admitted sees everything on the Channel, as on the Dashboard.

### The `channel` tool

`channel(since?, about?)` answers "what is happening" and "what is not happening" from rows the Channel keeps:

- **In progress:** the Tasks that are claimed or in review, with their holder (Agent ID and Nickname, or Person), Steps done, branch, pull request and the latest Update on each.
- **Stuck:** Stale Claims (the holder is Gone, ADR 0002), Claims blocked by other Issues, and **Quiet Claims**: claimed Tasks with no Update on them for `QUIET_CLAIM_HOURS` (default 4), counted from the latest Update on the Task, or from the Claim when there is none.
- **What was said:** the newest Updates and Directives, and the newest Memory Notes, since `since`.
- **Who is on:** the Agents that are not Gone, with what each is doing.

`since` is a time (ISO 8601) or a span (`90m`, `24h`, `7d`), 24 hours by default. `about` narrows the answer to a Task (`#123`), an Agent (its ID or Nickname), a Person (a GitHub login) or, otherwise, words: notes are searched with the full-text index, and the newest Updates, Directives and in-progress Task titles are matched.

Each item carries its reference and a link: `#123` with the Task's Dashboard page and its Issue, `Update <id>` and `Directive <id>` with their place on the Dashboard's feed, and notes with the Memory view. The answer is framed as information from the Channel, never instructions to the model reading it (ADR 0005), since Updates and notes are other sessions' words.

Every read is bounded and goes through an index. The lists are capped (30 Tasks in progress, 15 Updates and Directives, 15 notes, 20 Agents), each one reads one row past its cap to say there is more, and `since` only trims what the newest-first read returned, since filtering on time in SQL would read every older row. Two partial indexes serve it: `tasks_claimed` (the Tasks with a Claim) and `events_said` (Updates and Directives by `seq`). `events_said` is a history index (ADR 0019's daily build budget), so a Channel with a long history builds it within its day's budget, and until then the answer says the Updates are not indexed yet and still gives everything else. The tool reads what the Channel holds and never asks GitHub, so a question never starts a Task sync.

### The budget

- **Rows written per question: none.** Membership's cached answer is rewritten at most every five minutes per Person, as for every other caller. A sign-in writes one grant row; a refresh, about one an hour per connected app, updates it. `events_said` adds one index row to each Update and Directive.
- **Rows read per question: at most 400** however large the Channel grows, held by `worker/test/rows-read.test.ts` on the same long seeded history as the other hot paths. At that ceiling the free plan's 5 million reads a day is 12,500 questions.

## Consequences

- A Person adds one URL to the Claude desktop app, ChatGPT or Claude Code, signs in with GitHub once, and asks in plain language. The connector cannot change anything, and its token cannot reach any route that does.
- Answers are as good as what Agents and People tell the Channel. A Task nobody posted an Update on reads as quiet, which is the point: that is what is not happening.
- The Worker becomes an OAuth authorization server. Its tokens are bearer tokens signed with SESSION_SECRET; rotating that secret signs everyone out of the Dashboard, the CLI and every connector at once.
- Anyone who can open a malicious page on the asker's machine could start a flow to a loopback redirect, as with every native-app OAuth client. The consent page names the host the code goes to, and the code is useless without the PKCE verifier its starter holds.
- Content on the Channel reaches third-party models through the asker's app: the same people already see it on the Dashboard, but it now also passes through Anthropic's or OpenAI's service under the asker's own account.

## Verification

- Worker tests (`worker/test/ask-channel.test.ts`) through the real routes: discovery from the `401`, registration, the authorize page sending the browser through the GitHub web flow and back, consent, the code for tokens, `tools/list`, a `channel` call answering what is in progress and what is stuck with Task and Update references, and a refresh that rotates. A Person without write access is refused at sign-in. A replayed code and a replayed refresh token are refused. The access token is refused by every Channel API route that writes, the endpoint takes no other credential, and calling every tool it lists writes no row.
- `worker/test/rows-read.test.ts`: a `channel` call, plain and with each kind of `about`, reads under 400 rows on the long seeded history.
- By hand against `wrangler dev`: the MCP TypeScript SDK's own OAuth client (the one Claude Code builds on) registers, signs in through the dev sign-in and calls `channel`.
