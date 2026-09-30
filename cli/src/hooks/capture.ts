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
// a Claim it lost while it was away. Every other hook gets an empty answer.
// Events wait while the WebSocket is down or the Agent is not registered yet, and
// every message is sent again on reconnect until the Channel acknowledges it.
// Event IDs make that safe: the Channel records each Event once.

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, HookCaptureMessage, HookCaptureReply, HookEvent } from "../../../shared/src/index";
import { MAX_HOOK_EVENTS_PER_MESSAGE } from "../../../shared/src/index";
import { CONTEXT_HOOKS } from "../lost-claims";
import type { SessionSettings } from "../session-settings";
import { CAPTURED_HOOKS, type ClaudeHookInput, HookSummarizer } from "./summarize";

/** The most unacknowledged messages kept while the Channel cannot be reached. Oldest go first. */
const MAX_PENDING = 1000;
/** The largest hook input read from a hook, in bytes. A Write's input holds the whole file. */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

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
  /** The hook command's program and script. Defaults to this Node and the built hook script. */
  node?: string;
  script?: string;
}

type Pending = { ids: Set<string>; events: HookEvent[] };

export class HookCapture {
  readonly socketPath: string;
  private readonly summarizer: HookSummarizer;
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
    this.server = createServer((conn) => {
      this.readingHooks += 1;
      const chunks: Buffer[] = [];
      let size = 0;
      let read = false;
      // Reads the hook's whole input once, and gives the answer for it.
      const finish = (): string => {
        if (read) return "";
        read = true;
        if (size <= MAX_INPUT_BYTES) return this.receive(Buffer.concat(chunks).toString("utf8"));
        this.options.log(`hook input over ${MAX_INPUT_BYTES} bytes dropped`);
        return "";
      };
      conn.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_INPUT_BYTES) chunks.push(chunk);
      });
      conn.on("error", () => {});
      // The hook sent everything: answer, then close.
      conn.on("end", () => conn.end(finish()));
      conn.on("close", () => {
        finish();
        this.readingHooks -= 1;
        this.checkIdle();
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

  /** The Claude Code settings that install the hooks for this session. */
  settings(): SessionSettings {
    const node = this.options.node ?? process.execPath;
    const script = this.options.script ?? hookScriptPath();
    const command = [node, script, this.socketPath].map(shellQuote).join(" ");
    const hook = { type: "command" as const, command, timeout: 10 };
    const names = [...new Set<string>([...CAPTURED_HOOKS, ...CONTEXT_HOOKS])];
    return {
      hooks: Object.fromEntries(
        names.map((name) => [name, [name === "PostToolUse" ? { matcher: "*", hooks: [hook] } : { hooks: [hook] }]]),
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
  private receive(text: string): string {
    let input: ClaudeHookInput;
    try {
      input = JSON.parse(text) as ClaudeHookInput;
    } catch {
      this.options.log("unreadable hook input dropped");
      return "";
    }
    if (typeof input.session_id === "string") this.options.onSessionId?.(input.session_id);
    const events = this.summarizer.summarize(input).map((draft) => ({ id: randomUUID(), ...draft }) as HookEvent);
    if (events.length > 0) {
      if (this.agent) this.enqueue(events);
      else this.unsent.push(...events);
    }
    return this.options.context?.(input.hook_event_name) ?? "";
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
