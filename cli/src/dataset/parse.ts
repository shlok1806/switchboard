// Reads one session's files into Dataset Turns (ADR 0054): Claude Code's session file,
// with its subagents and workflow runs, or a Codex rollout. Every string is redacted as
// it is read, with the Transcript Read's redactor (ADR 0019), so nothing unredacted is
// ever held in a Turn. Alongside the Turns it gathers what links the session to its
// outcomes: pull requests, commits, Greenroom runs and whether it used Switchboard.

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { redactCleaned } from "../transcript";
import {
  type Correction,
  DATASET_SCHEMA,
  type DatasetThread,
  type DatasetTurn,
  type DatasetWorkflow,
  type RedactionCounts,
  type TokenCounts,
  type TurnPart,
} from "./schema";

/** The most characters one part keeps; a longer one is cut, saying how long it was. */
export const MAX_PART_CHARS = 64_000;

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (typeof value === "object" && value !== null ? (value as Json) : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** What a session's files say beyond its Turns, for linking its outcomes. */
export interface SessionRefs {
  /** Pull requests the CLI itself recorded (Claude Code's `pr-link`), or that `gh pr create` printed. */
  prs: { repo: string; number: number; url: string; via: "cli" | "tool-output" }[];
  /** `git commit`'s own lines: `[branch sha] message`. */
  commits: { sha: string; branch?: string; message: string }[];
  /** Greenroom run IDs: created when a `machine_create` call answered with it. */
  runs: Map<string, "created" | "mentioned">;
  /** Whether the session called Switchboard's tools or was told things by its wrapper. */
  usedSwitchboard: boolean;
  /** Codex subagent threads this session started. */
  children: string[];
  /** The GitHub repo the CLI recorded for the session's checkout, when it did. */
  repoUrl?: string;
}

/** One parsed session, ready to write. */
export interface ParsedSession {
  id: string;
  account: string | null;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  cwds: string[];
  gitBranches: string[];
  models: string[];
  threads: DatasetThread[];
  workflows: DatasetWorkflow[];
  turns: DatasetTurn[];
  tokens: TokenCounts;
  redactions: RedactionCounts;
  correctionKinds: Record<string, number>;
  refs: SessionRefs;
}

/** A Greenroom run ID: `20261107-020458-930abba92641e91f`. */
const RUN_ID = /\b(\d{8}-\d{6}-[0-9a-f]{16})\b/g;
/** A pull request's URL. */
const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
/** `git commit`'s summary line: `[main 1a2b3c4] Message` or `[topic (root-commit) 1a2b3c4] Message`. */
const COMMIT_LINE = /^\[([^\s\]]+)(?: \([a-z-]+\))? ([0-9a-f]{7,40})\] (.+)$/gm;
/** The same, as rtk's git wrapper prints it: `1a2b3c4d Message`. */
const SHORT_COMMIT_LINE = /^([0-9a-f]{7,40}) (\S.*)$/gm;
/** Where Claude Code says it put a tool's output that was too long to show. */
const SAVED_OUTPUT = /saved to: (\S+\/tool-results\/[^\s"'\\]+)/;

const REJECTED = "The user doesn't want to proceed with this tool use";
const INTERRUPTED = "[Request interrupted by user";

/**
 * Typed prompts that reject or redirect work, by how they start or what they say near
 * the start. A heuristic, named in each Correction's `cue`, so a reader can weigh it.
 */
const REDIRECT_STARTS: [RegExp, string][] = [
  [/^(no|nope|nah)\b(?![-'])/i, "starts:no"],
  [/^(stop|wait|hold on|hang on)\b/i, "starts:stop"],
  [/^(don'?t|do not|never)\b/i, "starts:dont"],
  [/^(revert|undo|roll back)\b/i, "starts:revert"],
  [/^(that'?s|this is|it'?s) (not|wrong)\b/i, "starts:not-right"],
  [/^actually\b/i, "starts:actually"],
];
const REDIRECT_PHRASES: [RegExp, string][] = [
  [/\bnot what i (asked|meant|wanted|said)\b/i, "says:not-what-i-asked"],
  [/\bi (said|told you|asked you)\b/i, "says:i-said"],
  [/\byou (shouldn'?t|should not|should have|didn'?t|forgot|missed|broke|ignored)\b/i, "says:you-should"],
  [/\bwhy (did|are|would|do) you\b/i, "says:why-did-you"],
  [/\b(that'?s|this is|it'?s) (wrong|incorrect|broken)\b/i, "says:wrong"],
];

/** The Correction a typed prompt is, if any, by REDIRECT_STARTS and REDIRECT_PHRASES. */
export function redirectCue(prompt: string): string | null {
  const text = prompt.trim();
  for (const [pattern, cue] of REDIRECT_STARTS) if (pattern.test(text)) return cue;
  const head = text.slice(0, 300);
  for (const [pattern, cue] of REDIRECT_PHRASES) if (pattern.test(head)) return cue;
  return null;
}

/** Builds Turns for one session, redacting as it goes, and counts what it masked. */
class SessionBuilder {
  readonly turns: DatasetTurn[] = [];
  readonly redactions: RedactionCounts = {};
  readonly correctionKinds: Record<string, number> = {};
  readonly tokens: TokenCounts = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  readonly refs: SessionRefs = { prs: [], commits: [], runs: new Map(), usedSwitchboard: false, children: [] };
  readonly cwds = new Set<string>();
  readonly branches = new Set<string>();
  readonly models = new Set<string>();
  account: string | null = null;
  title: string | undefined;
  startedAt: string | undefined;
  endedAt: string | undefined;

  constructor(readonly session: string) {}

  /** `text`, redacted and cut, with what it masked counted. */
  redact(text: string): { text: string; truncatedFrom?: number } {
    const { text: masked, kinds } = redactCleaned(text);
    for (const [kind, n] of Object.entries(kinds)) this.redactions[kind] = (this.redactions[kind] ?? 0) + n;
    if (masked.length <= MAX_PART_CHARS) return { text: masked };
    return { text: `${masked.slice(0, MAX_PART_CHARS)}…`, truncatedFrom: masked.length };
  }

  seen(at: string | undefined): void {
    if (at === undefined || at === "") return;
    if (this.startedAt === undefined || at < this.startedAt) this.startedAt = at;
    if (this.endedAt === undefined || at > this.endedAt) this.endedAt = at;
  }

  push(turn: Omit<DatasetTurn, "schema" | "session" | "n">): DatasetTurn {
    const full: DatasetTurn = { schema: DATASET_SCHEMA, session: this.session, n: this.turns.length, ...turn };
    this.turns.push(full);
    if (turn.correction) {
      this.correctionKinds[turn.correction.kind] = (this.correctionKinds[turn.correction.kind] ?? 0) + 1;
    }
    return full;
  }

  /** Reads links out of a tool call's input and its result, before either is redacted. */
  scanTool(name: string, input: string, result: string | null): void {
    if (name.startsWith("mcp__switchboard__") || name.startsWith("switchboard__")) this.refs.usedSwitchboard = true;
    const created = /machine_create$/.test(name);
    for (const text of [input, result ?? ""]) {
      for (const [, id] of text.matchAll(RUN_ID)) {
        if (id === undefined) continue;
        if (created && text === result) this.refs.runs.set(id, "created");
        else if (!this.refs.runs.has(id)) this.refs.runs.set(id, "mentioned");
      }
    }
    if (result === null) return;
    if (/\bgh\s+pr\s+create\b/.test(input)) {
      for (const [url, repo, number] of result.matchAll(PR_URL)) {
        if (repo && number) this.refs.prs.push({ repo, number: Number(number), url, via: "tool-output" });
      }
    }
    if (/\bgit\b[^\n]*\bcommit\b/.test(input)) {
      const add = (sha: string, message: string, branch?: string) => {
        if (this.refs.commits.some((c) => c.sha.startsWith(sha) || sha.startsWith(c.sha))) return;
        this.refs.commits.push({ sha, ...(branch === undefined ? {} : { branch }), message: message.slice(0, 200) });
      };
      let full = false;
      for (const [, branch, sha, message] of result.matchAll(COMMIT_LINE)) {
        if (branch && sha && message) {
          add(sha, message, branch);
          full = true;
        }
      }
      if (!full)
        for (const [, sha, message] of result.matchAll(SHORT_COMMIT_LINE)) if (sha && message) add(sha, message);
    }
  }

  /** Notes the wrapper's own framing, which says the session ran on a Channel. */
  scanText(text: string): void {
    if (!this.refs.usedSwitchboard && text.includes("[Switchboard]")) this.refs.usedSwitchboard = true;
  }
}

/** Reads a JSONL file a line at a time; a line that is not JSON (one still being written) is skipped. */
async function* jsonLines(path: string): AsyncGenerator<Json> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    try {
      yield obj(JSON.parse(line));
    } catch {
      // A partial line.
    }
  }
}

/** The text of a tool result's content: a string, or its text parts. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = obj(part);
      return p.type === "text" || p.type === "input_text" || p.type === "output_text" ? str(p.text) : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

/** Whether a Claude Code user entry is what the Person typed, not what the CLI or a hook put there. */
function typedByPerson(entry: Json, text: string): boolean {
  if (entry.isMeta === true || entry.isCompactSummary === true) return false;
  const origin = obj(entry.origin);
  if (typeof origin.kind === "string") return origin.kind === "human";
  // Older sessions carry no origin: anything the CLI wraps in a tag is not typed.
  return !text.trimStart().startsWith("<") && !text.startsWith(INTERRUPTED) && !text.startsWith("Caveat:");
}

/** A tool result's whole text: Claude Code's saved file when it kept the output there. */
async function fullResult(text: string, sessionDir: string): Promise<string> {
  const saved = SAVED_OUTPUT.exec(text)?.[1];
  if (saved === undefined || !saved.startsWith(join(sessionDir, "tool-results"))) return text;
  try {
    const file = await readFile(saved, "utf8");
    return file.length > text.length ? file : text;
  } catch {
    return text;
  }
}

/** Reads one Claude Code transcript file (the main one, a subagent's or a workflow agent's) into `b`. */
async function readClaudeThread(b: SessionBuilder, path: string, thread: string, sessionDir: string): Promise<number> {
  const before = b.turns.length;
  /** The tool calls whose results have not come yet: their name and input, for `scanTool`. */
  const calls = new Map<string, { name: string; input: string }>();
  let assistant: { turn: DatasetTurn; id: string; usage: TokenCounts } | null = null;
  let workedSincePrompt = false;
  const settle = () => {
    if (assistant === null) return;
    b.tokens.input += assistant.usage.input;
    b.tokens.output += assistant.usage.output;
    b.tokens.cacheCreation += assistant.usage.cacheCreation;
    b.tokens.cacheRead += assistant.usage.cacheRead;
    assistant.turn.tokens = { ...assistant.usage };
    assistant = null;
  };
  for await (const e of jsonLines(path)) {
    const at = str(e.timestamp) || undefined;
    if (e.type === "session-owner" && typeof e.accountUuid === "string") b.account = e.accountUuid;
    if (e.type === "ai-title" && typeof e.aiTitle === "string") b.title = e.aiTitle;
    if (e.type === "pr-link" && typeof e.prNumber === "number" && typeof e.prRepository === "string") {
      b.refs.prs.push({ repo: e.prRepository, number: e.prNumber, url: str(e.prUrl), via: "cli" });
    }
    if (e.type !== "user" && e.type !== "assistant" && e.type !== "system") continue;
    b.seen(at);
    if (typeof e.cwd === "string" && e.cwd !== "") b.cwds.add(e.cwd);
    if (typeof e.gitBranch === "string" && e.gitBranch !== "" && e.gitBranch !== "HEAD") b.branches.add(e.gitBranch);
    const where = e.isSidechain === true && thread === "main" ? "sidechain" : thread;
    const message = obj(e.message);
    if (e.type === "system") {
      if (e.subtype === "compact_boundary") {
        settle();
        const trigger = str(obj(e.compactMetadata).trigger) || "auto";
        b.push({
          thread: where,
          at,
          role: "system",
          kind: "compaction",
          parts: [{ type: "text", text: `Context compacted (${trigger})` }],
        });
      }
      continue;
    }
    if (e.type === "assistant") {
      const id = str(message.id) || `${b.turns.length}`;
      if (assistant === null || assistant.id !== id || assistant.turn.thread !== where) {
        settle();
        const model = str(message.model) || undefined;
        if (model !== undefined && model !== "<synthetic>") b.models.add(model);
        const turn = b.push({
          thread: where,
          at,
          role: "assistant",
          kind: "message",
          parts: [],
          ...(model ? { model } : {}),
        });
        assistant = { turn, id, usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 } };
      }
      const usage = obj(message.usage);
      const most = (field: keyof TokenCounts, value: unknown) => {
        if (assistant && typeof value === "number") assistant.usage[field] = Math.max(assistant.usage[field], value);
      };
      most("input", usage.input_tokens);
      most("output", usage.output_tokens);
      most("cacheCreation", usage.cache_creation_input_tokens);
      most("cacheRead", usage.cache_read_input_tokens);
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const p = obj(part);
        if (p.type === "text" && str(p.text).trim() !== "") {
          b.scanText(str(p.text));
          assistant.turn.parts.push({ type: "text", text: b.redact(str(p.text)).text });
        } else if (p.type === "thinking" && str(p.thinking).trim() !== "") {
          assistant.turn.parts.push({ type: "thinking", text: b.redact(str(p.thinking)).text });
        } else if (p.type === "tool_use") {
          const input = JSON.stringify(p.input ?? {});
          calls.set(str(p.id), { name: str(p.name), input });
          b.scanTool(str(p.name), input, null);
          assistant.turn.parts.push({
            type: "tool_use",
            id: str(p.id),
            name: str(p.name),
            input: b.redact(input).text,
          });
        }
      }
      workedSincePrompt = true;
      continue;
    }
    // A user entry: what the Person typed, what the CLI put there, or tool results.
    settle();
    const content = message.content;
    const texts: string[] = [];
    const results: TurnPart[] = [];
    let correction: Correction | undefined;
    let images = 0;
    if (typeof content === "string") texts.push(content);
    for (const part of Array.isArray(content) ? content : []) {
      const p = obj(part);
      if (p.type === "text") texts.push(str(p.text));
      if (p.type === "image") images++;
      if (p.type === "tool_result") {
        const raw = await fullResult(resultText(p.content), sessionDir);
        const call = calls.get(str(p.tool_use_id));
        if (call) {
          b.scanTool(call.name, call.input, raw);
          calls.delete(str(p.tool_use_id));
        }
        if (raw.includes(REJECTED)) correction = { kind: "rejected-tool", cue: "cli:rejected" };
        else if (raw.startsWith(INTERRUPTED)) correction = { kind: "interrupted", cue: "cli:interrupted" };
        const { text, truncatedFrom } = b.redact(raw);
        results.push({
          type: "tool_result",
          toolUseId: str(p.tool_use_id),
          text,
          ...(p.is_error === true ? { isError: true as const } : {}),
          ...(truncatedFrom === undefined ? {} : { truncatedFrom }),
        });
      }
    }
    if (results.length > 0)
      b.push({
        thread: where,
        at,
        role: "tool",
        kind: "result",
        parts: results,
        ...(correction ? { correction } : {}),
      });
    const said = texts.join("\n");
    if (said.trim() === "" && images === 0) continue;
    b.scanText(said);
    const typed = typedByPerson(e, said);
    let promptCorrection: Correction | undefined;
    if (said.startsWith(INTERRUPTED)) promptCorrection = { kind: "interrupted", cue: "cli:interrupted" };
    else if (typed && workedSincePrompt) {
      const cue = redirectCue(said);
      if (cue !== null) promptCorrection = { kind: "redirect", cue };
    }
    const parts: TurnPart[] = [];
    if (said.trim() !== "") parts.push({ type: "text", text: b.redact(said).text });
    for (let i = 0; i < images; i++) parts.push({ type: "image" });
    b.push({
      thread: where,
      at,
      role: "user",
      kind: typed ? "prompt" : "context",
      parts,
      ...(promptCorrection ? { correction: promptCorrection } : {}),
    });
    if (typed) workedSincePrompt = false;
  }
  settle();
  return b.turns.length - before;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function list(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function readJson(path: string): Promise<Json> {
  try {
    return obj(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return {};
  }
}

/** The files a Claude Code session is made of, for its fingerprint: its file, then its subagents' and workflows'. */
export async function claudeSessionFiles(file: string): Promise<string[]> {
  const dir = file.replace(/\.jsonl$/, "");
  const files = [file];
  const subagents = join(dir, "subagents");
  for (const name of await list(subagents)) if (/\.(jsonl|meta\.json)$/.test(name)) files.push(join(subagents, name));
  const runs = join(subagents, "workflows");
  for (const run of await list(runs)) {
    for (const name of await list(join(runs, run))) if (/\.(jsonl|json)$/.test(name)) files.push(join(runs, run, name));
  }
  for (const name of await list(join(dir, "workflows")))
    if (name.endsWith(".json")) files.push(join(dir, "workflows", name));
  return files;
}

/** Reads a Claude Code session, its subagents and its workflow runs. */
export async function parseClaudeSession(file: string): Promise<ParsedSession> {
  const id = basename(file, ".jsonl");
  const dir = file.replace(/\.jsonl$/, "");
  const b = new SessionBuilder(id);
  const threads: DatasetThread[] = [{ id: "main", kind: "main", turns: await readClaudeThread(b, file, "main", dir) }];
  const sidechain = b.turns.filter((t) => t.thread === "sidechain").length;
  if (sidechain > 0) {
    (threads[0] as DatasetThread).turns -= sidechain;
    threads.push({
      id: "sidechain",
      kind: "subagent",
      description: "Subagent turns kept in the main file by older Claude Code",
      turns: sidechain,
    });
  }
  const agentThread = async (path: string, threadId: string, kind: DatasetThread["kind"], workflowRun?: string) => {
    const meta = await readJson(path.replace(/\.jsonl$/, ".meta.json"));
    const turns = await readClaudeThread(b, path, threadId, dir);
    threads.push({
      id: threadId,
      kind,
      ...(typeof meta.agentType === "string" ? { agentType: meta.agentType } : {}),
      ...(typeof meta.description === "string" ? { description: b.redact(meta.description).text } : {}),
      ...(workflowRun === undefined ? {} : { workflowRun }),
      turns,
    });
  };
  const subagents = join(dir, "subagents");
  for (const name of await list(subagents)) {
    const agent = /^agent-(.+)\.jsonl$/.exec(name)?.[1];
    if (agent !== undefined) await agentThread(join(subagents, name), `subagent:${agent}`, "subagent");
  }
  const workflows: DatasetWorkflow[] = [];
  const runs = join(subagents, "workflows");
  for (const runId of await list(runs)) {
    const runDir = join(runs, runId);
    const agents: string[] = [];
    for (const name of await list(runDir)) {
      const agent = /^agent-(.+)\.jsonl$/.exec(name)?.[1];
      if (agent === undefined) continue;
      const threadId = `workflow:${runId}/${agent}`;
      await agentThread(join(runDir, name), threadId, "workflow-agent", runId);
      agents.push(threadId);
    }
    let journalEntries = 0;
    const journal = join(runDir, "journal.jsonl");
    if (await exists(journal)) {
      for await (const entry of jsonLines(journal)) {
        b.push({
          thread: `workflow:${runId}`,
          role: "system",
          kind: "workflow",
          parts: [{ type: "text", text: b.redact(JSON.stringify(entry)).text }],
        });
        journalEntries++;
      }
    }
    const script = await readJson(join(dir, "workflows", `${runId}.json`));
    const name = /\bname:\s*['"]([^'"\n]{1,120})['"]/.exec(str(script.script))?.[1];
    workflows.push({ runId, ...(name === undefined ? {} : { name }), agents, journalEntries });
  }
  return finish(b, threads, workflows);
}

function finish(b: SessionBuilder, threads: DatasetThread[], workflows: DatasetWorkflow[]): ParsedSession {
  return {
    id: b.session,
    account: b.account,
    ...(b.title === undefined ? {} : { title: b.redact(b.title).text }),
    ...(b.startedAt === undefined ? {} : { startedAt: b.startedAt }),
    ...(b.endedAt === undefined ? {} : { endedAt: b.endedAt }),
    cwds: [...b.cwds],
    gitBranches: [...b.branches],
    models: [...b.models],
    threads,
    workflows,
    turns: b.turns,
    tokens: b.tokens,
    redactions: b.redactions,
    correctionKinds: b.correctionKinds,
    refs: b.refs,
  };
}

/** The Codex session ID a rollout file is named after: `rollout-<time>-<uuid>.jsonl`. */
export function codexSessionId(file: string): string {
  return (
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file)?.[1] ??
    basename(file, ".jsonl")
  );
}

/** Text Codex puts in the user's place: its environment, the AGENTS.md it read, pasted instructions. */
function codexContext(text: string): boolean {
  const start = text.trimStart();
  return start.startsWith("<") || start.startsWith("# AGENTS.md");
}

/** Reads a Codex rollout file. */
export async function parseCodexSession(file: string): Promise<ParsedSession> {
  const b = new SessionBuilder(codexSessionId(file));
  const calls = new Map<string, { name: string; input: string }>();
  let assistant: DatasetTurn | null = null;
  let workedSincePrompt = false;
  let total: Json | null = null;
  const reply = (at: string | undefined): DatasetTurn => {
    if (assistant === null) assistant = b.push({ thread: "main", at, role: "assistant", kind: "message", parts: [] });
    return assistant;
  };
  for await (const e of jsonLines(file)) {
    const at = str(e.timestamp) || undefined;
    const p = obj(e.payload);
    if (e.type === "session_meta") {
      if (typeof p.creator_account_id === "string") b.account = p.creator_account_id;
      if (typeof p.cwd === "string" && p.cwd !== "") b.cwds.add(p.cwd);
      const git = obj(p.git);
      if (typeof git.branch === "string" && git.branch !== "") b.branches.add(git.branch);
      if (typeof git.repository_url === "string") b.refs.repoUrl = git.repository_url;
      continue;
    }
    if (e.type === "turn_context") {
      if (typeof p.cwd === "string" && p.cwd !== "") b.cwds.add(p.cwd);
      if (typeof p.model === "string") b.models.add(p.model);
      continue;
    }
    b.seen(at);
    if (e.type === "event_msg" && p.type === "token_count") {
      const info = obj(p.info);
      if (info.total_token_usage !== undefined) total = obj(info.total_token_usage);
      continue;
    }
    if (e.type === "event_msg" && p.type === "turn_aborted" && p.reason === "interrupted") {
      assistant = null;
      b.push({
        thread: "main",
        at,
        role: "user",
        kind: "context",
        parts: [{ type: "text", text: "[turn interrupted]" }],
        correction: { kind: "interrupted", cue: "cli:interrupted" },
      });
      continue;
    }
    if (e.type === "event_msg" && p.type === "item_completed") {
      const item = obj(p.item);
      if (item.type === "SubAgentActivity" && item.kind === "started" && typeof item.agent_thread_id === "string") {
        b.refs.children.push(item.agent_thread_id);
      }
      continue;
    }
    if (e.type === "compacted" || (e.type === "event_msg" && p.type === "context_compacted")) {
      assistant = null;
      b.push({
        thread: "main",
        at,
        role: "system",
        kind: "compaction",
        parts: [{ type: "text", text: "Context compacted" }],
      });
      continue;
    }
    if (e.type !== "response_item") continue;
    if (p.type === "message" && p.role === "user") {
      assistant = null;
      const said = resultText(p.content);
      if (said.trim() === "") continue;
      b.scanText(said);
      const typed = !codexContext(said);
      const cue = typed && workedSincePrompt ? redirectCue(said) : null;
      b.push({
        thread: "main",
        at,
        role: "user",
        kind: typed ? "prompt" : "context",
        parts: [{ type: "text", text: b.redact(said).text }],
        ...(cue === null ? {} : { correction: { kind: "redirect", cue } }),
      });
      if (typed) workedSincePrompt = false;
    } else if (p.type === "message" && p.role === "assistant") {
      const said = resultText(p.content);
      if (said.trim() === "") continue;
      b.scanText(said);
      reply(at).parts.push({ type: "text", text: b.redact(said).text });
      workedSincePrompt = true;
    } else if (p.type === "reasoning") {
      const summary = (Array.isArray(p.summary) ? p.summary : []).map((s) => str(obj(s).text)).join("\n");
      if (summary.trim() !== "") reply(at).parts.push({ type: "thinking", text: b.redact(summary).text });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const name = [str(p.namespace), str(p.name)].filter((s) => s !== "").join("__");
      const input =
        typeof p.arguments === "string"
          ? p.arguments
          : typeof p.input === "string"
            ? p.input
            : JSON.stringify(p.arguments ?? p.input ?? {});
      calls.set(str(p.call_id), { name, input });
      b.scanTool(name, input, null);
      reply(at).parts.push({ type: "tool_use", id: str(p.call_id), name, input: b.redact(input).text });
      workedSincePrompt = true;
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      assistant = null;
      const raw = typeof p.output === "string" ? p.output : resultText(obj(p.output).content ?? p.output);
      const call = calls.get(str(p.call_id));
      if (call) b.scanTool(call.name, call.input, raw);
      const { text, truncatedFrom } = b.redact(raw);
      b.push({
        thread: "main",
        at,
        role: "tool",
        kind: "result",
        parts: [
          {
            type: "tool_result",
            toolUseId: str(p.call_id),
            text,
            ...(truncatedFrom === undefined ? {} : { truncatedFrom }),
          },
        ],
      });
    }
  }
  if (total !== null) {
    const num = (value: unknown) => (typeof value === "number" ? value : 0);
    const cached = num(total.cached_input_tokens);
    b.tokens.input = Math.max(0, num(total.input_tokens) - cached);
    b.tokens.cacheRead = cached;
    b.tokens.output = num(total.output_tokens);
  }
  const turns = b.turns.length;
  return finish(b, [{ id: "main", kind: "main", turns }], []);
}
