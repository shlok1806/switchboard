// The memory routes of the Channel API (ADR 0019). Wire types live in shared/src/memory.ts.
//
//   POST /api/memory   an Agent writes a note { text, tags, task?, files? }
//   GET  /api/memory   any Person or Agent reads notes: ?q= searches, else the latest;
//                      narrowed by tag, task, author, after and before, up to limit

import type { MemoryQuery, MemoryResponse, PostNoteResponse } from "../../shared/src/index";
import { cleanNote, isMemoryTag, MAX_MEMORY_LIMIT } from "../../shared/src/index";
import type { Channel } from "./channel";
import type { Caller } from "./claims";
import { isAgentId } from "./claims-api";
import { fail, json, readJson } from "./http";

export const POST_MEMORY_ROUTE = "POST /api/memory";
export const GET_MEMORY_ROUTE = "GET /api/memory";

/** A positive integer query parameter, undefined when absent, or null when it is not one. */
function count(params: URLSearchParams, name: string, min: number): number | undefined | null {
  const value = params.get(name);
  if (value === null) return undefined;
  return /^\d+$/.test(value) && Number(value) >= min && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

/** Reads `GET /api/memory`'s query, or says what is wrong with it. */
export function memoryQuery(params: URLSearchParams): { ok: true; query: MemoryQuery } | { ok: false; reason: string } {
  const query: MemoryQuery = {};
  const q = params.get("q");
  if (q !== null) {
    if (q.trim() === "" || q.length > 200) return { ok: false, reason: '"q" must be 1 to 200 characters.' };
    query.q = q;
  }
  const tag = params.get("tag");
  if (tag !== null) {
    if (!isMemoryTag(tag)) return { ok: false, reason: `"${tag}" is not a note tag.` };
    query.tag = tag;
  }
  const author = params.get("author");
  if (author !== null) {
    if (!isAgentId(author)) return { ok: false, reason: '"author" must be an Agent ID.' };
    query.author = author;
  }
  for (const [name, min] of [
    ["task", 1],
    ["after", 0],
    ["before", 1],
    ["limit", 1],
  ] as const) {
    const value = count(params, name, min);
    if (value === null) return { ok: false, reason: `"${name}" must be an integer of at least ${min}.` };
    if (value !== undefined) query[name] = value;
  }
  if (query.limit !== undefined && query.limit > MAX_MEMORY_LIMIT) {
    return { ok: false, reason: `"limit" must be at most ${MAX_MEMORY_LIMIT}.` };
  }
  return { ok: true, query };
}

export async function handleMemoryRoute(
  route: typeof POST_MEMORY_ROUTE | typeof GET_MEMORY_ROUTE,
  request: Request,
  url: URL,
  channel: DurableObjectStub<Channel>,
  caller: Caller,
): Promise<Response> {
  if (route === GET_MEMORY_ROUTE) {
    const read = memoryQuery(url.searchParams);
    if (!read.ok) return fail(400, read.reason);
    const result = await channel.readMemory(read.query);
    if (!result.ok) return fail(result.status, result.reason);
    return json<MemoryResponse>({ notes: result.notes, ...(result.more ? { more: true } : {}) });
  }
  const note = cleanNote(await readJson(request));
  if (!note.ok) return fail(400, note.reason);
  const result = await channel.writeNote(caller, note.note);
  if (!result.ok) return fail(result.status, result.reason);
  return json<PostNoteResponse>({ ok: true, note: result.note }, 201);
}
