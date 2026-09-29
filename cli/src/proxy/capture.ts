// The Proxy Capture on the wrapper side. It runs the local proxy, turns each model
// turn into a Proxy Digest or a Raw Proxy Event (the Agent's Proxy mode decides,
// and the wrapper follows changes to it on its WebSocket mid-session), masks
// detected secrets unless masking is off, and sends the Event to the Channel over
// the wrapper's WebSocket.
//
// Events wait while the WebSocket is down or the Agent is not registered yet, and
// are sent again on reconnect until the Channel acknowledges them. The Event ID
// makes that safe: the Channel records each Event once.

import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentId,
  ProxyCaptureMessage,
  ProxyCaptureReply,
  ProxyEvent,
  ProxyMode,
} from "../../../shared/src/index";
import { DEFAULT_UPSTREAM, ProxyServer } from "./server";
import { buildProxyEvent } from "./turn";

/** The most unacknowledged Proxy Events kept while the Channel cannot be reached. Oldest go first. */
const MAX_PENDING = 50;

/** The wrapper's `--proxy`: a Proxy mode, or off to launch without the proxy. */
export type ProxySetting = ProxyMode | "off";

export interface ProxyCaptureOptions {
  /** The agent CLI's own ANTHROPIC_BASE_URL, if it had one. */
  upstream?: string;
  /** The starting Proxy mode; the Channel's changes follow. */
  mode: ProxyMode;
  /** Whether to mask secrets (on unless `--no-mask`). */
  mask: boolean;
  /** Tool call paths under this directory are sent relative to it. */
  root: string;
  send: (frame: string) => boolean;
  log: (line: string) => void;
}

export class ProxyCapture {
  private agent: AgentId | null = null;
  private mode: ProxyMode;
  private readonly pending = new Map<string, ProxyEvent>();

  private constructor(
    private readonly options: ProxyCaptureOptions,
    private readonly server: ProxyServer,
  ) {
    this.mode = options.mode;
  }

  /** Starts the local proxy. Throws when it cannot listen; the caller launches without it. */
  static async start(options: ProxyCaptureOptions): Promise<ProxyCapture> {
    let capture: ProxyCapture | null = null;
    const server = await ProxyServer.start({
      upstream: options.upstream || DEFAULT_UPSTREAM,
      capturing: () => ({ capture: capture !== null, raw: capture?.mode === "raw" }),
      onTurn: (turn) => {
        if (!capture) return;
        const event = buildProxyEvent(turn, {
          mode: capture.mode,
          mask: options.mask,
          root: options.root,
          id: randomUUID(),
        });
        capture.enqueue(event);
      },
      log: options.log,
    });
    capture = new ProxyCapture(options, server);
    return capture;
  }

  /** The base URL the agent CLI gets as ANTHROPIC_BASE_URL. */
  get url(): string {
    return this.server.url;
  }

  get currentMode(): ProxyMode {
    return this.mode;
  }

  /** The Agent is registered: send what waited, and follow its Proxy mode from now on. */
  setAgent(agent: Agent): void {
    this.agent = agent.id;
    this.agentChanged(agent);
    this.connected();
  }

  /** An Agent on the Channel changed. When it is ours, a new Proxy mode applies from the next turn. */
  agentChanged(agent: Agent): void {
    if (agent.id !== this.agent || agent.proxyMode === this.mode) return;
    this.options.log(`proxy mode ${this.mode} -> ${agent.proxyMode}`);
    this.mode = agent.proxyMode;
  }

  /** The WebSocket (re)connected: send every Event the Channel has not acknowledged. */
  connected(): void {
    for (const event of this.pending.values()) this.transmit(event);
  }

  /** The Channel's reply to one of our Events. */
  reply(reply: ProxyCaptureReply): void {
    if (reply.type === "proxy.refused") this.options.log(`Channel refused proxy event: ${reply.reason}`);
    this.pending.delete(reply.id);
  }

  /** Waits for turns still streaming, then for the Channel to acknowledge what was sent, up to `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await this.server.drain(timeoutMs);
    while (this.pending.size > 0 && this.agent !== null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async close(): Promise<void> {
    await this.server.close();
  }

  private enqueue(event: ProxyEvent): void {
    this.pending.set(event.id, event);
    if (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
      this.options.log("too many unsent proxy events: dropped oldest");
    }
    this.transmit(event);
  }

  private transmit(event: ProxyEvent): void {
    if (!this.agent) return;
    const frame: ProxyCaptureMessage = { type: "proxy", agent: this.agent, event };
    this.options.send(JSON.stringify(frame));
  }
}
