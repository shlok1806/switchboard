// The wrapper's side of the Channel API: join, register the Agent, heartbeat its
// Presence, end its session, and keep a WebSocket to the Channel open. The
// WebSocket also carries the Hook and Proxy Captures' Events to the Channel, and
// the Relay's Deliveries for the Agent's next turn back from it.
//
// Credentials (ADR 0007): the Person's session registers the Agent, and the
// registration answers with an Agent token. From then on every call the Agent
// makes (heartbeats, its WebSocket, its tools) carries that token instead.

import type {
  AgentContext,
  AgentId,
  AgentResponse,
  ApprovalDenyMessage,
  DeliveryMessage,
  DirectiveInterruptMessage,
  DirectiveMessage,
  ErrorResponse,
  HeartbeatRequest,
  HistoryRequestMessage,
  HookCaptureReply,
  InterruptAttached,
  InterruptMessage,
  JoinResponse,
  ProxyCaptureReply,
  RegisterAgentRequest,
  ReportedPresence,
  ReportedUsage,
  StreamMessage,
  TerminalInputFrame,
  TerminalReadRequestMessage,
  TerminalWatchersMessage,
  TranscriptRequestMessage,
} from "../../shared/src/index";
import { agentPath, channelApiBase, LIVE_PONG } from "../../shared/src/index";
import { Backoff, exhaustedCode, exhaustionMessage } from "./channel-net";
import { closeSocket, dropSocket, openSocket, WebSocket as Socket, type WebSocket } from "./channel-socket";
import type { Config } from "./config";
import { type Keepalive, keepalive, STREAM_PING_MS, silentAfterMs } from "./keepalive";

/** The most requests one process has in flight to the Channel at once; the rest wait their turn (ADR 0052). */
const MAX_IN_FLIGHT = 4;

/** How long a process makes no new connection to the Channel once the machine ran out of ports or descriptors. */
const EXHAUSTED_WAIT_MS = 60_000;

const KEEP_BOM = new TextDecoder("utf-8", { ignoreBOM: true });

/** The socket's first wait after a failure, and its longest (ADR 0052). */
const SOCKET_RETRY_MS = 1_000;
const SOCKET_RETRY_MAX_MS = 30_000;

/** Where a ChannelClient finds its Channel and its credential. */
export interface ChannelTarget {
  /** The Worker's origin. */
  url: string;
  /** The Channel's repo, `owner/name`. */
  repo: string;
  /** The Person's session, or an Agent token. */
  credential: string;
}

/** The Channel of `repo` on the Person's Worker, with their session: it goes to the Worker that issued it only. */
export function targetOf(config: Config, repo: string): ChannelTarget {
  return { url: config.url, repo, credential: config.session };
}

/** Everything the Channel sends the wrapper's WebSocket. */
export type ChannelMessage =
  | StreamMessage
  | HookCaptureReply
  | ProxyCaptureReply
  | DeliveryMessage
  | InterruptAttached
  | InterruptMessage
  | DirectiveMessage
  | DirectiveInterruptMessage
  | ApprovalDenyMessage
  | TerminalWatchersMessage
  | TerminalInputFrame
  | TerminalReadRequestMessage
  | TranscriptRequestMessage
  | HistoryRequestMessage;

export class ChannelError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The refusal as the Channel sent it, for one that carries more than its reason. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** The machine, not the Channel, ran out of local ports or file descriptors (ADR 0052). */
export class LocalExhaustionError extends ChannelError {
  constructor(readonly code: string) {
    super(0, exhaustionMessage(code));
  }
}

export class ChannelClient {
  /** The Channel API's base: `<url>/r/<owner>/<repo>`. */
  private readonly base: string;
  /** The Person's session: it registers Agents. */
  private readonly session: string;
  /** The Agent's token once registered; every other call then carries it. */
  private agentToken: string | null = null;
  private readonly tokenListeners = new Set<() => void>();
  /** Requests in flight now, and those waiting for one of them to finish. */
  private inFlight = 0;
  private readonly queue: (() => void)[] = [];
  /** Until when no new connection is made: the machine ran out of ports or descriptors, and why. */
  private exhaustedUntil = 0;
  private exhausted = "";

  constructor(target: ChannelTarget) {
    this.base = `${target.url.replace(/\/+$/, "")}${channelApiBase(target.repo)}`;
    this.session = target.credential;
  }

  /** Makes every later call, and the WebSocket, act as the Agent the token was issued to. */
  useAgentToken(token: string): void {
    if (this.agentToken === token) return;
    this.agentToken = token;
    for (const listener of this.tokenListeners) listener();
  }

  /** The credential calls carry now: the Agent's token once there is one, else the Person's session. */
  private credential(): string {
    return this.agentToken ?? this.session;
  }

  async request<T>(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
    return this.requestAs<T>(this.credential(), path, init, timeoutMs);
  }

  /** A GET whose answer is text, such as an artifact's page; a refusal is still the Channel's JSON. */
  requestText(path: string, timeoutMs = 10_000): Promise<string> {
    return this.requestAs<string>(this.credential(), path, {}, timeoutMs, true);
  }

  private async requestAs<T>(
    credential: string,
    path: string,
    init: RequestInit,
    timeoutMs: number,
    text = false,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${credential}`);
    // The deadline counts the wait for a turn too: a call queued behind stuck ones gives up with them.
    const signal = AbortSignal.timeout(timeoutMs);
    await this.turn(signal);
    try {
      this.refuseWhileExhausted();
      let response: Response;
      try {
        response = await fetch(`${this.base}${path}`, { ...init, headers, signal });
      } catch (error) {
        this.throwIfExhausted(error);
        throw new ChannelError(0, `Could not reach ${this.base}: ${(error as Error).message}`);
      }
      // The body is always read, so the connection goes back to the pool for the next call.
      // Decoded keeping a byte order mark, so the text is exactly the bytes sent.
      if (text && response.ok) return KEEP_BOM.decode(await response.arrayBuffer()) as T;
      const body = (await response.json().catch(() => ({ ok: false, reason: response.statusText }))) as
        | T
        | ErrorResponse;
      if (!response.ok) throw new ChannelError(response.status, (body as ErrorResponse).reason, body);
      return body as T;
    } finally {
      this.inFlight -= 1;
      this.queue.shift()?.();
    }
  }

  /** Waits for a free slot among MAX_IN_FLIGHT, or for `signal`'s deadline. */
  private async turn(signal: AbortSignal): Promise<void> {
    if (this.inFlight < MAX_IN_FLIGHT) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal.removeEventListener("abort", give);
        this.inFlight += 1;
        resolve();
      };
      const give = () => {
        const at = this.queue.indexOf(go);
        if (at >= 0) this.queue.splice(at, 1);
        reject(new ChannelError(0, `Could not reach ${this.base}: earlier calls to it have not finished`));
      };
      if (signal.aborted) return give();
      signal.addEventListener("abort", give, { once: true });
      this.queue.push(go);
    });
  }

  /**
   * When `error` says the machine is out of ports or descriptors: remembers it, so no new
   * connection adds to it for a while, and throws a LocalExhaustionError that says so.
   */
  private throwIfExhausted(error: unknown): void {
    const code = exhaustedCode(error);
    if (code === null) return;
    this.exhausted = code;
    this.exhaustedUntil = Date.now() + EXHAUSTED_WAIT_MS;
    throw new LocalExhaustionError(code);
  }

  private refuseWhileExhausted(): void {
    if (Date.now() < this.exhaustedUntil) throw new LocalExhaustionError(this.exhausted);
  }

  /** How long before a new connection may be made: 0 unless the machine ran out of ports or descriptors. */
  private exhaustedFor(): number {
    return Math.max(0, this.exhaustedUntil - Date.now());
  }

  join(): Promise<JoinResponse> {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const body = JSON.stringify({ timeZone });
    return this.requestAs<JoinResponse>(this.session, "/api/join", { method: "POST", body }, 10_000);
  }

  /** Registers the Agent with the Person's session, and from then on acts with the Agent token it answers with. */
  async register(request: RegisterAgentRequest): Promise<AgentResponse> {
    const body = JSON.stringify(request);
    const answer = await this.requestAs<AgentResponse>(this.session, "/api/agents", { method: "POST", body }, 10_000);
    if (answer.token !== undefined) this.useAgentToken(answer.token);
    return answer;
  }

  /** `usage` is a new usage reading (ADR 0011), sent once. */
  heartbeat(
    id: AgentId,
    presence: ReportedPresence,
    usage?: ReportedUsage,
    context?: AgentContext,
  ): Promise<AgentResponse> {
    const body: HeartbeatRequest = {
      presence,
      ...(context === undefined ? {} : { context }),
      ...(usage === undefined ? {} : { usage }),
    };
    return this.request<AgentResponse>(`${agentPath(id)}/heartbeat`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** The session ended; `detail` is the agent CLI's own reason, when its SessionEnd hook gave one. */
  end(id: AgentId, timeoutMs: number, detail?: string): Promise<AgentResponse> {
    const body = JSON.stringify(detail === undefined ? {} : { detail });
    return this.request<AgentResponse>(`${agentPath(id)}/end`, { method: "POST", body }, timeoutMs);
  }

  /**
   * Keeps a WebSocket to the Channel open, reconnecting with backoff, and hands
   * every message to `onMessage`, including replies to what the wrapper sends on it.
   * The socket speaks for the Agent, so it opens once the Agent token is here (the
   * registration), and reopens with each new one.
   */
  follow(
    onMessage: (message: ChannelMessage) => void,
    onStatus: (connected: boolean) => void,
    options: { pingMs?: number; log?: (line: string) => void } = {},
  ): ChannelStream {
    const pingMs = options.pingMs ?? STREAM_PING_MS;
    let closed = false;
    let socket: WebSocket | null = null;
    const backoff = new Backoff(SOCKET_RETRY_MS, SOCKET_RETRY_MAX_MS);
    let pending: ReturnType<typeof setTimeout> | undefined;

    /** The next socket opens after a wait that grows with each failure in a row (ADR 0052). */
    const retry = (exhausted = false): number => {
      clearTimeout(pending);
      const wait = exhausted ? Math.max(this.exhaustedFor(), backoff.longest()) : backoff.next();
      pending = setTimeout(connect, wait);
      return wait;
    };

    const connect = () => {
      if (closed) return;
      pending = undefined;
      if (this.exhaustedFor() > 0) {
        retry(true);
        return;
      }
      const query = new URLSearchParams({ token: this.agentToken ?? this.session });
      // A socket that has not opened by the time an open one would be given up for silence is given up too.
      const ws = openSocket(`${this.base.replace(/^http/, "ws")}/api/stream?${query}`, silentAfterMs(pingMs));
      socket = ws;
      let alive: Keepalive | undefined;
      let opened = false;
      let heard = false;
      let failure: unknown;
      ws.addEventListener("open", () => {
        opened = true;
        onStatus(true);
        alive = keepalive(ws, pingMs, (quiet) => {
          if (closed || socket !== ws) return;
          // Half-open: its close may never come, so it is destroyed and replaced (ADR 0048).
          socket = null;
          dropSocket(ws);
          onStatus(false);
          const wait = retry();
          options.log?.(
            `heard nothing from the Channel for ${Math.round(quiet / 1000)}s; reconnecting in ${Math.round(wait / 100) / 10}s`,
          );
        });
      });
      ws.addEventListener("message", (event) => {
        alive?.heard();
        if (event.data === LIVE_PONG) {
          // Only a socket the Channel answers a ping on counts as a success: one that opens and goes silent does not.
          if (!heard) {
            heard = true;
            backoff.reset();
          }
          return;
        }
        try {
          onMessage(JSON.parse(String(event.data)) as ChannelMessage);
        } catch {
          // Ignore frames we cannot read.
        }
      });
      ws.addEventListener("close", () => {
        alive?.stop();
        // A socket replaced by a reconnect has nothing more to say.
        if (closed || socket !== ws) return;
        socket = null;
        if (opened) onStatus(false);
        const code = exhaustedCode(failure);
        if (code !== null) {
          this.exhaustedUntil = Date.now() + EXHAUSTED_WAIT_MS;
          this.exhausted = code;
          options.log?.(`stream: ${exhaustionMessage(code)}; waiting before trying again`);
        }
        retry(code !== null);
      });
      ws.addEventListener("error", (event) => {
        // "close" follows and reconnects.
        failure = event.error ?? event.message;
      });
    };

    // A new Agent token: reconnect with it now, so the socket speaks for the Agent.
    const reconnect = () => {
      if (closed) return;
      clearTimeout(pending);
      backoff.reset();
      const old = socket;
      socket = null;
      if (old !== null) closeSocket(old, "a new Agent token");
      pending = setTimeout(connect, 0);
    };
    this.tokenListeners.add(reconnect);

    if (this.agentToken !== null) connect();
    return {
      send: (frame) => {
        if (socket?.readyState !== Socket.OPEN) return false;
        socket.send(frame);
        return true;
      },
      close: () => {
        closed = true;
        this.tokenListeners.delete(reconnect);
        clearTimeout(pending);
        if (socket !== null) closeSocket(socket, "the session ended");
      },
    };
  }
}

/** The wrapper's open WebSocket to the Channel. */
export interface ChannelStream {
  /** Sends a text frame now; false when the socket is not open (it reconnects on its own). */
  send(frame: string): boolean;
  /** Closes it for good. */
  close(): void;
}
