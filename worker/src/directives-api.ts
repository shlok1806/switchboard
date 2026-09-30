// The Directive route of the Channel API (ADR 0005). Wire types live in shared/src/directives.ts.
//
//   POST /api/directives   a Person sends { to: <Agent ID>, text } to one Agent
//
// A call made through an Agent's tools (`X-Switchboard-Agent`) is refused: Agents
// inform each other, only People instruct.

import type { PersonName, SendDirectiveResponse } from "../../shared/src/index";
import { MAX_DIRECTIVE_LENGTH } from "../../shared/src/index";
import type { Channel } from "./channel";
import { callerOf, isAgentId } from "./claims-api";
import { fail, json, readJson } from "./http";

export const DIRECTIVE_ROUTE = "POST /api/directives";

export async function handleDirectiveRoute(
  request: Request,
  channel: DurableObjectStub<Channel>,
  person: PersonName,
): Promise<Response> {
  const caller = callerOf(request, person);
  if ("error" in caller) return fail(400, caller.error);
  const body = await readJson(request);
  if (!isAgentId(body.to)) return fail(400, '"to" must be the target Agent ID.');
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0 || text.length > MAX_DIRECTIVE_LENGTH) {
    return fail(400, `A Directive needs "text" of 1 to ${MAX_DIRECTIVE_LENGTH} characters.`);
  }
  const result = await channel.sendDirective(caller, body.to, text);
  if (!result.ok) return fail(result.status, result.reason);
  return json<SendDirectiveResponse>({ ok: true, event: result.event }, 201);
}
