/**
 * The Claim part of the Channel API: claiming and releasing a Task, completing a
 * Step, and the Tool Capture that Agents use through Switchboard's MCP tools.
 * Terms follow CONTEXT.md.
 */
import type { AgentId, ChannelEvent, Holder, PersonName, Task, TaskNumber } from "./domain";

/** The `status:*` label a claimed Task carries on GitHub (ADR 0001). */
export const CLAIMED_LABEL = "status:claimed";

/**
 * `POST /api/tasks/:number/claim`. An Agent claims for itself. A Person claims for
 * themselves, or sets `for` to claim for one of their own Agents. A refusal names
 * the holder in `heldBy`. Claiming a Task you already hold changes nothing.
 */
export interface ClaimRequest {
  for?: AgentId;
}

/** `POST /api/tasks/:number/release`: the holder (or the holding Agent's Person) frees the Task. */
export type ReleaseRequest = Record<string, never>;

/**
 * `POST /api/tasks/:number/steps/:index/complete`: the holder ticks one Step,
 * `index` as in `Task.steps`. Completing a done Step changes nothing.
 */
export type CompleteStepRequest = Record<string, never>;

/** Claim, release and Step completion answer with the Task as it is now. */
export interface TaskActionResponse {
  ok: true;
  task: Task;
}

/** A refused Claim action. `heldBy` names the holder when the Task is held by someone else. */
export interface ClaimRefusal {
  ok: false;
  reason: string;
  heldBy?: Holder;
}

/** `POST /api/tool-calls`: an Agent reports one call to a Switchboard tool. Needs `AGENT_HEADER`. */
export interface ToolCallRequest {
  tool: SwitchboardTool;
  /** Short argument summary, such as `#9`. */
  arg: string;
  ok: boolean;
  durationMs: number;
  /** Short result, or the refusal. */
  output?: string;
  task?: TaskNumber;
}

export interface ToolCallResponse {
  ok: true;
  event: ChannelEvent;
}

/** The MCP tools the wrapper gives every Agent. */
export const SWITCHBOARD_TOOLS = [
  "list_tasks",
  "claim_task",
  "release_task",
  "complete_step",
  "post_update",
  "read_channel",
  "finish_task",
] as const;

export type SwitchboardTool = (typeof SWITCHBOARD_TOOLS)[number];

/** The longest `arg` and `output` a tool call Event keeps, in characters. */
export const MAX_TOOL_ARG_LENGTH = 200;
export const MAX_TOOL_OUTPUT_LENGTH = 2000;

export function claimPath(task: TaskNumber): string {
  return `/api/tasks/${task}/claim`;
}

export function releasePath(task: TaskNumber): string {
  return `/api/tasks/${task}/release`;
}

export function takeoverPath(task: TaskNumber): string {
  return `/api/tasks/${task}/takeover`;
}

export function stepPath(task: TaskNumber, index: number): string {
  return `/api/tasks/${task}/steps/${index}/complete`;
}

/** How a holder reads in refusals, comments and tool output: its Agent ID or Person name. */
export function holderName(holder: Holder): string {
  return holder.kind === "agent" ? holder.agentId : holder.person;
}

/* ── Stale Claims and Takeover (ADR 0002) ─────────────────── */

/**
 * `POST /api/tasks/:number/takeover`: a Person moves a Stale Claim to themselves or
 * to one of their own Agents. Refused for an Agent, and for a Claim that is not
 * Stale. Answers with the Task as it is now (`TaskActionResponse`).
 */
export interface TakeoverRequest {
  to: Holder;
}

/**
 * A Claim an Agent lost to a Takeover. The Channel hands each one to the Agent's
 * wrapper once, in the answer to its next registration or heartbeat
 * (`AgentResponse.lostClaims`), so a resumed Agent is told at its next turn.
 */
export interface LostClaim {
  task: TaskNumber;
  title: string;
  /** The Person who did the Takeover. */
  by: PersonName;
  /** The new holder. */
  to: Holder;
  at: string;
  /** The `takeover` Event. */
  event: string;
}
