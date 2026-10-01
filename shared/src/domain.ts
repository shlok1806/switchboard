/**
 * Switchboard domain types, shared by the Dashboard and the Worker.
 * Every name here follows CONTEXT.md. If a term changes there, change it here.
 */

/* ── Participants ─────────────────────────────────────────── */

/** A Person's name: their GitHub login, lowercased (ADR 0007). */
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
 * for example `shlok1806/claude/7f3a`. The CLI segment uses the short CLI name.
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
  /**
   * Whether the Agent's wrapper can type Interrupts into its CLI, as the wrapper said
   * when it registered. When false, Interrupts become Queue, labelled as downgraded.
   */
  canReceiveInterrupts: boolean;
  lastSeenAt: string;
  startedAt: string;
}

/** Who holds a Claim, or who a Takeover moves it to. */
export type Holder = { kind: "agent"; agentId: AgentId } | { kind: "person"; person: PersonName };

/* ── Tasks ────────────────────────────────────────────────── */

/** GitHub Issue number. Every Task is exactly one Issue. */
export type TaskNumber = number;

/** A checklist item inside one Task. Belongs to whoever holds the Claim. */
export interface Step {
  index: number;
  text: string;
  done: boolean;
}

/**
 * Mirrored to GitHub as a `status:*` label. `review`: its holder finished it and
 * its pull request is open (ADR 0006); the Claim stands until the PR merges.
 */
export type TaskStatus = "open" | "claimed" | "review" | "done";

/** The exclusive hold one Person or Agent has on a Task. */
export interface Claim {
  task: TaskNumber;
  holder: Holder;
  claimedAt: string;
  /** True when the holder is an Agent that is Gone. Never expires on its own (ADR 0002). */
  stale: boolean;
  /**
   * Set when the Task became blocked after it was claimed: the open Issues now
   * blocking it. The Claim stays held ("claimed but now blocked by #X").
   */
  blockedBy?: TaskNumber[];
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
 * `relay` is the Relay recording its Verdicts.
 */
export type Actor =
  | { kind: "agent"; agentId: AgentId }
  | { kind: "person"; person: PersonName }
  | { kind: "github" }
  | { kind: "relay" };

/** One changed file in a push or merge, with its committed diff hunks. */
export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** True when some of its hunks were cut to fit the size caps, or GitHub sent none (binary or too large). */
  truncated?: boolean;
}

/** One commit in a push. */
export interface PushCommit {
  sha: string;
  /** The first line of its message. */
  message: string;
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
   * A session started: once per session, when the wrapper registers the Agent (no
   * Capture), with how the CLI started it (`source`: "startup" or "resume").
   */
  "session.start": { cwd: string; resumed: boolean; source?: string };
  /**
   * A session ended: once per session, when the wrapper ends it. `detail` is the agent
   * CLI's own reason, when its SessionEnd hook reported one.
   */
  "session.end": { reason: "exit" | "timeout"; detail?: string };
  presence: { presence: Presence };
  /** One tool call. `arg` is a short summary of its input (a path, a command, a pattern), never file contents. */
  "tool.call": { tool: string; arg: string; ok: boolean; durationMs?: number; output?: string };
  /** A file the Agent edited: its path, relative to the repo when inside it. Never its contents. */
  "file.edit": { path: string; additions: number; deletions: number };
  /** A shell command the Agent ran, truncated. `exitCode` when the CLI reports one. */
  command: { command: string; exitCode?: number };
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
  claim: { holder: Holder };
  "claim.refused": { heldBy: Holder };
  "claim.release": { holder: Holder };
  "step.complete": { step: number; text: string };
  /**
   * Mirroring a Claim change to GitHub failed (ADR 0001). The Claim change itself
   * stands; GitHub is behind until the next change or a Person fixes it.
   */
  "mirror.failed": {
    change: "claim" | "release" | "step.complete" | "finish" | "takeover" | "update";
    call: string;
    reason: string;
  };
  /** The holder of a Claim went Gone, so the Claim is Stale. It stays held until a Person takes it over (ADR 0002). */
  "claim.stale": { holder: Holder };
  /** The holder of a Stale Claim came back before any Takeover, so the Claim is no longer Stale. */
  "claim.recovered": { holder: Holder };
  /** A claimed Task became blocked by open Issues. The Claim stays held. */
  "claim.blocked": { holder: Holder; blockedBy: TaskNumber[] };
  /** A claimed Task that was blocked after its Claim is no longer blocked. */
  "claim.unblocked": { holder: Holder };
  /** An Event written on purpose, in readable language. */
  update: { text: string };
  /** A message from a Person to an Agent. The only message with instruction weight. */
  directive: { to: AgentId; text: string };
  /**
   * How a Directive reached its Agent: typed into its running session right away
   * ("interrupt"), or held for its next turn ("queue"), with why it was not typed.
   * Recorded by the Channel after the `directive` Event (named in `directive`); the
   * actor is the target Agent.
   */
  "directive.delivery": {
    directive: string;
    from: PersonName;
    delivered: "interrupt" | "queue";
    reason?: DirectiveQueueReason;
  };
  /**
   * A Person moving a Stale Claim to a new holder, with the hand-off: the previous
   * holder, the Steps it completed and its last Update on the Task.
   */
  takeover: {
    from: Holder;
    to: Holder;
    stepsCompleted: string[];
    lastUpdate?: string;
  };
  /**
   * Commits pushed to a Task branch (`task/<issue#>-<slug>`), from the GitHub webhook.
   * `commit` and `message` are the newest commit's. Hunks are capped (see
   * `DIFF_LINES_PER_FILE`); `truncationNote` says so and how to get the rest.
   */
  push: {
    branch: string;
    commit: string;
    message: string;
    commits: PushCommit[];
    files: FileChange[];
    truncationNote?: string;
  };
  /** A pull request merged into the main branch, from the GitHub webhook. Hunks capped as for `push`. */
  merge: {
    into: string;
    pr: number;
    branch: string;
    commit: string;
    files: FileChange[];
    truncationNote?: string;
  };
  /** The Task's branch was created (or picked up again) by its holder's wrapper (ADR 0006). */
  "task.branch": { branch: string };
  /** The holder finished the Task: its branch was pushed and a pull request opened that closes the Issue. */
  "task.review": { pr: number; url: string; branch: string };
  "task.done": { pr?: number; closedOnGitHub: boolean };
  /** A new Task: created through the Channel API (actor is the Person) or found on GitHub. */
  "task.create": { title: string; url: string; via: TaskSyncVia };
  /** GitHub-owned fields of a Task changed on GitHub (ADR 0001). */
  "task.change": { fields: TaskField[]; via: TaskSyncVia };
  /** An Issue closed on GitHub was reopened there. */
  "task.reopen": { via: TaskSyncVia };
  /** The Issue was deleted or moved to another repo, so the Task is gone. */
  "task.remove": { via: TaskSyncVia };
  /**
   * The Relay's Verdict for one Event and one Agent, with Jev's probabilities and the
   * state Jev was sent. Recorded by the Relay (actor `relay`), never relayed itself.
   */
  verdict: Verdict;
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
  /** Files the Event changed that the receiving Agent touched, or that its Task's pushes changed. */
  files: string[];
  /** Symbols the diff removed or renamed that the receiving Agent uses. */
  symbols: string[];
}

/**
 * Where a Verdict came from.
 * - `jev`: Jev was asked.
 * - `rule`: no overlap and nothing addressed to the Agent, so the Relay dropped
 *   without calling Jev (still recorded).
 * - `fallback`: Jev failed or timed out, so the Relay queued the Event rather than lose it.
 */
export type VerdictSource = "jev" | "rule" | "fallback";

/** The structured state the Relay sends Jev for one Event and one Agent (issue #3). */
export interface RelayState {
  agent: {
    id: AgentId;
    /**
     * The Tasks the Agent is working on: claimed by it and not yet finished, newest
     * Claim first. A Task in review, or released, is not among them.
     */
    tasks: {
      number: TaskNumber;
      title: string;
      description: string;
      /** The first Step of the Task that is not done. */
      currentStep: string | null;
    }[];
    /** Files it edited, most recently edited first. */
    filesTouched: string[];
  };
  event: {
    /** Agent ID, Person name, or "github". */
    sender: string;
    type: EventType;
    task: { number: TaskNumber; title: string } | null;
    /** One short line of facts. */
    summary: string;
    files: string[];
    /** Committed diff hunks, capped, as unified diff text. Empty when the Event has none. */
    diff: string;
  };
  overlap: {
    sharedFiles: string[];
    /** Symbols the diff removed or renamed that this Agent uses. */
    symbolsAgentUses: string[];
    /** Why the Event is addressed to the Agent (its Task, a Directive, its Claim), or null. */
    addressedToAgent: string | null;
  };
}

/**
 * Why an Interrupt reached the Agent as a Queue.
 * - `below-threshold`: Jev was less sure than the threshold, so the Verdict's `option` is "queue".
 * - `cli-cannot-interrupt`: the Agent's CLI cannot receive Interrupts.
 * - `wrapper-offline`: the Agent's wrapper was not connected to the Channel.
 * - `rate-limited`: the Agent had an Interrupt too recently.
 * - `person-typing`: the Agent's Person kept typing, and the wrapper never types over them.
 * - `dialog-open`: the session was showing a permission prompt or a question, which typing would answer.
 * - `session-not-ready`: the session was not ready for typed input yet.
 * - `no-answer`: the wrapper did not say in time whether it typed the Interrupt.
 */
export type DowngradeReason =
  | "below-threshold"
  | "cli-cannot-interrupt"
  | "wrapper-offline"
  | "rate-limited"
  | "person-typing"
  | "dialog-open"
  | "session-not-ready"
  | "no-answer";

/**
 * Why a Directive waited for the Agent's next turn instead of being typed right away:
 * the Interrupt downgrade reasons that apply to it. A Directive has no threshold and
 * is exempt from the Interrupt rate limit.
 */
export type DirectiveQueueReason = Exclude<DowngradeReason, "below-threshold" | "rate-limited">;

/** The Relay's decision for one Event and one Agent. */
export interface Verdict {
  event: string;
  agent: AgentId;
  at: string;
  /** The Relay's decision, after the confidence threshold. */
  option: VerdictOption;
  /**
   * How the Event reached the Agent. An Interrupt is typed into the Agent's running
   * session ("interrupt"). When something stops that on the way it reaches the Agent
   * as a Queue instead: `option` stays "interrupt" and `downgraded` says why.
   */
  delivered: VerdictOption;
  source: VerdictSource;
  /** Jev's probabilities. Absent unless Jev answered. */
  probabilities?: VerdictProbabilities;
  /** Jev's confidence in its choice. */
  confidence?: number;
  /** Set when an Interrupt became a Queue. */
  downgraded?: {
    from: "interrupt";
    reason: DowngradeReason;
  };
  overlap: Overlap;
  /** Why the Event is addressed to the Agent, when it is. */
  addressed?: string;
  /** The state sent to Jev. Absent for a `rule` Drop, which never asks. */
  state?: RelayState;
  /** Why Jev gave no answer, for a `fallback`. */
  error?: string;
  latencyMs?: number;
}

/** Relay settings visible to Persons (`GET /api/relay`). Never carries a secret. */
export interface RelayConfig {
  /** An Interrupt below this probability becomes a Queue. */
  interruptThreshold: number;
  /** The fewest seconds between two Interrupts to one Agent. */
  interruptIntervalSeconds: number;
  /** The Jev model the Relay asks. */
  model: string;
}
