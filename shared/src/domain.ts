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

/** Payloads, keyed by Event type. */
export interface EventPayloads {
  /** A Person joined the Channel for the first time. */
  "person.join": { timeZone: string };
  "session.start": { cwd: string; resumed: boolean };
  "session.end": { reason: "exit" | "timeout" };
  "presence": { presence: Presence };
  "tool.call": { tool: string; arg: string; ok: boolean; durationMs: number; output?: string };
  "file.edit": { path: string; additions: number; deletions: number };
  "command": { command: string; exitCode: number };
  "turn.end": { turn: number };
  /** Proxy Digest: model, token counts, reply text and tool calls, secrets masked. */
  "proxy.digest": {
    model: string;
    inputTokens: number;
    outputTokens: number;
    reply: string;
    toolCalls: ToolCall[];
    maskedSecrets: number;
  };
  /** Raw Proxy Event: a full model turn including its context. Shown on the Dashboard only. */
  "proxy.raw": {
    model: string;
    inputTokens: number;
    outputTokens: number;
    context: string;
    reply: string;
    toolCalls: ToolCall[];
    maskedSecrets: number;
  };
  "claim": { holder: Holder };
  "claim.refused": { heldBy: Holder };
  "claim.release": { holder: Holder };
  "step.complete": { step: number; text: string };
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
