// Channel API routes for Tasks (ADR 0001), and the GitHub webhook that keeps them current.
// The Task routes are admitted like every other Channel API call; the webhook is
// authenticated by its HMAC signature instead. There is one webhook for every
// Channel: each delivery goes to the Channel of its `repository.full_name`.

import type { CreateTaskResponse, ErrorResponse, TaskListResponse, TaskResponse } from "../../shared/src/index";
import { MAX_TASK_DESCRIPTION_LENGTH, MAX_TASK_TITLE_LENGTH } from "../../shared/src/index";
import { channelRepo } from "./auth";
import { handleCodeWebhook } from "./branches-api";
import type { Channel } from "./channel";
import type { Caller } from "./claims";
import { CODE_WEBHOOK_EVENTS, readWebhook, verifySignature, WEBHOOK_EVENTS } from "./github/index";
import type { TaskResult } from "./tasks";

export const WEBHOOK_ROUTE = "POST /api/github/webhook";

const TASK_PATH = /^\/api\/tasks\/([1-9]\d{0,9})$/;

type ChannelStub = DurableObjectStub<Channel>;

function fail(status: number, reason: string): Response {
  return Response.json({ ok: false, reason } satisfies ErrorResponse, { status });
}

function answer<T, B>(result: TaskResult<T>, body: (value: T) => B, status = 200): Response {
  return result.ok ? Response.json(body(result.value), { status }) : fail(result.status, result.reason);
}

/** True for the authenticated Task routes this module answers. */
export function isTaskRoute(method: string, path: string): boolean {
  return (
    (path === "/api/tasks" && (method === "GET" || method === "POST")) || (method === "GET" && TASK_PATH.test(path))
  );
}

export async function handleTaskRoute(
  request: Request,
  url: URL,
  channel: ChannelStub,
  caller: Caller,
): Promise<Response> {
  if (url.pathname === "/api/tasks") {
    if (request.method === "POST") return handleCreate(request, channel, caller);
    return answer(await channel.listTasks(), (tasks): TaskListResponse => ({ tasks }));
  }
  const number = Number(TASK_PATH.exec(url.pathname)?.[1]);
  return answer(await channel.getTask(number), (task): TaskResponse => ({ task }));
}

async function handleCreate(request: Request, channel: ChannelStub, { person }: Caller): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length === 0 || title.length > MAX_TASK_TITLE_LENGTH) {
    return fail(400, `A Task needs a "title" of 1 to ${MAX_TASK_TITLE_LENGTH} characters.`);
  }
  const description = body.description ?? "";
  if (typeof description !== "string" || description.length > MAX_TASK_DESCRIPTION_LENGTH) {
    return fail(400, `"description" must be text of at most ${MAX_TASK_DESCRIPTION_LENGTH} characters.`);
  }
  const labels = body.labels ?? [];
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string" && label.trim().length > 0)) {
    return fail(400, '"labels" must be a list of label names.');
  }
  const result = await channel.createTask(person, {
    title,
    description,
    labels: labels.map((label: string) => label.trim()),
  });
  return answer(result, (task): CreateTaskResponse => ({ ok: true, task }), 201);
}

/**
 * `POST /api/github/webhook`: `issues`, `sub_issues` and `issue_dependencies` deliveries
 * for Tasks, and `push` and `pull_request` deliveries for pushes and merges (ADR 0006),
 * signed with GITHUB_WEBHOOK_SECRET. Other events (such as `ping`), and deliveries for
 * repos that may not have a Channel here, are acknowledged and ignored.
 */
export async function handleWebhook(
  request: Request,
  env: Env,
  channels: (repo: string) => ChannelStub,
): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) return fail(503, "Set the GITHUB_WEBHOOK_SECRET Worker secret first.");
  const body = await request.text();
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("X-Hub-Signature-256")))) {
    return fail(401, "Bad webhook signature.");
  }
  const event = request.headers.get("X-GitHub-Event") ?? "";
  if (!WEBHOOK_EVENTS.has(event) && !CODE_WEBHOOK_EVENTS.has(event)) return new Response(null, { status: 204 });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return fail(400, "The webhook body is not JSON.");
  }
  const named = (payload as { repository?: { full_name?: unknown } } | null)?.repository?.full_name;
  const repo = typeof named === "string" ? channelRepo(env, named) : null;
  if (repo === null) return new Response(null, { status: 204 });
  if (CODE_WEBHOOK_EVENTS.has(event)) return handleCodeWebhook(request, repo, channels(repo), event, payload);
  const change = readWebhook(event, payload, repo);
  if (change === null || change.issues.length === 0) return new Response(null, { status: 204 });
  const result = await channels(repo).gitHubWebhook(repo, change);
  return result.ok ? new Response(null, { status: 204 }) : fail(result.status, result.reason);
}
