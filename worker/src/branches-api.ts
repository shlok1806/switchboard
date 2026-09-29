// The branch routes of the Channel API (ADR 0006). Wire types live in shared/src/branches.ts.
//
//   POST /api/tasks/:number/branch   the holder's wrapper reports the Task branch it created
//   POST /api/tasks/:number/finish   the holder finishes the Task: a PR that closes the Issue
//
// And the `push` and `pull_request` GitHub webhook deliveries, which tasks-api.ts
// hands here once their signature is verified.

import type { PersonName } from "../../shared/src/index";
import { MAX_FINISH_SUMMARY_LENGTH } from "../../shared/src/index";
import type { Channel } from "./channel";
import { callerOf } from "./claims-api";
import { readCodeWebhook, repoOf } from "./github/index";
import { fail, json, readJson } from "./http";

export type BranchRoute = { kind: "branch" | "finish"; task: number };

const BRANCH_ACTION = /^\/api\/tasks\/([1-9]\d{0,9})\/(branch|finish)$/;

/** Returns the branch route a request is for, or null when it is not one. */
export function matchBranchRoute(method: string, pathname: string): BranchRoute | null {
  if (method !== "POST") return null;
  const action = BRANCH_ACTION.exec(pathname);
  if (!action?.[1] || !action[2]) return null;
  return { kind: action[2] === "branch" ? "branch" : "finish", task: Number(action[1]) };
}

export async function handleBranchRoute(
  route: BranchRoute,
  request: Request,
  channel: DurableObjectStub<Channel>,
  person: PersonName,
): Promise<Response> {
  const caller = callerOf(request, person);
  if ("error" in caller) return fail(400, caller.error);
  const body = await readJson(request);
  let result: Awaited<ReturnType<Channel["finishTask"]>>;
  if (route.kind === "branch") {
    const branch = body.branch;
    if (typeof branch !== "string" || branch.length === 0 || branch.length > 255) {
      return fail(400, 'A branch report needs "branch".');
    }
    result = await channel.recordBranch(caller, route.task, branch);
  } else {
    const summary = body.summary;
    if (summary !== undefined && (typeof summary !== "string" || summary.length > MAX_FINISH_SUMMARY_LENGTH)) {
      return fail(400, `"summary" must be text of at most ${MAX_FINISH_SUMMARY_LENGTH} characters.`);
    }
    result = await channel.finishTask(caller, route.task, summary);
  }
  if (result.ok) return json({ ok: true, task: result.task });
  return json({ ok: false, reason: result.reason, ...(result.heldBy ? { heldBy: result.heldBy } : {}) }, result.status);
}

/** A verified `push` or `pull_request` delivery. Anything that does not become an Event is acknowledged. */
export async function handleCodeWebhook(
  request: Request,
  env: Env,
  channel: DurableObjectStub<Channel>,
  event: string,
  payload: unknown,
): Promise<Response> {
  const change = readCodeWebhook(event, payload, repoOf(env));
  if (change === null) return new Response(null, { status: 204 });
  const delivery = request.headers.get("X-GitHub-Delivery") || crypto.randomUUID();
  const result = await channel.gitHubCodeWebhook(delivery, change);
  return result.ok ? new Response(null, { status: 204 }) : fail(result.status, result.reason);
}
