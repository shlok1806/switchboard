// The skill routes of the Channel API (ADR 0039). Wire types live in shared/src/skills.ts.
//
//   GET  /api/skills                     each skill's latest version, without its files
//   GET  /api/skills/:name[?version=n]   one version with its files, and every version
//   POST /api/skills/:name               publishes the next version { files }
//
// Any Person or Agent on the Channel reads them. A Person, or one of their Agents,
// publishes; a name belongs to the Person who first published it.

import type { PublishSkillResponse, SkillFile, SkillResponse, SkillsResponse } from "../../shared/src/index";
import type { Channel } from "./channel";
import type { Caller } from "./claims";
import { fail, json, readJson } from "./http";

export type SkillRoute = { kind: "list" } | { kind: "read"; name: string } | { kind: "publish"; name: string };

const ONE = /^\/api\/skills\/([^/]+)$/;

/** The skill route a request is for, or null. */
export function matchSkillRoute(method: string, pathname: string): SkillRoute | null {
  if (pathname === "/api/skills") return method === "GET" ? { kind: "list" } : null;
  const match = ONE.exec(pathname);
  if (!match?.[1]) return null;
  let name: string;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (method === "GET") return { kind: "read", name };
  if (method === "POST") return { kind: "publish", name };
  return null;
}

export async function handleSkillRoute(
  route: SkillRoute,
  request: Request,
  url: URL,
  channel: DurableObjectStub<Channel>,
  caller: Caller,
): Promise<Response> {
  if (route.kind === "list") return json<SkillsResponse>({ skills: await channel.listSkills() });
  if (route.kind === "read") {
    const raw = url.searchParams.get("version");
    if (raw !== null && !/^[1-9]\d{0,8}$/.test(raw)) return fail(400, '"version" must be a version number.');
    const read = await channel.readSkill(route.name, raw === null ? undefined : Number(raw));
    if (!read.ok) return fail(read.status, read.reason);
    return json<SkillResponse>(read.value);
  }
  const { files } = await readJson(request);
  if (!Array.isArray(files)) return fail(400, 'A skill is published as { "files": [{ "path", "content" }] }.');
  const published = await channel.publishSkill(caller, route.name, files as SkillFile[]);
  if (!published.ok) return fail(published.status, published.reason);
  return json<PublishSkillResponse>(published.value, published.value.published ? 201 : 200);
}
