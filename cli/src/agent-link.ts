// Keeps one Agent registered on the Channel for as long as its session runs:
// registers it (trading the Person's session for an Agent token, ADR 0007),
// heartbeats its Presence with that token, registers again for a new token if the
// Channel forgets the Agent or revokes its token (it went Gone), and ends the
// session on exit. Failures never stop the agent CLI; they are logged and retried
// on the next heartbeat.
//
// Once the Channel has registered the Agent, its Nickname and Proxy mode are the
// Channel's: anyone may change them while the Agent runs (ADR 0009). Registering
// again within the session sends what the Channel last said, never what the
// wrapper started with, so a change made meanwhile is not undone.

import type { Agent, AgentId, Cli, ProxyMode, ReportedPresence } from "../../shared/src/index";
import { type ChannelClient, ChannelError } from "./channel-client";
import type { NextTurnItems } from "./next-turn";

export interface AgentSession {
  cli: Cli;
  sessionId: string;
  resumed: boolean;
  cwd: string;
  /** How the agent CLI started the session ("startup", "resume"). */
  source?: string;
  nickname?: string;
  /** The Account Label (ADR 0009); null sends none. */
  account?: string | null;
  /** The starting Proxy mode (`--proxy`), when the Person gave one. */
  proxyMode?: ProxyMode;
  /** False when the Person turned secret masking off (`--no-mask`). */
  secretMasking?: boolean;
  /** Whether the wrapper can type Interrupts into this session. */
  interrupts?: boolean;
}

export class AgentLink {
  private agent: Agent | null = null;
  /** The Agent as the Channel last described it, kept across registrations. */
  private known: Agent | null = null;
  /** Whether the Channel registered the Agent once already, in this session. */
  private registered = false;
  private presence: ReportedPresence = "live";
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: ChannelClient,
    private readonly session: AgentSession,
    private readonly heartbeatMs: number,
    private readonly log: (line: string) => void,
    /** Called each time the Channel registers the Agent, with the Agent token it issued. */
    private readonly onRegistered: (agent: Agent, token: string | undefined) => void = () => {},
    /**
     * Called with what the Channel hands over for the Agent's next turn: Claims it
     * lost to a Takeover while it was Gone, and Queued Events.
     */
    private readonly onNextTurn: (items: NextTurnItems) => void = () => {},
  ) {}

  /** The Channel changed the Agent (say, renamed it): keep it, for registering again. */
  agentChanged(agent: Agent): void {
    if (this.known === null || agent.id !== this.known.id) return;
    this.known = agent;
    if (this.agent !== null) this.agent = agent;
  }

  get id(): AgentId | null {
    return this.agent?.id ?? null;
  }

  /**
   * Registers the Agent. Throws on refusals and network failures; the caller decides.
   * A Nickname the Channel would not set (another Agent holds it) is in `nicknameRefused`.
   */
  async register(): Promise<Agent & { nicknameRefused?: string }> {
    const known = this.known;
    const nickname = known === null ? this.session.nickname : (known.nickname ?? null);
    const proxyMode = known === null ? this.session.proxyMode : known.proxyMode;
    const answer = await this.client.register({
      cli: this.session.cli,
      sessionId: this.session.sessionId,
      resumed: this.session.resumed,
      cwd: this.session.cwd,
      ...(this.session.source === undefined ? {} : { source: this.session.source }),
      ...(nickname === undefined ? {} : { nickname }),
      ...(this.session.account === undefined ? {} : { account: this.session.account }),
      ...(proxyMode === undefined ? {} : { proxyMode }),
      ...(this.session.secretMasking === undefined ? {} : { secretMasking: this.session.secretMasking }),
      ...(this.session.interrupts === undefined ? {} : { interrupts: this.session.interrupts }),
      // Registered before in this session: the session goes on, it does not start again.
      ...(this.registered ? { rejoin: true } : {}),
    });
    const { agent } = answer;
    this.agent = agent;
    this.known = agent;
    this.registered = true;
    this.log(`registered ${agent.id}`);
    if (answer.nicknameRefused !== undefined) this.log(`Nickname not set: ${answer.nicknameRefused}`);
    this.onRegistered(agent, answer.token);
    this.handOver(answer);
    return answer.nicknameRefused === undefined ? agent : { ...agent, nicknameRefused: answer.nicknameRefused };
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

  /**
   * The session ended, for `detail` (the agent CLI's own reason, when it gave one).
   * Waits at most `timeoutMs` for the Channel to hear it.
   */
  async end(timeoutMs: number, detail?: string): Promise<void> {
    clearInterval(this.timer);
    await this.inFlight;
    if (!this.agent) return;
    try {
      await this.client.end(this.agent.id, timeoutMs, detail);
      this.log(`ended ${this.agent.id}`);
    } catch (error) {
      this.log(`could not end ${this.agent.id}: ${(error as Error).message}`);
    }
  }

  private handOver({ lostClaims, deliveries, directives }: NextTurnItems): void {
    if (lostClaims !== undefined && lostClaims.length > 0) {
      this.log(`lost Claims on ${lostClaims.map((lost) => `#${lost.task}`).join(", ")} to a Takeover`);
    }
    if ((lostClaims?.length ?? 0) + (deliveries?.length ?? 0) + (directives?.length ?? 0) === 0) return;
    this.onNextTurn({
      ...(lostClaims === undefined ? {} : { lostClaims }),
      ...(deliveries === undefined ? {} : { deliveries }),
      ...(directives === undefined ? {} : { directives }),
    });
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
      const answer = await this.client.heartbeat(id, this.presence);
      this.agentChanged(answer.agent);
      this.handOver(answer);
    } catch (error) {
      const lost =
        this.agent !== null && error instanceof ChannelError && (error.status === 404 || error.status === 401);
      this.log(`heartbeat failed: ${(error as Error).message}`);
      if (lost) {
        // The Channel does not know this Agent (its state was reset), or revoked its
        // token because it went Gone: register again now, for a new token.
        this.agent = null;
        this.beat();
      }
    }
  }
}
