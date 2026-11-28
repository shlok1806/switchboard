// The Channel's Agents and their Presence. The Channel Durable Object owns the
// storage and the Event stream; this module owns the rules:
//
// - The wrapper registers an Agent for a CLI session. The Agent ID comes from the
//   Person, the CLI and the session ID, so a resumed session gets the same Agent.
// - The wrapper heartbeats with the Presence it observes (Live or Idle).
// - The Channel alone decides Gone: when the session ends, or when an Agent has
//   been silent for `goneAfterMs`. A Durable Object alarm checks for silence.
// - A Host can Pause an Agent (ADR 0028): its process ends and its session is kept.
//   A Paused Agent is not Gone: neither its wrapper's heartbeat or end of session nor
//   the silence check change it. Registering again (a resume) brings it back.
// - Every Presence change is an Event.
// - That an Agent is still there is kept in memory (`Heard`): its last-seen time is
//   written only with a Presence change, at session end, or once the stored one is a
//   third of `goneAfterMs` old. So a heartbeat or a Hook Event that changes nothing
//   writes no row, and the silence check still finds a heartbeating Agent in the row
//   after a restart. Context and usage are written only when what they say changes.
// - A Nickname is unique on the Channel and can change while the Agent runs: by the
//   Agent itself or by any Person on the Channel. A name held by a Gone Agent is free
//   to take; every change is an `agent.rename` Event (ADR 0009).

import type {
  Actor,
  Agent,
  AgentContext,
  AgentId,
  AgentRole,
  AgentUsage,
  Capture,
  ChannelEvent,
  Cli,
  Delivery,
  DenyApprovalRequest,
  DirectiveDelivery,
  EventPayloads,
  EventType,
  HostId,
  LostClaim,
  PendingApproval,
  PersonName,
  Presence,
  ProxyMode,
  RegisterAgentRequest,
  ReportedPresence,
  ReportedUsage,
  StreamMessage,
} from "../../shared/src/index";
import {
  agentIdFor,
  DEFAULT_PROXY_MODE,
  hostIdFor,
  isAgentRole,
  MAX_LEAD_DEPTH,
  sameNickname,
  sameReading,
} from "../../shared/src/index";

type AgentRow = {
  id: string;
  person: string;
  cli: string;
  session_id: string;
  nickname: string | null;
  account: string | null;
  model: string | null;
  effort: string | null;
  usage: string | null;
  context: string | null;
  approval: string | null;
  host: string | null;
  role: string | null;
  parent: string | null;
  continues: string | null;
  presence: string;
  proxy_mode: string;
  secret_masking: number;
  can_receive_interrupts: number;
  last_seen_at: number;
  started_at: string;
};

export const GONE_RETENTION_MS = 7 * 86_400_000;
const PRUNE_BATCH = 10;

export const AGENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    person TEXT NOT NULL,
    cli TEXT NOT NULL,
    session_id TEXT NOT NULL,
    nickname TEXT,
    nickname_key TEXT,
    account TEXT,
    model TEXT,
    effort TEXT,
    usage TEXT,
    context TEXT,
    approval TEXT,
    host TEXT,
    role TEXT,
    parent TEXT,
    continues TEXT,
    presence TEXT NOT NULL,
    proxy_mode TEXT NOT NULL,
    secret_masking INTEGER NOT NULL,
    can_receive_interrupts INTEGER NOT NULL,
    gone_at INTEGER,
    last_seen_at INTEGER NOT NULL,
    started_at TEXT NOT NULL
  );
`;

/** Creates the `agents` table, and adds the columns later ADRs brought to a table made before them. */
export function createAgentsTable(sql: SqlStorage): void {
  sql.exec(AGENTS_SCHEMA);
  // ADR 0009: the Account Label. ADR 0010: the model and its effort. ADR 0011: usage.
  // ADR 0012: context. ADR 0013: the pending approval. ADR 0015: the Host that runs it.
  // ADR 0018: its role, and the lead that started it. ADR 0024: the Agent it continues.
  for (const column of [
    "account",
    "model",
    "effort",
    "usage",
    "context",
    "approval",
    "host",
    "role",
    "parent",
    "continues",
  ]) {
    try {
      sql.exec(`ALTER TABLE agents ADD COLUMN ${column} TEXT`);
    } catch {
      // The column is there already.
    }
  }
  try {
    sql.exec("ALTER TABLE agents ADD COLUMN gone_at INTEGER");
  } catch {
    // Existing Channels already have the retention timestamp.
  }
  // ADR 0009: Nicknames clash without regard to case. The case-folded Nickname, so a
  // registration or rename finds a clash through an index instead of reading every name.
  const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('agents')").toArray();
  if (!columns.some((c) => c.name === "nickname_key")) {
    sql.exec("ALTER TABLE agents ADD COLUMN nickname_key TEXT");
    const named = sql.exec<{ id: string; nickname: string }>(
      "SELECT id, nickname FROM agents WHERE nickname IS NOT NULL",
    );
    for (const row of named.toArray()) {
      sql.exec("UPDATE agents SET nickname_key = ? WHERE id = ?", nicknameKey(row.nickname), row.id);
    }
  }
  // The roster keeps every Agent the Channel has seen, so the queries that run on
  // every heartbeat or Relay decision read through these instead of the whole table.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_prune_cursor (singleton INTEGER PRIMARY KEY, seen INTEGER NOT NULL, id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS agents_gone ON agents (COALESCE(gone_at, last_seen_at), id) WHERE presence = 'gone';
    CREATE INDEX IF NOT EXISTS agents_by_last_seen ON agents (last_seen_at DESC, id);
    CREATE INDEX IF NOT EXISTS agents_live ON agents (last_seen_at) WHERE presence != 'gone';
    CREATE INDEX IF NOT EXISTS agents_by_parent ON agents (parent) WHERE parent IS NOT NULL;
    CREATE INDEX IF NOT EXISTS agents_by_continues ON agents (continues) WHERE continues IS NOT NULL;
    CREATE INDEX IF NOT EXISTS agents_by_nickname ON agents (nickname_key) WHERE nickname_key IS NOT NULL;
  `);
}

/** A Nickname as `sameNickname` compares it, as `nickname_key` keeps it. */
function nicknameKey(nickname: string | null): string | null {
  return nickname === null ? null : nickname.toLowerCase();
}

/** Who changes a Nickname, and through which Capture: the Agent itself (Tool Capture), or a Person. */
export type Renamer = { actor: Extract<Actor, { kind: "agent" | "person" }>; capture: Capture | null };

/**
 * What the roster heard from an Agent and may not have written yet: when it last heard
 * from it, and the stamp of its latest context reading when only the stamp moved.
 */
export interface Heard {
  seenAt: number;
  contextReadAt?: string;
}

/** What the roster needs from the Channel that hosts it. */
export interface RosterHost {
  sql: SqlStorage;
  /** Schedules the next silence check on the Channel's shared alarm; null when nobody can go silent. */
  schedulePresenceCheck(at: number | null): Promise<void>;
  /** Makes sure a silence check runs by `at`, leaving an earlier one as it is. */
  presenceCheckBy(at: number): Promise<void>;
  /** How long an Agent may stay silent before it is Gone. */
  goneAfterMs: number;
  /** Keeps what the roster heard from Agent `id` where it outlives this object's memory: on its wrapper's socket. */
  remember?(id: AgentId, heard: Heard): void;
  /** What `remember` kept, read once when the roster starts. */
  remembered?(): Iterable<readonly [AgentId, Heard]>;
  forget?(id: AgentId): void;
  retentionCheckBy?(at: number): void;
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
    ...(row.usage === null ? {} : { usage: JSON.parse(row.usage) as AgentUsage }),
    ...(row.context == null ? {} : { context: JSON.parse(row.context) as AgentContext }),
    ...(row.approval == null ? {} : { approval: JSON.parse(row.approval) as PendingApproval }),
    presence: row.presence as Presence,
    ...(row.host == null ? {} : { host: row.host as HostId }),
    ...(row.role != null && isAgentRole(row.role) ? { role: row.role } : {}),
    ...(row.parent == null ? {} : { parent: row.parent as AgentId }),
    ...(row.continues == null ? {} : { continues: row.continues as AgentId }),
    proxyMode: row.proxy_mode === "raw" ? "raw" : "digest",
    secretMasking: row.secret_masking === 1,
    canReceiveInterrupts: row.can_receive_interrupts === 1,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    startedAt: row.started_at,
  };
}

/** A usage report as an Agent's row keeps it: with the time the Channel heard it. */
function stamped(usage: ReportedUsage, now: number): string {
  const kept: AgentUsage = { ...usage, reportedAt: new Date(now).toISOString() };
  return JSON.stringify(kept);
}

/** The later of two ISO times, either of which may be missing. */
function later(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  return b !== undefined && b > a ? b : a;
}

/** A JSON column as its value, or null when it holds none. */
function parsed<T = unknown>(json: string | null): T | null {
  return json == null ? null : (JSON.parse(json) as T);
}

/** Columns of an Agent's row a heartbeat or a sign of life writes. */
type Changes = Partial<Record<"presence" | "usage" | "context" | "last_seen_at" | "gone_at", string | number>>;

export class AgentRoster {
  /**
   * What each Agent was heard saying since its row was last written: kept here, and on
   * its wrapper's socket through hibernation (`RosterHost.remember`). Every reader of an
   * Agent's last-seen time or context stamp reads through it (`toAgent`, `seen`).
   */
  private readonly heard = new Map<AgentId, Heard>();
  /** How old the stored last-seen time may get while the Agent is heard from: a third of `goneAfterMs`. */
  private readonly flushMs: number;

  constructor(private readonly host: RosterHost) {
    this.flushMs = host.goneAfterMs / 3;
    for (const [id, heard] of host.remembered?.() ?? []) this.keep(id, heard);
  }

  list(includeGone = false): Agent[] {
    // Historical lookup deliberately returns every retained Agent. Pruning bounds
    // this to roughly seven days plus Claim holders, leads and linked Agents.
    if (includeGone)
      return this.byLastSeen(
        this.host.sql.exec<AgentRow>("SELECT * FROM agents ORDER BY last_seen_at DESC, id").toArray(),
      );
    // Start with the two small indexed sets, never scan Gone history for Claims. A done
    // Task keeps its Claim, but its holder holds nothing being worked on.
    return this.byLastSeen(
      this.host.sql
        .exec<AgentRow>(`
      SELECT * FROM agents INDEXED BY agents_live WHERE presence != 'gone'
      UNION SELECT agents.* FROM tasks INDEXED BY tasks_working_by_holder_agent
        CROSS JOIN agents ON agents.id = tasks.holder_agent
        WHERE tasks.holder_agent IS NOT NULL AND json_extract(tasks.data, '$.status') <> 'done'
    `)
        .toArray(),
    );
  }

  /**
   * Visit only ten old Gone rows per pass, with a durable keyset cursor so protected
   * rows cannot starve later candidates. Keep Claim holders, granted leads and any
   * referenced predecessor or parent. Their summaries and authority chains must stay
   * usable (ADRs 0002, 0018, 0024). Unreferenced history remains in Events (ADR 0031).
   * Cleanup may span passes when an Agent has many files or tokens.
   */
  prune(cleanup: (id: AgentId) => boolean): number | null {
    const sql = this.host.sql;
    const cursor = sql
      .exec<{ seen: number; id: string }>("SELECT seen, id FROM agent_prune_cursor WHERE singleton = 1")
      .toArray()[0];
    // Separate equal-time and later-time seeks: SQLite does not seek through a
    // tuple comparison on this expression index and would reread earlier pages.
    // Apply the expiry cutoff after each limited seek, so it cannot cause SQLite
    // to choose an upper-bound scan instead of seeking forward from the cursor.
    const candidates = sql
      .exec<{ id: AgentId; last_seen_at: number; role: string | null }>(
        `
      SELECT * FROM (
        SELECT * FROM (
          SELECT id, COALESCE(agents.gone_at, agents.last_seen_at) AS last_seen_at, role
          FROM agents INDEXED BY agents_gone
          WHERE presence = 'gone' AND COALESCE(agents.gone_at, agents.last_seen_at) = ? AND id > ?
          ORDER BY id LIMIT ?
        ) UNION ALL SELECT * FROM (
          SELECT id, COALESCE(agents.gone_at, agents.last_seen_at) AS last_seen_at, role
          FROM agents INDEXED BY agents_gone
          WHERE presence = 'gone' AND COALESCE(agents.gone_at, agents.last_seen_at) > ?
          ORDER BY COALESCE(agents.gone_at, agents.last_seen_at), id LIMIT ?
        )
      ) WHERE last_seen_at <= ? ORDER BY last_seen_at, id LIMIT ?
    `,
        cursor?.seen ?? -1,
        cursor?.id ?? "",
        PRUNE_BATCH,
        cursor?.seen ?? -1,
        PRUNE_BATCH,
        Date.now() - GONE_RETENTION_MS,
        PRUNE_BATCH,
      )
      .toArray();
    for (const row of candidates) {
      if (row.role !== null) continue;
      if (sql.exec("SELECT 1 FROM tasks WHERE holder_agent = ? LIMIT 1", row.id).toArray().length) continue;
      if (sql.exec("SELECT 1 FROM agents WHERE parent = ? LIMIT 1", row.id).toArray().length) continue;
      if (sql.exec("SELECT 1 FROM agents WHERE continues = ? LIMIT 1", row.id).toArray().length) continue;
      if (!cleanup(row.id)) continue;
      sql.exec("DELETE FROM agents WHERE id = ?", row.id);
      this.heard.delete(row.id);
      this.host.forget?.(row.id);
    }
    const last = candidates.at(-1);
    if (last === undefined) sql.exec("DELETE FROM agent_prune_cursor WHERE singleton = 1");
    else sql.exec("INSERT OR REPLACE INTO agent_prune_cursor VALUES (1, ?, ?)", last.last_seen_at, last.id);
    if (candidates.length === PRUNE_BATCH) return Date.now() + 60_000;
    return this.retentionDeadline(last);
  }

  /** The next unvisited Gone row's expiry, with six hours between incomplete sweeps. */
  retentionDeadline(cursor?: { last_seen_at: number; id: string }): number | null {
    const sql = this.host.sql;
    const next = sql
      .exec<{ at: number }>(
        `
      SELECT * FROM (
        SELECT COALESCE(gone_at, last_seen_at) AS at, id FROM agents INDEXED BY agents_gone
        WHERE presence = 'gone' AND COALESCE(gone_at, last_seen_at) = ? AND id > ?
        ORDER BY id LIMIT 1
      ) UNION ALL SELECT * FROM (
        SELECT COALESCE(gone_at, last_seen_at) AS at, id FROM agents INDEXED BY agents_gone
        WHERE presence = 'gone' AND COALESCE(gone_at, last_seen_at) > ?
        ORDER BY COALESCE(gone_at, last_seen_at), id LIMIT 1
      ) ORDER BY at, id LIMIT 1
    `,
        cursor?.last_seen_at ?? -1,
        cursor?.id ?? "",
        cursor?.last_seen_at ?? -1,
      )
      .toArray()[0];
    if (next !== undefined) return Math.max(Date.now() + 6 * 3_600_000, next.at + GONE_RETENTION_MS);
    // At the end, wrap so protected rows and unfinished cleanup are reconsidered.
    sql.exec("DELETE FROM agent_prune_cursor WHERE singleton = 1");
    const oldest = sql
      .exec<{ at: number }>(`
      SELECT COALESCE(gone_at, last_seen_at) AS at FROM agents INDEXED BY agents_gone
      WHERE presence = 'gone' ORDER BY COALESCE(gone_at, last_seen_at), id LIMIT 1
    `)
      .toArray()[0];
    return oldest === undefined ? null : Math.max(Date.now() + 6 * 3_600_000, oldest.at + GONE_RETENTION_MS);
  }

  /** The Agents that are not Gone, most recently seen first. */
  live(): Agent[] {
    return this.byLastSeen(
      this.host.sql
        .exec<AgentRow>(
          "SELECT * FROM agents INDEXED BY agents_live WHERE presence != 'gone' ORDER BY last_seen_at DESC, id",
        )
        .toArray(),
    );
  }

  /** One Agent, or null when the Channel has never seen it. */
  find(id: AgentId): Agent | null {
    const row = this.row(id);
    return row === undefined ? null : this.toAgent(row);
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
    // The latest usage reading (ADR 0011); omitted keeps the Channel's.
    const usage = request.usage === undefined ? (existing?.usage ?? null) : stamped(request.usage, now);
    const secretMasking = request.secretMasking === false ? 0 : 1;
    // The wrapper says, every time it registers, whether it can type Interrupts into its CLI.
    const interrupts = request.interrupts === true ? 1 : 0;
    // Which Host runs the session now: a session resumed in a terminal has none.
    const host = request.host === undefined ? null : hostIdFor(person, request.host);
    if (existing) {
      const proxyMode = request.proxyMode ?? existing.proxy_mode;
      this.host.sql.exec(
        `UPDATE agents SET nickname = ?, nickname_key = ?, account = ?, model = ?, effort = ?, usage = ?,
             proxy_mode = ?, secret_masking = ?, can_receive_interrupts = ?, host = ?, presence = 'live',
             last_seen_at = ?
         WHERE id = ?`,
        nickname,
        nicknameKey(nickname),
        account,
        model,
        effort,
        usage,
        proxyMode,
        secretMasking,
        interrupts,
        host,
        now,
        id,
      );
    } else {
      this.host.sql.exec(
        `INSERT INTO agents (id, person, cli, session_id, nickname, nickname_key, account, model, effort, usage, host,
                             presence, proxy_mode, secret_masking, can_receive_interrupts, last_seen_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?)`,
        id,
        person,
        request.cli,
        request.sessionId,
        nickname,
        nicknameKey(nickname),
        account,
        model,
        effort,
        usage,
        host,
        request.proxyMode ?? DEFAULT_PROXY_MODE,
        secretMasking,
        interrupts,
        now,
        new Date(now).toISOString(),
      );
    }

    if (request.context !== undefined)
      this.host.sql.exec("UPDATE agents SET context = ? WHERE id = ?", JSON.stringify(request.context), id);
    // A prompt left open by an earlier run of the wrapper is gone with it; a prompt still open is reported again.
    if (existing) this.closeApproval(existing);
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
    await this.host.presenceCheckBy(now + this.host.goneAfterMs);
    return { ok: true, agent, ...(nicknameRefused === undefined ? {} : { nicknameRefused }) };
  }

  /**
   * Grants Agent `id` a role, or takes its role back (`role` null), for its own Person
   * only (ADR 0018). Records `agent.role.granted` or `agent.role.revoked` when it changed.
   */
  setRole(person: PersonName, id: AgentId, role: AgentRole | null): RosterResult {
    const row = this.row(id);
    if (!row) return { ok: false, status: 404, reason: `No Agent ${id} on this Channel.` };
    if (row.person !== person) {
      return {
        ok: false,
        status: 403,
        reason: `${id} is ${row.person}'s Agent. Only its own Person grants or revokes its role.`,
      };
    }
    const had = row.role !== null && isAgentRole(row.role) ? row.role : null;
    if (had === role) return { ok: true, agent: this.toAgent(row) };
    this.host.sql.exec("UPDATE agents SET role = ? WHERE id = ?", role, id);
    if (had !== null) {
      this.host.append({
        type: "agent.role.revoked",
        actor: { kind: "person", person },
        capture: null,
        payload: { agent: id, role: had },
      });
    }
    if (role !== null) {
      this.host.append({
        type: "agent.role.granted",
        actor: { kind: "person", person },
        capture: null,
        payload: { agent: id, role },
      });
    }
    const agent = this.agent(id);
    this.host.broadcast({ type: "agent", agent });
    return { ok: true, agent };
  }

  /** Agent `id` was started by lead `parent` (ADR 0018). Set once, when its spawn is answered. */
  setParent(id: AgentId, parent: AgentId): void {
    this.host.sql.exec("UPDATE agents SET parent = ? WHERE id = ? AND parent IS NULL", parent, id);
    const agent = this.find(id);
    if (agent !== null) this.host.broadcast({ type: "agent", agent });
  }

  /**
   * Agent `id` carries on Agent `from`'s work (ADR 0024). Set once: true when it was
   * set now, false when the Agent continued one already.
   */
  setContinues(id: AgentId, from: AgentId): boolean {
    const set = this.host.sql
      .exec("UPDATE agents SET continues = ? WHERE id = ? AND continues IS NULL RETURNING id", from, id)
      .toArray();
    if (set.length === 0) return false;
    this.host.broadcast({ type: "agent", agent: this.agent(id) });
    return true;
  }

  /** The Agents that carry on Agent `id`'s work (ADR 0024), oldest first. */
  successorsOf(id: AgentId): AgentId[] {
    return this.host.sql
      .exec<{ id: string }>(
        "SELECT id FROM agents INDEXED BY agents_by_continues WHERE continues = ? ORDER BY started_at, id",
        id,
      )
      .toArray()
      .map((row) => row.id as AgentId);
  }

  /** Whether Agent `id` is in lead `lead`'s subtree: its chain of parents reaches `lead` (ADR 0018). */
  inSubtree(lead: AgentId, id: AgentId): boolean {
    let at = this.row(id)?.parent ?? null;
    for (let depth = 0; at !== null && depth < MAX_LEAD_DEPTH; depth++) {
      if (at === lead) return true;
      at = this.row(at as AgentId)?.parent ?? null;
    }
    return false;
  }

  /** How many Agents in lead `lead`'s subtree are not Gone (ADR 0018). */
  liveInSubtree(lead: AgentId): number {
    return this.host.sql
      .exec<{ n: number }>(
        `WITH RECURSIVE tree (id, depth) AS (
           SELECT id, 1 FROM agents WHERE parent = ?
           UNION SELECT agents.id, tree.depth + 1 FROM agents JOIN tree ON agents.parent = tree.id WHERE tree.depth < ?
         )
         SELECT COUNT(*) AS n FROM agents WHERE id IN (SELECT id FROM tree) AND presence != 'gone'`,
        lead,
        MAX_LEAD_DEPTH,
      )
      .one().n;
  }

  /**
   * Renames a running (or Gone) Agent: by the Agent itself, or by any Person on the
   * Channel (ADR 0009). `nickname` is already clean; null clears it. Refuses a name
   * another Agent that is not Gone holds, naming it; takes one from a Gone Agent.
   */
  rename(id: AgentId, nickname: string | null, by: Renamer): RosterResult {
    const row = this.row(id);
    if (!row) return { ok: false, status: 404, reason: `No Agent ${id} on this Channel.` };
    if (row.nickname === nickname) return { ok: true, agent: this.toAgent(row) };
    if (nickname !== null) {
      const taken = this.takeName(nickname, id, by);
      if (!taken.ok) return taken;
    }
    this.host.sql.exec(
      "UPDATE agents SET nickname = ?, nickname_key = ? WHERE id = ?",
      nickname,
      nicknameKey(nickname),
      id,
    );
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
    if (found.row.model === model && found.row.effort === effort) return { ok: true, agent: this.toAgent(found.row) };
    this.host.sql.exec("UPDATE agents SET model = ?, effort = ? WHERE id = ?", model, effort, id);
    this.modelChanged(id, found.row.model, model, effort, capture);
    const agent = this.agent(id);
    this.host.broadcast({ type: "agent", agent });
    return { ok: true, agent };
  }

  /**
   * The permission prompt the Agent's CLI shows, or null once it closed, as its wrapper
   * reports it (ADR 0013): only the Agent itself or its own Person. Opening one is an
   * `approval.pending` Event, closing it `approval.closed`; a new prompt in place of an
   * open one closes that one first. Reporting what the Channel holds already changes nothing.
   */
  setApproval(person: PersonName, id: AgentId, approval: PendingApproval | null): RosterResult {
    const found = this.owned(person, id);
    if (!found.ok) return found;
    const held = found.row.approval == null ? null : (JSON.parse(found.row.approval) as PendingApproval);
    if (held?.id === approval?.id) return { ok: true, agent: this.toAgent(found.row) };
    // A Gone Agent shows no prompt: it may come back with a heartbeat, and report it again.
    if (approval !== null && found.row.presence === "gone") return { ok: true, agent: this.toAgent(found.row) };
    this.closeApproval(found.row);
    if (approval !== null) {
      this.host.sql.exec("UPDATE agents SET approval = ? WHERE id = ?", JSON.stringify(approval), id);
      const { openedAt: _, ...payload } = approval;
      this.host.append({ type: "approval.pending", actor: { kind: "agent", agentId: id }, capture: "hook", payload });
    }
    const agent = this.agent(id);
    this.host.broadcast({ type: "agent", agent });
    return { ok: true, agent };
  }

  /**
   * The Agent's own Person denies its open prompt `request.id` from the Channel (ADR 0014):
   * only a deniable one, only once, and only while `deliver` reaches the Agent's wrapper.
   */
  denyApproval(person: PersonName, id: AgentId, request: DenyApprovalRequest, deliver: () => boolean): RosterResult {
    const found = this.owned(person, id);
    if (!found.ok) return found;
    const held = found.row.approval == null ? null : (JSON.parse(found.row.approval) as PendingApproval);
    if (held === null || held.id !== request.id) {
      return { ok: false, status: 409, reason: `Agent ${id} is not waiting on that prompt any more.` };
    }
    if (held.deniable !== true) {
      return { ok: false, status: 409, reason: "That prompt can be answered only at the Agent's terminal." };
    }
    if (held.deniedBy !== undefined) {
      return { ok: false, status: 409, reason: `${held.deniedBy} already denied that prompt.` };
    }
    if (!deliver()) {
      return {
        ok: false,
        status: 409,
        reason: `Agent ${id}'s wrapper is not connected to the Channel. Answer the prompt at its terminal.`,
      };
    }
    this.host.sql.exec(
      "UPDATE agents SET approval = ? WHERE id = ?",
      JSON.stringify({ ...held, deniedBy: person }),
      id,
    );
    this.host.append({
      type: "approval.denied",
      actor: { kind: "person", person },
      capture: null,
      payload: { agent: id, id: held.id, ...(request.message === undefined ? {} : { message: request.message }) },
    });
    const agent = this.agent(id);
    this.host.broadcast({ type: "agent", agent });
    return { ok: true, agent };
  }

  /** Clears the prompt the row holds, if any, recording `approval.closed`. The caller broadcasts. */
  private closeApproval(row: AgentRow): void {
    if (row.approval == null) return;
    const held = JSON.parse(row.approval) as PendingApproval;
    this.host.sql.exec("UPDATE agents SET approval = NULL WHERE id = ?", row.id);
    this.host.append({
      type: "approval.closed",
      actor: { kind: "agent", agentId: row.id as AgentId },
      capture: "hook",
      payload: { id: held.id },
    });
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
      .exec<AgentRow>(
        "SELECT * FROM agents INDEXED BY agents_by_nickname WHERE nickname_key = ? AND id != ?",
        nicknameKey(nickname),
        id,
      )
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
      this.host.sql.exec("UPDATE agents SET nickname = NULL, nickname_key = NULL WHERE id = ?", gone.id);
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

  /**
   * The Agent is still running, with the Presence its wrapper observes. A Gone Agent
   * comes back. A usage reading, when the wrapper has a new one, replaces the
   * Agent's (ADR 0011); it is not an Event. Usage and context are written only when
   * they say something new: the same reading again, or the same context with a newer
   * `readAt`, as an older wrapper sends with every heartbeat, is only heard.
   */
  async heartbeat(
    person: PersonName,
    id: AgentId,
    presence: ReportedPresence,
    usage?: ReportedUsage,
    context?: AgentContext,
  ): Promise<RosterResult> {
    const found = this.owned(person, id);
    if (!found.ok) return found;
    const { row } = found;
    // The wrapper of a Paused Agent is on its way out: its heartbeat does not bring the Agent back.
    if (row.presence === "paused") return { ok: true, agent: this.toAgent(row) };
    const now = Date.now();
    const changes: Changes = {};
    if (row.presence !== presence) changes.presence = presence;
    if (usage !== undefined && !sameReading(parsed<AgentUsage>(row.usage), usage, "reportedAt")) {
      changes.usage = stamped(usage, now);
    }
    let contextReadAt: string | undefined;
    if (context !== undefined) {
      if (sameReading(parsed<AgentContext>(row.context), context, "readAt")) contextReadAt = context.readAt;
      else changes.context = JSON.stringify(context);
    }
    this.heardFrom(row, now, changes, contextReadAt);
    const agent = this.agent(id);
    if (row.presence !== presence) this.changed(id, presence);
    if (row.presence !== presence || usage !== undefined || context !== undefined)
      this.host.broadcast({ type: "agent", agent });
    await this.host.presenceCheckBy(now + this.host.goneAfterMs);
    return { ok: true, agent };
  }

  /**
   * The session ended: the Agent is Gone until it resumes. Ending a Gone Agent changes
   * nothing, and neither does ending a Paused one's: that is its process ending for the pause.
   */
  async endSession(person: PersonName, id: AgentId, detail?: string): Promise<RosterResult> {
    const found = this.owned(person, id);
    if (!found.ok) return found;
    if (found.row.presence === "gone" || found.row.presence === "paused") {
      return { ok: true, agent: this.toAgent(found.row) };
    }
    this.gone(found.row, Math.max(Date.now(), this.seen(found.row)));
    this.closeApproval(found.row);
    const agent = this.agent(id);
    this.record(id, "session.end", { reason: "exit", ...(detail ? { detail: detail.slice(0, 40) } : {}) });
    this.changed(id, "gone");
    this.host.broadcast({ type: "agent", agent });
    // The silence check set for it stays: when it runs early it finds the next deadline itself.
    return { ok: true, agent };
  }

  /**
   * Marks every Agent that has been silent for `goneAfterMs` as Gone, then schedules
   * the check for the next Agent that could go silent. Runs from the Channel's alarm.
   * The Channel, not the Agent, decides this, so these Events carry no Capture.
   *
   * The rows find who may be silent; what memory heard since has the last word. The
   * stored time of an Agent that is heard from is never older than `flushMs` plus one
   * heartbeat, so after a restart, with nothing in memory, the rows alone are enough.
   */
  async expireSilent(now = Date.now()): Promise<void> {
    const silentSince = now - this.host.goneAfterMs;
    const candidates = this.host.sql
      .exec<AgentRow>(
        "SELECT * FROM agents INDEXED BY agents_live WHERE presence != 'gone' AND presence != 'paused' AND last_seen_at <= ?",
        silentSince,
      )
      .toArray();
    for (const row of candidates) {
      const seen = this.seen(row);
      if (seen > silentSince) continue;
      this.gone(row, seen);
      this.changed(row.id as AgentId, "gone");
      // Silent for minutes: whatever prompt it reported is no longer known to be open.
      this.closeApproval(row);
      this.host.broadcast({ type: "agent", agent: this.agent(row.id) });
    }
    // The next check is for the quietest Agent left, as recently as anyone heard from it.
    const quietest = this.host.sql
      .exec<Pick<AgentRow, "id" | "last_seen_at">>(
        "SELECT id, last_seen_at FROM agents INDEXED BY agents_live WHERE presence != 'gone' AND presence != 'paused'",
      )
      .toArray()
      .reduce((min, row) => Math.min(min, this.seen(row)), Number.POSITIVE_INFINITY);
    await this.host.schedulePresenceCheck(
      quietest === Number.POSITIVE_INFINITY ? null : quietest + this.host.goneAfterMs,
    );
  }

  /**
   * Checks that `person` may act for Agent `id`, and counts it as heard from: an Agent
   * whose hooks report work is not silent. It does not change Presence.
   */
  touch(person: PersonName, id: AgentId): { ok: true; agent: Agent } | Refusal {
    const found = this.owned(person, id);
    if (!found.ok) return found;
    this.heardFrom(found.row, Date.now(), {});
    return { ok: true, agent: this.toAgent(found.row) };
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
    if (found.row.proxy_mode === mode) return { ok: true, agent: this.toAgent(found.row) };
    this.host.sql.exec("UPDATE agents SET proxy_mode = ? WHERE id = ?", mode, id);
    const agent = this.agent(id);
    this.host.broadcast({ type: "agent", agent });
    return { ok: true, agent };
  }

  /**
   * A Host pauses Agent `id` (ADR 0028): it is Paused from now, so its wrapper ending the
   * session is not Gone. Its open prompt goes with its process. False when it is not running.
   */
  pause(id: AgentId): boolean {
    const row = this.row(id);
    if (row === undefined || row.presence === "gone" || row.presence === "paused") return false;
    this.host.sql.exec("UPDATE agents SET presence = 'paused' WHERE id = ?", id);
    this.closeApproval(row);
    this.changed(id, "paused");
    this.host.broadcast({ type: "agent", agent: this.agent(id) });
    return true;
  }

  /** The Host refused a pause: Agent `id` is Idle again, and its next heartbeat says better. */
  async unpause(id: AgentId): Promise<void> {
    const row = this.row(id);
    if (row === undefined || row.presence !== "paused") return;
    const now = Date.now();
    this.host.sql.exec("UPDATE agents SET presence = 'idle', last_seen_at = ? WHERE id = ?", now, id);
    this.changed(id, "idle");
    this.host.broadcast({ type: "agent", agent: this.agent(id) });
    await this.host.presenceCheckBy(now + this.host.goneAfterMs);
  }

  /** A Paused Agent was stopped: Gone, with a `session.end` since no process is left to end it. */
  endPaused(id: AgentId): void {
    const row = this.row(id);
    if (row === undefined || row.presence !== "paused") return;
    this.gone(row, Math.max(Date.now(), this.seen(row)));
    this.record(id, "session.end", { reason: "exit", detail: "stopped while paused" });
    this.changed(id, "gone");
    this.host.broadcast({ type: "agent", agent: this.agent(id) });
  }

  /**
   * Counts Agent `row` as heard from at `now`, and writes `changes` to its row. The
   * last-seen time goes with them only when they change its Presence or the stored one
   * is `flushMs` old; until then memory keeps it. An unchanged context's newer stamp
   * goes into a row that is written anyway.
   */
  private heardFrom(row: AgentRow, now: number, changes: Changes, contextReadAt?: string): void {
    const heard = this.hear(row.id as AgentId, now, contextReadAt);
    if (changes.presence !== undefined || row.last_seen_at <= now - this.flushMs) {
      changes.last_seen_at = Math.max(heard.seenAt, row.last_seen_at);
      changes.context ??= this.freshContext(row, heard);
    }
    this.update(row.id as AgentId, changes);
  }

  /** Notes that Agent `id` was heard from at `now`, in memory and where `remember` keeps it. */
  private hear(id: AgentId, now: number, contextReadAt?: string): Heard {
    const heard = this.keep(id, { seenAt: now, ...(contextReadAt === undefined ? {} : { contextReadAt }) });
    this.host.remember?.(id, heard);
    return heard;
  }

  /** Adds `heard` to what memory holds for Agent `id`, keeping the later of each. */
  private keep(id: AgentId, heard: Heard): Heard {
    const before = this.heard.get(id);
    const readAt = later(before?.contextReadAt, heard.contextReadAt);
    const kept: Heard = {
      seenAt: Math.max(heard.seenAt, before?.seenAt ?? 0),
      ...(readAt === undefined ? {} : { contextReadAt: readAt }),
    };
    this.heard.set(id, kept);
    return kept;
  }

  /** Marks Agent `row` Gone, last seen at `seenAt`, with the context stamp memory held. */
  private gone(row: AgentRow, seenAt: number): void {
    const id = row.id as AgentId;
    const goneAt = Date.now();
    this.update(id, {
      presence: "gone",
      gone_at: goneAt,
      ...(seenAt > row.last_seen_at ? { last_seen_at: seenAt } : {}),
      context: this.freshContext(row, this.heard.get(id)),
    });
    this.heard.delete(id);
    this.host.retentionCheckBy?.(goneAt + GONE_RETENTION_MS);
  }

  /** When Agent `row` was last heard from: its row, or memory when that heard it since. */
  private seen(row: Pick<AgentRow, "id" | "last_seen_at">): number {
    return Math.max(row.last_seen_at, this.heard.get(row.id as AgentId)?.seenAt ?? 0);
  }

  /** The row's context with the newer stamp `heard` holds for it, as JSON; undefined when there is none. */
  private freshContext(row: AgentRow, heard: Heard | undefined): string | undefined {
    const context = parsed<AgentContext>(row.context);
    if (context === null || heard?.contextReadAt === undefined || heard.contextReadAt <= context.readAt) {
      return undefined;
    }
    return JSON.stringify({ ...context, readAt: heard.contextReadAt });
  }

  /** Writes `changes` to Agent `id`'s row; with none, writes nothing. */
  private update(id: AgentId, changes: Changes): void {
    const columns = (Object.keys(changes) as (keyof Changes)[]).filter((column) => changes[column] !== undefined);
    if (columns.length === 0) return;
    this.host.sql.exec(
      `UPDATE agents SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
      ...columns.map((column) => changes[column] ?? null),
      id,
    );
  }

  /** The Agent a row describes, with what memory heard since the row was written. */
  private toAgent(row: AgentRow): Agent {
    const agent = rowToAgent(row);
    const heard = this.heard.get(agent.id);
    if (heard === undefined) return agent;
    const { context } = agent;
    const readAt = context === undefined ? undefined : later(context.readAt, heard.contextReadAt);
    return {
      ...agent,
      lastSeenAt: new Date(this.seen(row)).toISOString(),
      ...(context === undefined || readAt === undefined ? {} : { context: { ...context, readAt } }),
    };
  }

  /** The Agents of `rows`, most recently seen first, as memory knows it. */
  private byLastSeen(rows: AgentRow[]): Agent[] {
    return rows
      .map((row) => ({ row, seen: this.seen(row) }))
      .sort((a, b) => b.seen - a.seen || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0))
      .map(({ row }) => this.toAgent(row));
  }

  private row(id: string): AgentRow | undefined {
    return this.host.sql.exec<AgentRow>("SELECT * FROM agents WHERE id = ?", id).toArray()[0];
  }

  private agent(id: string): Agent {
    const row = this.row(id);
    if (!row) throw new Error(`Agent ${id} vanished`);
    return this.toAgent(row);
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
