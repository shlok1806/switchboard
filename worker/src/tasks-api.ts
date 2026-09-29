// Channel API routes for Tasks (ADR 0001), and the GitHub webhook that keeps them current.
// The Task routes are authenticated like every other Channel API call; the webhook is
// authenticated by its HMAC signature instead.

import type {
  CreateTaskResponse,
  ErrorResponse,
  PersonName,
  TaskListResponse,
  TaskResponse,
} from "../../shared/src/index";
import { MAX_TASK_DESCRIPTION_LENGTH, MAX_TASK_TITLE_LENGTH } from "../../shared/src/index";
import { handleCodeWebhook } from "./branches-api";
import { CODE_WEBHOOK_EVENTS, readWebhook, repoOf, verifySignature, WEBHOOK_EVENTS } from "./github/index";
import type { TaskResult } from "./tasks";

/** Interim setup (issue #1): one Channel per deployment. Matches index.ts. */
const CHANNEL_NAME = "main";

export const WEBHOOK_ROUTE = "POST /api/github/webhook";

const TASK_PATH = /^\/api\/tasks\/([1-9]\d{0,9})$/;

function channel(env: Env) {
  return env.CHANNEL.get(env.CHANNEL.idFromName(CHANNEL_NAME));
}

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

export async function handleTaskRoute(request: Request, url: URL, env: Env, person: PersonName): Promise<Response> {
  if (url.pathname === "/api/tasks") {
    if (request.method === "POST") return handleCreate(request, env, person);
    return answer(await channel(env).listTasks(), (tasks): TaskListResponse => ({ tasks }));
  }
  const number = Number(TASK_PATH.exec(url.pathname)?.[1]);
  return answer(await channel(env).getTask(number), (task): TaskResponse => ({ task }));
}

async function handleCreate(request: Request, env: Env, person: PersonName): Promise<Response> {
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
  const result = await channel(env).createTask(person, {
    title,
    description,
    labels: labels.map((label: string) => label.trim()),
  });
  return answer(result, (task): CreateTaskResponse => ({ ok: true, task }), 201);
}

/**
 * `POST /api/github/webhook`: `issues`, `sub_issues` and `issue_dependencies` deliveries
 * for Tasks, and `push` and `pull_request` deliveries for pushes and merges (ADR 0006),
 * signed with GITHUB_WEBHOOK_SECRET. Other events (such as `ping`) are acknowledged.
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
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
  if (CODE_WEBHOOK_EVENTS.has(event)) return handleCodeWebhook(request, env, channel(env), event, payload);
  const change = readWebhook(event, payload, repoOf(env));
  if (change === null || change.issues.length === 0) return new Response(null, { status: 204 });
  const result = await channel(env).gitHubWebhook(change);
  return result.ok ? new Response(null, { status: 204 }) : fail(result.status, result.reason);
}
