// The Agent routes of the Channel API. Wire types live in shared/src/agents.ts.
//
//   GET  /api/agents                 every Agent, with its Presence
//   POST /api/agents                 register an Agent for a session (or resume it)
//   POST /api/agents/:id/heartbeat   the Agent is still running, Live or Idle
//   POST /api/agents/:id/end         the session ended; the Agent goes Gone
//
// `:id` is the URL-encoded Agent ID, since Agent IDs contain "/".

import type {
  AgentId,
  AgentResponse,
  AgentsResponse,
  Cli,
  PersonName,
  RegisterAgentRequest,
} from "../../shared/src/index";
import { CLIS, MAX_NICKNAME_LENGTH, SESSION_ID_PATTERN } from "../../shared/src/index";
import type { RosterResult } from "./agents";
import type { Channel } from "./channel";
import { fail, json, readJson } from "./http";

export type AgentRoute =
  | { kind: "list" }
  | { kind: "register" }
  | { kind: "heartbeat"; id: AgentId }
  | { kind: "end"; id: AgentId };

const AGENT_ACTION = /^\/api\/agents\/([^/]+)\/(heartbeat|end)$/;

/** Returns the Agent route a request is for, or null when it is not one. */
export function matchAgentRoute(method: string, pathname: string): AgentRoute | null {
  if (pathname === "/api/agents") {
    if (method === "GET") return { kind: "list" };
    if (method === "POST") return { kind: "register" };
    return null;
  }
  const match = method === "POST" ? AGENT_ACTION.exec(pathname) : null;
  if (!match?.[1] || !match[2]) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (id.split("/").length !== 3) return null;
  return { kind: match[2] === "heartbeat" ? "heartbeat" : "end", id: id as AgentId };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseRegister(body: Record<string, unknown>): Parsed<RegisterAgentRequest> {
  const { cli, sessionId, resumed, cwd, nickname } = body;
  if (typeof cli !== "string" || !CLIS.includes(cli as Cli)) {
    return { ok: false, reason: `"cli" must be one of ${CLIS.join(", ")}.` };
  }
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, reason: '"sessionId" must be the CLI\'s session ID: letters, digits and "-".' };
  }
  if (resumed !== undefined && typeof resumed !== "boolean") {
    return { ok: false, reason: '"resumed" must be true or false.' };
  }
  if (cwd !== undefined && typeof cwd !== "string") return { ok: false, reason: '"cwd" must be a path.' };
  let cleanNickname: string | null | undefined;
  if (nickname === null || nickname === undefined) {
    cleanNickname = nickname;
  } else if (typeof nickname === "string" && nickname.trim().length <= MAX_NICKNAME_LENGTH) {
    cleanNickname = nickname.trim() || null;
  } else {
    return { ok: false, reason: `"nickname" must be at most ${MAX_NICKNAME_LENGTH} characters.` };
  }
  return {
    ok: true,
    value: {
      cli: cli as Cli,
      sessionId,
      resumed: resumed ?? false,
      cwd: cwd ?? "",
      ...(cleanNickname === undefined ? {} : { nickname: cleanNickname }),
    },
  };
}

function answer(result: RosterResult, status = 200): Response {
  return result.ok
    ? json<AgentResponse>({ ok: true, agent: result.agent }, status)
    : fail(result.status, result.reason);
}

export async function handleAgentRoute(
  route: AgentRoute,
  request: Request,
  channel: DurableObjectStub<Channel>,
  person: PersonName,
): Promise<Response> {
  switch (route.kind) {
    case "list":
      return json<AgentsResponse>({ agents: await channel.listAgents() });
    case "register": {
      const parsed = parseRegister(await readJson(request));
      if (!parsed.ok) return fail(400, parsed.reason);
      return answer(await channel.registerAgent(person, parsed.value));
    }
    case "heartbeat": {
      const { presence } = await readJson(request);
      if (presence !== "live" && presence !== "idle") return fail(400, '"presence" must be "live" or "idle".');
      return answer(await channel.heartbeat(person, route.id, presence));
    }
    case "end":
      return answer(await channel.endSession(person, route.id));
  }
}
