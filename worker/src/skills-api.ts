// The skill routes of the Channel API (ADR 0039, 0050). Wire types live in shared/src/skills.ts.
//
//   GET  /api/skills                     each skill's latest version, without its manifest
//   GET  /api/skills/:name[?version=n]   one version with its manifest, and every version
//   POST /api/skills/:name               publishes the next version { files: manifest };
//                                        409 { missing } names the files to upload first
//   POST /api/skill-files                stores chunks of files { chunks: [{ digest, size, index, data }] }
//   POST /api/skill-files/read           reads chunks of published files { chunks: [{ digest, index }] }
//
// A file's chunks travel as base64, at most SKILL_TRANSFER_BYTES of file bytes a request,
// so neither a request nor the RPC to the Channel comes near its limit. Any Person or Agent
// on the Channel reads them. A Person, or one of their Agents, uploads and publishes; a
// name belongs to the Person who first published it.

import type {
  PublishSkillResponse,
  ReadSkillFilesResponse,
  SkillEntry,
  SkillFilesMissing,
  SkillResponse,
  SkillsResponse,
  UploadSkillFilesResponse,
} from "../../shared/src/index";
import {
  fromBase64,
  SKILL_FILES_PATH,
  SKILL_FILES_READ_PATH,
  SKILL_TRANSFER_BYTES,
  toBase64,
} from "../../shared/src/index";
import type { Channel } from "./channel";
import type { Caller } from "./claims";
import { fail, json, readJson } from "./http";

export type SkillRoute =
  | { kind: "list" }
  | { kind: "read"; name: string }
  | { kind: "publish"; name: string }
  | { kind: "upload" }
  | { kind: "read-files" };

const ONE = /^\/api\/skills\/([^/]+)$/;

/** The skill route a request is for, or null. */
export function matchSkillRoute(method: string, pathname: string): SkillRoute | null {
  if (pathname === "/api/skills") return method === "GET" ? { kind: "list" } : null;
  if (pathname === SKILL_FILES_PATH) return method === "POST" ? { kind: "upload" } : null;
  if (pathname === SKILL_FILES_READ_PATH) return method === "POST" ? { kind: "read-files" } : null;
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

/** The longest base64 a request's chunks may carry together, with room for the JSON around them. */
const MAX_BASE64 = Math.ceil(SKILL_TRANSFER_BYTES / 3) * 4;

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
  if (route.kind === "upload") {
    const { chunks } = await readJson(request);
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return fail(400, 'Skill files are uploaded as { "chunks": [{ "digest", "size", "index", "data" }] }.');
    }
    let length = 0;
    const decoded = [];
    for (const chunk of chunks as Record<string, unknown>[]) {
      if (typeof chunk?.data !== "string") return fail(400, 'Each chunk carries its bytes as base64 "data".');
      length += chunk.data.length;
      if (length > MAX_BASE64) return fail(413, `One upload carries at most ${SKILL_TRANSFER_BYTES} bytes of files.`);
      const data = fromBase64(chunk.data);
      if (data === null) return fail(400, 'Each chunk carries its bytes as base64 "data".');
      decoded.push({ digest: String(chunk.digest), size: Number(chunk.size), index: Number(chunk.index), data });
    }
    const stored = await channel.uploadSkillFiles(decoded);
    if (!stored.ok) return fail(stored.status, stored.reason);
    return json<UploadSkillFilesResponse>(stored.value);
  }
  if (route.kind === "read-files") {
    const { chunks } = await readJson(request);
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return fail(400, 'Skill files are read as { "chunks": [{ "digest", "index" }] }.');
    }
    const read = await channel.readSkillFiles(
      (chunks as Record<string, unknown>[]).map((chunk) => ({
        digest: String(chunk?.digest),
        index: Number(chunk?.index),
      })),
    );
    if (!read.ok) return fail(read.status, read.reason);
    return json<ReadSkillFilesResponse>({
      chunks: read.value.map((chunk) => ({ digest: chunk.digest, index: chunk.index, data: toBase64(chunk.data) })),
    });
  }
  const { files } = await readJson(request);
  if (!Array.isArray(files)) {
    return fail(400, 'A skill is published as { "files": [{ "path", "size", "digest", "encoding" }] }.');
  }
  const published = await channel.publishSkill(caller, route.name, files as SkillEntry[]);
  if (!published.ok) {
    if (published.missing !== undefined) {
      return json<SkillFilesMissing>(
        { ok: false, reason: published.reason, missing: published.missing },
        published.status,
      );
    }
    return fail(published.status, published.reason);
  }
  return json<PublishSkillResponse>(published.value, published.value.published ? 201 : 200);
}
