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

import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentContext,
  AgentId,
  Cli,
  ProxyMode,
  ReportedPresence,
  ReportedUsage,
} from "../../shared/src/index";
import { type ChannelClient, ChannelError, LocalExhaustionError } from "./channel-client";
import { Backoff } from "./channel-net";
import type { NextTurnItems } from "./next-turn";

/** The most session IDs `registerPicked` tries before it gives up. */
const MAX_PICKS = 5;

/** A Channel that does not answer is tried again at most this many heartbeat intervals apart (ADR 0052). */
const MAX_HEARTBEAT_BACKOFF = 10;

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
  /** The model from `--model` or the CLI's config (ADR 0010), until the Channel knows better. */
  model?: string;
  effort?: string;
  /** The starting Proxy mode (`--proxy`), when the Person gave one. */
  proxyMode?: ProxyMode;
  /** False when the Person turned secret masking off (`--no-mask`). */
  secretMasking?: boolean;
  /** Whether the wrapper can type Interrupts into this session. */
  interrupts?: boolean;
  /**
   * The Host that started this session (ADR 0015), and the spawn it answers. The spawn
   * is answered once the CLI's session has started (`sessionStarted`): Claude Code runs
   * its SessionStart hook only past its folder trust dialog, which a Host never answers.
   */
  host?: string;
  spawn?: string;
  /** The Host installed on this machine for the Channel, which answers for its Local Events after it (ADR 0037). */
  historyHost?: string;
  /** The Agent whose work this session carries on (ADR 0024), from `--from`. */
  continues?: AgentId;
  /** The Channel's librarian (ADR 0045), from `--librarian`. */
  librarian?: true;
}

export class AgentLink {
  private agent: Agent | null = null;
  /** The Agent as the Channel last described it, kept across registrations. */
  private known: Agent | null = null;
  /** Whether the Channel registered the Agent once already, in this session. */
  private registered = false;
  /** Whether the CLI's session has started, and whether the Channel has the spawn's answer. */
  private started = false;
  private spawnAnswered = false;
  private presence: ReportedPresence = "live";
  /** The latest usage reading (ADR 0011), and whether the Channel has yet to hear it. */
  private usage: ReportedUsage | null = null;
  private usageUnsent = false;
  readContext?: () => Promise<{ context: AgentContext; usage?: ReportedUsage }>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  /** Heartbeats wait longer after each failure in a row, and none is sent before `nextTry` (ADR 0052). */
  private readonly backoff: Backoff;
  private nextTry = 0;

  constructor(
    private readonly client: ChannelClient,
    private session: AgentSession,
    private readonly heartbeatMs: number,
    private readonly log: (line: string) => void,
    /** Called each time the Channel registers the Agent, with the Agent token it issued. */
    private readonly onRegistered: (agent: Agent, token: string | undefined) => void = () => {},
    /**
     * Called with what the Channel hands over for the Agent's next turn: Claims it
     * lost to a Takeover while it was Gone, and Queued Events.
     */
    private readonly onNextTurn: (items: NextTurnItems) => void = () => {},
  ) {
    this.backoff = new Backoff(heartbeatMs, heartbeatMs * MAX_HEARTBEAT_BACKOFF);
  }

  /** The Channel changed the Agent (say, renamed it): keep it, for registering again. */
  agentChanged(agent: Agent): void {
    if (this.known === null || agent.id !== this.known.id) return;
    this.known = agent;
    if (this.agent !== null) this.agent = agent;
  }

  get id(): AgentId | null {
    return this.agent?.id ?? null;
  }

  /** The session's ID: the one it started with, or the one `registerPicked` picked instead. */
  get sessionId(): string {
    return this.session.sessionId;
  }

  /**
   * Registers a new session whose ID Switchboard picked, before the CLI starts. An Agent
   * ID keeps only 4 characters of the session ID, so another of the Person's sessions
   * may already hold this one's, and the Channel refuses it (409). Then it picks another
   * session ID, up to MAX_PICKS in all; `sessionId` is the one it registered with.
   */
  async registerPicked(pick: () => string = randomUUID): Promise<Agent & { nicknameRefused?: string }> {
    for (let picks = 1; ; picks++) {
      try {
        return await this.register();
      } catch (error) {
        const taken = error instanceof ChannelError && error.status === 409;
        if (!taken || picks >= MAX_PICKS || this.registered) throw error;
        const next = pick();
        this.log(`${(error as Error).message} Picked session ${next} instead of ${this.session.sessionId}.`);
        this.session = { ...this.session, sessionId: next };
      }
    }
  }

  /**
   * Registers the Agent. Throws on refusals and network failures; the caller decides.
   * A Nickname the Channel would not set (another Agent holds it) is in `nicknameRefused`.
   *
   * It waits its turn behind any heartbeat, and a heartbeat asked for meanwhile (a
   * usage reading, a Presence change) waits for it: two registrations in flight at once
   * would both look like the session's first, and the Channel would start it twice.
   */
  register(): Promise<Agent & { nicknameRefused?: string }> {
    const registered = this.inFlight.then(() => this.registerNow());
    this.inFlight = registered.then(
      () => {},
      () => {},
    );
    return registered;
  }

  private async registerNow(): Promise<Agent & { nicknameRefused?: string }> {
    const known = this.known;
    const nickname = known === null ? this.session.nickname : (known.nickname ?? null);
    const proxyMode = known === null ? this.session.proxyMode : known.proxyMode;
    // What the Channel last knew of the model wins over the configured one: the proxy may have seen a switch.
    const model = known?.model ?? this.session.model;
    const effort = known?.model !== undefined ? known.effort : this.session.effort;
    const sentUsage = this.usage;
    const answersSpawn = this.spawnUnanswered();
    const answer = await this.client.register({
      cli: this.session.cli,
      sessionId: this.session.sessionId,
      resumed: this.session.resumed,
      cwd: this.session.cwd,
      ...(this.session.source === undefined ? {} : { source: this.session.source }),
      ...(nickname === undefined ? {} : { nickname }),
      ...(this.session.account === undefined ? {} : { account: this.session.account }),
      ...(model === undefined ? {} : { model, ...(effort === undefined ? {} : { effort }) }),
      ...(proxyMode === undefined ? {} : { proxyMode }),
      ...(this.session.secretMasking === undefined ? {} : { secretMasking: this.session.secretMasking }),
      ...(this.session.interrupts === undefined ? {} : { interrupts: this.session.interrupts }),
      ...(sentUsage === null ? {} : { usage: sentUsage }),
      ...(this.session.host === undefined ? {} : { host: this.session.host }),
      // The spawn is answered once, by the first registration after the session started.
      ...(answersSpawn ? { spawn: this.session.spawn } : {}),
      ...(this.session.continues === undefined ? {} : { continues: this.session.continues }),
      ...(this.session.librarian === undefined ? {} : { librarian: true }),
      ...(this.session.historyHost === undefined ? {} : { historyHost: this.session.historyHost }),
      // Registered before in this session: the session goes on, it does not start again.
      ...(this.registered ? { rejoin: true } : {}),
    });
    const { agent } = answer;
    if (this.usage === sentUsage) this.usageUnsent = false;
    this.agent = agent;
    this.known = agent;
    this.registered = true;
    if (answersSpawn) this.spawnAnswered = true;
    this.log(`registered ${agent.id}`);
    if (answer.nicknameRefused !== undefined) this.log(`Nickname not set: ${answer.nicknameRefused}`);
    this.onRegistered(agent, answer.token);
    this.handOver(answer);
    return answer.nicknameRefused === undefined ? agent : { ...agent, nicknameRefused: answer.nicknameRefused };
  }

  /**
   * The CLI's session started (its SessionStart hook ran). A Host's spawn is answered
   * now: by registering again within the session, or by the first registration.
   */
  sessionStarted(): void {
    if (this.started) return;
    this.started = true;
    if (this.spawnUnanswered()) this.beat();
  }

  /** Whether the session started and its Host's spawn still waits for the answer. */
  private spawnUnanswered(): boolean {
    return this.session.spawn !== undefined && this.started && !this.spawnAnswered;
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

  /** Sends a new usage reading (ADR 0011) with a heartbeat right away; a failed one goes with the next. */
  reportUsage(usage: ReportedUsage): void {
    this.usage = usage;
    this.usageUnsent = true;
    this.beat();
  }

  /**
   * The session ended, for `detail` (the agent CLI's own reason, when it gave one).
   * Waits at most `timeoutMs` for the Channel to hear it.
   */
  async end(timeoutMs: number, detail?: string): Promise<void> {
    clearInterval(this.timer);
    // A usage reading the Channel has not heard yet goes first, so a short session reports it.
    if ((this.usageUnsent || this.readContext !== undefined) && this.agent !== null) this.beat();
    await this.inFlight;
    if (!this.agent) return;
    try {
      await this.client.end(this.agent.id, timeoutMs, detail);
      this.log(`ended ${this.agent.id}`);
    } catch (error) {
      this.log(`could not end ${this.agent.id}: ${(error as Error).message}`);
    }
  }

  /**
   * The Channel did not answer, or this machine could not reach it: wait longer before
   * the next try, and say so once, not at every beat. The session itself goes on.
   */
  private unreachable(error: ChannelError): void {
    const exhausted = error instanceof LocalExhaustionError;
    const wait = exhausted ? this.backoff.longest() : this.backoff.next();
    this.nextTry = Date.now() + wait;
    if (this.backoff.count === 1 || exhausted) {
      this.log(
        `cannot reach the Channel: ${error.message}. The session goes on; trying again less and less often, at most every ${Math.round(
          (this.heartbeatMs * MAX_HEARTBEAT_BACKOFF) / 1000,
        )}s`,
      );
    }
  }

  /** A heartbeat got through: back to the usual pace, and say so if it had not been. */
  private reached(): void {
    const failed = this.backoff.count;
    this.backoff.reset();
    this.nextTry = 0;
    if (failed > 0) this.log(`reached the Channel again after ${failed} failed ${failed === 1 ? "try" : "tries"}`);
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
    // Backing off from a Channel that does not answer: this beat waits for a later one.
    if (Date.now() < this.nextTry) return;
    try {
      // Registering again answers a spawn: a failed try is tried again on the next beat.
      if (!this.agent || this.spawnUnanswered()) {
        await this.registerNow();
        this.reached();
        // A fresh registration is Live; say so if we are not.
        if (this.presence === "live") return;
      }
      const id = this.agent?.id;
      if (!id) return;
      const usage = this.usageUnsent && this.usage !== null ? this.usage : undefined;
      const reading = await this.readContext?.().catch((error: Error) => {
        this.log(`context reading failed: ${error.message}`);
        return undefined;
      });
      const answer = await this.client.heartbeat(id, this.presence, reading?.usage ?? usage, reading?.context);
      if (usage !== undefined && usage === this.usage) this.usageUnsent = false;
      this.agentChanged(answer.agent);
      this.handOver(answer);
      this.reached();
    } catch (error) {
      const lost =
        this.agent !== null && error instanceof ChannelError && (error.status === 404 || error.status === 401);
      if (error instanceof ChannelError && error.status === 0) {
        this.unreachable(error);
        return;
      }
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
