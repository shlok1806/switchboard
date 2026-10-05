// The central Switchboard Worker (ADR 0004). One Channel per GitHub repo (ADR 0007),
// each a Durable Object named by `owner/repo`. Routes:
//
//   /<owner>/<repo>                 the Dashboard (the static site's index.html)
//   /r/<owner>/<repo>/api/...       the Channel API, admitted by the Channel
//   /auth/...                       sign-in with GitHub (auth-api.ts)
//   POST /api/github/webhook        GitHub's deliveries, routed by their repository
//
// Everything under /r/ needs a credential: a Person session or an Agent token
// (auth.ts). The Channel admits it: a live token, and a Person with write access
// to the repo. An Agent token does only what an Agent may: read the Channel, post
// its own Events, and claim, release and finish for itself. The wire format lives
// in shared/src/.

import type {
  HistoryResponse,
  JoinRequest,
  JoinResponse,
  PostUpdateResponse,
  RelayResponse,
} from "../../shared/src/index";
import { MAX_HISTORY_LIMIT, MAX_UPDATE_LENGTH } from "../../shared/src/index";
import { type AgentRoute, handleAgentRoute, matchAgentRoute } from "./agents-api";
import { channelRepo, devMode, readCredential } from "./auth";
import { handleAuthRoute, isAuthRoute } from "./auth-api";
import { handleBranchRoute, matchBranchRoute } from "./branches-api";
import type { Caller } from "./claims";
import { handleClaimRoute, matchClaimRoute } from "./claims-api";
import { DIRECTIVE_ROUTE, handleDirectiveRoute } from "./directives-api";
import { fail, json, readJson } from "./http";
import { relaySettings } from "./relay/relay";
import { handleTakeoverRoute, matchTakeoverRoute } from "./takeover-api";
import { handleTaskRoute, handleWebhook, isTaskRoute, WEBHOOK_ROUTE } from "./tasks-api";

export { Channel } from "./channel";

/** `/r/<owner>/<repo>/<rest>`: a Channel API call. */
const CHANNEL_PATH = /^\/r\/([^/]+\/[^/]+)(\/api\/.*)$/;
/** `/<owner>/<repo>` (or with a trailing slash): the Dashboard of that Channel. */
const DASHBOARD_PATH = /^\/([^/]+\/[^/]+?)\/?$/;

/** The Channel Durable Object of `repo`, a key from `channelRepo`. */
function channelOf(env: Env, repo: string) {
  return env.CHANNEL.get(env.CHANNEL.idFromName(repo));
}

/** Parses a non-negative integer query parameter, or returns null if it is malformed. */
function intParam(url: URL, name: string, fallback: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

type ChannelStub = ReturnType<typeof channelOf>;

async function handleJoin(request: Request, channel: ChannelStub, caller: Caller): Promise<Response> {
  const { timeZone } = (await readJson(request)) as JoinRequest;
  const joined = await channel.join(caller.person, typeof timeZone === "string" ? timeZone : undefined);
  return json<JoinResponse>({ ok: true, person: joined });
}

async function handleHistory(url: URL, channel: ChannelStub): Promise<Response> {
  if (url.searchParams.has("tail")) {
    const tail = intParam(url, "tail", 0);
    if (tail === null || tail < 1 || tail > MAX_HISTORY_LIMIT) {
      return fail(400, `"tail" must be between 1 and ${MAX_HISTORY_LIMIT}.`);
    }
    const events = await channel.latestEvents(tail);
    return json<HistoryResponse>({ events, cursor: events.at(-1)?.seq ?? 0 });
  }
  const after = intParam(url, "after", 0);
  const limit = intParam(url, "limit", MAX_HISTORY_LIMIT);
  if (after === null || limit === null || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    return fail(400, `"after" must be a non-negative integer and "limit" between 1 and ${MAX_HISTORY_LIMIT}.`);
  }
  const events = await channel.history(after, limit);
  return json<HistoryResponse>({ events, cursor: events.at(-1)?.seq ?? after });
}

async function handlePostUpdate(request: Request, channel: ChannelStub, caller: Caller): Promise<Response> {
  const body = await readJson(request);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0 || text.length > MAX_UPDATE_LENGTH) {
    return fail(400, `An Update needs "text" of 1 to ${MAX_UPDATE_LENGTH} characters.`);
  }
  const task = body.task;
  if (task !== undefined && !(typeof task === "number" && Number.isInteger(task) && task > 0)) {
    return fail(400, '"task" must be a GitHub Issue number.');
  }
  const result = await channel.postUpdate(caller, text, task);
  if (!result.ok) return fail(result.status, result.reason);
  return json<PostUpdateResponse>({ ok: true, event: result.event }, 201);
}

async function handleStream(request: Request, url: URL, channel: ChannelStub, caller: Caller): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return fail(426, "Connect with a WebSocket.");
  }
  const after = url.searchParams.get("after");
  if (after !== null && !/^\d+$/.test(after)) return fail(400, '"after" must be a non-negative integer.');
  // The Durable Object only ever sees the admitted Person and Agent, never a credential.
  const target = new URL("https://channel/stream");
  target.searchParams.set("person", caller.person);
  if (caller.agent !== undefined) target.searchParams.set("agent", caller.agent);
  if (after !== null) target.searchParams.set("after", after);
  return channel.fetch(target, { headers: { Upgrade: "websocket" } });
}

const ROUTES = new Set([
  "POST /api/join",
  "GET /api/events",
  "GET /api/relay",
  "POST /api/updates",
  "GET /api/stream",
  DIRECTIVE_ROUTE,
]);

/** What an Agent token may call (ADR 0007): read the Channel, and act for its own Agent only. */
const AGENT_ROUTES = new Set(["GET /api/events", "GET /api/relay", "POST /api/updates", "GET /api/stream"]);
const AGENT_ROUTE_KINDS: ReadonlySet<AgentRoute["kind"]> = new Set([
  "list",
  "heartbeat",
  "end",
  "touched-files",
  "nickname",
]);

const AGENT_REFUSED =
  "An Agent token cannot do this. Agents read the Channel, post their own Events, and claim, release and finish " +
  "Tasks for themselves; Directives, Takeovers and everything else a Person does need a Person's session.";

async function handleChannel(request: Request, url: URL, env: Env, repo: string, path: string): Promise<Response> {
  const route = `${request.method} ${path}`;
  const inner = new URL(url);
  inner.pathname = path;
  const taskRoute = isTaskRoute(request.method, path);
  const agentRoute = matchAgentRoute(request.method, path);
  const claimRoute = matchClaimRoute(request.method, path);
  const branchRoute = matchBranchRoute(request.method, path);
  const takeoverTask = matchTakeoverRoute(request.method, path);
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

  const credential = await readCredential(request, url, env);
  if (!credential.ok) return fail(credential.status, credential.reason);
  const channel = channelOf(env, repo);
  const admitted = await channel.admit(repo, credential.credential, devMode(env, url));
  if (!admitted.ok) return fail(admitted.status, admitted.reason);
  const caller: Caller = {
    person: admitted.person,
    ...(admitted.agent === undefined ? {} : { agent: admitted.agent }),
  };

  if (caller.agent !== undefined) {
    const allowed =
      AGENT_ROUTES.has(route) ||
      (taskRoute && request.method === "GET") ||
      claimRoute !== null ||
      branchRoute !== null ||
      (agentRoute !== null && AGENT_ROUTE_KINDS.has(agentRoute.kind));
    if (!allowed) return fail(403, AGENT_REFUSED);
    if (
      agentRoute !== null &&
      "id" in agentRoute &&
      agentRoute.kind !== "touched-files" &&
      agentRoute.id !== caller.agent
    ) {
      return fail(403, `This token belongs to Agent ${caller.agent}. An Agent acts for itself only.`);
    }
  }

  if (taskRoute) return handleTaskRoute(request, inner, channel, caller);
  if (agentRoute !== null) return handleAgentRoute(agentRoute, request, channel, caller);
  if (claimRoute !== null) return handleClaimRoute(claimRoute, request, channel, caller);
  if (branchRoute !== null) return handleBranchRoute(branchRoute, request, channel, caller);
  if (takeoverTask !== null) return handleTakeoverRoute(takeoverTask, request, channel, caller);

  switch (route) {
    case "POST /api/join":
      return handleJoin(request, channel, caller);
    case "GET /api/events":
      return handleHistory(inner, channel);
    case "GET /api/relay":
      return json<RelayResponse>({ relay: relaySettings(env) });
    case "POST /api/updates":
      return handlePostUpdate(request, channel, caller);
    case DIRECTIVE_ROUTE:
      return handleDirectiveRoute(request, channel, caller);
    default:
      return handleStream(request, inner, channel, caller);
  }
}

/** The Dashboard's page for a Channel: the static site's index.html, which reads the repo from the path. */
async function handleDashboard(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.ASSETS) return fail(404, "The Dashboard is not built into this Worker.");
  const page = await env.ASSETS.fetch(new Request(new URL("/", url), { headers: request.headers }));
  const headers = new Headers(page.headers);
  headers.set("Cache-Control", "no-cache");
  return new Response(page.body, { status: page.status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (`${request.method} ${url.pathname}` === WEBHOOK_ROUTE) {
      return handleWebhook(request, env, (repo) => channelOf(env, repo));
    }
    if (isAuthRoute(url.pathname)) return handleAuthRoute(request, url, env, (repo) => channelOf(env, repo));

    const api = CHANNEL_PATH.exec(url.pathname);
    if (api?.[1] !== undefined && api[2] !== undefined) {
      let named: string;
      try {
        named = decodeURIComponent(api[1]);
      } catch {
        return fail(404, "Not found.");
      }
      const repo = channelRepo(env, named);
      if (repo === null) return fail(404, `There is no Channel for ${named} here.`);
      return handleChannel(request, url, env, repo, api[2]);
    }

    const page = DASHBOARD_PATH.exec(url.pathname);
    if (request.method === "GET" && page?.[1] !== undefined && channelRepo(env, page[1]) !== null) {
      return handleDashboard(request, url, env);
    }
    return fail(404, "Not found.");
  },
} satisfies ExportedHandler<Env>;
