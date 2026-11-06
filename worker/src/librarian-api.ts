// The librarian's routes of the Channel API (ADR 0045). Wire types live in shared/src/librarian.ts.
//
//   GET /api/librarian        what changed after the Librarian Cursor (any Person or Agent)
//   PUT /api/librarian        the librarian moves its cursor { through, quiet }
//   GET /api/github           the Connector's github tool's answer, for Agents and Persons (ADR 0041)
//
// A librarian's token reaches these, the Brief's routes, every read, and its wrapper's own
// reports, and nothing else that writes (`librarianMayCall`).

import type {
  GitHubReadResponse,
  LibrarianFeedResponse,
  MoveLibrarianCursorResponse,
  TaskNumber,
} from "../../shared/src/index";
import { GITHUB_READ_PATH, LIBRARIAN_PATH } from "../../shared/src/index";
import type { Channel } from "./channel";
import type { Caller } from "./claims";
import { readerFor } from "./github/index";
import { fail, json, readJson } from "./http";
import { githubTool, readOnlyGitHub } from "./mcp/github";

export type LibrarianRoute = { kind: "feed" } | { kind: "move" } | { kind: "github" };

/** The most Quiet Claims a cursor remembers: the most the Feed can name. */
const MAX_QUIET = 100;

export function matchLibrarianRoute(method: string, pathname: string): LibrarianRoute | null {
  if (pathname === LIBRARIAN_PATH)
    return method === "GET" ? { kind: "feed" } : method === "PUT" ? { kind: "move" } : null;
  if (pathname === GITHUB_READ_PATH && method === "GET") return { kind: "github" };
  return null;
}

/**
 * Whether the librarian's token may make a call (ADR 0045): it reads, writes Brief pages
 * and its cursor, and its wrapper and MCP server report on its own session (heartbeats,
 * its model, the Tool Capture's `tool.call`). Every other write is refused.
 */
export function librarianMayCall(
  method: string,
  route: { brief: boolean; librarian: boolean; wrapperReport: boolean; stream: boolean; toolCall: boolean },
): boolean {
  return method === "GET" || route.brief || route.librarian || route.wrapperReport || route.stream || route.toolCall;
}

export const LIBRARIAN_REFUSED =
  "The librarian's token writes Brief pages and nothing else (ADR 0045). It reads the Channel and GitHub; " +
  "Updates, notes, Claims, Directives, spawns and Tasks are for other Agents and Persons.";

export async function handleLibrarianRoute(
  route: LibrarianRoute,
  request: Request,
  url: URL,
  env: Env,
  repo: string,
  channel: DurableObjectStub<Channel>,
  caller: Caller,
): Promise<Response> {
  if (route.kind === "feed") return json<LibrarianFeedResponse>(await channel.librarianFeed());
  if (route.kind === "move") {
    const body = await readJson(request);
    const { through, quiet } = body;
    if (typeof through !== "number" || !Number.isSafeInteger(through) || through < 0) {
      return fail(400, '"through" must be the seq of the last Event handled.');
    }
    if (
      !Array.isArray(quiet) ||
      quiet.length > MAX_QUIET ||
      !quiet.every((task) => typeof task === "number" && Number.isSafeInteger(task) && task > 0)
    ) {
      return fail(400, `"quiet" must be the Task numbers of at most ${MAX_QUIET} Quiet Claims.`);
    }
    const moved = await channel.moveLibrarianCursor(caller, { through, quiet: quiet as TaskNumber[] });
    if (!moved.ok) return fail(moved.status, moved.reason);
    return json<MoveLibrarianCursorResponse>({ ok: true, cursor: moved.cursor });
  }
  // The same answer the Connector's github tool gives, through the same read-only client.
  const rest = readerFor(env, repo);
  const about = url.searchParams.get("about");
  const since = url.searchParams.get("since");
  const result = await githubTool.run(
    {
      channel: {
        askChannel: (question) => channel.askChannel(question),
        askBrief: (page) => channel.askBrief(page),
      },
      github: rest === null ? null : readOnlyGitHub(rest, repo),
      langfuse: async () => null,
      repo,
      origin: url.origin,
      now: Date.now(),
    },
    { ...(about === null ? {} : { about }), ...(since === null ? {} : { since }) },
  );
  return json<GitHubReadResponse>({ text: result.text, isError: result.isError === true });
}
