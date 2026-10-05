// The wrapper's side of the Channel API: join, register the Agent, heartbeat its
// Presence, end its session, and keep a WebSocket to the Channel open. The
// WebSocket also carries the Hook and Proxy Captures' Events to the Channel, and
// the Relay's Deliveries for the Agent's next turn back from it.
//
// Credentials (ADR 0007): the Person's session registers the Agent, and the
// registration answers with an Agent token. From then on every call the Agent
// makes (heartbeats, its WebSocket, its tools) carries that token instead.

import type {
  AgentId,
  AgentResponse,
  DeliveryMessage,
  DirectiveInterruptMessage,
  DirectiveMessage,
  ErrorResponse,
  HookCaptureReply,
  InterruptAttached,
  InterruptMessage,
  JoinResponse,
  ProxyCaptureReply,
  RegisterAgentRequest,
  ReportedPresence,
  StreamMessage,
} from "../../shared/src/index";
import { agentPath, channelApiBase, LIVE_PING, LIVE_PONG } from "../../shared/src/index";
import type { Config } from "./config";

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
  | DirectiveInterruptMessage;

export class ChannelError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
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

  private async requestAs<T>(credential: string, path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${credential}`);
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new ChannelError(0, `Could not reach ${this.base}: ${(error as Error).message}`);
    }
    const body = (await response.json().catch(() => ({ ok: false, reason: response.statusText }))) as T | ErrorResponse;
    if (!response.ok) throw new ChannelError(response.status, (body as ErrorResponse).reason);
    return body as T;
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

  heartbeat(id: AgentId, presence: ReportedPresence): Promise<AgentResponse> {
    return this.request<AgentResponse>(`${agentPath(id)}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ presence }),
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
  follow(onMessage: (message: ChannelMessage) => void, onStatus: (connected: boolean) => void): ChannelStream {
    let closed = false;
    let socket: WebSocket | null = null;
    let retry = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      pending = undefined;
      const query = new URLSearchParams({ token: this.agentToken ?? this.session });
      const ws = new WebSocket(`${this.base.replace(/^http/, "ws")}/api/stream?${query}`);
      socket = ws;
      let keepalive: ReturnType<typeof setInterval> | undefined;
      ws.addEventListener("open", () => {
        retry = 0;
        onStatus(true);
        keepalive = setInterval(() => ws.send(LIVE_PING), 30_000);
      });
      ws.addEventListener("message", (event) => {
        if (event.data === LIVE_PONG) return;
        try {
          onMessage(JSON.parse(String(event.data)) as ChannelMessage);
        } catch {
          // Ignore frames we cannot read.
        }
      });
      ws.addEventListener("close", () => {
        clearInterval(keepalive);
        // A socket replaced by a reconnect has nothing more to say.
        if (closed || socket !== ws) return;
        onStatus(false);
        if (pending !== undefined) return;
        retry += 1;
        pending = setTimeout(connect, Math.min(30_000, 500 * 2 ** retry));
      });
      ws.addEventListener("error", () => {
        // "close" follows and reconnects.
      });
    };

    // A new Agent token: reconnect with it now, so the socket speaks for the Agent.
    const reconnect = () => {
      if (closed) return;
      clearTimeout(pending);
      retry = 0;
      const old = socket;
      pending = setTimeout(connect, 0);
      old?.close();
    };
    this.tokenListeners.add(reconnect);

    if (this.agentToken !== null) connect();
    return {
      send: (frame) => {
        if (socket?.readyState !== WebSocket.OPEN) return false;
        socket.send(frame);
        return true;
      },
      close: () => {
        closed = true;
        this.tokenListeners.delete(reconnect);
        clearTimeout(pending);
        socket?.close();
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
