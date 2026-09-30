// The wrapper's side of the Channel API: join, register the Agent, heartbeat its
// Presence, end its session, and keep a WebSocket to the Channel open. The
// WebSocket also carries the Hook and Proxy Captures' Events to the Channel, and
// the Relay's Deliveries for the Agent's next turn back from it.

import type {
  AgentId,
  AgentResponse,
  DeliveryMessage,
  ErrorResponse,
  HookCaptureReply,
  JoinResponse,
  ProxyCaptureReply,
  RegisterAgentRequest,
  ReportedPresence,
  StreamMessage,
} from "../../shared/src/index";
import { agentPath, LIVE_PING, LIVE_PONG } from "../../shared/src/index";
import type { Config } from "./config";

/** Everything the Channel sends the wrapper's WebSocket. */
export type ChannelMessage = StreamMessage | HookCaptureReply | ProxyCaptureReply | DeliveryMessage;

export class ChannelError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ChannelClient {
  private readonly base: string;

  constructor(private readonly config: Config) {
    this.base = config.url.replace(/\/+$/, "");
  }

  async request<T>(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${this.config.secret}`);
    headers.set("X-Switchboard-Person", this.config.person);
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
    return this.request<JoinResponse>("/api/join", { method: "POST", body: JSON.stringify({ timeZone }) });
  }

  register(request: RegisterAgentRequest): Promise<AgentResponse> {
    return this.request<AgentResponse>("/api/agents", { method: "POST", body: JSON.stringify(request) });
  }

  heartbeat(id: AgentId, presence: ReportedPresence): Promise<AgentResponse> {
    return this.request<AgentResponse>(`${agentPath(id)}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ presence }),
    });
  }

  end(id: AgentId, timeoutMs: number): Promise<AgentResponse> {
    return this.request<AgentResponse>(`${agentPath(id)}/end`, { method: "POST", body: "{}" }, timeoutMs);
  }

  /**
   * Keeps a WebSocket to the Channel open, reconnecting with backoff, and hands
   * every message to `onMessage`, including replies to what the wrapper sends on it.
   */
  follow(onMessage: (message: ChannelMessage) => void, onStatus: (connected: boolean) => void): ChannelStream {
    let closed = false;
    let socket: WebSocket | null = null;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let retry = 0;

    const connect = () => {
      if (closed) return;
      const query = new URLSearchParams({ person: this.config.person, secret: this.config.secret });
      const ws = new WebSocket(`${this.base.replace(/^http/, "ws")}/api/stream?${query}`);
      socket = ws;
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
        if (closed) return;
        onStatus(false);
        retry += 1;
        setTimeout(connect, Math.min(30_000, 500 * 2 ** retry));
      });
      ws.addEventListener("error", () => {
        // "close" follows and reconnects.
      });
    };

    connect();
    return {
      send: (frame) => {
        if (socket?.readyState !== WebSocket.OPEN) return false;
        socket.send(frame);
        return true;
      },
      close: () => {
        closed = true;
        clearInterval(keepalive);
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
