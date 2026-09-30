// The Takeover route of the Channel API (ADR 0002). Wire types live in shared/src/claims.ts.
//
//   POST /api/tasks/:number/takeover   a Person moves a Stale Claim to { to: Holder }
//
// A call made through an Agent's tools (`X-Switchboard-Agent`) is refused: only a
// Person can take over.

import type { Holder, PersonName } from "../../shared/src/index";
import type { Channel } from "./channel";
import { answer, callerOf, isAgentId } from "./claims-api";
import { fail, readJson } from "./http";

const TAKEOVER = /^\/api\/tasks\/([1-9]\d{0,9})\/takeover$/;

/** The Task a Takeover request is for, or null when the request is not one. */
export function matchTakeoverRoute(method: string, pathname: string): number | null {
  if (method !== "POST") return null;
  const match = TAKEOVER.exec(pathname);
  return match?.[1] ? Number(match[1]) : null;
}

/** Reads `{ kind: "person", person }` or `{ kind: "agent", agentId }`, or null. */
function readHolder(value: unknown): Holder | null {
  if (typeof value !== "object" || value === null) return null;
  const holder = value as Record<string, unknown>;
  if (holder.kind === "person" && typeof holder.person === "string" && holder.person.length > 0) {
    return { kind: "person", person: holder.person.trim().toLowerCase() };
  }
  if (holder.kind === "agent" && isAgentId(holder.agentId)) return { kind: "agent", agentId: holder.agentId };
  return null;
}

export async function handleTakeoverRoute(
  task: number,
  request: Request,
  channel: DurableObjectStub<Channel>,
  person: PersonName,
): Promise<Response> {
  const caller = callerOf(request, person);
  if ("error" in caller) return fail(400, caller.error);
  const to = readHolder((await readJson(request)).to);
  if (to === null) {
    return fail(
      400,
      '"to" must be { "kind": "person", "person": <name> } or { "kind": "agent", "agentId": <Agent ID> }.',
    );
  }
  return answer(await channel.takeoverTask(caller, task, to));
}
