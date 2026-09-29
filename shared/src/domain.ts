/**
 * Switchboard domain types, shared by the Dashboard and the Worker.
 * Every name here follows CONTEXT.md. If a term changes there, change it here.
 */

/* ── Participants ─────────────────────────────────────────── */

/** A Person's name is their identity on the Channel (interim auth, see issue #1). */
export type PersonName = string;

/** A human on the Channel. Every Agent belongs to exactly one Person. */
export interface Person {
  name: PersonName;
  /** IANA time zone of the Person's laptop, for showing their local time. */
  timeZone: string;
  joinedAt: string;
}

/** The agent CLIs Switchboard supports. */
export type Cli = "claude-code" | "codex" | "gemini";

/**
 * The permanent name of an Agent: `<person>/<cli>/<short session id>`,
 * for example `shlok/claude/7f3a`. The CLI segment uses the short CLI name.
 */
export type AgentId = `${string}/${string}/${string}`;

/** Live (recently active), Idle (waiting on its Person) or Gone (silent ~10 min, or session ended). */
export type Presence = "live" | "idle" | "gone";

/** Per-Agent Proxy mode, set by its Person. */
export type ProxyMode = "raw" | "digest";

/** One coding-agent session run by a Person. */
export interface Agent {
  id: AgentId;
  person: PersonName;
  cli: Cli;
  /** Optional readable label. Never replaces the Agent ID. */
  nickname?: string;
  presence: Presence;
  proxyMode: ProxyMode;
  /** Secret masking on Proxy Events. On by default. */
  secretMasking: boolean;
  /** False when the CLI cannot receive Interrupts; they become Queue, labelled as downgraded. */
  canReceiveInterrupts: boolean;
  lastSeenAt: string;
  startedAt: string;
}

/** Who holds a Claim, or who a Takeover moves it to. */
export type Holder =
  | { kind: "agent"; agentId: AgentId }
  | { kind: "person"; person: PersonName };

/* ── Tasks ────────────────────────────────────────────────── */

/** GitHub Issue number. Every Task is exactly one Issue. */
export type TaskNumber = number;

/** A checklist item inside one Task. Belongs to whoever holds the Claim. */
export interface Step {
  index: number;
  text: string;
  done: boolean;
}

/** Mirrored to GitHub as a `status:*` label. */
export type TaskStatus = "open" | "claimed" | "done";

/** The exclusive hold one Person or Agent has on a Task. */
export interface Claim {
  task: TaskNumber;
  holder: Holder;
  claimedAt: string;
  /** True when the holder is an Agent that is Gone. Never expires on its own (ADR 0002). */
  stale: boolean;
}

export interface Task {
  number: TaskNumber;
  /** GitHub owns title, description, labels and blockers (ADR 0001). */
  title: string;
  description: string;
  labels: string[];
  /** Open Issues this Task is blocked by (GitHub issue dependencies). */
  blockedBy: TaskNumber[];
  /** Parent Task when this is a Subtask (a GitHub sub-issue). */
  parent?: TaskNumber;
  /** Every Subtask, open or done. */
  subtasks: TaskNumber[];
  /** How many of `subtasks` are done. */
  subtasksDone: number;
  /** Checklist items (`- [ ]` / `- [x]`) in the Issue body, in order. */
  steps: Step[];
  /** How many of `steps` are done. */
  stepsDone: number;
  /** The Issue on GitHub. */
  url: string;
  status: TaskStatus;
  claim?: Claim;
  /** `task/<issue#>-<slug>`, created on Claim (ADR 0006). */
  branch?: string;
  /** Pull request number, opened on finish. */
  pr?: number;
  updatedAt: string;
}

/* ── Channel ──────────────────────────────────────────────── */

/** The route by which an Event reached the Channel. */
export type Capture = "proxy" | "hook" | "tool";

/**
 * Who an Event names. Every Event names its Agent or Person.
 * `github` covers pushes, merges and Issue changes reported by the GitHub webhook.
 */
export type Actor =
  | { kind: "agent"; agentId: AgentId }
  | { kind: "person"; person: PersonName }
  | { kind: "github" };

/** One changed file in a push, with its committed diff hunks. */
export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "ctx" | "add" | "del";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface ToolCall {
  name: string;
  /** Short argument summary, such as a path or a command. */
  arg: string;
}

/** What a Proxy Event says about one model turn, in both Proxy modes. */
export interface ProxyTurn {
  model: string;
  /** Input tokens that were neither read from nor written to the prompt cache. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens read from the prompt cache. */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache. */
  cacheCreationTokens: number;
  /** The reply's text, masked and cut short. */
  reply: string;
  /** Every tool the reply calls, with a short summary of its input. */
  toolCalls: ToolCall[];
  /** How many detected secrets were masked before the Event left the laptop. */
  maskedSecrets: number;
}

/** Payloads, keyed by Event type. */
export interface EventPayloads {
  /** A Person joined the Channel for the first time. */
  "person.join": { timeZone: string };
  /**
   * A session started. The wrapper records one when it registers the Agent (no Capture).
   * The Hook Capture records one when the agent CLI reports it, with the CLI's `source`
   * (Claude Code: "startup", "resume", "clear" or "compact").
   */
  "session.start": { cwd: string; resumed: boolean; source?: string };
  /** A session ended. `detail` is the agent CLI's own reason, when a Hook reported it. */
  "session.end": { reason: "exit" | "timeout"; detail?: string };
  "presence": { presence: Presence };
  /** One tool call. `arg` is a short summary of its input (a path, a command, a pattern), never file contents. */
  "tool.call": { tool: string; arg: string; ok: boolean; durationMs?: number; output?: string };
  /** A file the Agent edited: its path, relative to the repo when inside it. Never its contents. */
  "file.edit": { path: string; additions: number; deletions: number };
  /** A shell command the Agent ran, truncated. `exitCode` when the CLI reports one. */
  "command": { command: string; exitCode?: number };
  /** The Agent finished a turn. `turn` counts turns in this run of the wrapper, from 1. */
  "turn.end": { turn: number };
  /**
   * Proxy Digest: one model turn in short. Model, token counts, the reply text and
   * the tool calls it made, with detected secrets masked on the laptop.
   */
  "proxy.digest": ProxyTurn;
  /**
   * Raw Proxy Event: a full model turn. `context` is the request body (everything in
   * the model's context) and `response` the response body as it arrived (an SSE
   * stream when streaming), each cut to `capBytes`. Shown on the Dashboard only,
   * never relayed into any Agent (ADR 0005).
   */
  "proxy.raw": ProxyTurn & {
    context: string;
    response: string;
    /** The most bytes of each body kept. */
    capBytes: number;
    /** Which bodies were longer than `capBytes` and cut. */
    truncated: { context: boolean; response: boolean };
  };
  "claim": { holder: Holder };
  "claim.refused": { heldBy: Holder };
  "claim.release": { holder: Holder };
  "step.complete": { step: number; text: string };
  /**
   * Mirroring a Claim change to GitHub failed (ADR 0001). The Claim change itself
   * stands; GitHub is behind until the next change or a Person fixes it.
   */
  "mirror.failed": { change: "claim" | "release" | "step.complete"; call: string; reason: string };
  /** An Event written on purpose, in readable language. */
  "update": { text: string };
  /** A message from a Person to an Agent. The only message with instruction weight. */
  "directive": { to: AgentId; text: string };
  /** A Person moving a Stale Claim to a new holder, with the hand-off. */
  "takeover": {
    from: Holder;
    to: Holder;
    stepsCompleted: string[];
    lastUpdate?: string;
  };
  "push": { branch: string; commit: string; message: string; files: FileChange[] };
  "merge": { into: "main"; pr: number; branch: string; files: string[] };
  "task.done": { pr?: number; closedOnGitHub: boolean };
  /** A new Task: created through the Channel API (actor is the Person) or found on GitHub. */
  "task.create": { title: string; url: string; via: TaskSyncVia };
  /** GitHub-owned fields of a Task changed on GitHub (ADR 0001). */
  "task.change": { fields: TaskField[]; via: TaskSyncVia };
  /** An Issue closed on GitHub was reopened there. */
  "task.reopen": { via: TaskSyncVia };
  /** The Issue was deleted or moved to another repo, so the Task is gone. */
  "task.remove": { via: TaskSyncVia };
}

/**
 * How a Task change reached the Channel: a call to the Channel API, a GitHub
 * webhook, or the periodic reconcile that repairs missed webhooks.
 */
export type TaskSyncVia = "channel" | "webhook" | "reconcile";

/** The Task fields GitHub owns, as named in `task.change` Events. */
export type TaskField = "title" | "description" | "labels" | "blockedBy" | "parent" | "subtasks" | "steps";

export type EventType = keyof EventPayloads;

interface EventBase {
  id: string;
  /** Monotonic order on the Channel. */
  seq: number;
  at: string;
  actor: Actor;
  /**
   * The Capture that carried it. Null for Events that did not come through an Agent
   * Capture: a Person on the Dashboard, or the GitHub webhook.
   */
  capture: Capture | null;
  task?: TaskNumber;
  /**
   * Groups Events from one Agent model turn across Captures,
   * so the same moment can be compared side by side.
   */
  turn?: string;
}

/** Anything recorded on the Channel. Append-only. */
export type ChannelEvent = {
  [K in EventType]: EventBase & { type: K; payload: EventPayloads[K] };
}[EventType];

export type EventOf<K extends EventType> = Extract<ChannelEvent, { type: K }>;

/* ── Relay ────────────────────────────────────────────────── */

export type VerdictOption = "drop" | "queue" | "interrupt";

/** Jev's probability for each option. Sums to 1. */
export type VerdictProbabilities = Record<VerdictOption, number>;

/** What the Relay worked out in code before asking Jev. */
export interface Overlap {
  files: string[];
  /** Symbols the diff removed or renamed that the receiving Agent uses. */
  symbols: string[];
}

/** The Relay's decision for one Event and one Agent. */
export interface Verdict {
  event: string;
  agent: AgentId;
  at: string;
  /** The delivered decision, after any downgrade. */
  option: VerdictOption;
  /**
   * `jev`: Jev was asked. `skipped`: no overlap and not addressed to the Agent,
   * so the Relay dropped without calling Jev (still recorded).
   */
  source: "jev" | "skipped";
  /** Jev's probabilities. Absent when skipped. */
  probabilities?: VerdictProbabilities;
  /** Set when an Interrupt was delivered as a Queue. */
  downgraded?: {
    from: "interrupt";
    reason: "below-threshold" | "cli-cannot-interrupt";
  };
  overlap: Overlap;
  latencyMs?: number;
}

/** Relay settings visible to Persons. */
export interface RelayConfig {
  /** An Interrupt below this probability becomes a Queue. */
  interruptThreshold: number;
  model: string;
}
