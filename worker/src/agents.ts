// The Channel's Agents and their Presence. The Channel Durable Object owns the
// storage and the Event stream; this module owns the rules:
//
// - The wrapper registers an Agent for a CLI session. The Agent ID comes from the
//   Person, the CLI and the session ID, so a resumed session gets the same Agent.
// - The wrapper heartbeats with the Presence it observes (Live or Idle).
// - The Channel alone decides Gone: when the session ends, or when an Agent has
//   been silent for `goneAfterMs`. A Durable Object alarm checks for silence.
// - Every Presence change is an Event.
// - A Nickname is unique on the Channel and can change while the Agent runs: by the
//   Agent itself or by any Person on the Channel. A name held by a Gone Agent is free
//   to take; every change is an `agent.rename` Event (ADR 0009).

import type {
  Actor,
  Agent,
  AgentId,
  Capture,
  ChannelEvent,
  Cli,
  Delivery,
  DirectiveDelivery,
  EventPayloads,
  EventType,
  LostClaim,
  PersonName,
  Presence,
  ProxyMode,
  RegisterAgentRequest,
  ReportedPresence,
  StreamMessage,
} from "../../shared/src/index";
import { agentIdFor, DEFAULT_PROXY_MODE, sameNickname } from "../../shared/src/index";

type AgentRow = {
  id: string;
  person: string;
  cli: string;
  session_id: string;
  nickname: string | null;
  account: string | null;
  model: string | null;
  effort: string | null;
  presence: string;
  proxy_mode: string;
  secret_masking: number;
  can_receive_interrupts: number;
  last_seen_at: number;
  started_at: string;
};

export const AGENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    person TEXT NOT NULL,
    cli TEXT NOT NULL,
    session_id TEXT NOT NULL,
    nickname TEXT,
    account TEXT,
    model TEXT,
    effort TEXT,
    presence TEXT NOT NULL,
    proxy_mode TEXT NOT NULL,
    secret_masking INTEGER NOT NULL,
    can_receive_interrupts INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    started_at TEXT NOT NULL
  );
`;

/** Creates the `agents` table, and adds the columns later ADRs brought to a table made before them. */
export function createAgentsTable(sql: SqlStorage): void {
  sql.exec(AGENTS_SCHEMA);
  // ADR 0009: the Account Label. ADR 0010: the model and its effort.
  for (const column of ["account", "model", "effort"]) {
    try {
      sql.exec(`ALTER TABLE agents ADD COLUMN ${column} TEXT`);
    } catch {
      // The column is there already.
    }
  }
}

/** Who changes a Nickname, and through which Capture: the Agent itself (Tool Capture), or a Person. */
export type Renamer = { actor: Extract<Actor, { kind: "agent" | "person" }>; capture: Capture | null };

/** What the roster needs from the Channel that hosts it. */
export interface RosterHost {
  sql: SqlStorage;
  /** Schedules the next silence check on the Channel's shared alarm; null when nobody can go silent. */
  schedulePresenceCheck(at: number | null): Promise<void>;
  /** How long an Agent may stay silent before it is Gone. */
  goneAfterMs: number;
  append<K extends EventType>(event: {
    type: K;
    actor: Extract<Actor, { kind: "agent" | "person" }>;
    capture: Capture | null;
    payload: EventPayloads[K];
  }): ChannelEvent;
  broadcast(message: StreamMessage): void;
  /** Called after every Presence change is recorded, so Claims can follow it (Stale Claims). */
  presenceChanged?(id: AgentId, presence: Presence): void;
}

/** A refusal the Worker turns into an HTTP error. */
export type Refusal = { ok: false; status: 403 | 404 | 409; reason: string };
/**
 * `lostClaims`, `deliveries` and `directives` are set by the Channel, not the roster:
 * Claims the Agent lost to a Takeover, Queued Events and Directives for its next turn.
 */
export type RosterResult =
  | {
      ok: true;
      agent: Agent;
      lostClaims?: LostClaim[];
      deliveries?: Delivery[];
      directives?: DirectiveDelivery[];
      /** A new Agent token, set only by registration (ADR 0007). */
      token?: string;
      /** Registration only: why the Nickname asked for was not set (ADR 0009). */
      nicknameRefused?: string;
    }
  | Refusal;

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id as AgentId,
    person: row.person,
    cli: row.cli as Cli,
    ...(row.nickname === null ? {} : { nickname: row.nickname }),
    ...(row.account === null ? {} : { account: row.account }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.effort === null ? {} : { effort: row.effort }),
    presence: row.presence as Presence,
    proxyMode: row.proxy_mode === "raw" ? "raw" : "digest",
    secretMasking: row.secret_masking === 1,
    canReceiveInterrupts: row.can_receive_interrupts === 1,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    startedAt: row.started_at,
  };
}

export class AgentRoster {
  constructor(private readonly host: RosterHost) {}

  list(): Agent[] {
    return this.host.sql
      .exec<AgentRow>("SELECT * FROM agents ORDER BY last_seen_at DESC, id")
      .toArray()
      .map(rowToAgent);
  }

  /** One Agent, or null when the Channel has never seen it. */
  find(id: AgentId): Agent | null {
    const row = this.row(id);
    return row === undefined ? null : rowToAgent(row);
  }

  /**
   * Registers the Agent for a session, or brings it back when the session resumes.
   * It is Live afterwards. Records `session.start`, and `presence` when it changed.
   */
  async register(person: PersonName, request: RegisterAgentRequest): Promise<RosterResult> {
    const id = agentIdFor(person, request.cli, request.sessionId);
    const now = Date.now();
    const existing = this.row(id);
    if (existing && existing.session_id !== request.sessionId) {
      return {
        ok: false,
        status: 409,
        reason: `Agent ID ${id} already belongs to another of your sessions. Start a new session to get a different one.`,
      };
    }

    // A Nickname another Agent holds is not set, and does not stop the session (ADR 0009).
    const self: Renamer = { actor: { kind: "agent", agentId: id }, capture: null };
    let nicknameRefused: string | undefined;
    let nickname = request.nickname === undefined ? (existing?.nickname ?? null) : request.nickname;
    if (typeof request.nickname === "string") {
      const taken = this.takeName(request.nickname, id, self);
      if (!taken.ok) {
        nicknameRefused = taken.reason;
        nickname = existing?.nickname ?? null;
      }
    }
    const account = request.account === undefined ? (existing?.account ?? null) : request.account;
    // What the wrapper knows of the model (ADR 0010); omitted keeps the Channel's.
    const model = request.model === undefined ? (existing?.model ?? null) : request.model;
    const effort = request.model === undefined ? (existing?.effort ?? null) : (request.effort ?? null);
    const secretMasking = request.secretMasking === false ? 0 : 1;
    // The wrapper says, every time it registers, whether it can type Interrupts into its CLI.
    const interrupts = request.interrupts === true ? 1 : 0;
    if (existing) {
      const proxyMode = request.proxyMode ?? existing.proxy_mode;
      this.host.sql.exec(
        `UPDATE agents SET nickname = ?, account = ?, model = ?, effort = ?, proxy_mode = ?, secret_masking = ?,
             can_receive_interrupts = ?, presence = 'live', last_seen_at = ?
         WHERE id = ?`,
        nickname,
        account,
        model,
        effort,
        proxyMode,
        secretMasking,
        interrupts,
        now,
        id,
      );
    } else {
      this.host.sql.exec(
        `INSERT INTO agents (id, person, cli, session_id, nickname, account, model, effort, presence, proxy_mode,
                             secret_masking, can_receive_interrupts, last_seen_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?)`,
        id,
        person,
        request.cli,
        request.sessionId,
        nickname,
        account,
        model,
        effort,
        request.proxyMode ?? DEFAULT_PROXY_MODE,
        secretMasking,
        interrupts,
        now,
        new Date(now).toISOString(),
      );
    }

    const agent = this.agent(id);
    // Once per session: a wrapper registering again within its session (it went Gone) starts none.
    if (!request.rejoin || existing === undefined) {
      const source = request.source === undefined ? undefined : request.source.slice(0, 40);
      this.record(id, "session.start", {
        cwd: request.cwd,
        resumed: request.resumed || existing !== undefined,
        ...(source === undefined ? {} : { source }),
      });
    }
    if (existing && existing.nickname !== nickname) this.renamed(id, existing.nickname, nickname, self);
    if ((existing?.model ?? null) !== model || (existing?.effort ?? null) !== effort) {
      this.modelChanged(id, existing?.model ?? null, model, effort, null);
    }
    if (existing?.presence !== "live") this.changed(id, "live");
    this.host.broadcast({ type: "agent", agent });
    await this.watch();
    return { ok: true, agent, ...(nicknameRefused === undefined ? {} : { nicknameRefused }) };
  }

  /**
   * Renames a running (or Gone) Agent: by the Agent itself, or by any Person on the
   * Channel (ADR 0009). `nickname` is already clean; null clears it. Refuses a name
   * another Agent that is not Gone holds, naming it; takes one from a Gone Agent.
   */
  rename(id: AgentId, nickname: string | null, by: Renamer): RosterResult {
    const row = this.row(id);
    if (!row) return { ok: false, status: 404, reason: `No Agent ${id} on this Channel.` };
    if (row.nickname === nickname) return { ok: true, agent: rowToAgent(row) };
    if (nickname !== null) {
      const taken = this.takeName(nickname, id, by);
      if (!taken.ok) return taken;
    }
    this.host.sql.exec("UPDATE agents SET nickname = ? WHERE id = ?", nickname, id);
    this.renamed(id, row.nickname, nickname, by);
    const agent = this.agent(id);
    this.host.broadcast({ type: "agent", agent });
    return { ok: true, agent };
  }

  /**
   * The model the Agent runs on, as its wrapper reports it (ADR 0010): only the Agent
   * itself or its own Person. A change is an `agent.model` Event and is broadcast.
   */
  setModel(
    person: PersonName,
    id: AgentId,
    model: string | null,
    effort: string | null,
    capture: Capture | null,
  ): RosterResult {
    const found = this.owned(person, id);
    if (!found.ok) return found;
    if (found.row.model === model && found.row.effort === effort) return { ok: true, agent: rowToAgent(found.row) };
    this.host.sql.exec("UPDATE agents SET model = ?, effort = ? WHERE id = ?", model, effort, id);
    this.modelChanged(id, found.row.model, model, effort, capture);
    const agent = this.agent(id);
    this.host.broadcast({ type: "agent", agent });
    return { ok: true, agent };
  }

  private modelChanged(
    id: AgentId,
    from: string | null,
    to: string | null,
    effort: string | null,
    capture: Capture | null,
  ): void {
    this.host.append({
      type: "agent.model",
      actor: { kind: "agent", agentId: id },
      capture,
      payload: {
        ...(from === null ? {} : { from }),
        ...(to === null ? {} : { to }),
        ...(effort === null ? {} : { effort }),
      },
    });
  }

  /**
   * Makes `nickname` free for Agent `id`: refused when another Agent that is not Gone
   * holds it; taken, and recorded, from a Gone Agent that does (ADR 0009).
   */
  private takeName(nickname: string, id: AgentId, by: Renamer): { ok: true } | Refusal {
    const holders = this.host.sql
      .exec<AgentRow>("SELECT * FROM agents WHERE nickname IS NOT NULL AND id != ?", id)
      .toArray()
      .filter((row) => row.nickname !== null && sameNickname(row.nickname, nickname));
    const live = holders.find((row) => row.presence !== "gone");
    if (live) {
      return {
        ok: false,
        status: 409,
        reason: `The Nickname "${live.nickname}" is taken by Agent ${live.id} on this Channel. Pick another one.`,
      };
    }
    for (const gone of holders) {
      this.host.sql.exec("UPDATE agents SET nickname = NULL WHERE id = ?", gone.id);
      this.renamed(gone.id as AgentId, gone.nickname, null, by);
      this.host.broadcast({ type: "agent", agent: this.agent(gone.id) });
    }
    return { ok: true };
  }

  /** Records an `agent.rename` Event, named for whoever renamed. */
  private renamed(id: AgentId, from: string | null, to: string | null, by: Renamer): void {
    this.host.append({
      type: "agent.rename",
      actor: by.actor,
      capture: by.capture,
      payload: { agent: id, ...(from === null ? {} : { from }), ...(to === null ? {} : { to }) },
    });
  }

  /** The Agent is still running, with the Presence its wrapper observes. A Gone Agent comes back. */
  async heartbeat(person: PersonName, id: AgentId, presence: ReportedPresence): Promise<RosterResult> {
    const found = this.owned(person, id);
    if (!found.ok) return found;
    const now = Date.now();
    this.host.sql.exec("UPDATE agents SET presence = ?, last_seen_at = ? WHERE id = ?", presence, now, id);
    const agent = this.agent(id);
    if (found.row.presence !== presence) {
      this.changed(id, presence);
      this.host.broadcast({ type: "agent", agent });
    }
    await this.watch();
    return { ok: true, agent };
  }

  /** The session ended: the Agent is Gone until it resumes. Ending a Gone Agent changes nothing. */
  async endSession(person: PersonName, id: AgentId, detail?: string): Promise<RosterResult> {
    const found = this.owned(person, id);
    if (!found.ok) return found;
    if (found.row.presence === "gone") return { ok: true, agent: rowToAgent(found.row) };
    this.host.sql.exec("UPDATE agents SET presence = 'gone', last_seen_at = ? WHERE id = ?", Date.now(), id);
    const agent = this.agent(id);
    this.record(id, "session.end", { reason: "exit", ...(detail ? { detail: detail.slice(0, 40) } : {}) });
    this.changed(id, "gone");
    this.host.broadcast({ type: "agent", agent });
    await this.watch();
    return { ok: true, agent };
  }

  /**
   * Marks every Agent that has been silent for `goneAfterMs` as Gone, then schedules
   * the check for the next Agent that could go silent. Runs from the Channel's alarm.
   * The Channel, not the Agent, decides this, so these Events carry no Capture.
   */
  async expireSilent(now = Date.now()): Promise<void> {
    const silent = this.host.sql
      .exec<AgentRow>(
        "UPDATE agents SET presence = 'gone' WHERE presence != 'gone' AND last_seen_at <= ? RETURNING *",
        now - this.host.goneAfterMs,
      )
      .toArray();
    for (const row of silent) {
      this.changed(row.id as AgentId, "gone");
      this.host.broadcast({ type: "agent", agent: rowToAgent(row) });
    }
    await this.watch();
  }

  /**
   * Checks that `person` may act for Agent `id`, and counts it as heard from: an Agent
   * whose hooks report work is not silent. It does not change Presence.
   */
  touch(person: PersonName, id: AgentId): { ok: true; agent: Agent } | Refusal {
    const found = this.owned(person, id);
    if (!found.ok) return found;
    this.host.sql.exec("UPDATE agents SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?", Date.now(), id);
    return { ok: true, agent: rowToAgent(found.row) };
  }

  /** Whether the Channel knows Agent `id`. */
  has(id: AgentId): boolean {
    return this.row(id) !== undefined;
  }

  /**
   * Sets an Agent's Proxy mode. Only the Agent's own Person may. The Agent's wrapper
   * hears of it on its WebSocket, like everyone else, and switches mid-session.
   */
  setProxyMode(person: PersonName, id: AgentId, mode: ProxyMode): RosterResult {
    const found = this.owned(person, id);
    if (!found.ok) return found;
    if (found.row.proxy_mode === mode) return { ok: true, agent: rowToAgent(found.row) };
    this.host.sql.exec("UPDATE agents SET proxy_mode = ? WHERE id = ?", mode, id);
    const agent = this.agent(id);
    this.host.broadcast({ type: "agent", agent });
    return { ok: true, agent };
  }

  /** Schedules the silence check for when the quietest Agent that is not Gone would go Gone. */
  private async watch(): Promise<void> {
    const oldest = this.host.sql
      .exec<{ oldest: number | null }>("SELECT MIN(last_seen_at) AS oldest FROM agents WHERE presence != 'gone'")
      .one().oldest;
    await this.host.schedulePresenceCheck(oldest === null ? null : oldest + this.host.goneAfterMs);
  }

  private row(id: string): AgentRow | undefined {
    return this.host.sql.exec<AgentRow>("SELECT * FROM agents WHERE id = ?", id).toArray()[0];
  }

  private agent(id: string): Agent {
    const row = this.row(id);
    if (!row) throw new Error(`Agent ${id} vanished`);
    return rowToAgent(row);
  }

  /** Finds an Agent that `person` may act for: only an Agent's own Person may. */
  private owned(person: PersonName, id: AgentId): { ok: true; row: AgentRow } | Refusal {
    const row = this.row(id);
    if (!row) return { ok: false, status: 404, reason: `No Agent ${id} on this Channel. Register it first.` };
    if (row.person !== person) {
      return { ok: false, status: 403, reason: `Agent ${id} belongs to ${row.person}.` };
    }
    return { ok: true, row };
  }

  /** Records a Presence change and tells the host. */
  private changed(id: AgentId, presence: Presence): void {
    this.record(id, "presence", { presence });
    this.host.presenceChanged?.(id, presence);
  }

  /**
   * Records a roster Event. The wrapper's registration, heartbeats and session end
   * and the Channel's own silence check are not a Capture, so these carry none.
   * What the agent CLI itself reports arrives through the Hook Capture instead.
   */
  private record<K extends EventType>(id: AgentId, type: K, payload: EventPayloads[K]): void {
    this.host.append({ type, actor: { kind: "agent", agentId: id }, capture: null, payload });
  }
}
