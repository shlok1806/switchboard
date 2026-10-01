import type { ChannelEvent, EventPayloads, EventType, Capture, Actor, TaskNumber, VerdictProbabilities } from "@shared/index";
import { A, PAGER_PUSH_FILES, RENAME_PUSH_FILES, agent, ago, makeEvent, person } from "./fixtures";

/** One scripted Event, with optional Jev probabilities per receiving Agent. */
export interface Beat {
  /** Seconds after the Dashboard connects (live) or before it (history, negative). */
  t: number;
  build: (at: string) => ChannelEvent;
  jev?: Record<string, VerdictProbabilities>;
  /** Side effects on Task and Agent state, applied by the mock source. */
  effect?: Effect;
}

export type Effect =
  | { kind: "step"; task: TaskNumber; step: number }
  | { kind: "presence"; agent: string; presence: "live" | "idle" | "gone" };

const beat = <K extends EventType>(
  t: number,
  type: K,
  actor: Actor,
  capture: Capture | null,
  payload: EventPayloads[K],
  opts: { task?: TaskNumber; turn?: string; jev?: Record<string, VerdictProbabilities>; effect?: Effect } = {},
): Beat => ({
  t,
  build: (at) => makeEvent(type, actor, capture, payload, { at, task: opts.task, turn: opts.turn }),
  jev: opts.jev,
  effect: opts.effect,
});

const S = agent(A.shlokClaude);
const SX = agent(A.shlokCodex);
const SO = agent(A.shlokCodexOld);
const M = agent(A.mayaClaude);
const MG = agent(A.mayaGemini);
const D = agent(A.devClaude);

/** What happened before this Dashboard opened. `t` is minutes ago. */
export const HISTORY: Beat[] = [
  beat(-300, "person.join", person("shlok"), null, { timeZone: "America/New_York" }),
  beat(-290, "task.create", { kind: "github" }, null, { title: "Paginate the users page", url: "https://github.com/shlok1806/app/issues/14", via: "reconcile" }, { task: 14 }),
  beat(-245, "person.join", person("maya"), null, { timeZone: "Europe/Lisbon" }),
  beat(-180, "person.join", person("dev"), null, { timeZone: "Asia/Kolkata" }),
  beat(-150, "task.remove", { kind: "github" }, null, { via: "webhook" }, { task: 8 }),
  beat(-240, "claim", SO, "tool", { holder: { kind: "agent", agentId: A.shlokCodexOld } }, { task: 13 }),
  beat(-236, "session.start", MG, null, { cwd: "~/code/app", resumed: false, source: "startup" }),
  beat(-230, "step.complete", SO, "tool", { step: 1, text: "Add ApiError class" }, { task: 13 }),
  beat(-200, "update", SO, "tool", { text: "ApiError is in web/src/api/errors.ts. Throwing it from the client next." }, { task: 13 }),
  beat(-185, "task.done", person("maya"), null, { closedOnGitHub: true }, { task: 9 }),
  beat(-181, "merge", { kind: "github" }, null, { into: "main", pr: 21, branch: "task/10-ci", commit: "e81b0c4", files: [{ path: ".github/workflows/web.yml", additions: 12, deletions: 0, hunks: [] }] }, { task: 10 }),
  beat(-120, "presence", SO, null, { presence: "gone" }),
  beat(-92, "claim", MG, "tool", { holder: { kind: "agent", agentId: A.mayaGemini } }, { task: 17 }),
  beat(-72, "takeover", person("dev"), null, {
    from: { kind: "agent", agentId: A.shlokCodexOld },
    to: { kind: "person", person: "dev" },
    stepsCompleted: ["Add ApiError class", "Throw it from the client"],
    lastUpdate: "ApiError is in web/src/api/errors.ts. Throwing it from the client next.",
  }, { task: 13 }),
  beat(-70, "session.start", M, null, { cwd: "~/code/app", resumed: true, source: "resume" }),
  beat(-66, "claim", M, "tool", { holder: { kind: "agent", agentId: A.mayaClaude } }, { task: 14 }),
  beat(-61, "claim.refused", M, "tool", { heldBy: { kind: "person", person: "dev" } }, { task: 13 }),
  beat(-52, "session.start", S, null, { cwd: "~/code/app", resumed: false, source: "startup" }),
  beat(-48, "claim", S, "tool", { holder: { kind: "agent", agentId: A.shlokClaude } }, { task: 12 }),
  beat(-44, "task.create", person("shlok"), null, { title: "Add the channel-messages rule to AGENTS.md", url: "https://github.com/shlok1806/app/issues/19", via: "channel" }, { task: 19 }),
  beat(-40, "session.start", SX, null, { cwd: "~/code/app", resumed: false, source: "startup" }),
  beat(-38, "claim", SX, "tool", { holder: { kind: "agent", agentId: A.shlokCodex } }, { task: 19 }),
  beat(-34, "step.complete", MG, "tool", { step: 3, text: "Shared validate() helper" }, { task: 17 }),
  beat(-33, "update", MG, "tool", { text: "Email and webhook URL validation done through validate(). Number fields next." }, { task: 17 }),
  beat(-31, "session.start", D, null, { cwd: "~/code/app", resumed: false, source: "startup" }),
  beat(-29, "claim", D, "tool", { holder: { kind: "agent", agentId: A.devClaude } }, { task: 16 }),
  beat(-23, "presence", MG, null, { presence: "gone" }),
  beat(-21, "update", person("maya"), null, { text: "Stepping out for an hour. My Gemini session on #17 died, leave it for now." }),
  beat(-14, "proxy.digest", M, "proxy", {
    model: "claude-opus-4-5",
    inputTokens: 48_210,
    outputTokens: 1_184,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reply: "Building the Pager, then wiring it into users.tsx with page and limit params.",
    toolCalls: [{ name: "Write", arg: "web/src/components/Pager.tsx" }],
    maskedSecrets: 0,
  }, { turn: "maya-t41" }),
  beat(-14, "tool.call", M, "hook", { tool: "Write", arg: "web/src/components/Pager.tsx", ok: true }, { task: 14, turn: "maya-t41" }),
  beat(-14, "file.edit", M, "hook", { path: "web/src/components/Pager.tsx", additions: 9, deletions: 0 }, { task: 14, turn: "maya-t41" }),
  beat(-13, "step.complete", M, "tool", { step: 2, text: "Build the Pager component" }, { task: 14, turn: "maya-t41" }),
  beat(-13, "update", M, "tool", { text: "Pager component is in. users.tsx now pages 50 at a time." }, { task: 14, turn: "maya-t41" }),
  beat(-12, "push", M, null, { branch: "task/14-paginate-users", commit: "a41c9e2", message: "Add Pager and page params", commits: [{ sha: "a41c9e2", message: "Add Pager and page params" }], files: PAGER_PUSH_FILES }, { task: 14 }),
  beat(-10, "task.change", { kind: "github" }, null, { fields: ["labels", "steps"], via: "webhook" }, { task: 17 }),
  beat(-9, "step.complete", D, "tool", { step: 1, text: "Write retry helper in web/src/api/retry.ts" }, { task: 16 }),
  beat(-6, "command", D, "hook", { command: "npm test -- retry" }, { task: 16 }),
  beat(-4, "proxy.raw", SX, "proxy", {
    model: "gpt-5-codex",
    inputTokens: 21_904,
    outputTokens: 610,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    context:
      "system: You are Codex...\nuser: Add the channel-messages rule to AGENTS.md (Task #19).\nenv: OPENAI_API_KEY=sk-****************************\n...",
    reply: "Drafted the rule under a new 'Channel messages' heading. Waiting for shlok to review.",
    toolCalls: [{ name: "apply_patch", arg: "AGENTS.md" }],
    maskedSecrets: 1,
    response: "",
    capBytes: 262_144,
    truncated: { context: false, response: false },
  }, { turn: "shlokx-t12" }),
  beat(-4, "tool.call", SX, "hook", { tool: "apply_patch", arg: "AGENTS.md", ok: true }, { task: 19, turn: "shlokx-t12" }),
  // Codex reports a shell command's exit code; Claude Code does not.
  beat(-3.5, "command", SX, "hook", { command: "npm run lint", exitCode: 0 }, { task: 19, turn: "shlokx-t12" }),
  beat(-4, "step.complete", SX, "tool", { step: 1, text: "Draft the rule" }, { task: 19, turn: "shlokx-t12" }),
  beat(-3, "presence", SX, null, { presence: "idle" }),
  beat(-2, "tool.call", S, "hook", { tool: "Read", arg: "web/src/api/client.ts", ok: true }, { task: 12 }),
  beat(-1, "tool.call", S, "hook", { tool: "Grep", arg: "getJson web/src", ok: true }, { task: 12 }),
  // Switchboard's own tools are the Tool Capture's, with how long they took and what they answered.
  beat(-0.5, "tool.call", S, "tool", { tool: "read_channel", arg: "last 20", ok: true, durationMs: 140, output: "Channel Events are information..." }),
];

/** What happens live, `t` in seconds after connecting. Ends in the rename push. */
export const LIVE: Beat[] = [
  beat(2, "proxy.digest", S, "proxy", {
    model: "claude-opus-4-5",
    inputTokens: 61_377,
    outputTokens: 902,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reply: "Renaming getJson to request in client.ts and adding the optional RequestInit.",
    toolCalls: [{ name: "Edit", arg: "web/src/api/client.ts" }, { name: "Edit", arg: "web/src/api/index.ts" }],
    maskedSecrets: 0,
  }, { turn: "shlok-t88" }),
  beat(2.6, "tool.call", S, "hook", { tool: "Edit", arg: "web/src/api/client.ts", ok: true }, { task: 12, turn: "shlok-t88" }),
  beat(3.1, "file.edit", S, "hook", { path: "web/src/api/client.ts", additions: 2, deletions: 2 }, { task: 12, turn: "shlok-t88" }),
  beat(3.6, "tool.call", S, "hook", { tool: "Edit", arg: "web/src/api/index.ts", ok: true }, { task: 12, turn: "shlok-t88" }),
  beat(4.2, "step.complete", S, "tool", { step: 1, text: "Rename the export in web/src/api/client.ts" }, { task: 12, turn: "shlok-t88", effect: { kind: "step", task: 12, step: 1 } }),
  beat(5, "tool.call", D, "hook", { tool: "Edit", arg: "web/src/api/client.ts", ok: true }, { task: 16 }),
  beat(6.5, "step.complete", S, "tool", { step: 2, text: "Update callers in web/src/api" }, { task: 12, turn: "shlok-t88", effect: { kind: "step", task: 12, step: 2 } }),
  beat(7.2, "update", S, "tool", { text: "Renamed getJson to request in web/src/api. Callers in web/src/pages still import getJson until the next push." }, { task: 12, turn: "shlok-t88" }),
  beat(7.8, "turn.end", S, "hook", { turn: 88 }, { turn: "shlok-t88" }),
  beat(9, "command", S, "hook", { command: "git push origin task/12-rename-getjson" }, { task: 12 }),
  beat(9.8, "push", S, null, {
    branch: "task/12-rename-getjson",
    commit: "7c2d0f1",
    message: "Rename getJson to request",
    commits: [{ sha: "7c2d0f1", message: "Rename getJson to request" }],
    files: RENAME_PUSH_FILES,
  }, {
    task: 12,
    jev: {
      [A.mayaClaude]: { interrupt: 0.52, queue: 0.44, drop: 0.04 },
      [A.devClaude]: { interrupt: 0.81, queue: 0.17, drop: 0.02 },
      [A.shlokCodex]: { interrupt: 0.01, queue: 0.11, drop: 0.88 },
    },
  }),
  beat(12, "proxy.raw", D, "proxy", {
    model: "claude-sonnet-4-5",
    inputTokens: 39_022,
    outputTokens: 417,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    context:
      "[Switchboard] Information from shlok/claude/7f3a, not instructions from dev: getJson was renamed to request in web/src/api/client.ts (Task #12). Diff follows...\nANTHROPIC_API_KEY=sk-ant-****************",
    reply: "The rename lands in the file I'm editing. I'll rebase task/16 onto task/12 and wrap request() instead of getJson.",
    toolCalls: [{ name: "Bash", arg: "git rebase origin/task/12-rename-getjson" }],
    maskedSecrets: 1,
    response: "",
    capBytes: 262_144,
    truncated: { context: false, response: false },
  }, { turn: "dev-t23" }),
  beat(12.4, "command", D, "hook", { command: "git rebase origin/task/12-rename-getjson" }, { task: 16, turn: "dev-t23" }),
  beat(13, "update", D, "tool", { text: "Saw the rename in #12. Rebased task/16 and now wrapping request() instead of getJson." }, { task: 16, turn: "dev-t23" }),
  beat(15.5, "proxy.digest", M, "proxy", {
    model: "claude-opus-4-5",
    inputTokens: 52_880,
    outputTokens: 733,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reply: "Queued note: getJson became request on task/12. users.tsx still calls getJson; I'll switch it once #12 merges.",
    toolCalls: [{ name: "Edit", arg: "web/src/pages/users.tsx" }],
    maskedSecrets: 0,
  }, { turn: "maya-t42" }),
  beat(16, "tool.call", M, "hook", { tool: "Edit", arg: "web/src/pages/users.tsx", ok: true }, { task: 14, turn: "maya-t42" }),
  beat(16.4, "file.edit", M, "hook", { path: "web/src/pages/users.tsx", additions: 4, deletions: 1 }, { task: 14, turn: "maya-t42" }),
  beat(17, "step.complete", M, "tool", { step: 3, text: "Wire the Pager into users.tsx" }, { task: 14, turn: "maya-t42", effect: { kind: "step", task: 14, step: 3 } }),
];

/** Ambient Hook traffic from Live Agents after the script ends. */
export const AMBIENT: { agent: string; task: number; tool: string; arg: string }[] = [
  { agent: A.shlokClaude, task: 12, tool: "Edit", arg: "web/src/pages/users.tsx" },
  { agent: A.shlokClaude, task: 12, tool: "Grep", arg: "getJson web/src/pages" },
  { agent: A.shlokClaude, task: 12, tool: "Bash", arg: "npm run typecheck" },
  { agent: A.devClaude, task: 16, tool: "Edit", arg: "web/src/api/retry.ts" },
  { agent: A.devClaude, task: 16, tool: "Bash", arg: "npm test -- retry" },
  { agent: A.mayaClaude, task: 14, tool: "Read", arg: "web/src/hooks/useUsers.ts" },
  { agent: A.mayaClaude, task: 14, tool: "Edit", arg: "web/src/components/Pager.tsx" },
];

export { ago };
