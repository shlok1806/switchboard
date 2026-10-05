// The Agent routes of the Channel API. Wire types live in shared/src/agents.ts.
//
//   GET  /api/agents                 every Agent, with its Presence
//   POST /api/agents                 register an Agent for a session (or resume it)
//   POST /api/agents/:id/heartbeat   the Agent is still running, Live or Idle
//   POST /api/agents/:id/end         the session ended; the Agent goes Gone
//   GET  /api/agents/:id/touched-files  the files the Agent has edited (Hook Capture)
//   POST /api/agents/:id/proxy-mode  set the Agent's Proxy mode; its own Person only
//   POST /api/agents/:id/nickname    rename the Agent; itself, or any Person (ADR 0009)
//   POST /api/agents/:id/model       the model it runs on; itself or its Person (ADR 0010)
//
// `:id` is the URL-encoded Agent ID, since Agent IDs contain "/".

import type {
  AgentId,
  AgentResponse,
  AgentsResponse,
  Cli,
  ProxyMode,
  RegisterAgentRequest,
  TouchedFilesResponse,
} from "../../shared/src/index";
import {
  CLIS,
  cleanAccountLabel,
  cleanModelField,
  cleanNickname,
  MAX_ACCOUNT_LABEL_LENGTH,
  MAX_EFFORT_LENGTH,
  MAX_MODEL_LENGTH,
  MAX_NICKNAME_LENGTH,
  PROXY_MODES,
  SESSION_ID_PATTERN,
} from "../../shared/src/index";
import type { RosterResult } from "./agents";
import type { Channel } from "./channel";
import type { Caller } from "./claims";
import { fail, json, readJson } from "./http";

export type AgentRoute =
  | { kind: "list" }
  | { kind: "register" }
  | { kind: "heartbeat"; id: AgentId }
  | { kind: "end"; id: AgentId }
  | { kind: "touched-files"; id: AgentId }
  | { kind: "proxy-mode"; id: AgentId }
  | { kind: "nickname"; id: AgentId }
  | { kind: "model"; id: AgentId };

const AGENT_ACTION = /^\/api\/agents\/([^/]+)\/(heartbeat|end|touched-files|proxy-mode|nickname|model)$/;
const METHODS = {
  heartbeat: "POST",
  end: "POST",
  "touched-files": "GET",
  "proxy-mode": "POST",
  nickname: "POST",
  model: "POST",
} as const;

function isProxyMode(value: unknown): value is ProxyMode {
  return PROXY_MODES.includes(value as ProxyMode);
}

const PROXY_MODE_REASON = `"proxyMode" must be one of ${PROXY_MODES.join(", ")}.`;
const NICKNAME_REASON = `"nickname" must be text of at most ${MAX_NICKNAME_LENGTH} characters, or null.`;

const MODEL_REASON = '"model" must be a model ID, or null; "effort" text or null.';

/** A model ID or effort from a request: clean, null for unknown, undefined when absent. False when it is not one. */
function parseModelField(value: unknown, max: number): string | null | undefined | false {
  if (value === null || value === undefined) return value;
  return typeof value === "string" ? cleanModelField(value, max) : false;
}

/** A Nickname from a request: clean, null to clear it, undefined to leave it. False when it is not one. */
function parseNickname(nickname: unknown): string | null | undefined | false {
  if (nickname === null || nickname === undefined) return nickname;
  if (typeof nickname !== "string") return false;
  const clean = cleanNickname(nickname);
  return clean === undefined ? false : clean;
}

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
  const {
    cli,
    sessionId,
    resumed,
    cwd,
    nickname,
    account,
    model,
    effort,
    proxyMode,
    secretMasking,
    interrupts,
    source,
    rejoin,
  } = body;
  if (source !== undefined && typeof source !== "string") return { ok: false, reason: '"source" must be text.' };
  if (rejoin !== undefined && typeof rejoin !== "boolean") {
    return { ok: false, reason: '"rejoin" must be true or false.' };
  }
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
  const clean = parseNickname(nickname);
  if (clean === false) return { ok: false, reason: NICKNAME_REASON };
  if (account !== undefined && account !== null && typeof account !== "string") {
    return { ok: false, reason: `"account" must be text of at most ${MAX_ACCOUNT_LABEL_LENGTH} characters, or null.` };
  }
  const cleanAccount = typeof account === "string" ? cleanAccountLabel(account) : account;
  const cleanModel = parseModelField(model, MAX_MODEL_LENGTH);
  const cleanEffort = parseModelField(effort, MAX_EFFORT_LENGTH);
  if (cleanModel === false || cleanEffort === false) return { ok: false, reason: MODEL_REASON };
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
      ...(clean === undefined ? {} : { nickname: clean }),
      ...(cleanAccount === undefined ? {} : { account: cleanAccount }),
      ...(typeof cleanModel === "string" ? { model: cleanModel } : {}),
      ...(typeof cleanModel === "string" && typeof cleanEffort === "string" ? { effort: cleanEffort } : {}),
      ...(proxyMode === undefined ? {} : { proxyMode }),
      ...(secretMasking === undefined ? {} : { secretMasking }),
      ...(interrupts === undefined ? {} : { interrupts }),
      ...(source === undefined ? {} : { source: source.slice(0, 40) }),
      ...(rejoin === undefined ? {} : { rejoin }),
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
          ...(result.token === undefined ? {} : { token: result.token }),
          ...(result.nicknameRefused === undefined ? {} : { nicknameRefused: result.nicknameRefused }),
        },
        status,
      )
    : fail(result.status, result.reason);
}

export async function handleAgentRoute(
  route: AgentRoute,
  request: Request,
  channel: DurableObjectStub<Channel>,
  caller: Caller,
): Promise<Response> {
  const { person } = caller;
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
    case "end": {
      const { detail } = await readJson(request);
      return answer(await channel.endSession(person, route.id, typeof detail === "string" ? detail : undefined));
    }
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
    case "nickname": {
      const nickname = parseNickname((await readJson(request)).nickname);
      if (nickname === false || nickname === undefined) return fail(400, NICKNAME_REASON);
      return answer(await channel.renameAgent(caller, route.id, nickname));
    }
    case "model": {
      const body = await readJson(request);
      const model = parseModelField(body.model, MAX_MODEL_LENGTH);
      const effort = parseModelField(body.effort, MAX_EFFORT_LENGTH);
      if (model === false || model === undefined || effort === false) return fail(400, MODEL_REASON);
      const via = body.via === "proxy" ? "proxy" : "config";
      return answer(await channel.setAgentModel(caller, route.id, model, effort ?? null, via));
    }
  }
}
