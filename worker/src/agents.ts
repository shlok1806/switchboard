// The Channel's Agents and their Presence. The Channel Durable Object owns the
// storage and the Event stream; this module owns the rules:
//
// - The wrapper registers an Agent for a CLI session. The Agent ID comes from the
//   Person, the CLI and the session ID, so a resumed session gets the same Agent.
// - The wrapper heartbeats with the Presence it observes (Live or Idle).
// - The Channel alone decides Gone: when the session ends, or when an Agent has
//   been silent for `goneAfterMs`. A Durable Object alarm checks for silence.
// - Every Presence change is an Event.

import type {
  Agent,
  AgentId,
  Capture,
  ChannelEvent,
  Cli,
  EventPayloads,
  EventType,
  PersonName,
  Presence,
  RegisterAgentRequest,
  ReportedPresence,
  StreamMessage,
} from "../../shared/src/index";
import { agentIdFor } from "../../shared/src/index";

type AgentRow = {
  id: string;
  person: string;
  cli: string;
  session_id: string;
  nickname: string | null;
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
    presence TEXT NOT NULL,
    proxy_mode TEXT NOT NULL,
    secret_masking INTEGER NOT NULL,
    can_receive_interrupts INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    started_at TEXT NOT NULL
  );
`;

/** What the roster needs from the Channel that hosts it. */
export interface RosterHost {
  sql: SqlStorage;
  /** Schedules the next silence check on the Channel's shared alarm; null when nobody can go silent. */
  schedulePresenceCheck(at: number | null): Promise<void>;
  /** How long an Agent may stay silent before it is Gone. */
  goneAfterMs: number;
  append<K extends EventType>(event: {
    type: K;
    actor: { kind: "agent"; agentId: AgentId };
    capture: Capture | null;
    payload: EventPayloads[K];
  }): ChannelEvent;
  broadcast(message: StreamMessage): void;
}

/** A refusal the Worker turns into an HTTP error. */
export type Refusal = { ok: false; status: 403 | 404 | 409; reason: string };
export type RosterResult = { ok: true; agent: Agent } | Refusal;

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id as AgentId,
    person: row.person,
    cli: row.cli as Cli,
    ...(row.nickname === null ? {} : { nickname: row.nickname }),
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

    if (existing) {
      const nickname = request.nickname === undefined ? existing.nickname : request.nickname;
      this.host.sql.exec(
        "UPDATE agents SET nickname = ?, presence = 'live', last_seen_at = ? WHERE id = ?",
        nickname,
        now,
        id,
      );
    } else {
      this.host.sql.exec(
        `INSERT INTO agents (id, person, cli, session_id, nickname, presence, proxy_mode, secret_masking,
                             can_receive_interrupts, last_seen_at, started_at)
         VALUES (?, ?, ?, ?, ?, 'live', 'digest', 1, 1, ?, ?)`,
        id,
        person,
        request.cli,
        request.sessionId,
        request.nickname ?? null,
        now,
        new Date(now).toISOString(),
      );
    }

    const agent = this.agent(id);
    this.record(id, "session.start", "hook", {
      cwd: request.cwd,
      resumed: request.resumed || existing !== undefined,
    });
    if (existing?.presence !== "live") this.record(id, "presence", "hook", { presence: "live" });
    this.host.broadcast({ type: "agent", agent });
    await this.watch();
    return { ok: true, agent };
  }

  /** The Agent is still running, with the Presence its wrapper observes. A Gone Agent comes back. */
  async heartbeat(person: PersonName, id: AgentId, presence: ReportedPresence): Promise<RosterResult> {
    const found = this.owned(person, id);
    if (!found.ok) return found;
    const now = Date.now();
    this.host.sql.exec("UPDATE agents SET presence = ?, last_seen_at = ? WHERE id = ?", presence, now, id);
    const agent = this.agent(id);
    if (found.row.presence !== presence) {
      this.record(id, "presence", "hook", { presence });
      this.host.broadcast({ type: "agent", agent });
    }
    await this.watch();
    return { ok: true, agent };
  }

  /** The session ended: the Agent is Gone until it resumes. Ending a Gone Agent changes nothing. */
  async endSession(person: PersonName, id: AgentId): Promise<RosterResult> {
    const found = this.owned(person, id);
    if (!found.ok) return found;
    if (found.row.presence === "gone") return { ok: true, agent: rowToAgent(found.row) };
    this.host.sql.exec("UPDATE agents SET presence = 'gone', last_seen_at = ? WHERE id = ?", Date.now(), id);
    const agent = this.agent(id);
    this.record(id, "session.end", "hook", { reason: "exit" });
    this.record(id, "presence", "hook", { presence: "gone" });
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
      this.record(row.id as AgentId, "presence", null, { presence: "gone" });
      this.host.broadcast({ type: "agent", agent: rowToAgent(row) });
    }
    await this.watch();
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

  private record<K extends EventType>(id: AgentId, type: K, capture: Capture | null, payload: EventPayloads[K]): void {
    this.host.append({ type, actor: { kind: "agent", agentId: id }, capture, payload });
  }
}
