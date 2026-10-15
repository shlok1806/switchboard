// The Hook Capture on the wrapper side. It installs Claude Code hooks for the
// wrapped session only, receives what they report on a local socket, turns it
// into small Hook Events and sends them to the Channel over the wrapper's
// WebSocket.
//
// Hooks never wait on the network: each hook runs `switchboard-hook.js`, which
// hands its input to this socket and exits. Sending happens here, afterwards.
// The socket answers each hook at once, from what the wrapper already holds: for
// the hooks whose output Claude Code adds to the model's context (SessionStart,
// UserPromptSubmit), that is what the Agent must be told at its next turn, such as
// a Claim it lost while it was away. Every other hook gets an empty answer. One
// exception waits: Claude Code's PermissionRequest is held until its prompt is denied
// from the Channel or closes (`hold`, ADR 0014), and never waits on the network either.
// Events wait while the WebSocket is down or the Agent is not registered yet, and
// every message is sent again on reconnect until the Channel acknowledges it.
// Event IDs make that safe: the Channel records each Event once.

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, HookCaptureMessage, HookCaptureReply, HookEvent } from "../../../shared/src/index";
import { MAX_HOOK_EVENTS_PER_MESSAGE, MAX_HOOK_TEXT_LENGTH, truncate } from "../../../shared/src/index";
import { DIALOG_HOOKS, DIALOG_TOOLS } from "../interrupts";
import { MEMORY_HOOKS } from "../memory";
import { CONTEXT_HOOKS } from "../next-turn";
import type { SessionSettings } from "../session-settings";
import { ShellEdits, shellCallKey, shellDir } from "./shell-edits";
import { CAPTURED_HOOKS, type ClaudeHookInput, type HookEventDraft, HookSummarizer } from "./summarize";

/** The most unacknowledged messages kept while the Channel cannot be reached. Oldest go first. */
const MAX_PENDING = 1000;
/** What ends a held hook's input (`switchboard-hook.js --hold`); JSON text never holds a NUL byte. */
const END_OF_INPUT = 0x00;
/** What a held hook sends once it has printed its answer. */
const ACK = 0x06;

/** A hook the wrapper holds (ADR 0014), until it answers it or the hook ends first. */
export interface HeldHook {
  /** Aborted when the hook ended before it was answered: it gave up, or its CLI killed it. */
  readonly gone: AbortSignal;
  /**
   * Answers the hook with `text`, once. Resolves true when the hook printed it for its
   * CLI, false when it ended first or did not say it did.
   */
  answer(text: string): Promise<boolean>;
}

/** One hook connection's side of a hold. Inert for a hook nothing holds. */
class HeldConnection implements HeldHook {
  private readonly lapse = new AbortController();
  readonly gone = this.lapse.signal;
  /** What the hook is answered with. */
  readonly text: Promise<string>;
  private give: (text: string) => void = () => {};
  private given = false;
  private acked = false;
  private settle: (printed: boolean) => void = () => {};
  private readonly printed = new Promise<boolean>((resolve) => {
    this.settle = resolve;
  });

  constructor() {
    this.text = new Promise((give) => {
      this.give = give;
    });
  }

  answer(text: string): Promise<boolean> {
    if (this.gone.aborted || this.given) return Promise.resolve(false);
    this.given = true;
    this.give(text);
    return this.printed;
  }

  /** The hook sent ACK: it printed the answer. */
  acknowledged(): void {
    this.acked = true;
  }

  /** The hook's side closed, or the whole connection. */
  ended(): void {
    if (!this.given) {
      // Nobody answered it: whoever holds it hears it is gone, and the connection closes with no answer.
      this.lapse.abort();
      this.give("");
    }
    this.settle(this.acked);
  }
}

/** The largest hook input read from a hook, in bytes. A Write's input holds the whole file. */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

/** How long Claude Code lets the held PermissionRequest hook run, in seconds (ADR 0014). */
export const HELD_HOOK_TIMEOUT_SECONDS = 600;

/** Where a hook finds the wrapper's socket when its command does not name it. */
export const HOOK_SOCKET_ENV = "SWITCHBOARD_HOOK_SOCKET";

/** The hook script, built next to the wrapper's own bundle. */
export function hookScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "switchboard-hook.js");
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export interface HookCaptureOptions {
  /** A private directory for the socket. */
  dir: string;
  /** The repo root: edited paths are sent relative to it. */
  root: string;
  /** Sends a text frame on the Channel WebSocket; false when it is not open. */
  send: (frame: string) => boolean;
  log: (line: string) => void;
  /** Called with the session ID each hook reports. */
  onSessionId?: (sessionId: string) => void;
  /**
   * What a hook prints back into the agent CLI, by hook name. Claude Code adds a
   * SessionStart or UserPromptSubmit hook's output to the model's context.
   */
  context?: (hook: string | undefined) => string;
  /** Called with every hook's input, before it is answered. The Interrupt typer watches them. */
  onHook?: (input: ClaudeHookInput) => void;
  /**
   * Turns another CLI's hook input into Claude Code's shape (hook and tool names,
   * fields), so everything after it reads one shape. Claude Code's needs none.
   */
  translate?: (raw: Record<string, unknown>) => ClaudeHookInput | ClaudeHookInput[];
  /**
   * Holds a hook's answer: when it returns true, the hook is answered whenever
   * `hook.answer` is called. Claude Code's PermissionRequest, which the wrapper
   * answers with a deny from the Channel or with nothing (ADR 0014).
   */
  hold?: (input: ClaudeHookInput, hook: HeldHook) => boolean;
  /**
   * A hook's whole answer, printed as is, or null to answer as usual. The memory
   * nudges block a Stop or a PreCompact this way (ADR 0019). Reads only this machine.
   */
  decide?: (input: ClaudeHookInput) => Promise<string | null>;
  /** Called with the Hook Events each hook made, as they are recorded. */
  onEvents?: (events: readonly HookEvent[]) => void;
  /** Wraps the text for a hook's answer the way the agent CLI reads it. Plain text by default. */
  answer?: (hook: string | undefined, text: string) => string;
  /** The hook command's program and script. Defaults to this Node and the built hook script. */
  node?: string;
  script?: string;
}

type Pending = { ids: Set<string>; events: HookEvent[] };

export class HookCapture {
  readonly socketPath: string;
  private readonly summarizer: HookSummarizer;
  private readonly shellEdits: ShellEdits;
  private readonly server: Server;
  private agent: AgentId | null = null;
  /** Events not yet sent because the Agent is not registered. */
  private unsent: HookEvent[] = [];
  /** Messages sent (or waiting to be) that the Channel has not acknowledged, oldest first. */
  private readonly pending = new Map<string, Pending>();
  private readingHooks = 0;
  private readonly idleWaiters = new Set<() => void>();

  private constructor(private readonly options: HookCaptureOptions) {
    this.socketPath = join(options.dir, "hook.sock");
    this.summarizer = new HookSummarizer(options.root);
    this.shellEdits = new ShellEdits(options.log);
    // Half-open: the hook has finished writing, and waits for the answer, which may take a moment.
    this.server = createServer({ allowHalfOpen: true }, (conn) => {
      this.readingHooks += 1;
      const chunks: Buffer[] = [];
      let size = 0;
      let read = false;
      // Set once the hook sent its whole input: it closed its side, or (a held hook) sent END_OF_INPUT.
      let complete = false;
      const held = new HeldConnection();
      // Reads the hook's whole input once, and gives the answer for it.
      const finish = async (): Promise<string> => {
        if (read) return "";
        read = true;
        if (size <= MAX_INPUT_BYTES) return this.receive(Buffer.concat(chunks).toString("utf8"), held);
        this.options.log(`hook input over ${MAX_INPUT_BYTES} bytes dropped`);
        return "";
      };
      // Answer, then close our side.
      const respond = () => {
        complete = true;
        void finish().then((answer) => conn.end(answer));
      };
      conn.on("data", (chunk: Buffer) => {
        if (complete) {
          if (chunk.includes(ACK)) held.acknowledged();
          return;
        }
        const end = chunk.indexOf(END_OF_INPUT);
        const part = end === -1 ? chunk : chunk.subarray(0, end);
        size += part.length;
        if (size <= MAX_INPUT_BYTES) chunks.push(part);
        if (end !== -1) respond();
      });
      conn.on("error", () => {});
      // A hook closes its side once it sent everything. A held hook closes it only at
      // its end: after its ACK, or when it gave up or was killed before an answer.
      conn.on("end", () => {
        if (complete) held.ended();
        else respond();
      });
      conn.on("close", () => {
        held.ended();
        void finish().finally(() => {
          this.readingHooks -= 1;
          this.checkIdle();
        });
      });
    });
  }

  /** Starts listening on the local socket. */
  static async start(options: HookCaptureOptions): Promise<HookCapture> {
    const capture = new HookCapture(options);
    await new Promise<void>((resolve, reject) => {
      capture.server.once("error", reject);
      capture.server.listen(capture.socketPath, () => resolve());
    });
    return capture;
  }

  /**
   * The shell command every hook runs. With `socketInEnv` the socket path is left
   * out, and the hook reads it from `HOOK_SOCKET_ENV` instead: the command then stays
   * the same from session to session, which a CLI that trusts hooks by their command
   * (Codex) needs so the Person trusts it once.
   */
  command(socketInEnv = false): string {
    const node = this.options.node ?? process.execPath;
    const script = this.options.script ?? hookScriptPath();
    return [node, script, ...(socketInEnv ? [] : [this.socketPath])].map(shellQuote).join(" ");
  }

  /** The Claude Code settings that install the hooks for this session. */
  settings(): SessionSettings {
    const hook = { type: "command" as const, command: this.command(), timeout: 10 };
    // Claude Code shows its dialog while this one runs: it waits for the wrapper's answer (ADR 0014).
    const held = {
      type: "command" as const,
      command: `${this.command()} --hold`,
      timeout: HELD_HOOK_TIMEOUT_SECONDS,
    };
    const names = [...new Set<string>([...CAPTURED_HOOKS, ...CONTEXT_HOOKS, ...DIALOG_HOOKS, ...MEMORY_HOOKS])];
    // PreToolUse: the dialog tools, and the shell, whose changes are worked out around it.
    const matchers: Record<string, string> = { PostToolUse: "*", PreToolUse: [...DIALOG_TOOLS, "Bash"].join("|") };
    return {
      hooks: Object.fromEntries(
        names.map((name) => {
          const matcher = matchers[name];
          const hooks = [name === "PermissionRequest" ? held : hook];
          return [name, [matcher === undefined ? { hooks } : { matcher, hooks }]];
        }),
      ),
    };
  }

  /** The Agent is registered: send what it has done so far, and everything from now on. */
  setAgent(id: AgentId): void {
    this.agent = id;
    const waiting = this.unsent;
    this.unsent = [];
    for (let i = 0; i < waiting.length; i += MAX_HOOK_EVENTS_PER_MESSAGE) {
      this.enqueue(waiting.slice(i, i + MAX_HOOK_EVENTS_PER_MESSAGE));
    }
  }

  /** The WebSocket (re)connected: send every message the Channel has not acknowledged. */
  connected(): void {
    for (const message of this.pending.values()) this.transmit(message);
  }

  /** A reply from the Channel to one of our messages. */
  reply(reply: HookCaptureReply): void {
    const ids = reply.type === "hook.ack" ? reply.recorded : reply.ids;
    if (reply.type === "hook.refused") this.options.log(`Channel refused hook events: ${reply.reason}`);
    for (const [key, message] of this.pending) {
      for (const id of ids) message.ids.delete(id);
      if (message.ids.size === 0) this.pending.delete(key);
    }
    this.checkIdle();
  }

  /**
   * Waits until every hook that has connected has been read and every Event the
   * Channel can be sent has been acknowledged, or `timeoutMs` passes.
   */
  async drain(timeoutMs: number): Promise<void> {
    if (this.idle()) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.idleWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.idleWaiters.add(finish);
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Takes one hook's input, and returns what the hook prints back into the agent CLI. */
  private async receive(text: string, held: HeldConnection): Promise<string> {
    let inputs: ClaudeHookInput[];
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      // One hook of another CLI can stand for several of Claude Code's (a patch editing several files).
      inputs = [this.options.translate ? this.options.translate(raw) : (raw as ClaudeHookInput)].flat();
    } catch {
      this.options.log("unreadable hook input dropped");
      return "";
    }
    const input = inputs[0];
    if (input === undefined) return "";
    if (typeof input.session_id === "string") this.options.onSessionId?.(input.session_id);
    for (const each of inputs) this.options.onHook?.(each);
    this.record(inputs.flatMap((each) => this.summarizer.summarize(each)));
    // A shell call: the CLI is answered once the snapshot before it (PreToolUse) or after it
    // (PostToolUse) is taken, so the snapshots hold the command's changes and nothing else.
    for (const each of inputs) {
      if (each.tool_name !== "Bash") continue;
      const dir = shellDir(each.cwd, each.tool_input, this.options.root);
      const key = shellCallKey(each.tool_use_id, dir, each.tool_input);
      if (each.hook_event_name === "PreToolUse") await this.shellEdits.start(key, dir);
      if (each.hook_event_name === "PostToolUse") await this.shellChanges(key);
    }
    if (this.options.hold?.(input, held)) return held.text;
    const decided = await this.options.decide?.(input).catch((error: Error) => {
      this.options.log(`hook answer failed: ${error.message}`);
      return null;
    });
    if (decided !== undefined && decided !== null) return decided;
    const context = this.options.context?.(input.hook_event_name) ?? "";
    return this.options.answer ? this.options.answer(input.hook_event_name, context) : context;
  }

  /** Gives drafts their IDs and sends them, or holds them until the Agent is registered. */
  private record(drafts: HookEventDraft[]): void {
    const events = drafts.map((draft) => ({ id: randomUUID(), ...draft }) as HookEvent);
    if (events.length === 0) return;
    this.options.onEvents?.(events);
    if (this.agent) this.enqueue(events);
    else this.unsent.push(...events);
  }

  /** Records one `file.edit` per file shell call `key` changed. */
  private async shellChanges(key: string): Promise<void> {
    try {
      const changes = await this.shellEdits.finish(key);
      this.record(
        changes.map((change) => ({
          type: "file.edit",
          payload: { ...change, path: truncate(change.path, MAX_HOOK_TEXT_LENGTH) },
        })),
      );
    } catch (error) {
      this.options.log(`shell edits failed: ${(error as Error).message}`);
    }
  }

  private enqueue(events: HookEvent[]): void {
    const message: Pending = { ids: new Set(events.map((e) => e.id)), events };
    this.pending.set(events[0]?.id ?? randomUUID(), message);
    if (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
      this.options.log("too many unsent hook events: dropped the oldest");
    }
    this.transmit(message);
  }

  private transmit(message: Pending): void {
    if (!this.agent) return;
    const frame: HookCaptureMessage = { type: "hook", agent: this.agent, events: message.events };
    this.options.send(JSON.stringify(frame));
  }

  private idle(): boolean {
    return this.readingHooks === 0 && (this.pending.size === 0 || this.agent === null);
  }

  private checkIdle(): void {
    if (!this.idle()) return;
    for (const resolve of [...this.idleWaiters]) resolve();
  }
}
