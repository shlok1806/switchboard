// The Host routes of the Channel API (ADR 0015). Wire types live in shared/src/hosts.ts.
//
//   GET    /api/hosts               every Host, with whether it is Live, and the cap
//   POST   /api/hosts               register (or update) one of the caller's Hosts
//   DELETE /api/hosts/:name         remove one of the caller's Hosts
//   POST   /api/agents/spawn        start an Agent on one of the caller's Hosts
//   POST   /api/agents/:id/stop     stop an Agent a Host runs
//   POST   /api/agents/:id/pause    end its process, keep its session (ADR 0028)
//   POST   /api/agents/:id/resume   relaunch a Paused Agent (ADR 0028)
//
// Every route needs a Person's session, except that a lead's Agent token may spawn and
// stop (ADR 0018): the Channel checks the role and the lead's subtree. Any other Agent
// token is refused (ADR 0005). A Person may use another Person's Host only if that Host
// allows them (ADR 0028): the Channel checks its copy, the Host its own file.

import type {
  AgentId,
  ControlAgentResponse,
  HostResponse,
  HostsResponse,
  SpawnAgentRequest,
  SpawnAgentResponse,
  StopAgentResponse,
} from "../../shared/src/index";
import {
  CLIS,
  cleanAbsolutePath,
  cleanModelField,
  cleanNickname,
  HOST_NAME_PATTERN,
  isPermissionMode,
  LOGIN_PATTERN,
  MAX_BRIEF_LENGTH,
  MAX_HOST_ALLOW,
  MAX_HOST_ROOTS,
  MAX_MODEL_LENGTH,
  PERMISSION_MODES,
} from "../../shared/src/index";
import type { Channel } from "./channel";
import type { Caller } from "./claims";
import { fail, json, readJson } from "./http";

export type HostRoute =
  | { kind: "list" }
  | { kind: "register" }
  | { kind: "remove"; name: string }
  | { kind: "spawn" }
  | { kind: "stop"; id: AgentId }
  | { kind: "pause"; id: AgentId }
  | { kind: "resume"; id: AgentId };

const CONTROL = /^\/api\/agents\/([^/]+)\/(stop|pause|resume)$/;
const HOST = /^\/api\/hosts\/([^/]+)$/;

/** Returns the Host route a request is for, or null when it is not one. */
export function matchHostRoute(method: string, pathname: string): HostRoute | null {
  if (pathname === "/api/hosts") {
    if (method === "GET") return { kind: "list" };
    if (method === "POST") return { kind: "register" };
    return null;
  }
  if (pathname === "/api/agents/spawn") return method === "POST" ? { kind: "spawn" } : null;
  const host = HOST.exec(pathname);
  if (host?.[1] !== undefined) return method === "DELETE" ? { kind: "remove", name: host[1] } : null;
  const control = CONTROL.exec(pathname);
  if (control?.[1] === undefined || method !== "POST") return null;
  let id: string;
  try {
    id = decodeURIComponent(control[1]);
  } catch {
    return null;
  }
  const kind = control[2] as "stop" | "pause" | "resume";
  return id.split("/").length === 3 ? { kind, id: id as AgentId } : null;
}

export const HOST_AGENT_REFUSED =
  "An Agent cannot list, register or remove Hosts, or attach as one: only a Person can (ADR 0015, ADR 0018).";

/** Whether an Agent token may call `route`: a lead may spawn and stop, the Channel decides the rest (ADR 0018). */
export function agentMayCall(route: HostRoute): boolean {
  // Pausing and resuming stay a Person's (ADR 0028): a lead's reach is to start and stop its own subtree.
  return route.kind === "spawn" || route.kind === "stop";
}

/** A Host's name, or `<person>/<name>`. */
function isHostRef(value: string): boolean {
  const slash = value.indexOf("/");
  if (slash < 0) return HOST_NAME_PATTERN.test(value);
  return LOGIN_PATTERN.test(value.slice(0, slash)) && HOST_NAME_PATTERN.test(value.slice(slash + 1));
}

const MODE_REASON = `"permissionMode" must be one of ${PERMISSION_MODES.join(", ")}.`;

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseSpawn(body: Record<string, unknown>): Parsed<SpawnAgentRequest> {
  const { host, cli, cwd, nickname, model, brief, permissionMode, from } = body;
  if (host !== undefined && (typeof host !== "string" || !isHostRef(host))) {
    return { ok: false, reason: '"host" must be the name of one of your Hosts, or `<person>/<name>` of another\'s.' };
  }
  // Codex and Gemini CLI follow behind the same request (ADR 0015).
  if (cli !== "claude-code") {
    return {
      ok: false,
      reason: CLIS.includes(cli as never)
        ? `Hosts start only claude-code Agents for now, not ${cli}.`
        : '"cli" must be "claude-code".',
    };
  }
  const path = cleanAbsolutePath(cwd);
  if (path === null) return { ok: false, reason: '"cwd" must be an absolute folder path.' };
  const cleanName = nickname === undefined ? undefined : typeof nickname === "string" ? cleanNickname(nickname) : null;
  if (cleanName === null || (nickname !== undefined && cleanName === undefined)) {
    return { ok: false, reason: '"nickname" must be a Nickname.' };
  }
  const cleanModel =
    model === undefined ? undefined : typeof model === "string" ? cleanModelField(model, MAX_MODEL_LENGTH) : null;
  if (cleanModel === null || (model !== undefined && cleanModel === undefined)) {
    return { ok: false, reason: '"model" must be a model ID.' };
  }
  const text = typeof brief === "string" ? brief.trim() : brief;
  if (text !== undefined && (typeof text !== "string" || text.length > MAX_BRIEF_LENGTH)) {
    return { ok: false, reason: `"brief" must be text of at most ${MAX_BRIEF_LENGTH} characters.` };
  }
  if (permissionMode !== undefined && !isPermissionMode(permissionMode)) return { ok: false, reason: MODE_REASON };
  if (from !== undefined && (typeof from !== "string" || from.split("/").length !== 3)) {
    return { ok: false, reason: '"from" must be the ID of the Agent whose work it carries on.' };
  }
  return {
    ok: true,
    value: {
      ...(host === undefined ? {} : { host }),
      cli,
      cwd: path,
      ...(cleanName === undefined ? {} : { nickname: cleanName }),
      ...(cleanModel === undefined ? {} : { model: cleanModel }),
      ...(text === undefined || text === "" ? {} : { brief: text }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(from === undefined ? {} : { from: from as AgentId }),
    },
  };
}

export async function handleHostRoute(
  route: HostRoute,
  request: Request,
  channel: DurableObjectStub<Channel>,
  caller: Caller,
): Promise<Response> {
  const { person } = caller;
  switch (route.kind) {
    case "list":
      return json<HostsResponse>(await channel.listHosts());
    case "register": {
      const { name, roots, maxPermissionMode, allow, allowChannel } = await readJson(request);
      if (typeof name !== "string" || !HOST_NAME_PATTERN.test(name)) {
        return fail(400, '"name" must be a Host name: lower-case letters, digits and "-", at most 40.');
      }
      const clean = Array.isArray(roots) ? roots.map(cleanAbsolutePath) : null;
      if (clean === null || clean.length === 0 || clean.length > MAX_HOST_ROOTS || clean.includes(null)) {
        return fail(400, `"roots" must be 1 to ${MAX_HOST_ROOTS} absolute folder paths.`);
      }
      if (maxPermissionMode !== undefined && !isPermissionMode(maxPermissionMode)) {
        return fail(400, `"maxPermissionMode" must be one of ${PERMISSION_MODES.join(", ")}.`);
      }
      if (
        allow !== undefined &&
        (!Array.isArray(allow) ||
          allow.length > MAX_HOST_ALLOW ||
          !allow.every((login) => typeof login === "string" && LOGIN_PATTERN.test(login)))
      ) {
        return fail(400, `"allow" must be at most ${MAX_HOST_ALLOW} Person logins.`);
      }
      if (allowChannel !== undefined && typeof allowChannel !== "boolean") {
        return fail(400, '"allowChannel" must be true or false.');
      }
      const host = await channel.registerHost(person, {
        name,
        roots: [...new Set(clean as string[])],
        ...(maxPermissionMode === undefined ? {} : { maxPermissionMode }),
        ...(allow === undefined ? {} : { allow: allow as string[] }),
        ...(allowChannel === undefined ? {} : { allowChannel }),
      });
      return json<HostResponse>({ ok: true, host });
    }
    case "remove":
      return (await channel.removeHost(person, route.name))
        ? json({ ok: true })
        : fail(404, `You have no Host named ${route.name}.`);
    case "spawn": {
      const parsed = parseSpawn(await readJson(request));
      if (!parsed.ok) return fail(400, parsed.reason);
      const result = await channel.spawnAgent(caller, parsed.value);
      if (!result.ok) return fail(result.status, result.reason);
      return json<SpawnAgentResponse>(
        {
          ok: true,
          spawn: result.spawn,
          host: result.host,
          ...(result.agent === undefined ? {} : { agent: result.agent }),
        },
        result.agent === undefined ? 202 : 201,
      );
    }
    case "stop": {
      const result = await channel.stopAgent(caller, route.id);
      if (!result.ok) return fail(result.status, result.reason);
      return json<StopAgentResponse>({ ok: true, agent: route.id, host: result.host });
    }
    case "pause":
    case "resume": {
      const result = await channel.controlAgent(person, route.id, route.kind);
      if (!result.ok) return fail(result.status, result.reason);
      return json<ControlAgentResponse>({ ok: true, agent: route.id, host: result.host, presence: result.presence });
    }
  }
}
