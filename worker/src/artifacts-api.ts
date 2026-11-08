// The artifact routes of the Channel API (ADR 0053). Wire types live in shared/src/artifacts.ts.
//
//   GET /api/artifacts                          each artifact's latest version, the latest first
//   GET /api/artifacts/:name[?version=n]        one version, and every version kept
//   GET /api/artifacts/:name/page[?version=n]   the page itself, in a sandbox; &download=1 saves it
//   PUT /api/artifacts/:name                    publishes the next version { html, title? }
//   DELETE /api/artifacts/:name                 its owner, as a Person, removes every version
//
// Any Person or Agent on the Channel reads and publishes; a name belongs to the Person
// who first published it, and only that Person deletes it: an Agent token is refused, as
// deleting cannot be undone and an Agent never acts as its Person (ADR 0034). The page is served with a `sandbox` Content-Security-Policy,
// so its scripts run in an opaque origin: the session cookie never makes them the
// viewer, and they cannot read the Channel's answers or write to it (writes check Origin).

import type {
  ArtifactResponse,
  ArtifactsResponse,
  DeleteArtifactResponse,
  PublishArtifactResponse,
} from "../../shared/src/index";
import { ARTIFACT_CSP, ARTIFACTS_PATH, checkArtifact } from "../../shared/src/index";
import type { Channel } from "./channel";
import type { Caller } from "./claims";
import { fail, json, readJson } from "./http";

const AGENT_MAY_NOT_DELETE =
  "An Agent cannot delete an artifact: deleting cannot be undone, and an Agent never acts as its Person. " +
  "Its Person deletes it from the Dashboard or with `switchboard artifacts delete`.";

export type ArtifactRoute =
  | { kind: "list" }
  | { kind: "read"; name: string }
  | { kind: "page"; name: string }
  | { kind: "publish"; name: string }
  | { kind: "delete"; name: string };

const ONE = /^\/api\/artifacts\/([^/]+)(\/page)?$/;

/** The artifact route a request is for, or null. */
export function matchArtifactRoute(method: string, pathname: string): ArtifactRoute | null {
  if (pathname === ARTIFACTS_PATH) return method === "GET" ? { kind: "list" } : null;
  const match = ONE.exec(pathname);
  if (!match?.[1]) return null;
  let name: string;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (match[2] !== undefined) return method === "GET" ? { kind: "page", name } : null;
  if (method === "GET") return { kind: "read", name };
  if (method === "PUT") return { kind: "publish", name };
  if (method === "DELETE") return { kind: "delete", name };
  return null;
}

export async function handleArtifactRoute(
  route: ArtifactRoute,
  request: Request,
  url: URL,
  channel: DurableObjectStub<Channel>,
  caller: Caller,
): Promise<Response> {
  if (route.kind === "list") return json<ArtifactsResponse>({ artifacts: await channel.listArtifacts() });
  if (route.kind === "read" || route.kind === "page") {
    const raw = url.searchParams.get("version");
    if (raw !== null && !/^[1-9]\d{0,8}$/.test(raw)) return fail(400, '"version" must be a version number.');
    const version = raw === null ? undefined : Number(raw);
    if (route.kind === "read") {
      const read = await channel.readArtifact(route.name, version);
      if (!read.ok) return fail(read.status, read.reason);
      return json<ArtifactResponse>(read.value);
    }
    const page = await channel.artifactPage(route.name, version);
    if (!page.ok) return fail(page.status, page.reason);
    const { artifact, html } = page.value;
    const headers: Record<string, string> = {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": ARTIFACT_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-cache",
      ETag: `"${artifact.digest}"`,
    };
    if (url.searchParams.get("download") === "1") {
      headers["Content-Disposition"] = `attachment; filename="${artifact.name}-v${artifact.version}.html"`;
    }
    if (request.headers.get("If-None-Match") === headers.ETag) return new Response(null, { status: 304, headers });
    return new Response(html, { headers });
  }
  if (route.kind === "delete") {
    if (caller.agent !== undefined) return fail(403, AGENT_MAY_NOT_DELETE);
    const deleted = await channel.deleteArtifact(caller.person, route.name);
    if (!deleted.ok) return fail(deleted.status, deleted.reason);
    return json<DeleteArtifactResponse>({ ok: true, ...deleted.value });
  }
  const check = checkArtifact(route.name, await readJson(request));
  if (!check.ok) return fail(400, check.reason);
  const published = await channel.publishArtifact(caller, route.name, check.publish);
  if (!published.ok) return fail(published.status, published.reason);
  return json<PublishArtifactResponse>(published.value, published.value.published ? 201 : 200);
}
