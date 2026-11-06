// The Brief's routes of the Channel API (ADR 0042). Wire types live in shared/src/brief.ts.
//
//   GET /api/brief                    every page's current version, the overview first
//   GET /api/brief/:page[?version=n]  one page, current or one of its kept earlier versions
//   PUT /api/brief/:page              an Agent replaces the page { text, title? }
//
// Any Person or Agent on the Channel reads. Only an Agent writes, through its own MCP.
// The Connector's token reaches none of these: it is not a Person session or an Agent token.

import type { BriefPageResponse, BriefResponse, WriteBriefResponse } from "../../shared/src/index";
import { BRIEF_PATH, cleanBriefWrite } from "../../shared/src/index";
import type { Channel } from "./channel";
import type { Caller } from "./claims";
import { fail, json, readJson } from "./http";

export type BriefRoute = { kind: "list" } | { kind: "read"; page: string } | { kind: "write"; page: string };

const ONE = /^\/api\/brief\/([^/]+)$/;

/** The Brief route a request is for, or null. */
export function matchBriefRoute(method: string, pathname: string): BriefRoute | null {
  if (pathname === BRIEF_PATH) return method === "GET" ? { kind: "list" } : null;
  const match = ONE.exec(pathname);
  if (!match?.[1]) return null;
  let page: string;
  try {
    page = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (method === "GET") return { kind: "read", page };
  if (method === "PUT") return { kind: "write", page };
  return null;
}

export async function handleBriefRoute(
  route: BriefRoute,
  request: Request,
  url: URL,
  channel: DurableObjectStub<Channel>,
  caller: Caller,
): Promise<Response> {
  if (route.kind === "list") return json<BriefResponse>({ pages: await channel.briefPages() });
  if (route.kind === "read") {
    const raw = url.searchParams.get("version");
    if (raw !== null && !/^[1-9]\d{0,8}$/.test(raw)) return fail(400, '"version" must be a version number.');
    const read = await channel.readBriefPage(route.page, raw === null ? undefined : Number(raw));
    if (!read.ok) return fail(read.status, read.reason);
    return json<BriefPageResponse>(read.value);
  }
  const write = cleanBriefWrite(route.page, await readJson(request));
  if (!write.ok) return fail(400, write.reason);
  const result = await channel.writeBriefPage(caller, route.page, write.write);
  if (!result.ok) return fail(result.status, result.reason);
  return json<WriteBriefResponse>({ ok: true, ...result.value }, result.value.written ? 201 : 200);
}
