// The Dataset's records (ADR 0054), version DATASET_SCHEMA. docs/dataset.md describes
// every field for whoever trains on it; a change that breaks a reader bumps the version,
// and a sync rewrites every session written under an older one.

/** The schema version every record carries. */
export const DATASET_SCHEMA = 1;

/** The agent CLIs whose session files the collector reads. */
export type DatasetCli = "claude-code" | "codex";

/** Counts of what redaction masked, by kind (`an Anthropic key`), never the values. */
export type RedactionCounts = Record<string, number>;

/** Tokens the model's own usage records report, summed once per model message. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/**
 * One thread of a session: its main conversation, a subagent it started, or an agent
 * of a workflow run it started. Every Turn names the thread it belongs to.
 */
export interface DatasetThread {
  /** `main`, `subagent:<agentId>` or `workflow:<runId>/<agentId>`. */
  id: string;
  kind: "main" | "subagent" | "workflow-agent";
  /** The subagent's type and the description it was started with, when its meta file says. */
  agentType?: string;
  description?: string;
  /** The workflow run it ran in. */
  workflowRun?: string;
  turns: number;
}

/** A workflow run the session started, from its journal and its script. */
export interface DatasetWorkflow {
  runId: string;
  name?: string;
  /** The threads of its agents. */
  agents: string[];
  /** Journal entries, as Turns of thread `workflow:<runId>`. */
  journalEntries: number;
}

/** One session: `sessions/<cli>/<id>/session.json`. */
export interface DatasetSession {
  schema: typeof DATASET_SCHEMA;
  id: string;
  cli: DatasetCli;
  /** The account the session ran under, as the CLI recorded it, and the source it was read from. */
  account: { id: string | null; source: string };
  title?: string;
  startedAt?: string;
  endedAt?: string;
  /** The first working directory, then every one it used. */
  cwd?: string;
  cwds: string[];
  gitBranches: string[];
  models: string[];
  /** The session that started this one, for a Codex subagent thread. */
  parent?: string;
  threads: DatasetThread[];
  workflows: DatasetWorkflow[];
  counts: {
    turns: number;
    prompts: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    corrections: number;
  };
  /** Corrections by kind. */
  correctionKinds: Record<string, number>;
  tokens: TokenCounts;
  redactions: RedactionCounts;
}

/** A user's prompt that rejects or redirects work, kept as it was said (after redaction). */
export interface Correction {
  /**
   * - `rejected-tool`: the Person refused a tool call at its permission prompt.
   * - `interrupted`: the Person stopped the turn.
   * - `redirect`: a typed prompt, right after the model worked, that says no or steers it elsewhere.
   */
  kind: "rejected-tool" | "interrupted" | "redirect";
  /** What gave it away: the rule's name, such as `starts:no` or `cli:rejected`. */
  cue: string;
}

/** One part of a Turn. Text is redacted; tool inputs are kept as their redacted JSON text. */
export type TurnPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: string }
  | { type: "tool_result"; toolUseId: string; text: string; isError?: true; truncatedFrom?: number }
  | { type: "image" };

/** One message of a thread: a line of `sessions/<cli>/<id>/turns.jsonl`, in order. */
export interface DatasetTurn {
  schema: typeof DATASET_SCHEMA;
  session: string;
  thread: string;
  /** Its place in the session's file, from 0, over every thread. */
  n: number;
  at?: string;
  /**
   * - `user` / `prompt`: what the Person typed.
   * - `user` / `context`: what the CLI or a hook put in the user's place (instructions, notifications).
   * - `assistant` / `message`: the model's reply.
   * - `tool` / `result`: the results of the tool calls of the message before.
   * - `system` / `compaction`: the CLI compacted the context; `system` / `workflow`: a workflow journal entry.
   */
  role: "user" | "assistant" | "tool" | "system";
  kind: "prompt" | "context" | "message" | "result" | "compaction" | "workflow";
  parts: TurnPart[];
  model?: string;
  tokens?: TokenCounts;
  correction?: Correction;
}

/** A pull request a session opened or worked on, and how it turned out. */
export interface PullRequestOutcome {
  repo: string;
  number: number;
  url: string;
  /** Where the link came from: the CLI's own record, a tool's output, or the Channel's Task. */
  via: ("cli" | "tool-output" | "channel")[];
  state?: "open" | "merged" | "closed";
  mergedAt?: string;
  closedAt?: string;
  mergeCommit?: string;
  /** A later pull request or commit on the repo that reverted it. */
  revertedBy?: string;
}

/** What the Channel knows of a session's Agent: its Tasks, Claims and pull requests. */
export interface ChannelOutcome {
  channel: string;
  agent: string;
  tasks: {
    task: number;
    claimedAt?: string;
    releasedAt?: string;
    stepsCompleted: number;
    pr?: number;
    done?: boolean;
  }[];
}

/** A Greenroom run the session started or named, and its verdict. */
export interface GreenroomOutcome {
  runId: string;
  relation: "created" | "mentioned";
  name?: string;
  verdict?: string;
  outcome?: string;
  summary?: string;
}

/** One session's outcomes: `sessions/<cli>/<id>/outcome.json`, and a line of `outcomes.jsonl`. */
export interface DatasetOutcome {
  schema: typeof DATASET_SCHEMA;
  session: string;
  cli: DatasetCli;
  linkedAt: string;
  repo?: string;
  branches: string[];
  /** Commits the session made, from `git commit`'s own output. */
  commits: { sha: string; branch?: string; message?: string }[];
  prs: PullRequestOutcome[];
  switchboard?: ChannelOutcome;
  greenroom: GreenroomOutcome[];
  corrections: number;
  /** What could not be linked, and why, so a gap is never mistaken for "no outcome". */
  unlinked: { what: string; why: string }[];
}

/** `redactions.json`: what every sync's redaction masked, over the whole Dataset. */
export interface RedactionManifest {
  schema: typeof DATASET_SCHEMA;
  sessions: number;
  sessionsWithRedactions: number;
  total: number;
  kinds: RedactionCounts;
}
