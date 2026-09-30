// The Agent routes of the Channel API. Wire types live in shared/src/agents.ts.
//
//   GET  /api/agents                 every Agent, with its Presence
//   POST /api/agents                 register an Agent for a session (or resume it)
//   POST /api/agents/:id/heartbeat   the Agent is still running, Live or Idle
//   POST /api/agents/:id/end         the session ended; the Agent goes Gone
//   GET  /api/agents/:id/touched-files  the files the Agent has edited (Hook Capture)
//   POST /api/agents/:id/proxy-mode  set the Agent's Proxy mode; its own Person only
//
// `:id` is the URL-encoded Agent ID, since Agent IDs contain "/".

import type {
  AgentId,
  AgentResponse,
  AgentsResponse,
  Cli,
  PersonName,
  ProxyMode,
  RegisterAgentRequest,
  TouchedFilesResponse,
} from "../../shared/src/index";
import { CLIS, MAX_NICKNAME_LENGTH, PROXY_MODES, SESSION_ID_PATTERN } from "../../shared/src/index";
import type { RosterResult } from "./agents";
import type { Channel } from "./channel";
import { fail, json, readJson } from "./http";

export type AgentRoute =
  | { kind: "list" }
  | { kind: "register" }
  | { kind: "heartbeat"; id: AgentId }
  | { kind: "end"; id: AgentId }
  | { kind: "touched-files"; id: AgentId }
  | { kind: "proxy-mode"; id: AgentId };

const AGENT_ACTION = /^\/api\/agents\/([^/]+)\/(heartbeat|end|touched-files|proxy-mode)$/;
const METHODS = { heartbeat: "POST", end: "POST", "touched-files": "GET", "proxy-mode": "POST" } as const;

function isProxyMode(value: unknown): value is ProxyMode {
  return PROXY_MODES.includes(value as ProxyMode);
}

const PROXY_MODE_REASON = `"proxyMode" must be one of ${PROXY_MODES.join(", ")}.`;

/** Returns the Agent route a request is for, or null when it is not one. */
export function matchAgentRoute(method: string, pathname: string): AgentRoute | null {
  if (pathname === "/api/agents") {
    if (method === "GET") return { kind: "list" };
    if (method === "POST") return { kind: "register" };
    return null;
  }
  const match = AGENT_ACTION.exec(pathname);
  const kind = match?.[2] as keyof typeof METHODS | undefined;
  if (!match?.[1] || !kind || METHODS[kind] !== method) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (id.split("/").length !== 3) return null;
  return { kind, id: id as AgentId };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseRegister(body: Record<string, unknown>): Parsed<RegisterAgentRequest> {
  const { cli, sessionId, resumed, cwd, nickname, proxyMode, secretMasking, interrupts } = body;
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
  if (proxyMode !== undefined && !isProxyMode(proxyMode)) return { ok: false, reason: PROXY_MODE_REASON };
  if (secretMasking !== undefined && typeof secretMasking !== "boolean") {
    return { ok: false, reason: '"secretMasking" must be true or false.' };
  }
  if (interrupts !== undefined && typeof interrupts !== "boolean") {
    return { ok: false, reason: '"interrupts" must be true or false.' };
  }
  return {
    ok: true,
    value: {
      cli: cli as Cli,
      sessionId,
      resumed: resumed ?? false,
      cwd: cwd ?? "",
      ...(cleanNickname === undefined ? {} : { nickname: cleanNickname }),
      ...(proxyMode === undefined ? {} : { proxyMode }),
      ...(secretMasking === undefined ? {} : { secretMasking }),
      ...(interrupts === undefined ? {} : { interrupts }),
    },
  };
}

function answer(result: RosterResult, status = 200): Response {
  return result.ok
    ? json<AgentResponse>(
        {
          ok: true,
          agent: result.agent,
          ...(result.lostClaims && result.lostClaims.length > 0 ? { lostClaims: result.lostClaims } : {}),
          ...(result.deliveries && result.deliveries.length > 0 ? { deliveries: result.deliveries } : {}),
          ...(result.directives && result.directives.length > 0 ? { directives: result.directives } : {}),
        },
        status,
      )
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
    case "touched-files": {
      const files = await channel.touchedFiles(route.id);
      if (files === null) return fail(404, `No Agent ${route.id} on this Channel.`);
      return json<TouchedFilesResponse>({ agent: route.id, files });
    }
    case "proxy-mode": {
      const { mode } = await readJson(request);
      if (!isProxyMode(mode)) return fail(400, `"mode" must be one of ${PROXY_MODES.join(", ")}.`);
      return answer(await channel.setProxyMode(person, route.id, mode));
    }
  }
}
