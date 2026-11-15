import { readerFor } from "./github/index";
import { ManagedReadFailure, managedError } from "./managed-channel";
import { githubTool, readOnlyGitHub } from "./mcp/github";

/** Call only inside the managed facade, after task.read admission. */
export async function managedGitHubRead(env: Env, repo: string, url: URL): Promise<unknown> {
  const about = url.searchParams.get("about");
  const since = url.searchParams.get("since");
  // The tool chooses all API operations. No client-supplied repository, URL or
  // GraphQL document enters the App client; paths remain within this repository.
  if (
    about !== null &&
    (about.length > 200 ||
      [...about].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
  )
    return managedError(400, "invalid_github_query");
  const rest = readerFor(env, repo);
  const unavailable = async (): Promise<never> => {
    throw new ManagedReadFailure(404);
  };
  const reader = rest === null ? null : readOnlyGitHub(rest, repo);
  const github =
    reader === null
      ? null
      : {
          get: (path: string) => reader.get(path),
          query: async (query: string, variables: Record<string, unknown>) => {
            const response = await reader.query(query, variables);
            if (!response.ok) return response;
            const body = await response.json<{ data?: unknown; errors?: unknown[] }>();
            // Legacy tools include partial GraphQL error messages in successful text.
            // Managed reads reject partial answers rather than release upstream errors.
            if (body.errors?.length) throw new ManagedReadFailure(502);
            return Response.json({ data: body.data });
          },
        };
  const result = await githubTool.run(
    {
      channel: { askChannel: unavailable, askBrief: unavailable },
      github,
      langfuse: unavailable,
      repo,
      origin: url.origin,
      now: Date.now(),
    },
    { ...(about === null ? {} : { about }), ...(since === null ? {} : { since }) },
  );
  // External error messages can contain upstream payloads or installation details.
  // Keep them out of managed responses, including tool-caught exceptions.
  if (result.isError) throw new ManagedReadFailure(502);
  return { text: result.text, isError: false };
}
