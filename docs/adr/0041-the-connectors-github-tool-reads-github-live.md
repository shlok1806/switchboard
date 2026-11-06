# The Connector's github tool reads GitHub live, through the App

Status: accepted on 2026-11-06, for #157, the second tool of ADR 0040's plan. Builds on ADR 0007 (the Switchboard GitHub App and its installation token), ADR 0037 (the free plan's rows are the budget) and ADR 0040 (the read-only Connector, its sign-in and its tool list).

## Context

ADR 0040 planned a `github` tool beside `channel`: issues, pull requests, commits, CI runs and repo files, read live through the GitHub App Switchboard already has, never copied into the Channel. Two questions set its shape: "what merged in the last week, and what is failing CI?" and "what does the ADR about X say?". The asker's own model does the reasoning, so the tool only has to answer bounded reads with links it can cite and follow up on.

Three limits matter besides rows:

- A Worker on the free plan may make 50 subrequests per request, and one Connector POST may batch 8 tool calls (ADR 0040). The REST API needs a call per pull request to learn its CI state, so "what is open and what is failing" would cost one call per pull request.
- GitHub rate-limits the App's installation: 5,000 REST calls an hour, a GraphQL budget in points, and code search at 10 calls a minute.
- The App can read every repo its installation covers, not only the Channel's.

## Decision

### One tool, the same two arguments as `channel`

`github(about?, since?)`, where `about` says which question it is:

- **Nothing:** what happened since `since` (7 days by default, as the question is usually about a week): the pull requests merged, each with its CI state; the open ones, with theirs; a "Failing CI" list of the default branch's head and the open pull requests whose checks fail, each failing check named with its link; the commits on the default branch; the issues opened and closed.
- **`#123`** (or `123`): that issue or pull request, with its state, author, labels, CI and failing checks, the issues a pull request closes, and its description.
- **A path** (no spaces, and a `/` or a file extension): a file's text or a directory's entries, ADRs marked with their number, and the latest commits that changed it (since `since`, when given). This answers "what changed in an area and when".
- **Words:** the repo's docs (Markdown and other prose files) whose paths match the words, the best match's text with its ADR number, and the issues and pull requests GitHub's search finds for them.

The same shape as `channel` keeps the Connector one idea: `about` narrows, `since` reaches back. A tool per kind of thing, or a `kind` argument, would make the asker's model choose between near-identical tools for no answer it could not get from `about`.

### GraphQL, at most three calls to GitHub per question

The tool reads through GitHub's GraphQL API, which answers a whole question in one call: the activity answer asks for the merged and open pull requests with their last commit's `statusCheckRollup`, the default branch's history, and both issue searches in one query. A number is one query and a path is one. Words are the recursive tree (REST, one call) and an issue search (GraphQL) in parallel, then the best doc's text. So a question is at most three calls, and a batch of 8 questions at most 24 plus the installation token's two, inside the 50.

### Docs are found by their paths, not by code search

Words are matched against the paths of the default branch's prose files, from one call to the recursive tree. A word counts for more the fewer docs it matches (inverse document frequency), so "ADR" in "the ADR about stale claims" barely counts and the docs that match only such words are left out. A number matches a numbered file, so "ADR 2" finds `0002-...`. This repo's ADRs, like most, are named for what they decide, which is what the asker names.

We rejected GitHub's code search: 10 calls a minute for the whole installation, an index that lags pushes, and no way to read the text it found without another call.

### What GitHub cannot answer comes back in words

Every failure is a tool result with `isError` and a sentence the asker's model can pass on, never a thrown error or a JSON-RPC error: a used-up rate limit says until when (from `x-ratelimit-reset` or `retry-after`, and GraphQL's `RATE_LIMITED`), GitHub's 5xx says to ask again in a minute, a missing installation or App says so with the setup doc. When GitHub answers part of a query and refuses the rest, as when the App may not read CI, the answer keeps what came and adds a note saying what is missing.

### The App reads CI with two more read-only permissions

`statusCheckRollup` needs **Checks: Read-only** (check runs, which GitHub Actions jobs are) and **Commit statuses: Read-only** (statuses other CI services post). They join the App's permissions in `docs/github-app-setup.md`; the owner updates the App, and each installation accepts the new permissions. Until then the answer says CI is missing and everything else still comes. Actions' own permission is not needed: a check run carries its job's link.

### Only the Channel's repo

The words are stripped of search qualifiers (anything with a `:`) before they go into the search, and only results whose links are under the Channel's repo are kept, so a question cannot reach another repo the installation covers. Every query names the Channel's repo itself. The tool gets a read-only view of the App's client, which sends GET requests and GraphQL queries and refuses a document with a mutation or subscription before it is sent.

### Bounded, with links

The lists are capped: 20 merged and 20 open pull requests, 15 commits, 15 issues opened and 15 closed, 10 search results, 10 docs, 200 directory entries and 5 failing checks per item. Each says when there are more. A file is quoted up to 24,000 characters, and an issue's or pull request's description up to 4,000. Quoted text is fenced, so its own headings stay inside it. Every item carries its number or path and its GitHub link, and the answer is framed as information, not instructions (ADR 0005).

## Consequences

- No row is written per question, and the rows read are only the ones every Connector call reads to admit itself (its grant and its Person's Membership, by key): GitHub answers the question, not the Channel.
- Each question spends the App's GitHub rate limit, which the Channel's Task sync and mirroring also spend. One question is one to three calls, so a busy Connector is a small share of 5,000 an hour.
- A doc whose path does not name its subject is found only by listing its directory. The tool says to do that when nothing matches.

## Verification

- `worker/test/ask-github.test.ts`, through the Connector's endpoint, with GitHub replaced at its HTTP boundary (`worker/test/fake-github-api.ts`) and the real App client minting its installation token there: the activity answer lists the week's merged pull requests with links and CI state and leaves out older ones, and its Failing CI list names the default branch and the open pull request whose check failed, with the check's link; a longer `since` reaches further. Words about a subject return the ADR's number and text and leave out ADRs about other subjects; an ADR is found by its number. A number, a directory and a file answer with their CI, entries and commits. A rate limit (REST and GraphQL), a 502, a partial answer, a missing installation and a missing App each come back as words. Every kind of question writes no row and calls GitHub at most three times.
- `worker/test/ask-channel.test.ts`: every tool the Connector lists writes no row, `github` included.
- `worker/test/rows-read.test.ts`: a `github` question reads exactly the rows a `ping` reads.
- By hand, the tool's queries run against the real `shlok1806/switchboard` with a user token, to check them against GitHub's schema.
