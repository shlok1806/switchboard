// The central Switchboard Worker (ADR 0004). It authenticates every Channel API
// call and hands it to the Channel's Durable Object. The wire format lives in
// shared/src/channel.ts. The page at `/` is a static asset in public/.

import type {
  HistoryResponse,
  JoinRequest,
  JoinResponse,
  PersonName,
  PostUpdateResponse,
} from "../../shared/src/index";
import { MAX_HISTORY_LIMIT, MAX_UPDATE_LENGTH } from "../../shared/src/index";
import { handleAgentRoute, matchAgentRoute } from "./agents-api";
import { authenticate } from "./auth";
import { handleBranchRoute, matchBranchRoute } from "./branches-api";
import { callerOf, handleClaimRoute, matchClaimRoute } from "./claims-api";
import { fail, json, readJson } from "./http";
import { handleTakeoverRoute, matchTakeoverRoute } from "./takeover-api";
import { handleTaskRoute, handleWebhook, isTaskRoute, WEBHOOK_ROUTE } from "./tasks-api";

export { Channel } from "./channel";

/** Interim setup (issue #1): one Channel per deployment. */
const CHANNEL_NAME = "main";

/** Parses a non-negative integer query parameter, or returns null if it is malformed. */
function intParam(url: URL, name: string, fallback: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function channel(env: Env) {
  return env.CHANNEL.get(env.CHANNEL.idFromName(CHANNEL_NAME));
}

async function handleJoin(request: Request, env: Env, person: PersonName): Promise<Response> {
  const { timeZone } = (await readJson(request)) as JoinRequest;
  const joined = await channel(env).join(person, typeof timeZone === "string" ? timeZone : undefined);
  return json<JoinResponse>({ ok: true, person: joined });
}

async function handleHistory(url: URL, env: Env): Promise<Response> {
  if (url.searchParams.has("tail")) {
    const tail = intParam(url, "tail", 0);
    if (tail === null || tail < 1 || tail > MAX_HISTORY_LIMIT) {
      return fail(400, `"tail" must be between 1 and ${MAX_HISTORY_LIMIT}.`);
    }
    const events = await channel(env).latestEvents(tail);
    return json<HistoryResponse>({ events, cursor: events.at(-1)?.seq ?? 0 });
  }
  const after = intParam(url, "after", 0);
  const limit = intParam(url, "limit", MAX_HISTORY_LIMIT);
  if (after === null || limit === null || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    return fail(400, `"after" must be a non-negative integer and "limit" between 1 and ${MAX_HISTORY_LIMIT}.`);
  }
  const events = await channel(env).history(after, limit);
  return json<HistoryResponse>({ events, cursor: events.at(-1)?.seq ?? after });
}

async function handlePostUpdate(request: Request, env: Env, person: PersonName): Promise<Response> {
  const body = await readJson(request);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0 || text.length > MAX_UPDATE_LENGTH) {
    return fail(400, `An Update needs "text" of 1 to ${MAX_UPDATE_LENGTH} characters.`);
  }
  const task = body.task;
  if (task !== undefined && !(typeof task === "number" && Number.isInteger(task) && task > 0)) {
    return fail(400, '"task" must be a GitHub Issue number.');
  }
  // An Agent posting through Switchboard's tools sends X-Switchboard-Agent.
  const caller = callerOf(request, person);
  if ("error" in caller) return fail(400, caller.error);
  const result = await channel(env).postUpdate(caller, text, task);
  if (!result.ok) return fail(result.status, result.reason);
  return json<PostUpdateResponse>({ ok: true, event: result.event }, 201);
}

async function handleStream(request: Request, url: URL, env: Env, person: PersonName): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return fail(426, "Connect with a WebSocket.");
  }
  const after = url.searchParams.get("after");
  if (after !== null && !/^\d+$/.test(after)) return fail(400, '"after" must be a non-negative integer.');
  // The Durable Object only ever sees the verified Person, never the secret.
  const target = new URL("https://channel/stream");
  target.searchParams.set("person", person);
  if (after !== null) target.searchParams.set("after", after);
  return channel(env).fetch(target, { headers: { Upgrade: "websocket" } });
}

const ROUTES = new Set(["POST /api/join", "GET /api/events", "POST /api/updates", "GET /api/stream"]);

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route === WEBHOOK_ROUTE) return handleWebhook(request, env);
    const taskRoute = isTaskRoute(request.method, url.pathname);
    const agentRoute = matchAgentRoute(request.method, url.pathname);
    const claimRoute = matchClaimRoute(request.method, url.pathname);
    const branchRoute = matchBranchRoute(request.method, url.pathname);
    const takeoverTask = matchTakeoverRoute(request.method, url.pathname);
    if (
      !ROUTES.has(route) &&
      !taskRoute &&
      agentRoute === null &&
      claimRoute === null &&
      branchRoute === null &&
      takeoverTask === null
    ) {
      return fail(404, "Not found.");
    }

    const auth = await authenticate(request, url, env.JOIN_SECRET);
    if (!auth.ok) return fail(auth.status, auth.reason);
    if (taskRoute) return handleTaskRoute(request, url, env, auth.person);
    if (agentRoute !== null) return handleAgentRoute(agentRoute, request, channel(env), auth.person);
    if (claimRoute !== null) return handleClaimRoute(claimRoute, request, channel(env), auth.person);
    if (branchRoute !== null) return handleBranchRoute(branchRoute, request, channel(env), auth.person);
    if (takeoverTask !== null) return handleTakeoverRoute(takeoverTask, request, channel(env), auth.person);

    switch (route) {
      case "POST /api/join":
        return handleJoin(request, env, auth.person);
      case "GET /api/events":
        return handleHistory(url, env);
      case "POST /api/updates":
        return handlePostUpdate(request, env, auth.person);
      default:
        return handleStream(request, url, env, auth.person);
    }
  },
} satisfies ExportedHandler<Env>;
