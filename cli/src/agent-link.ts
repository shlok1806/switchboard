// Keeps one Agent registered on the Channel for as long as its session runs:
// registers it, heartbeats its Presence, re-registers if the Channel forgets it,
// and ends the session on exit. Failures never stop the agent CLI; they are
// logged and retried on the next heartbeat.

import type { Agent, AgentId, Cli, LostClaim, ProxyMode, ReportedPresence } from "../../shared/src/index";
import { type ChannelClient, ChannelError } from "./channel-client";

export interface AgentSession {
  cli: Cli;
  sessionId: string;
  resumed: boolean;
  cwd: string;
  nickname?: string;
  /** The starting Proxy mode (`--proxy`), when the Person gave one. */
  proxyMode?: ProxyMode;
  /** False when the Person turned secret masking off (`--no-mask`). */
  secretMasking?: boolean;
}

export class AgentLink {
  private agent: Agent | null = null;
  private presence: ReportedPresence = "live";
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: ChannelClient,
    private readonly session: AgentSession,
    private readonly heartbeatMs: number,
    private readonly log: (line: string) => void,
    /** Called each time the Channel registers the Agent. */
    private readonly onRegistered: (agent: Agent) => void = () => {},
    /** Called with the Claims the Agent lost to a Takeover while it was Gone, when the Channel hands them over. */
    private readonly onLostClaims: (lost: LostClaim[]) => void = () => {},
  ) {}

  get id(): AgentId | null {
    return this.agent?.id ?? null;
  }

  /** Registers the Agent. Throws on refusals and network failures; the caller decides. */
  async register(): Promise<Agent> {
    const { agent, lostClaims } = await this.client.register({
      cli: this.session.cli,
      sessionId: this.session.sessionId,
      resumed: this.session.resumed,
      cwd: this.session.cwd,
      ...(this.session.nickname === undefined ? {} : { nickname: this.session.nickname }),
      ...(this.session.proxyMode === undefined ? {} : { proxyMode: this.session.proxyMode }),
      ...(this.session.secretMasking === undefined ? {} : { secretMasking: this.session.secretMasking }),
    });
    this.agent = agent;
    this.log(`registered ${agent.id}`);
    this.onRegistered(agent);
    this.lost(lostClaims);
    return agent;
  }

  /** Starts heartbeating. Registers first on the next beat if registration has not succeeded yet. */
  start(): void {
    this.timer = setInterval(() => this.beat(), this.heartbeatMs);
  }

  /** Reports a Presence change right away. */
  report(presence: ReportedPresence): void {
    this.presence = presence;
    this.beat();
  }

  /** The session ended. Waits at most `timeoutMs` for the Channel to hear it. */
  async end(timeoutMs: number): Promise<void> {
    clearInterval(this.timer);
    await this.inFlight;
    if (!this.agent) return;
    try {
      await this.client.end(this.agent.id, timeoutMs);
      this.log(`ended ${this.agent.id}`);
    } catch (error) {
      this.log(`could not end ${this.agent.id}: ${(error as Error).message}`);
    }
  }

  private lost(lostClaims: LostClaim[] | undefined): void {
    if (lostClaims === undefined || lostClaims.length === 0) return;
    this.log(`lost Claims on ${lostClaims.map((lost) => `#${lost.task}`).join(", ")} to a Takeover`);
    this.onLostClaims(lostClaims);
  }

  private beat(): void {
    this.inFlight = this.inFlight.then(() => this.send());
  }

  private async send(): Promise<void> {
    try {
      if (!this.agent) {
        await this.register();
        // A fresh registration is Live; say so if we are not.
        if (this.presence === "live") return;
      }
      const id = this.agent?.id;
      if (!id) return;
      this.lost((await this.client.heartbeat(id, this.presence)).lostClaims);
    } catch (error) {
      if (error instanceof ChannelError && error.status === 404) {
        // The Channel does not know this Agent (its state was reset): register again next beat.
        this.agent = null;
      }
      this.log(`heartbeat failed: ${(error as Error).message}`);
    }
  }
}
