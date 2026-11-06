// The Brief of the mock Channel (ADR 0042): the pages its Agents keep, as the Worker
// returns them, the overview first and the stuck page last.
import type { BriefPage } from "@shared/index";
import { A, ago } from "./fixtures";

const OVERVIEW = `# The app

A web client for the team's internal API: the users page, settings and the dashboard widgets, all in \`web/\`.

## Where it stands

- The API client is being cleaned up (#11): \`getJson\` became \`request()\` in #12, and typed errors (#13) are next.
- Retries for failed GET requests are in review (#16). Writes are never retried, as ADR 0003 decided.
- The users page pages by 50 (#14); its empty state (#20) and keyboard shortcuts (#21) are open.
- CI for \`web/\` runs on every pull request since #10.

## What is next

1. A timeout option for \`request()\` (#15), then moving the dashboard widgets onto it (#18).
2. Validating the settings form (#17).

See **stuck** for what is not moving.`;

const API_CLIENT = `# API client

Every call goes through \`request()\` in \`web/src/api/client.ts\` (#12).

- It retries a 429 or a 5xx three times, waiting 250ms, 1s and 4s, for GET only (#16, ADR 0003).
- Lists page by 50 with \`?cursor=\`.
- Errors are \`ApiError\` with the server's \`reason\` (#13, open). Until it lands, callers read \`error.status\`.

Open: a timeout option (#15). The widgets still call \`fetch\` directly until #18.`;

const USERS_PAGE = `# Users page

Pages by 50 through \`request()\` (#14), sorted by last sign-in.

- Empty state: open (#20).
- Keyboard shortcuts for the table: open (#21), waiting on the design pass.`;

const STUCK = `# Stuck and not happening

- #9, the flaky login test: claimed two days ago, no Update since. Its holder is Gone.
- #19, the channel-messages rule for AGENTS.md: nobody has claimed it.
- #18 waits on #15: the widgets cannot move to \`request()\` before it has a timeout.`;

const librarian = { agent: A.shlokClaude, person: "shlok", nickname: "api-client" };
const scout = { agent: A.mayaClaude, person: "maya", nickname: "users-page" };

export const BRIEF_PAGES: BriefPage[] = [
  { page: "overview", title: "Overview", version: 6, text: OVERVIEW, author: librarian, updatedAt: ago(60 * 40) },
  { page: "api-client", title: "API client", version: 4, text: API_CLIENT, author: librarian, updatedAt: ago(60 * 60 * 3) },
  { page: "users-page", title: "Users page", version: 2, text: USERS_PAGE, author: scout, updatedAt: ago(60 * 60 * 26) },
  { page: "stuck", title: "Stuck and not happening", version: 9, text: STUCK, author: librarian, updatedAt: ago(60 * 12) },
];
