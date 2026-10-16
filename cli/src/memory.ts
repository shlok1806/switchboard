// Shared memory on the wrapper's side (ADR 0019).
//
// - The inbox keeps the notes other Agents write, as they arrive on the Channel
//   stream, and hands the next hook that can add to the model's context a digest of
//   those its Agent has not been shown, those on the Tasks it holds and the files it
//   edited first (ADR 0024): it follows both on the same stream. It never waits on the network. Which note
//   the Agent was shown last is kept on this machine, under its Agent ID, so a
//   restarted or resumed session catches up from there (`GET /api/memory?after=`).
// - The nudges remind the model to write notes. They never write one themselves:
//   the Stop hook blocks the stop once when a turn changed files and wrote no note,
//   and asks once for notes when the session nears compaction. A PreCompact hook
//   holds one automatic compaction back while there is still room, so the notes
//   come before it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentContext,
  AgentId,
  AgentSummary,
  ChannelEvent,
  DigestFocus,
  Holder,
  HookEvent,
  MemoryNote,
  MemoryQuery,
  MemoryResponse,
  TaskNumber,
} from "../../shared/src/index";
import { MAX_MEMORY_LIMIT, memoryDigest, memoryQueryString, noteFromEvent } from "../../shared/src/index";
import type { ClaudeHookInput } from "./hooks/summarize";
import { SWITCHBOARD_TOOL } from "./hooks/summarize";

/** The hooks the nudges need besides the captured ones. */
export const MEMORY_HOOKS = ["PreCompact"] as const;

/** The most notes the inbox holds for one digest. More than a digest shows: it counts the rest. */
const MAX_HELD = 200;
/** The most files the inbox weights the digest toward: the ones edited last. */
const MAX_FOCUS_FILES = 50;

export interface MemoryInboxOptions {
  /** Where each Agent's last-shown note is kept: one file per Agent ID. */
  dir: string;
  /** A Channel read as the Agent. */
  read: (path: string) => Promise<MemoryResponse>;
  /** The Agent's own summary (ADR 0024): the Tasks it holds and files it edited, before this run. */
  summary?: (agent: AgentId) => Promise<AgentSummary>;
  log: (line: string) => void;
}

/** One Agent's last-shown note, as kept on disk. */
interface Cursor {
  shown: number;
}

export class MemoryInbox {
  private agent: AgentId | null = null;
  /** The highest note `seq` the Agent was shown, or null when it has never been shown any. */
  private shown: number | null = null;
  /** Notes by others it has not been shown, by `seq`. */
  private readonly held = new Map<number, MemoryNote>();
  /** A catch-up found more notes than it fetched: older ones it will never show. */
  private earlier = false;
  /** The Tasks the Agent holds, which its digest is weighted toward. */
  private readonly tasks = new Set<TaskNumber>();
  /** The files it edited, most recently first. */
  private files: string[] = [];

  constructor(private readonly options: MemoryInboxOptions) {}

  /** The Agent is registered: read where it left off, and catch up on what it missed meanwhile. */
  async registered(agent: AgentId): Promise<void> {
    if (this.agent !== agent) {
      this.agent = agent;
      this.shown = this.readCursor(agent);
      // Notes held before the Agent was known that are its own, or that it was already shown.
      for (const [seq, note] of this.held) if (!this.wanted(note)) this.held.delete(seq);
      await this.seed(agent);
    }
    const newest = Math.max(this.shown ?? 0, ...this.held.keys());
    const query: MemoryQuery = { limit: MAX_MEMORY_LIMIT, ...(newest > 0 ? { after: newest } : {}) };
    try {
      const { notes, more } = await this.options.read(memoryQueryString(query));
      for (const note of notes) this.keep(note);
      if (more === true) this.earlier = true;
    } catch (error) {
      this.options.log(`could not catch up on notes: ${(error as Error).message}`);
    }
  }

  /** What the Agent works on, from what the Channel knew of it before this run. */
  private async seed(agent: AgentId): Promise<void> {
    if (this.options.summary === undefined) return;
    try {
      const { tasks, files } = await this.options.summary(agent);
      this.focus({ tasks: tasks.map((task) => task.number), files });
    } catch (error) {
      this.options.log(`could not read what this Agent works on: ${(error as Error).message}`);
    }
  }

  /**
   * Weights the digest toward these Tasks and files as well: the Agent's own, or those of
   * an Agent whose work it carries on (ADR 0024).
   */
  focus(focus: Partial<DigestFocus>): void {
    for (const task of focus.tasks ?? []) this.tasks.add(task);
    for (const file of [...(focus.files ?? [])].reverse()) this.edited(file);
  }

  /** What the digest is weighted toward now. */
  get currentFocus(): DigestFocus {
    return { tasks: [...this.tasks], files: [...this.files] };
  }

  /**
   * An Event from the Channel stream: kept when it is another Agent's note. The
   * Agent's own Claims and file edits move what its digest is weighted toward.
   */
  event(event: ChannelEvent): void {
    const note = noteFromEvent(event);
    if (note !== null) this.keep(note);
    if (this.agent === null) return;
    const mine = (holder: Holder) => holder.kind === "agent" && holder.agentId === this.agent;
    const task = event.task;
    switch (event.type) {
      case "claim":
        if (task !== undefined && mine(event.payload.holder)) this.tasks.add(task);
        break;
      case "claim.release":
        if (task !== undefined && mine(event.payload.holder)) this.tasks.delete(task);
        break;
      case "takeover":
        if (task === undefined) break;
        if (mine(event.payload.to)) this.tasks.add(task);
        else if (mine(event.payload.from)) this.tasks.delete(task);
        break;
      case "file.edit":
        if (event.actor.kind === "agent" && event.actor.agentId === this.agent) this.edited(event.payload.path);
        break;
    }
  }

  private edited(path: string): void {
    this.files = [path, ...this.files.filter((file) => file !== path)].slice(0, MAX_FOCUS_FILES);
  }

  /** The digest of notes the Agent has not been shown, once; "" when there are none. */
  take(): string {
    if (this.agent === null || this.held.size === 0) return "";
    const notes = [...this.held.values()];
    const earlier = this.earlier;
    this.held.clear();
    this.earlier = false;
    this.shown = Math.max(this.shown ?? 0, ...notes.map((note) => note.seq));
    this.writeCursor(this.agent, this.shown);
    return memoryDigest(notes, undefined, earlier, this.currentFocus);
  }

  private wanted(note: MemoryNote): boolean {
    return note.author !== this.agent && (this.shown === null || note.seq > this.shown);
  }

  private keep(note: MemoryNote): void {
    if (!this.wanted(note)) return;
    this.held.set(note.seq, note);
    if (this.held.size > MAX_HELD) this.held.delete(Math.min(...this.held.keys()));
  }

  private file(agent: AgentId): string {
    return join(this.options.dir, `${encodeURIComponent(agent)}.json`);
  }

  private readCursor(agent: AgentId): number | null {
    try {
      const { shown } = JSON.parse(readFileSync(this.file(agent), "utf8")) as Cursor;
      return Number.isSafeInteger(shown) && shown >= 0 ? shown : null;
    } catch {
      return null;
    }
  }

  private writeCursor(agent: AgentId, shown: number): void {
    try {
      mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.file(agent), JSON.stringify({ shown } satisfies Cursor), { mode: 0o600 });
    } catch (error) {
      this.options.log(`could not keep the last note shown: ${(error as Error).message}`);
    }
  }
}

/** Tokens Claude Code keeps free below its window: room for the summary, and its own buffer. */
const COMPACTION_HEADROOM = 33_000;

/**
 * About where Claude Code compacts a session on its own, in tokens: `window` less the
 * room it keeps for the summary and its buffer, or the share of the window
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE names.
 */
export function compactionPoint(window: number, env: NodeJS.ProcessEnv): number {
  const percent = Number(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  if (Number.isFinite(percent) && percent > 0 && percent <= 100) return Math.floor((window * percent) / 100);
  return Math.max(Math.floor(window / 2), window - COMPACTION_HEADROOM);
}

/** The share of the compaction point past which the Agent is asked for notes. */
export const NEAR_COMPACTION = 0.8;
/** The share of the window past which a compaction is never held back: it may be the hard limit. */
export const HOLD_COMPACTION_BELOW = 0.95;

export const EDIT_NUDGE =
  "[Switchboard] This turn changed files and wrote no memory note. If it decided something, learned a fact, or " +
  "ruled something out that other Agents on this Channel should know, write it now with memory_note: one short " +
  "note each, tagged. If there is nothing worth noting, stop now without writing one.";

export const COMPACTION_NUDGE =
  "[Switchboard] This session is close to compacting its context. Before it does, write a memory_note for each " +
  "decision, fact or dead end that must outlive the compaction, for other Agents and for this session after it. " +
  "Then stop.";

export const COMPACTION_HELD =
  "Switchboard held this compaction back once, so the session can write its notes first. It compacts at the next " +
  "chance.";

/** Whether the Agent was asked for notes before compaction: not yet, due at the next Stop, or asked. */
type CompactionAsk = "not-asked" | "due" | "asked";

export interface MemoryNudgesOptions {
  /** The session's latest context reading, read now (ADR 0012); undefined when unknown. */
  context: () => Promise<AgentContext | undefined>;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Whether to ask before compaction too: false where the CLI's compaction was not checked (ADR 0024). */
  compaction?: boolean;
}

/** The Stop and PreCompact hooks' answers that ask the model for notes (ADR 0019). */
export class MemoryNudges {
  private changed = false;
  private noted = false;
  private compaction: CompactionAsk = "not-asked";
  private held = false;

  constructor(private readonly options: MemoryNudgesOptions) {}

  /** Every hook's input, as it arrives. */
  hook(input: ClaudeHookInput): void {
    const name = input.hook_event_name;
    if (name === "UserPromptSubmit") {
      // A new turn.
      this.changed = false;
      this.noted = false;
    }
    if (name === "PostToolUse" && isNoteTool(input.tool_name)) this.noted = true;
    // Compacted or cleared: the context starts over, and its next compaction is a new one to ask about.
    if (name === "SessionStart" && (input.source === "compact" || input.source === "clear")) {
      this.compaction = "not-asked";
      this.held = false;
    }
  }

  /** The Events the Hook Capture recorded: a `file.edit` means the turn changed files. */
  events(events: readonly HookEvent[]): void {
    if (events.some((event) => event.type === "file.edit")) this.changed = true;
  }

  /** What a Stop or PreCompact hook answers, or null to let it be. */
  async decide(input: ClaudeHookInput): Promise<string | null> {
    if (input.hook_event_name === "Stop") return this.stop(input);
    if (input.hook_event_name === "PreCompact") return this.preCompact(input);
    return null;
  }

  private async stop(input: ClaudeHookInput): Promise<string | null> {
    // Already continuing because of a Stop hook: never block twice in a row.
    if (input.stop_hook_active === true) return null;
    const reasons: string[] = [];
    if (this.changed && !this.noted) reasons.push(EDIT_NUDGE);
    const compaction = this.options.compaction !== false;
    if (
      compaction &&
      (this.compaction === "due" || (this.compaction === "not-asked" && (await this.nearCompaction())))
    ) {
      this.compaction = "asked";
      reasons.push(COMPACTION_NUDGE);
    }
    // Asked once per turn: the model's next stop ends it.
    this.changed = false;
    if (reasons.length === 0) return null;
    this.options.log(`asked for memory notes before stopping (${reasons.length})`);
    return JSON.stringify({ decision: "block", reason: reasons.join("\n\n") });
  }

  private async preCompact(input: ClaudeHookInput): Promise<string | null> {
    // Never a /compact the Person asked for, never twice, never once the Agent was asked.
    if (this.options.compaction === false) return null;
    if (input.trigger !== "auto" || this.held || this.compaction !== "not-asked") return null;
    const context = await this.options.context();
    if (context?.tokens === undefined || context.window === undefined) return null;
    // Near the window, this may be the compaction at the hard limit: blocking it fails the request.
    if (context.tokens >= context.window * HOLD_COMPACTION_BELOW) return null;
    this.held = true;
    this.compaction = "due";
    this.options.log("held an automatic compaction back once, for memory notes");
    return JSON.stringify({ decision: "block", reason: COMPACTION_HELD });
  }

  private async nearCompaction(): Promise<boolean> {
    const context = await this.options.context();
    if (context?.tokens === undefined || context.window === undefined) return false;
    return context.tokens >= compactionPoint(context.window, this.options.env) * NEAR_COMPACTION;
  }
}

function isNoteTool(tool: string | undefined): boolean {
  return tool !== undefined && SWITCHBOARD_TOOL.test(tool) && tool.endsWith("memory_note");
}
