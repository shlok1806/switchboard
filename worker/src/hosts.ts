// Hosts (ADR 0015): a Person's machines that start and stop Agents with no window.
// The Channel Durable Object owns the sockets and the Event stream; this module owns
// the rules:
//
// - A Host belongs to one Person, who registers it with the folders Agents may run in
//   and the loosest permission mode they may run in. Only that Person may use it.
// - A Host is Live while its socket is attached. `host.online` and `host.offline` are
//   recorded only when that changes and stays changed: a Host that reconnects within
//   `OFFLINE_GRACE_MS` records nothing, so a flapping connection does not flood the
//   Channel.
// - A spawn is recorded (`agent.spawn`, whose ID names it) and sent to the Host. It
//   ends when the new wrapper registers with that ID (`agent.spawned`), when the Host
//   reports it could not start it, or after `SPAWN_EXPIRES_MS` without either
//   (`agent.spawn.failed`). The caller waits for the end, up to `spawnWaitMs`.
// - The Agents Hosts run, and the spawns still starting, are capped per Channel.
// - A stop is recorded (`agent.stop`) and sent to the Host that runs the Agent. The
//   Agent goes Gone the usual way, when its wrapper ends the session.
//
// The folders and mode kept here are advisory (ADR 0017). The same Person's session
// that spawns can re-register the Host with wider ones, so a stolen session could
// widen them first. `switchboard host run` MUST re-check every spawn against its own
// install-time configuration on the machine (the folder after realpath, under its
// local roots; the mode no looser than its local maximum) and never trust this copy.
// `host_spawns` rows are never pruned: one short row per spawn, next to its Event.

import type {
  Actor,
  Agent,
  AgentId,
  Capture,
  ChannelEvent,
  EventPayloads,
  EventType,
  Host,
  HostId,
  HostSpawnMessage,
  HostStopMessage,
  PermissionMode,
  PersonName,
  RegisterHostRequest,
  SpawnAgentRequest,
} from "../../shared/src/index";
import {
  DEFAULT_PERMISSION_MODE,
  hostIdFor,
  isPermissionMode,
  permissionModeWithin,
  underRoots,
} from "../../shared/src/index";

/** A Host whose socket closed is recorded Offline only after this long without it coming back. */
export const OFFLINE_GRACE_MS = 30_000;
/** A spawn the Host has not answered after this long failed. */
export const SPAWN_EXPIRES_MS = 120_000;
/** How long `POST /api/agents/spawn` waits for the Agent, unless HOST_SPAWN_WAIT_SECONDS says otherwise. */
export const DEFAULT_SPAWN_WAIT_MS = 45_000;

export const HOSTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS hosts (
    person TEXT NOT NULL,
    name TEXT NOT NULL,
    roots TEXT NOT NULL,
    max_mode TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL,
    recorded TEXT NOT NULL DEFAULT 'offline',
    offline_since INTEGER,
    PRIMARY KEY (person, name)
  );
  CREATE TABLE IF NOT EXISTS host_spawns (
    id TEXT PRIMARY KEY,
    person TEXT NOT NULL,
    host TEXT NOT NULL,
    state TEXT NOT NULL,
    requested_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS host_spawns_pending ON host_spawns (requested_at) WHERE state = 'pending';
`;

type HostRow = {
  person: string;
  name: string;
  roots: string;
  max_mode: string;
  registered_at: string;
  last_seen_at: number;
  /** The Presence the last `host.online` or `host.offline` recorded. */
  recorded: string;
  /** When its last socket closed, while that is not recorded yet. */
  offline_since: number | null;
};

type SpawnRow = { id: string; person: string; host: string; state: string; requested_at: number };

/** What the Hosts need from the Channel that keeps them. */
export interface HostsDeps {
  sql: SqlStorage;
  append<K extends EventType>(event: {
    type: K;
    actor: Extract<Actor, { kind: "agent" | "person" }>;
    capture: Capture | null;
    payload: EventPayloads[K];
  }): ChannelEvent;
  /** Whether Host `id` has a socket attached now. */
  attached(id: HostId): boolean;
  /** Sends `message` to Host `id`'s newest socket. False when it has none. */
  sendTo(id: HostId, message: HostSpawnMessage | HostStopMessage): boolean;
  /** Closes Host `id`'s sockets, for a Host that was removed. */
  close(id: HostId): void;
  findAgent(id: AgentId): Agent | null;
  /** Sets when the Hosts next need the alarm (null: never). */
  schedule(at: number | null): Promise<void>;
  /** How many Agents Hosts may run at once. */
  cap: number;
  spawnWaitMs: number;
}

export type HostRefusal = { ok: false; status: 403 | 404 | 409 | 502; reason: string };

/** How a spawn ended, for the request waiting on it. */
type SpawnEnd = { agent: Agent } | { reason: string };

export type SpawnResult = { ok: true; spawn: string; host: HostId; agent?: Agent } | HostRefusal;

function rowToHost(row: HostRow, live: boolean): Host {
  return {
    id: hostIdFor(row.person, row.name),
    person: row.person,
    name: row.name,
    roots: JSON.parse(row.roots) as string[],
    maxPermissionMode: isPermissionMode(row.max_mode) ? row.max_mode : DEFAULT_PERMISSION_MODE,
    live,
    registeredAt: row.registered_at,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
  };
}

export class Hosts {
  /** Requests waiting on their spawn, by spawn ID. In memory: the waiting request keeps the object alive. */
  private readonly waiting = new Map<string, (end: SpawnEnd) => void>();

  constructor(private readonly deps: HostsDeps) {
    deps.sql.exec(HOSTS_SCHEMA);
  }

  list(): Host[] {
    return this.deps.sql
      .exec<HostRow>("SELECT * FROM hosts ORDER BY person, name")
      .toArray()
      .map((row) => this.toHost(row));
  }

  find(person: PersonName, name: string): Host | null {
    const row = this.row(person, name);
    return row === undefined ? null : this.toHost(row);
  }

  /** Registers one of `person`'s Hosts, or updates its folders and mode. */
  register(person: PersonName, request: RegisterHostRequest): Host {
    const now = Date.now();
    this.deps.sql.exec(
      `INSERT INTO hosts (person, name, roots, max_mode, registered_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (person, name) DO UPDATE SET roots = excluded.roots, max_mode = excluded.max_mode`,
      person,
      request.name,
      JSON.stringify(request.roots),
      request.maxPermissionMode ?? DEFAULT_PERMISSION_MODE,
      new Date(now).toISOString(),
      now,
    );
    return this.find(person, request.name) as Host;
  }

  /** Removes one of `person`'s Hosts and closes its sockets. False when there was none. */
  remove(person: PersonName, name: string): boolean {
    if (this.row(person, name) === undefined) return false;
    this.deps.sql.exec("DELETE FROM hosts WHERE person = ? AND name = ?", person, name);
    this.deps.close(hostIdFor(person, name));
    return true;
  }

  /** The Agents Hosts run now, and the spawns still starting. */
  running(): number {
    const agents = this.deps.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM agents INDEXED BY agents_live WHERE presence != 'gone' AND host IS NOT NULL",
      )
      .one().n;
    const starting = this.deps.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM host_spawns INDEXED BY host_spawns_pending WHERE state = 'pending'",
      )
      .one().n;
    return agents + starting;
  }

  /** A Host's socket attached. False when `person` has no Host `name`, and the socket is refused. */
  attach(person: PersonName, name: string): boolean {
    const row = this.row(person, name);
    if (row === undefined) return false;
    this.deps.sql.exec(
      "UPDATE hosts SET last_seen_at = ?, offline_since = NULL, recorded = 'online' WHERE person = ? AND name = ?",
      Date.now(),
      person,
      name,
    );
    if (row.recorded !== "online") {
      this.deps.append({
        type: "host.online",
        actor: { kind: "person", person },
        capture: null,
        payload: { host: hostIdFor(person, name) },
      });
    }
    return true;
  }

  /** A Host's socket closed. Once the Host has none for `OFFLINE_GRACE_MS`, it is recorded Offline. */
  async detached(person: PersonName, name: string): Promise<void> {
    if (this.deps.attached(hostIdFor(person, name))) return;
    this.deps.sql.exec(
      "UPDATE hosts SET offline_since = ? WHERE person = ? AND name = ? AND recorded = 'online'",
      Date.now(),
      person,
      name,
    );
    await this.reschedule();
  }

  /**
   * Asks one of `person`'s Hosts to start an Agent, and waits up to `spawnWaitMs` for
   * it to register. `request` is already clean, apart from what only a Host can judge.
   */
  async spawn(person: PersonName, request: SpawnAgentRequest): Promise<SpawnResult> {
    const host = this.pick(person, request.host);
    if (!host.ok) return host;
    const { row } = host;
    const id = hostIdFor(person, row.name);
    const roots = JSON.parse(row.roots) as string[];
    if (!underRoots(request.cwd, roots)) {
      return {
        ok: false,
        status: 403,
        reason: `${request.cwd} is not under ${id}'s folders (${roots.join(", ") || "none"}). Add it with \`switchboard host install --root\`.`,
      };
    }
    const mode: PermissionMode = request.permissionMode ?? DEFAULT_PERMISSION_MODE;
    const max = isPermissionMode(row.max_mode) ? row.max_mode : DEFAULT_PERMISSION_MODE;
    if (!permissionModeWithin(mode, max)) {
      return { ok: false, status: 403, reason: `${id} starts Agents in at most the "${max}" permission mode.` };
    }
    if (this.running() >= this.deps.cap) {
      return {
        ok: false,
        status: 409,
        reason: `Hosts on this Channel already run or are starting ${this.deps.cap} Agents, the most allowed.`,
      };
    }

    const event = this.deps.append({
      type: "agent.spawn",
      actor: { kind: "person", person },
      capture: null,
      payload: {
        host: id,
        cli: request.cli,
        cwd: request.cwd,
        ...(request.nickname === undefined ? {} : { nickname: request.nickname }),
        ...(request.model === undefined ? {} : { model: request.model }),
        permissionMode: mode,
        ...(request.brief === undefined ? {} : { brief: request.brief }),
      },
    });
    const spawn = event.id;
    this.deps.sql.exec(
      "INSERT INTO host_spawns (id, person, host, state, requested_at) VALUES (?, ?, ?, 'pending', ?)",
      spawn,
      person,
      row.name,
      Date.now(),
    );
    const ended = new Promise<SpawnEnd>((resolve) => this.waiting.set(spawn, resolve));
    const sent = this.deps.sendTo(id, {
      type: "host.spawn",
      spawn,
      cli: request.cli,
      cwd: request.cwd,
      ...(request.nickname === undefined ? {} : { nickname: request.nickname }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.brief === undefined ? {} : { brief: request.brief }),
      permissionMode: mode,
      by: person,
    });
    if (!sent) this.failed(spawn, `${id} went Offline before the request reached it.`);
    await this.reschedule();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = await Promise.race([
      ended,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.deps.spawnWaitMs);
      }),
    ]);
    clearTimeout(timer);
    this.waiting.delete(spawn);
    if (end === null) return { ok: true, spawn, host: id };
    if ("reason" in end) return { ok: false, status: 502, reason: `${id} could not start the Agent: ${end.reason}` };
    return { ok: true, spawn, host: id, agent: end.agent };
  }

  /**
   * Agent `agent` registered with spawn `spawn`, from `person`'s Host `name`. Records
   * `agent.spawned` once, for a spawn still pending on that Host; anything else is ignored.
   */
  spawned(person: PersonName, name: string, spawn: string, agent: Agent): void {
    if (!this.takePending(spawn, person, name, "spawned")) return;
    this.deps.append({
      type: "agent.spawned",
      actor: { kind: "agent", agentId: agent.id },
      capture: null,
      payload: { spawn, host: hostIdFor(person, name), agent: agent.id },
    });
    this.waiting.get(spawn)?.({ agent });
  }

  /** `person`'s Host `name` says it could not start spawn `spawn`. Ignored unless that spawn is its, and pending. */
  hostFailed(person: PersonName, name: string, spawn: string, reason: string): void {
    const row = this.spawnRow(spawn);
    if (row === undefined || row.person !== person || row.host !== name) return;
    this.failed(spawn, reason);
  }

  /** Asks the Host that runs Agent `agent` to stop it. Only the Agent's own Person may. */
  stop(person: PersonName, agentId: AgentId): { ok: true; host: HostId } | HostRefusal {
    const agent = this.deps.findAgent(agentId);
    if (agent === null) return { ok: false, status: 404, reason: `No Agent ${agentId} on this Channel.` };
    if (agent.person !== person) {
      return {
        ok: false,
        status: 403,
        reason: `${agentId} is ${agent.person}'s Agent. Only its own Person may stop it.`,
      };
    }
    if (agent.host === undefined) {
      return {
        ok: false,
        status: 409,
        reason: `${agentId} runs in a terminal, not on a Host. Stop it there.`,
      };
    }
    if (agent.presence === "gone") return { ok: false, status: 409, reason: `${agentId} is Gone already.` };
    const host = agent.host;
    if (!this.deps.attached(host)) {
      return { ok: false, status: 409, reason: `${host} is Offline, so it cannot stop ${agentId} now.` };
    }
    this.deps.append({
      type: "agent.stop",
      actor: { kind: "person", person },
      capture: null,
      payload: { agent: agentId, host },
    });
    if (!this.deps.sendTo(host, { type: "host.stop", agent: agentId })) {
      return { ok: false, status: 409, reason: `${host} went Offline before the request reached it.` };
    }
    return { ok: true, host };
  }

  /** The alarm: records Hosts that stayed away Offline, and fails spawns nobody answered. */
  async alarm(now = Date.now()): Promise<void> {
    const away = this.deps.sql
      .exec<HostRow>(
        "SELECT * FROM hosts WHERE recorded = 'online' AND offline_since IS NOT NULL AND offline_since <= ?",
        now - OFFLINE_GRACE_MS,
      )
      .toArray();
    for (const row of away) {
      const id = hostIdFor(row.person, row.name);
      if (this.deps.attached(id)) {
        this.deps.sql.exec("UPDATE hosts SET offline_since = NULL WHERE person = ? AND name = ?", row.person, row.name);
        continue;
      }
      this.deps.sql.exec(
        "UPDATE hosts SET recorded = 'offline', offline_since = NULL WHERE person = ? AND name = ?",
        row.person,
        row.name,
      );
      this.deps.append({
        type: "host.offline",
        actor: { kind: "person", person: row.person },
        capture: null,
        payload: { host: id },
      });
    }
    const expired = this.deps.sql
      .exec<SpawnRow>(
        "SELECT * FROM host_spawns INDEXED BY host_spawns_pending WHERE state = 'pending' AND requested_at <= ?",
        now - SPAWN_EXPIRES_MS,
      )
      .toArray();
    for (const row of expired) {
      this.failed(
        row.id,
        `${hostIdFor(row.person, row.host)} did not start it within ${SPAWN_EXPIRES_MS / 60_000} minutes.`,
      );
    }
    await this.reschedule();
  }

  /** The Host a spawn goes to: the one named, or the Person's most recently seen Live Host. */
  private pick(person: PersonName, name: string | undefined): { ok: true; row: HostRow } | HostRefusal {
    if (name !== undefined) {
      const row = this.row(person, name);
      if (row === undefined) {
        return {
          ok: false,
          status: 404,
          reason: `You have no Host named ${name}. Run \`switchboard host install\` on it.`,
        };
      }
      if (!this.deps.attached(hostIdFor(person, name))) {
        return { ok: false, status: 409, reason: `${hostIdFor(person, name)} is Offline.` };
      }
      return { ok: true, row };
    }
    const live = this.deps.sql
      .exec<HostRow>("SELECT * FROM hosts WHERE person = ? ORDER BY last_seen_at DESC", person)
      .toArray()
      .find((row) => this.deps.attached(hostIdFor(person, row.name)));
    if (live === undefined) {
      return { ok: false, status: 409, reason: "None of your Hosts is Live. Run `switchboard host install` on one." };
    }
    return { ok: true, row: live };
  }

  /** Ends a pending spawn as failed: records it and tells the request waiting on it. */
  private failed(spawn: string, reason: string): void {
    const row = this.spawnRow(spawn);
    if (row === undefined || !this.takePending(spawn, row.person, row.host, "failed")) return;
    this.deps.append({
      type: "agent.spawn.failed",
      actor: { kind: "person", person: row.person },
      capture: null,
      payload: { spawn, host: hostIdFor(row.person, row.host), reason },
    });
    this.waiting.get(spawn)?.({ reason });
  }

  /** Moves spawn `spawn` from pending to `state`. False when it was not pending on that Host. */
  private takePending(spawn: string, person: PersonName, name: string, state: "spawned" | "failed"): boolean {
    return (
      this.deps.sql
        .exec(
          "UPDATE host_spawns SET state = ? WHERE id = ? AND person = ? AND host = ? AND state = 'pending' RETURNING id",
          state,
          spawn,
          person,
          name,
        )
        .toArray().length > 0
    );
  }

  private async reschedule(): Promise<void> {
    const offline = this.deps.sql
      .exec<{ at: number | null }>("SELECT MIN(offline_since) AS at FROM hosts WHERE recorded = 'online'")
      .one().at;
    const pending = this.deps.sql
      .exec<{ at: number | null }>(
        "SELECT MIN(requested_at) AS at FROM host_spawns INDEXED BY host_spawns_pending WHERE state = 'pending'",
      )
      .one().at;
    const deadlines = [
      ...(offline === null ? [] : [offline + OFFLINE_GRACE_MS]),
      ...(pending === null ? [] : [pending + SPAWN_EXPIRES_MS]),
    ];
    await this.deps.schedule(deadlines.length === 0 ? null : Math.min(...deadlines));
  }

  private row(person: PersonName, name: string): HostRow | undefined {
    return this.deps.sql.exec<HostRow>("SELECT * FROM hosts WHERE person = ? AND name = ?", person, name).toArray()[0];
  }

  private spawnRow(spawn: string): SpawnRow | undefined {
    return this.deps.sql.exec<SpawnRow>("SELECT * FROM host_spawns WHERE id = ?", spawn).toArray()[0];
  }

  private toHost(row: HostRow): Host {
    return rowToHost(row, this.deps.attached(hostIdFor(row.person, row.name)));
  }
}
