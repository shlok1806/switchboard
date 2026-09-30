// The Claim routes of the Channel API (ADR 0001). Wire types live in shared/src/claims.ts.
//
//   POST /api/tasks/:number/claim                   claim a Task (a Person may name one of their Agents)
//   POST /api/tasks/:number/release                 release it
//   POST /api/tasks/:number/steps/:index/complete   tick one Step
//   POST /api/tool-calls                            an Agent reports a call to a Switchboard tool
//
// A call made with an Agent token (ADR 0007) is that Agent's: its Events name the
// Agent and carry the Tool Capture. An Agent claims for itself only.

import type {
  AgentId,
  ClaimRefusal as ClaimRefusalBody,
  SwitchboardTool,
  TaskActionResponse,
  ToolCallResponse,
} from "../../shared/src/index";
import { MAX_TOOL_ARG_LENGTH, MAX_TOOL_OUTPUT_LENGTH, SWITCHBOARD_TOOLS } from "../../shared/src/index";
import type { Channel } from "./channel";
import type { Caller, ClaimResult } from "./claims";
import { fail, json, readJson } from "./http";

export type ClaimRoute =
  | { kind: "claim"; task: number }
  | { kind: "release"; task: number }
  | { kind: "step"; task: number; index: number }
  | { kind: "tool-call" };

const TASK_ACTION = /^\/api\/tasks\/([1-9]\d{0,9})\/(claim|release)$/;
const STEP_ACTION = /^\/api\/tasks\/([1-9]\d{0,9})\/steps\/(0|[1-9]\d{0,4})\/complete$/;

/** Returns the Claim route a request is for, or null when it is not one. */
export function matchClaimRoute(method: string, pathname: string): ClaimRoute | null {
  if (method !== "POST") return null;
  if (pathname === "/api/tool-calls") return { kind: "tool-call" };
  const action = TASK_ACTION.exec(pathname);
  if (action?.[1] && action[2]) {
    return { kind: action[2] === "claim" ? "claim" : "release", task: Number(action[1]) };
  }
  const step = STEP_ACTION.exec(pathname);
  if (step?.[1] && step[2]) return { kind: "step", task: Number(step[1]), index: Number(step[2]) };
  return null;
}

/** An Agent ID is three non-empty parts separated by "/". */
export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && /^[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(value);
}

export function answer(result: ClaimResult): Response {
  if (result.ok) return json<TaskActionResponse>({ ok: true, task: result.task });
  const body: ClaimRefusalBody = { ok: false, reason: result.reason };
  if (result.heldBy !== undefined) body.heldBy = result.heldBy;
  return json(body, result.status);
}

export async function handleClaimRoute(
  route: ClaimRoute,
  request: Request,
  channel: DurableObjectStub<Channel>,
  caller: Caller,
): Promise<Response> {
  const body = await readJson(request);
  switch (route.kind) {
    case "claim": {
      const forAgent = body.for;
      if (forAgent !== undefined && !isAgentId(forAgent)) return fail(400, '"for" must be an Agent ID.');
      if (forAgent !== undefined && caller.agent !== undefined && forAgent !== caller.agent) {
        return fail(403, "An Agent claims for itself only.");
      }
      return answer(await channel.claimTask(caller, route.task, forAgent));
    }
    case "release":
      return answer(await channel.releaseTask(caller, route.task));
    case "step":
      return answer(await channel.completeStep(caller, route.task, route.index));
    case "tool-call": {
      const { tool, arg, ok, durationMs, output, task } = body;
      if (!SWITCHBOARD_TOOLS.includes(tool as SwitchboardTool)) {
        return fail(400, `"tool" must be one of ${SWITCHBOARD_TOOLS.join(", ")}.`);
      }
      if (typeof arg !== "string" || typeof ok !== "boolean") return fail(400, 'A tool call needs "arg" and "ok".');
      if (typeof durationMs !== "number" || !(durationMs >= 0)) return fail(400, '"durationMs" must be a duration.');
      if (output !== undefined && typeof output !== "string") return fail(400, '"output" must be text.');
      if (task !== undefined && !(typeof task === "number" && Number.isInteger(task) && task > 0)) {
        return fail(400, '"task" must be a GitHub Issue number.');
      }
      const result = await channel.recordToolCall(
        caller,
        {
          tool: tool as SwitchboardTool,
          arg: arg.slice(0, MAX_TOOL_ARG_LENGTH),
          ok,
          durationMs: Math.round(durationMs),
          ...(output === undefined ? {} : { output: output.slice(0, MAX_TOOL_OUTPUT_LENGTH) }),
        },
        task,
      );
      return result.ok ? json<ToolCallResponse>(result, 201) : fail(result.status, result.reason);
    }
  }
}
