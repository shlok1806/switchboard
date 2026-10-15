// One Durable Object per Channel (ADR 0004), and one Channel per GitHub repo,
// named by `owner/repo` (ADR 0007). It owns the Channel's Persons, who may join
// (write access to the repo, and the Agent tokens), its append-only Event stream
// in SQLite, and every live WebSocket, using WebSocket hibernation so idle
// subscribers cost nothing.

import { DurableObject } from "cloudflare:workers";
import type {
  AccountUsage,
  Actor,
  Agent,
  AgentContext,
  AgentId,
  AgentRole,
  ApprovalDenyMessage,
  Capture,
  ChannelEvent,
  DeliveryMessage,
  DenyApprovalRequest,
  DirectiveInterruptMessage,
  DirectiveMessage,
  EventPayloads,
  EventType,
  Holder,
  HookCaptureReply,
  Host,
  HostId,
  HostSpawnedMessage,
  HostSpawnMessage,
  HostStopMessage,
  InterruptAttached,
  InterruptMessage,
  InterruptResult,
  MemoryQuery,
  PendingApproval,
  Person,
  PersonName,
  PostNoteRequest,
  ProxyCaptureReply,
  ProxyMode,
  RegisterAgentRequest,
  RegisterHostRequest,
  ReportedPresence,
  ReportedUsage,
  SpawnAgentRequest,
  StreamMessage,
  Task,
  TaskNumber,
  TouchedFile,
} from "../../shared/src/index";
import {
  DEFAULT_GONE_AFTER_SECONDS,
  DEFAULT_HOST_AGENTS_LIVE_CAP,
  DEFAULT_LEAD_AGENTS_LIVE_CAP,
  DEFAULT_MEMORY_NOTES_PER_DAY,
  hostIdFor,
  LIVE_PING,
  LIVE_PONG,
  MAX_SPAWN_FAILURE_LENGTH,
} from "../../shared/src/index";
import { Access, type AdmitResult, MEMBERSHIP_TTL_MS } from "./access";
import { AgentRoster, createAgentsTable, type RosterResult } from "./agents";
import { Alarms } from "./alarms";
import type { Credential } from "./auth";
import { Branches, type CodeEventResult } from "./branches";
import { type Caller, type ClaimRefusal, type ClaimResult, Claims } from "./claims";
import { DIRECTIVES_SCHEMA, type DirectiveResult, Directives } from "./directives";
import { type CodeChange, type GitHub, gitHubFor, type WebhookChange } from "./github/index";
import { HOOK_CAPTURE_SCHEMA, HookCapture } from "./hook-capture";
import { DEFAULT_SPAWN_WAIT_MS, type HostRefusal, Hosts, type SpawnResult } from "./hosts";
import { MEMORY_SCHEMA, Memory, type MemoryReadResult, type NoteResult } from "./memory";
import { ProxyCapture } from "./proxy-capture";
import { jevFor } from "./relay/jev";
import { interruptIntervalMs, interruptThreshold, RELAY_SCHEMA, Relay } from "./relay/relay";
import { StaleClaims } from "./stale-claims";
import { StatusComments } from "./status-comment";
import { type NewTask, type TaskResult, Tasks, workingTasks } from "./tasks";
import { AccountUsageStore } from "./usage";
import { Wakes } from "./wakes";

type EventRow = {
  seq: number;
  id: string;
  at: string;
  type: string;
  actor: string;
  capture: string | null;
  task: number | null;
  turn: string | null;
  payload: string;
};

type PersonRow = { name: string; time_zone: string; joined_at: string };

/** The parts of an Event its author supplies. The Channel adds `id`, `seq` and `at`. */
export interface NewEvent<K extends EventType> {
  type: K;
  actor: Actor;
  capture: Capture | null;
  payload: EventPayloads[K];
  task?: TaskNumber;
  turn?: string;
}

/**
 * Creates the `events` table, which is append-only: this object only ever INSERTs
 * into it, apart from the one-time backfill of the actor columns below.
 *
 * The table holds the Channel's whole history, so every query on a hot path must
 * reach its rows through an index; Durable Objects bill each row a query reads. The
 * partial indexes cover the few Event types that are looked up later: pushes and
 * merges (the Relay's recent code) and Updates (the status comment, Takeovers).
 * `actor_kind` and `actor_id` copy the actor's kind and Agent ID or Person name out
 * of the JSON, so an index can find one holder's Updates.
 */
export function createEventsTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      capture TEXT,
      task INTEGER,
      turn TEXT,
      payload TEXT NOT NULL,
      actor_kind TEXT,
      actor_id TEXT
    );
  `);
  // What one-off work on the whole table writes, per UTC day (`buildHistoryIndexes`).
  // `sizes` is what the missing history indexes would cover, once that day has counted them.
  sql.exec("CREATE TABLE IF NOT EXISTS index_builds (day TEXT PRIMARY KEY, rows INTEGER NOT NULL, sizes TEXT)");
  const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('events')").toArray();
  if (!columns.some((c) => c.name === "actor_kind")) {
    // A table made before the actor columns: add them and fill them in, once. That
    // writes a row per Event, so it spends the same day's budget as building indexes.
    sql.exec("ALTER TABLE events ADD COLUMN actor_kind TEXT");
    sql.exec("ALTER TABLE events ADD COLUMN actor_id TEXT");
    const filled = sql.exec(`
      UPDATE events SET
        actor_kind = json_extract(actor, '$.kind'),
        actor_id = coalesce(json_extract(actor, '$.agentId'), json_extract(actor, '$.person'))
    `);
    filled.toArray();
    chargeIndexBuilds(sql, utcDay(), filled.rowsWritten);
  }
  sql.exec(`
    CREATE INDEX IF NOT EXISTS events_code ON events (seq) WHERE type IN ('push', 'merge');
    CREATE INDEX IF NOT EXISTS events_updates_by_task ON events (task, seq) WHERE type = 'update';
    CREATE INDEX IF NOT EXISTS events_updates_by_actor ON events (actor_kind, actor_id, seq) WHERE type = 'update';
    CREATE INDEX IF NOT EXISTS events_updates_by_actor_task ON events (actor_kind, actor_id, task, seq) WHERE type = 'update';
  `);
}

/**
 * The indexes the scoped history reads need (an Agent's, a Task's, Events by Wake).
 * Each is partial, so it writes a row only for the Events its `where` holds.
 */
export const HISTORY_INDEXES = [
  { name: "events_by_agent", on: "(actor_id, seq)", where: "actor_kind = 'agent'" },
  { name: "events_directives_to", on: "(json_extract(payload, '$.to'), seq)", where: "type = 'directive'" },
  // Renames of an Agent, and its stops by its Person (ADR 0009, ADR 0015).
  {
    name: "events_about_agent",
    on: "(json_extract(payload, '$.agent'), seq)",
    where: "type IN ('agent.rename', 'agent.stop')",
  },
  { name: "events_by_task", on: "(task, seq)", where: "task IS NOT NULL AND type <> 'verdict'" },
  { name: "events_wakes", on: "(seq)", where: "type = 'wake'" },
] as const;

export type HistoryIndex = (typeof HISTORY_INDEXES)[number]["name"];

/**
 * Rows a Channel may spend building history indexes in one UTC day. Building an
 * index writes one row per Event it covers. The free plan allows 100,000 written rows
 * a day, which may be the account's rather than one Durable Object's, and a Channel's
 * own traffic used up to 51,000 on its busiest day: so a quarter of it.
 */
export const INDEX_BUILD_BUDGET = 25_000;

/**
 * The largest index a Channel builds, on a day it has spent nothing else. Bigger than
 * that, the index is never built and its history reads say so (`IndexTooLarge`).
 */
export const INDEX_BUILD_CEILING = 80_000;

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Adds `rows` written by one-off work to `day`'s spend. */
function chargeIndexBuilds(sql: SqlStorage, day: string, rows: number): void {
  sql.exec(
    "INSERT INTO index_builds (day, rows) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET rows = rows + excluded.rows",
    day,
    rows,
  );
}

/** Which history indexes exist, and which never will: they cover more than `INDEX_BUILD_CEILING` Events. */
export interface HistoryIndexes {
  built: Set<HistoryIndex>;
  tooLarge: Set<HistoryIndex>;
}

/**
 * Builds the history indexes that fit today's budget, and says which exist. A day that
 * has spent nothing may build one index past the budget, up to the ceiling, so no index
 * waits forever. Counting what the missing indexes would cover reads every Event, so it
 * is done once a day at most: a later start that day reuses the count.
 */
export function buildHistoryIndexes(
  sql: SqlStorage,
  today = utcDay(),
  budget = INDEX_BUILD_BUDGET,
  ceiling = INDEX_BUILD_CEILING,
): HistoryIndexes {
  const existing = new Set(
    sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'")
      .toArray()
      .map((row) => row.name),
  );
  const missing = HISTORY_INDEXES.filter((index) => !existing.has(index.name));
  const tooLarge = new Set<HistoryIndex>();
  if (missing.length > 0) {
    const day = sql
      .exec<{ rows: number; sizes: string | null }>("SELECT rows, sizes FROM index_builds WHERE day = ?", today)
      .toArray()[0];
    let sizes: Partial<Record<HistoryIndex, number>>;
    if (day?.sizes != null) {
      // Counted today already: what is left is built on a later day.
      sizes = JSON.parse(day.sizes) as Partial<Record<HistoryIndex, number>>;
      for (const index of missing) if ((sizes[index.name] ?? 0) > ceiling) tooLarge.add(index.name);
    } else {
      const counted = sql
        .exec<Record<string, number>>(
          `SELECT ${missing.map((index, i) => `coalesce(sum(CASE WHEN ${index.where} THEN 1 ELSE 0 END), 0) AS n${i}`).join(", ")} FROM events`,
        )
        .one();
      sizes = Object.fromEntries(missing.map((index, i) => [index.name, Number(counted[`n${i}`] ?? 0)]));
      let spent = day?.rows ?? 0;
      for (const index of missing) {
        const rows = sizes[index.name] ?? 0;
        if (rows > ceiling) {
          tooLarge.add(index.name);
          continue;
        }
        if (spent + rows > budget && spent > 0) continue;
        const cursor = sql.exec(`CREATE INDEX IF NOT EXISTS ${index.name} ON events ${index.on} WHERE ${index.where}`);
        cursor.toArray();
        // What the build wrote, or what the count said it would if SQLite reports less.
        spent += Math.max(rows, cursor.rowsWritten);
        existing.add(index.name);
      }
      sql.exec(
        "INSERT INTO index_builds (day, rows, sizes) VALUES (?, ?, ?) ON CONFLICT (day) DO UPDATE SET rows = excluded.rows, sizes = excluded.sizes",
        today,
        spent,
        JSON.stringify(sizes),
      );
    }
  }
  return {
    built: new Set(HISTORY_INDEXES.map((index) => index.name).filter((name) => existing.has(name))),
    tooLarge,
  };
}

/** The answer to a scoped history read whose index is not built yet: it is built on a later day. */
export type IndexPending = { pending: HistoryIndex };

/** The answer to a scoped history read whose index covers too many Events to build. */
export type IndexTooLarge = { tooLarge: HistoryIndex };

/** The actor's kind and its Agent ID or Person name, as `actor_kind` and `actor_id` keep them. */
function actorColumns(actor: Actor): [string, string | null] {
  switch (actor.kind) {
    case "agent":
      return [actor.kind, actor.agentId];
    case "person":
      return [actor.kind, actor.person];
    default:
      return [actor.kind, null];
  }
}

function rowToEvent(row: EventRow): ChannelEvent {
  return {
    id: row.id,
    seq: row.seq,
    at: row.at,
    type: row.type,
    actor: JSON.parse(row.actor),
    capture: row.capture,
    ...(row.task === null ? {} : { task: row.task }),
    ...(row.turn === null ? {} : { turn: row.turn }),
    payload: JSON.parse(row.payload),
  } as ChannelEvent;
}

function rowToPerson(row: PersonRow): Person {
  return { name: row.name, timeZone: row.time_zone, joinedAt: row.joined_at };
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export class Channel extends DurableObject<Env> {
  /** The one Durable Object alarm, shared by every job that wakes on a timer. */
  private readonly alarms: Alarms;
  /** Tasks mirrored from GitHub Issues (ADR 0001). */
  private readonly tasks: Tasks;
  /** Agents and their Presence. */
  private readonly agents: AgentRoster;
  /** Hook Events the wrappers send, and each Agent's touched files. */
  private readonly hooks: HookCapture;
  /** The Proxy Events wrappers send, one per model turn. */
  private readonly proxy: ProxyCapture;
  /** Claims on Tasks, and their Steps. */
  private readonly claims: Claims;
  /** Task branches, pull requests, and the pushes and merges GitHub reports. */
  private readonly branches: Branches;
  /** Stale Claims, Takeovers and Claims blocked after they were made (ADR 0002). */
  private readonly staleClaims: StaleClaims;
  /** Verdicts for every new Event and connected Agent, and Queue deliveries (ADR 0003, ADR 0005). */
  private readonly relay: Relay;
  private readonly usage: AccountUsageStore;
  /** Directives from Persons to Agents, delivered without the Relay (ADR 0005). */
  private readonly directives: Directives;
  private readonly hosts: Hosts;
  /** Records the wrappers' idle wakes. */
  private readonly wakes: Wakes;
  /** Who may use the Channel: membership of the repo, and Agent tokens (ADR 0007). */
  private readonly access: Access;
  /** Each Issue's one status comment (issue #2). */
  private readonly status: StatusComments;
  /** The notes Agents write for each other (ADR 0019). */
  private readonly memory: Memory;
  /** The history indexes built so far (`buildHistoryIndexes`), and the UTC day they were last tried. */
  private historyIndexes: HistoryIndexes;
  private historyIndexesDay = utcDay();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    createEventsTable(ctx.storage.sql);
    this.historyIndexes = buildHistoryIndexes(ctx.storage.sql);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS persons (
        name TEXT PRIMARY KEY,
        time_zone TEXT NOT NULL,
        joined_at TEXT NOT NULL
      );
    `);
    createAgentsTable(ctx.storage.sql);
    this.usage = new AccountUsageStore(ctx.storage.sql);
    ctx.storage.sql.exec(HOOK_CAPTURE_SCHEMA);
    ctx.storage.sql.exec(RELAY_SCHEMA);
    ctx.storage.sql.exec(DIRECTIVES_SCHEMA);
    ctx.storage.sql.exec(MEMORY_SCHEMA);
    const notesPerDay = Number(env.MEMORY_NOTES_PER_DAY);
    this.memory = new Memory(
      ctx.storage.sql,
      Number.isInteger(notesPerDay) && notesPerDay >= 0 ? notesPerDay : DEFAULT_MEMORY_NOTES_PER_DAY,
    );
    // Answer keepalive pings without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(LIVE_PING, LIVE_PONG));
    this.alarms = new Alarms(ctx.storage);
    this.access = new Access({
      sql: ctx.storage.sql,
      gitHub: () => this.gitHub(),
      refused: (person) => this.closeSockets(person, 4003, "No longer a member of this Channel's repo."),
    });
    this.tasks = new Tasks({
      storage: ctx.storage,
      gitHub: () => this.gitHub(),
      nextReconcile: () => this.alarms.deadline("tasks"),
      scheduleReconcile: (at) => this.alarms.set("tasks", at),
      append: (event) => this.append(event),
      broadcast: (message) => this.broadcast(message),
      changed: (task) => this.staleClaims.taskChanged(task),
    });
    const goneAfterSeconds = Number(env.PRESENCE_GONE_AFTER_SECONDS);
    this.agents = new AgentRoster({
      sql: ctx.storage.sql,
      schedulePresenceCheck: (at) => this.alarms.set("presence", at),
      goneAfterMs: (goneAfterSeconds > 0 ? goneAfterSeconds : DEFAULT_GONE_AFTER_SECONDS) * 1000,
      append: (event) => this.append(event),
      broadcast: (message) => this.broadcast(message),
      presenceChanged: (id, presence) => {
        this.staleClaims.presenceChanged(id, presence);
        // An Agent's token stops working when it goes Gone; resuming issues a new one.
        if (presence === "gone" && this.access.revokeAgent(id)) {
          this.closeSockets(agentTag(id), 4001, "Agent token revoked: the Agent is Gone.");
        }
      },
    });
    this.hooks = new HookCapture({
      sql: ctx.storage.sql,
      touchAgent: (person, id) => this.agents.touch(person, id),
      currentTask: (id) => this.currentTask(id),
      appendOnce: (id, event) => this.insert(id, event),
    });
    this.proxy = new ProxyCapture({
      touchAgent: (person, id) => this.agents.touch(person, id),
      currentTask: (id) => this.currentTask(id),
      appendOnce: (id, event) => this.insert(id, event),
    });
    this.status = new StatusComments({ sql: ctx.storage.sql, tasks: this.tasks, agents: this.agents });
    this.claims = new Claims({
      tasks: this.tasks,
      agents: this.agents,
      status: this.status,
      gitHub: () => this.gitHub(),
      append: (event) => this.append(event),
    });
    this.branches = new Branches({
      tasks: this.tasks,
      claims: this.claims,
      gitHub: () => this.gitHub(),
      append: (event) => this.append(event),
      appendOnce: (id, event) => this.insert(id, event),
    });
    this.staleClaims = new StaleClaims({
      sql: ctx.storage.sql,
      tasks: this.tasks,
      agents: this.agents,
      claims: this.claims,
      append: (event) => this.append(event),
    });
    this.relay = new Relay({
      sql: ctx.storage.sql,
      heldTasks: () => this.tasks.held(),
      liveAgents: () => this.agents.live(),
      task: (number) => this.tasks.read(number),
      touchedFiles: (id) => this.hooks.touchedFiles(id),
      jev: () => jevFor(env),
      threshold: interruptThreshold(env.RELAY_INTERRUPT_THRESHOLD),
      interruptIntervalMs: interruptIntervalMs(env.RELAY_INTERRUPT_INTERVAL_SECONDS),
      append: (id, event) => {
        const stored = this.insert(id, event);
        if (!stored) throw new Error("Event ID collision");
        return stored;
      },
      sendTo: (person, message) => {
        for (const ws of this.personSockets(person)) send(ws, message);
      },
      interruptTo: (agent, message) => this.interruptTo(agent, message),
      waitUntil: (work) => this.ctx.waitUntil(work),
    });
    this.directives = new Directives({
      sql: ctx.storage.sql,
      findAgent: (id) => this.agents.find(id),
      append: (event) => this.append(event),
      sendTo: (person, message) => {
        for (const ws of this.personSockets(person)) send(ws, message);
      },
      interruptTo: (agent, message) => this.interruptTo(agent, message),
      waitUntil: (work) => this.ctx.waitUntil(work),
    });
    this.wakes = new Wakes({ sql: ctx.storage.sql, append: (event) => this.append(event) });
    const wait = Number((env as { HOST_SPAWN_WAIT_SECONDS?: string }).HOST_SPAWN_WAIT_SECONDS);
    this.hosts = new Hosts({
      sql: ctx.storage.sql,
      append: (event) => this.append(event),
      attached: (id) => this.hostSocket(id) !== null,
      sendTo: (id, message) => {
        const ws = this.hostSocket(id);
        return ws !== null && send(ws, message);
      },
      close: (id) => this.closeSockets(hostTag(id), 4004, "This Host was removed."),
      findAgent: (id) => this.agents.find(id),
      inSubtree: (lead, id) => this.agents.inSubtree(lead, id),
      liveInSubtree: (lead) => this.agents.liveInSubtree(lead),
      setParent: (id, parent) => this.agents.setParent(id, parent),
      schedule: (at) => this.alarms.set("hosts", at),
      cap: this.hostCap(),
      leadCap: this.leadCap(),
      spawnWaitMs: wait > 0 ? wait * 1000 : DEFAULT_SPAWN_WAIT_MS,
    });
  }

  /**
   * The shared alarm: runs each job whose deadline has come (the Task reconcile,
   * the Presence silence check). Each job schedules its own next run.
   */
  override async alarm(): Promise<void> {
    const due = this.alarms.takeDue();
    try {
      if (due.has("tasks")) await this.tasks.alarm();
      if (due.has("presence")) await this.agents.expireSilent();
      if (due.has("members")) await this.recheckMembers();
      if (due.has("hosts")) await this.hosts.alarm();
    } finally {
      await this.alarms.arm();
    }
  }

  /** The GitHub for this Channel's repo, or null when the App is not configured. */
  private gitHub(): GitHub | null {
    const repo = this.access.repo();
    return repo === null ? null : gitHubFor(this.env, repo);
  }

  /**
   * Admits a call to the Channel of `repo` (ADR 0007): a live Agent token, and a
   * Person with write access to the repo, checked with GitHub at most every few
   * minutes. `fresh` asks GitHub now, as sign-in does.
   */
  admit(repo: string, credential: Credential, dev: boolean, fresh = false): Promise<AdmitResult> {
    this.access.setRepo(repo);
    return this.access.admit(credential, dev, fresh);
  }

  /**
   * While streams are open, re-checks their Persons' access every few minutes, so
   * someone removed from the repo stops seeing the Channel even without a new call.
   */
  private async recheckMembers(): Promise<void> {
    const persons = new Set(this.ctx.getWebSockets().flatMap((ws) => this.ctx.getTags(ws).slice(0, 1)));
    await this.access.recheck(persons);
    await this.watchMembers();
  }

  private async watchMembers(): Promise<void> {
    const open = this.ctx.getWebSockets().length > 0;
    if (!open) await this.alarms.set("members", null);
    else if (this.alarms.deadline("members") === null) await this.alarms.set("members", Date.now() + MEMBERSHIP_TTL_MS);
  }

  /** Closes every WebSocket carrying `tag`: a Person's, or an Agent's (`agentTag`). */
  private closeSockets(tag: string, code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets(tag)) {
      try {
        ws.close(code, reason);
      } catch {
        // Already closed.
      }
    }
  }

  listTasks(): Promise<TaskResult<Task[]>> {
    return this.tasks.list();
  }

  getTask(number: TaskNumber): Promise<TaskResult<Task>> {
    return this.tasks.get(number);
  }

  /** A Person creating a Task, which creates its GitHub Issue first. */
  createTask(name: PersonName, task: NewTask): Promise<TaskResult<Task>> {
    this.join(name);
    return this.tasks.create(name, task);
  }

  /** Claims a Task for the caller, or, for a Person, for one of their own Agents. */
  claimTask(caller: Caller, number: TaskNumber, forAgent?: AgentId): Promise<ClaimResult> {
    this.join(caller.person);
    return this.claims.claim(caller, number, forAgent);
  }

  releaseTask(caller: Caller, number: TaskNumber): Promise<ClaimResult> {
    return this.claims.release(caller, number);
  }

  completeStep(caller: Caller, number: TaskNumber, index: number): Promise<ClaimResult> {
    return this.claims.completeStep(caller, number, index);
  }

  /** The holder's wrapper reporting the Task branch it created (ADR 0006). */
  recordBranch(caller: Caller, number: TaskNumber, branch: string): Promise<ClaimResult> {
    return this.branches.record(caller, number, branch);
  }

  /** The holder finishing a Task: a pull request that closes the Issue, and the Task goes to review. */
  finishTask(caller: Caller, number: TaskNumber, summary?: string): Promise<ClaimResult> {
    return this.branches.finish(caller, number, summary);
  }

  /** A verified GitHub `push` or `pull_request` delivery, recorded once per delivery ID. */
  gitHubCodeWebhook(repo: string, delivery: string, change: CodeChange): Promise<CodeEventResult> {
    this.access.setRepo(repo);
    return this.branches.codeEvent(delivery, change);
  }

  /** A Person moving a Stale Claim to themselves or one of their own Agents (ADR 0002). */
  takeoverTask(caller: Caller, number: TaskNumber, to: Holder): Promise<ClaimResult> {
    this.join(caller.person);
    return this.staleClaims.takeover(caller, number, to);
  }

  /** An Agent reporting one call to a Switchboard tool, recorded with the Tool Capture. */
  recordToolCall(
    caller: Caller,
    call: EventPayloads["tool.call"],
    task?: TaskNumber,
  ): { ok: true; event: ChannelEvent } | ClaimRefusal {
    const who = this.claims.resolve(caller);
    if (!who.ok) return who;
    if (who.acting.actor.kind !== "agent") {
      return { ok: false, status: 400, reason: "Only an Agent reports tool calls." };
    }
    const event = this.append({
      type: "tool.call",
      actor: who.acting.actor,
      capture: "tool",
      payload: call,
      ...(task === undefined ? {} : { task }),
    });
    return { ok: true, event };
  }

  /** A verified GitHub webhook delivery, reduced to the Issues it touched. */
  gitHubWebhook(repo: string, change: WebhookChange): Promise<TaskResult<null>> {
    this.access.setRepo(repo);
    return this.tasks.webhook(change);
  }

  /** Every Agent the Channel has seen, most recently seen first. */
  listAgents(): Agent[] {
    return this.agents.list();
  }

  /**
   * Registers the Agent for a CLI session, or brings it back on resume, and joins
   * its Person. This is where `switchboard run` trades the Person's session for a
   * new Agent token, bound to this one Agent (ADR 0007).
   */
  async registerAgent(person: PersonName, request: RegisterAgentRequest): Promise<RosterResult> {
    if (request.host !== undefined && this.hosts.find(person, request.host) === null) {
      return { ok: false, status: 409, reason: `You have no Host named ${request.host} on this Channel.` };
    }
    this.join(person);
    const result = this.withNextTurn(await this.agents.register(person, request));
    if (!result.ok) return result;
    if (request.usage !== undefined) this.recordUsage(request.usage);
    if (request.host !== undefined && request.spawn !== undefined) {
      this.hosts.spawned(person, request.host, request.spawn, result.agent);
    }
    return { ...result, token: await this.access.issueAgentToken(result.agent.id, person) };
  }

  async heartbeat(
    person: PersonName,
    id: AgentId,
    presence: ReportedPresence,
    usage?: ReportedUsage,
    context?: AgentContext,
  ): Promise<RosterResult> {
    const result = this.withNextTurn(await this.agents.heartbeat(person, id, presence, usage, context));
    if (result.ok && usage !== undefined) this.recordUsage(usage);
    return result;
  }

  /** Every account the Channel has usage readings for (ADR 0011). */
  listAccounts(): AccountUsage[] {
    return this.usage.list();
  }

  /** Keeps an account's `/usage` reading, when the report names the account, and tells the stream. */
  private recordUsage(usage: ReportedUsage): void {
    const identity = usage.email ?? usage.accountId;
    if (identity === undefined || usage.limits === undefined) return;
    const account = this.usage.record(identity, usage.plan, usage.limits);
    if (account !== null) this.broadcast({ type: "account", account });
  }

  /**
   * Hands the Agent's wrapper what the Agent must hear at its next turn, once: the
   * Claims it lost to a Takeover while it was Gone, and the Queued Events its
   * wrapper has not acknowledged over the WebSocket, and the Directives it has not
   * acknowledged either.
   */
  private withNextTurn(result: RosterResult): RosterResult {
    if (!result.ok) return result;
    const lostClaims = this.staleClaims.takeLostClaims(result.agent.id);
    const deliveries = this.relay.takeDeliveries(result.agent.id);
    const directives = this.directives.takeDirectives(result.agent.id);
    return {
      ...result,
      ...(lostClaims.length === 0 ? {} : { lostClaims }),
      ...(deliveries.length === 0 ? {} : { deliveries }),
      ...(directives.length === 0 ? {} : { directives }),
    };
  }

  endSession(person: PersonName, id: AgentId, detail?: string): Promise<RosterResult> {
    return this.agents.endSession(person, id, detail);
  }

  /**
   * A Person sending a Directive to one Agent, or a lead sending one to an Agent in its
   * subtree (ADR 0018). Refused through any other Agent's credentials.
   */
  sendDirective(caller: Caller, to: AgentId, text: string): DirectiveResult {
    if (caller.agent === undefined) {
      this.join(caller.person);
      return this.directives.send({ person: caller.person }, to, text);
    }
    const lead = this.lead(caller.agent, "send Directives");
    if (!lead.ok) return lead;
    if (!this.agents.inSubtree(caller.agent, to)) {
      return {
        ok: false,
        status: 403,
        reason: `${to} is not one of the Agents ${caller.agent} started. A lead sends Directives only to its own subtree.`,
      };
    }
    return this.directives.send({ person: caller.person, lead: caller.agent }, to, text);
  }

  /**
   * Agent `agent`, calling with its token, holds the lead role (ADR 0018). Otherwise a
   * refusal saying that only a Person may `act`, unless they make the Agent a lead.
   */
  private lead(agent: AgentId, act: string): { ok: true } | { ok: false; status: 403; reason: string } {
    if (this.agents.find(agent)?.role === "lead") return { ok: true };
    return {
      ok: false,
      status: 403,
      reason:
        `Only a Person may ${act}, or a lead for them. ${agent} is not a lead: its Person can make it one ` +
        `(\`switchboard role grant ${agent} lead\`, ADR 0018). Agents post Updates instead.`,
    };
  }

  /** The Agent's own Person grants it a role, or takes it back with null (ADR 0018). Never an Agent. */
  setAgentRole(caller: Caller, id: AgentId, role: AgentRole | null): RosterResult {
    if (caller.agent !== undefined) {
      return {
        ok: false,
        status: 403,
        reason: "Only the Agent's own Person grants or revokes a role, never an Agent.",
      };
    }
    this.join(caller.person);
    return this.agents.setRole(caller.person, id, role);
  }

  /**
   * Renames an Agent (ADR 0009): the Agent itself, through its token (the Tool
   * Capture), or any Person on the Channel. Everyone hears on the stream.
   */
  renameAgent(caller: Caller, id: AgentId, nickname: string | null): RosterResult {
    if (caller.agent !== undefined && caller.agent !== id) {
      return {
        ok: false,
        status: 403,
        reason: `This token belongs to Agent ${caller.agent}. An Agent renames itself only.`,
      };
    }
    if (caller.agent === undefined) this.join(caller.person);
    return this.agents.rename(
      id,
      nickname,
      caller.agent === undefined
        ? { actor: { kind: "person", person: caller.person }, capture: null }
        : { actor: { kind: "agent", agentId: caller.agent }, capture: "tool" },
    );
  }

  /** The model an Agent runs on, from its wrapper (ADR 0010): the Agent's own token or its own Person. */
  setAgentModel(
    caller: Caller,
    id: AgentId,
    model: string | null,
    effort: string | null,
    via: "proxy" | "config",
  ): RosterResult {
    if (caller.agent !== undefined && caller.agent !== id) {
      return {
        ok: false,
        status: 403,
        reason: `This token belongs to Agent ${caller.agent}. An Agent acts for itself only.`,
      };
    }
    return this.agents.setModel(caller.person, id, model, effort, via === "proxy" ? "proxy" : null);
  }

  /** The permission prompt an Agent's CLI shows, from its wrapper (ADR 0013): the Agent's own token or its own Person. */
  setAgentApproval(caller: Caller, id: AgentId, approval: PendingApproval | null): RosterResult {
    if (caller.agent !== undefined && caller.agent !== id) {
      return {
        ok: false,
        status: 403,
        reason: `This token belongs to Agent ${caller.agent}. An Agent acts for itself only.`,
      };
    }
    return this.agents.setApproval(caller.person, id, approval);
  }

  /** The Agent's own Person denies its open prompt from the Channel; its wrapper answers the hook (ADR 0014). */
  denyAgentApproval(caller: Caller, id: AgentId, deny: DenyApprovalRequest): RosterResult {
    if (caller.agent !== undefined) {
      return { ok: false, status: 403, reason: "Only the Agent's own Person can deny its prompt, never an Agent." };
    }
    return this.agents.denyApproval(caller.person, id, deny, () =>
      this.interruptTo(id, {
        type: "approval.deny",
        agent: id,
        id: deny.id,
        person: caller.person,
        ...(deny.message === undefined ? {} : { message: deny.message }),
      }),
    );
  }

  /** Sets an Agent's Proxy mode; only its own Person may. Its wrapper hears on the stream. */
  setProxyMode(person: PersonName, id: AgentId, mode: ProxyMode): RosterResult {
    return this.agents.setProxyMode(person, id, mode);
  }

  /**
   * Joins a Person to the Channel. The first time a name is seen it records a
   * `person.join` Event; later calls return the existing Person, updating the
   * time zone when a valid one is given.
   */
  join(name: PersonName, timeZone?: string): Person {
    const zone = timeZone !== undefined && isTimeZone(timeZone) ? timeZone : undefined;
    const existing = this.ctx.storage.sql.exec<PersonRow>("SELECT * FROM persons WHERE name = ?", name).toArray()[0];
    if (existing) {
      if (zone === undefined || zone === existing.time_zone) return rowToPerson(existing);
      this.ctx.storage.sql.exec("UPDATE persons SET time_zone = ? WHERE name = ?", zone, name);
      const person = rowToPerson({ ...existing, time_zone: zone });
      this.broadcast({ type: "person", person });
      return person;
    }
    const person: Person = { name, timeZone: zone ?? "UTC", joinedAt: new Date().toISOString() };
    this.ctx.storage.sql.exec(
      "INSERT INTO persons (name, time_zone, joined_at) VALUES (?, ?, ?)",
      person.name,
      person.timeZone,
      person.joinedAt,
    );
    this.broadcast({ type: "person", person });
    this.append({
      type: "person.join",
      actor: { kind: "person", person: name },
      capture: null,
      payload: { timeZone: person.timeZone },
    });
    return person;
  }

  /**
   * Records an Update: one a Person wrote directly (from the CLI or the Dashboard),
   * or one an Agent posted through Switchboard's tools (the Tool Capture).
   */
  postUpdate(caller: Caller, text: string, task?: TaskNumber): { ok: true; event: ChannelEvent } | ClaimRefusal {
    this.join(caller.person);
    const who = this.claims.resolve(caller);
    if (!who.ok) return who;
    const event = this.append({
      type: "update",
      actor: who.acting.actor,
      capture: who.acting.capture,
      payload: { text },
      ...(task === undefined ? {} : { task }),
    });
    // The holder's Update shows as the last Update in the Issue's status comment.
    if (task !== undefined) this.ctx.waitUntil(this.claims.updated(who.acting, task));
    return { ok: true, event };
  }

  /**
   * Agent `caller.agent` writes a note for the Channel (ADR 0019). Only Agents write
   * notes; a Person speaks with an Update or a Directive. Without a Task, the note is
   * about the Task the Agent works on now.
   */
  writeNote(caller: Caller, note: PostNoteRequest): NoteResult | ClaimRefusal {
    if (caller.agent === undefined) {
      return {
        ok: false,
        status: 403,
        reason: "Only Agents write notes. A Person tells the Channel with an Update, or an Agent with a Directive.",
      };
    }
    const who = this.claims.resolve(caller);
    if (!who.ok) return who;
    const admitted = this.memory.admit();
    if (!admitted.ok) return admitted;
    const nickname = this.agents.find(caller.agent)?.nickname;
    const task = note.task ?? this.currentTask(caller.agent) ?? undefined;
    const event = this.append({
      type: "memory.note",
      actor: who.acting.actor,
      capture: who.acting.capture,
      payload: {
        text: note.text,
        tags: note.tags,
        ...(note.files === undefined ? {} : { files: note.files }),
        ...(nickname === undefined ? {} : { nickname }),
      },
      ...(task === undefined ? {} : { task }),
    });
    return { ok: true, note: this.memory.keep(event) };
  }

  /** The Channel's notes, for any Person or Agent on it (ADR 0019). */
  readMemory(query: MemoryQuery): MemoryReadResult {
    return this.memory.read(query);
  }

  /** Events with `seq` greater than `after`, oldest first. */
  history(after: number, limit: number): ChannelEvent[] {
    return this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit)
      .toArray()
      .map(rowToEvent);
  }

  /** The latest `count` Events with `seq` below `before`, oldest first. */
  latestEvents(count: number, before = Number.MAX_SAFE_INTEGER): ChannelEvent[] {
    return this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?", before, count)
      .toArray()
      .reverse()
      .map(rowToEvent);
  }

  /**
   * The latest `count` Events about Agent `agent` with `seq` below `before`, oldest
   * first: what it did, the Directives to it and its renames by others.
   */
  latestEventsOfAgent(
    agent: AgentId,
    count: number,
    before = Number.MAX_SAFE_INTEGER,
  ): ChannelEvent[] | IndexPending | IndexTooLarge {
    const pending = this.pendingIndex("events_by_agent", "events_directives_to", "events_about_agent");
    if (pending) return pending;
    const sql = this.ctx.storage.sql;
    const rows = [
      ...sql.exec<EventRow>(
        `SELECT * FROM events INDEXED BY events_by_agent
         WHERE actor_kind = 'agent' AND actor_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
        agent,
        before,
        count,
      ),
      ...sql.exec<EventRow>(
        `SELECT * FROM events INDEXED BY events_directives_to
         WHERE type = 'directive' AND json_extract(payload, '$.to') = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
        agent,
        before,
        count,
      ),
      ...sql.exec<EventRow>(
        `SELECT * FROM events INDEXED BY events_about_agent
         WHERE type IN ('agent.rename', 'agent.stop') AND json_extract(payload, '$.agent') = ? AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
        agent,
        before,
        count,
      ),
    ];
    // An Agent that renamed itself is in two of the reads.
    const bySeq = new Map(rows.map((row) => [row.seq, row]));
    return [...bySeq.values()]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, count)
      .reverse()
      .map(rowToEvent);
  }

  /**
   * The latest `count` Events on Task `task` with `seq` below `before`, oldest first.
   * Verdicts are left out, as from the index: there are many per Event, and the
   * Dashboard reads them with the Events they judge.
   */
  latestEventsOfTask(
    task: TaskNumber,
    count: number,
    before = Number.MAX_SAFE_INTEGER,
  ): ChannelEvent[] | IndexPending | IndexTooLarge {
    const pending = this.pendingIndex("events_by_task");
    if (pending) return pending;
    return this.ctx.storage.sql
      .exec<EventRow>(
        `SELECT * FROM events INDEXED BY events_by_task
         WHERE task = ? AND type <> 'verdict' AND seq < ? ORDER BY seq DESC LIMIT ?`,
        task,
        before,
        count,
      )
      .toArray()
      .reverse()
      .map(rowToEvent);
  }

  /** The first named index not built, after trying once more if a new day's budget has begun. */
  private pendingIndex(...names: HistoryIndex[]): IndexPending | IndexTooLarge | undefined {
    const today = utcDay();
    if (today !== this.historyIndexesDay && names.some((name) => !this.historyIndexes.built.has(name))) {
      this.historyIndexesDay = today;
      this.historyIndexes = buildHistoryIndexes(this.ctx.storage.sql, today);
    }
    const tooLarge = names.find((name) => this.historyIndexes.tooLarge.has(name));
    if (tooLarge !== undefined) return { tooLarge };
    const pending = names.find((name) => !this.historyIndexes.built.has(name));
    return pending === undefined ? undefined : { pending };
  }

  /** The Events with these IDs, oldest first; IDs the Channel does not know are left out. */
  eventsById(ids: readonly string[]): ChannelEvent[] {
    if (ids.length === 0) return [];
    return this.ctx.storage.sql
      .exec<EventRow>(`SELECT * FROM events WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY seq`, ...ids)
      .toArray()
      .map(rowToEvent);
  }

  /** The first `count` Wakes with `seq` above `after`, oldest first. */
  wakesAfter(after: number, count: number): ChannelEvent[] | IndexPending | IndexTooLarge {
    const pending = this.pendingIndex("events_wakes");
    if (pending) return pending;
    return this.ctx.storage.sql
      .exec<EventRow>(
        "SELECT * FROM events INDEXED BY events_wakes WHERE type = 'wake' AND seq > ? ORDER BY seq LIMIT ?",
        after,
        count,
      )
      .toArray()
      .map(rowToEvent);
  }

  /** Every Person who has joined the Channel. */
  listPersons(): Person[] {
    return this.ctx.storage.sql.exec<PersonRow>("SELECT * FROM persons ORDER BY name").toArray().map(rowToPerson);
  }

  /**
   * Upgrades an already-admitted request to the live stream. The Worker passes the
   * admitted Person as `?person=`, the Agent when the stream was opened with an
   * Agent token as `?agent=`, and the resume cursor as `?after=`. An Agent's stream
   * is its wrapper's: only it may send that Agent's Hook and Proxy Events.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("person");
    const agent = url.searchParams.get("agent");
    const host = url.searchParams.get("host");
    const after = url.searchParams.get("after");
    if (name === null) return new Response("Missing person", { status: 400 });

    if (host !== null) {
      // A Host's socket only carries what the Channel asks of that Host: no stream.
      if (this.hosts.find(name, host) === null) {
        return Response.json({ error: `You have no Host named ${host} on this Channel.` }, { status: 404 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, [name, hostTag(hostIdFor(name, host))]);
      server.serializeAttachment({ at: Date.now() } satisfies HostAttachment);
      this.hosts.attach(name, host);
      await this.watchMembers();
      return new Response(null, { status: 101, webSocket: client });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, agent === null ? [name] : [name, agentTag(agent as AgentId)]);
    // Everything below is synchronous, so no other Event can be appended
    // between the backlog and the live stream: none is missed or sent twice.
    if (after !== null) {
      for (const event of this.history(Number(after), Number.MAX_SAFE_INTEGER)) {
        send(server, { type: "event", event });
      }
    }
    for (const agent of this.agents.list()) send(server, { type: "agent", agent });
    this.join(name);
    await this.watchMembers();
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * The stream is receive-only except for what a wrapper says about its own Agent: its Hook
   * and Proxy Events (with the reply on the same socket), what it holds for the next turn,
   * whether it typed an Interrupt or Directive, and its Wakes. Clients do everything else
   * over HTTP.
   */
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const type = (frame as { type?: unknown }).type;
    if (
      type !== "hook" &&
      type !== "proxy" &&
      type !== "delivery.ack" &&
      type !== "directive.ack" &&
      type !== "interrupt.attach" &&
      type !== "interrupt.result" &&
      type !== "directive.result" &&
      type !== "wake" &&
      type !== "wake.capped" &&
      type !== "host.spawn.failed"
    ) {
      return;
    }
    const [person, tag] = this.ctx.getTags(ws);
    if (person === undefined) return;
    if (type === "host.spawn.failed") {
      // Only a Host's own socket answers for its spawns.
      const host = tag?.startsWith(HOST_TAG) ? tag.slice(HOST_TAG.length + person.length + 1) : null;
      const { spawn, reason } = frame as { spawn?: unknown; reason?: unknown };
      if (host === null || typeof spawn !== "string" || typeof reason !== "string") return;
      this.hosts.hostFailed(person, host, spawn, reason.slice(0, MAX_SPAWN_FAILURE_LENGTH) || "no reason given");
      return;
    }
    // The Agent whose token opened this socket; a Person's socket speaks for no Agent.
    const socketAgent = tag?.startsWith(AGENT_TAG) ? (tag.slice(AGENT_TAG.length) as AgentId) : null;
    const body = frame as Record<string, unknown>;
    if (type === "interrupt.attach" || type === "interrupt.result" || type === "directive.result") {
      // Only the Agent's own wrapper may speak for it.
      const agent = body.agent;
      if (typeof agent !== "string" || agent !== socketAgent) return;
      if (type === "interrupt.attach") {
        // Kept on the socket itself, so it survives hibernation and goes when the socket does.
        const attached: WrapperAttachment = { agent: agent as AgentId, at: Date.now() };
        ws.serializeAttachment(attached);
        // Tells the wrapper its Agent's Interrupts and Directives come here from now on.
        send(ws, { type: "interrupt.attached", agent: agent as AgentId });
        return;
      }
      const result = parseInterruptResult(body);
      if (result === null) return;
      if (type === "interrupt.result") this.relay.interruptAnswered(result);
      else this.directives.answered(result.agent, result.id, result.typed ? "typed" : result.reason);
      return;
    }
    if (type === "wake" || type === "wake.capped") {
      // The wrapper woke its idle Agent, or stopped at the cap. Only the Agent's own wrapper may say so.
      const agent = body.agent;
      if (typeof agent !== "string" || agent !== socketAgent) return;
      if (type === "wake.capped") {
        this.wakes.capped(agent as AgentId);
        return;
      }
      const strings = (value: unknown) =>
        Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
      this.wakes.woke(agent as AgentId, strings(body.deliveries), strings(body.directives));
      return;
    }
    if (type === "delivery.ack" || type === "directive.ack") {
      // The wrapper holds these for its Agent's next turn. Only the Agent's own Person may say so.
      const agent = body.agent;
      if (typeof agent !== "string" || !Array.isArray(body.ids)) return;
      if (agent !== socketAgent) return;
      const ids = body.ids.filter((id): id is string => typeof id === "string");
      if (type === "delivery.ack") this.relay.acknowledge(agent as AgentId, ids);
      else this.directives.acknowledge(agent as AgentId, ids);
      return;
    }
    send(
      ws,
      type === "hook" ? this.hooks.receive(person, socketAgent, body) : this.proxy.receive(person, socketAgent, body),
    );
  }

  /**
   * Sends an Interrupt to the wrapper of Agent `id`: the socket that most recently
   * said it belongs to that wrapper. False when there is none.
   */
  private interruptTo(
    id: AgentId,
    message: InterruptMessage | DirectiveInterruptMessage | ApprovalDenyMessage,
  ): boolean {
    const person = this.agents.find(id)?.person;
    if (person === undefined) return false;
    let target: { ws: WebSocket; at: number } | null = null;
    for (const ws of this.ctx.getWebSockets(person)) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const attached = ws.deserializeAttachment() as WrapperAttachment | null;
      if (attached?.agent !== id) continue;
      if (target === null || attached.at > target.at) target = { ws, at: attached.at };
    }
    return target !== null && send(target.ws, message);
  }

  /**
   * The Task Agent `id` works on now: its newest Claim not yet finished (#56), or null.
   * Its Hook and Proxy Events are about this Task as they arrive.
   */
  private currentTask(id: AgentId): TaskNumber | null {
    return workingTasks(this.tasks.held(id), id)[0]?.number ?? null;
  }

  /** The files Agent `id` has edited, most recently first, or null when the Channel has no such Agent. */
  touchedFiles(id: AgentId): TouchedFile[] | null {
    return this.agents.has(id) ? this.hooks.touchedFiles(id) : null;
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    const [person, tag] = this.ctx.getTags(ws);
    if (person !== undefined && tag?.startsWith(HOST_TAG)) {
      await this.hosts.detached(person, tag.slice(HOST_TAG.length + person.length + 1));
    }
  }

  /** Every Host on the Channel, with whether it is Live. */
  listHosts(): { hosts: Host[]; cap: number; running: number } {
    return { hosts: this.hosts.list(), cap: this.hostCap(), running: this.hosts.running() };
  }

  private leadCap(): number {
    const cap = Number(this.env.LEAD_AGENTS_LIVE_CAP);
    return Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_LEAD_AGENTS_LIVE_CAP;
  }

  private hostCap(): number {
    const cap = Number(this.env.HOST_AGENTS_LIVE_CAP);
    return Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_HOST_AGENTS_LIVE_CAP;
  }

  /** Registers one of `person`'s Hosts, or updates its folders and mode, and joins them. */
  registerHost(person: PersonName, request: RegisterHostRequest): Host {
    this.join(person);
    return this.hosts.register(person, request);
  }

  removeHost(person: PersonName, name: string): boolean {
    return this.hosts.remove(person, name);
  }

  /** Starts an Agent on one of the caller's Person's Hosts (ADR 0015), for the Person or their lead (ADR 0018). */
  async spawnAgent(caller: Caller, request: SpawnAgentRequest): Promise<SpawnResult> {
    if (caller.agent === undefined) {
      this.join(caller.person);
      return this.hosts.spawn({ person: caller.person }, request);
    }
    const lead = this.lead(caller.agent, "start Agents");
    if (!lead.ok) return lead;
    return this.hosts.spawn({ person: caller.person, lead: caller.agent }, request);
  }

  /** Stops an Agent one of the caller's Person's Hosts runs: for the Person, or their lead over it. */
  stopAgent(caller: Caller, id: AgentId): { ok: true; host: HostId } | HostRefusal {
    if (caller.agent === undefined) return this.hosts.stop({ person: caller.person }, id);
    const lead = this.lead(caller.agent, "stop Agents");
    if (!lead.ok) return lead;
    return this.hosts.stop({ person: caller.person, lead: caller.agent }, id);
  }

  /** Host `id`'s newest open socket, or null when it is Offline. */
  private hostSocket(id: HostId): WebSocket | null {
    let newest: { ws: WebSocket; at: number } | null = null;
    for (const ws of this.ctx.getWebSockets(hostTag(id))) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const at = (ws.deserializeAttachment() as HostAttachment | null)?.at ?? 0;
      if (newest === null || at > newest.at) newest = { ws, at };
    }
    return newest?.ws ?? null;
  }

  /** `person`'s sockets that carry the stream: theirs and their wrappers', not their Hosts'. */
  private personSockets(person: PersonName): WebSocket[] {
    return this.ctx.getWebSockets(person).filter((ws) => !this.ctx.getTags(ws)[1]?.startsWith(HOST_TAG));
  }

  private append<K extends EventType>(event: NewEvent<K>): ChannelEvent {
    const stored = this.insert(crypto.randomUUID(), event);
    if (!stored) throw new Error("Event ID collision");
    return stored;
  }

  /** Records an Event under `id` and broadcasts it, or returns null when the Channel already has that ID. */
  private insert<K extends EventType>(id: string, event: NewEvent<K>): ChannelEvent | null {
    const row = this.ctx.storage.sql
      .exec<EventRow>(
        `INSERT INTO events (id, at, type, actor, capture, task, turn, payload, actor_kind, actor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING *`,
        id,
        new Date().toISOString(),
        event.type,
        JSON.stringify(event.actor),
        event.capture,
        event.task ?? null,
        event.turn ?? null,
        JSON.stringify(event.payload),
        ...actorColumns(event.actor),
      )
      .toArray()[0];
    if (!row) return null;
    const stored = rowToEvent(row);
    this.broadcast({ type: "event", event: stored });
    // The Relay decides who hears about it, after this request.
    this.relay.consider(stored);
    return stored;
  }

  private broadcast(message: StreamMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (!this.ctx.getTags(ws)[1]?.startsWith(HOST_TAG)) send(ws, message);
    }
  }
}

/** The tag on a WebSocket opened with an Agent's token. */
const AGENT_TAG = "agent:";

function agentTag(id: AgentId): string {
  return `${AGENT_TAG}${id}`;
}

/** The tag on a Host's WebSocket: `host:<person>/<name>`. */
const HOST_TAG = "host:";

function hostTag(id: HostId): string {
  return `${HOST_TAG}${id}`;
}

/** What a Host's socket carries: when it attached, so the newest one gets the Host's requests. */
interface HostAttachment {
  at: number;
}

/** What a wrapper's socket carries: the Agent whose Interrupts it types, and since when. */
interface WrapperAttachment {
  agent: AgentId;
  at: number;
}

const WRAPPER_DOWNGRADES: ReadonlySet<string> = new Set(["person-typing", "dialog-open", "session-not-ready"]);

/** A wrapper's `interrupt.result` (or `directive.result`, the same shape), or null when it is not one. */
function parseInterruptResult(body: Record<string, unknown>): InterruptResult | null {
  const { agent, id, typed, reason } = body;
  if (typeof agent !== "string" || typeof id !== "string") return null;
  if (typed === true) return { type: "interrupt.result", agent: agent as AgentId, id, typed: true };
  if (typed === false && typeof reason === "string" && WRAPPER_DOWNGRADES.has(reason)) {
    return {
      type: "interrupt.result",
      agent: agent as AgentId,
      id,
      typed: false,
      reason: reason as Extract<InterruptResult, { typed: false }>["reason"],
    };
  }
  return null;
}

/** Sends `message` on `ws`. False when the socket is closing. */
function send(
  ws: WebSocket,
  message:
    | StreamMessage
    | HookCaptureReply
    | ProxyCaptureReply
    | DeliveryMessage
    | InterruptAttached
    | InterruptMessage
    | DirectiveMessage
    | DirectiveInterruptMessage
    | ApprovalDenyMessage
    | HostSpawnMessage
    | HostSpawnedMessage
    | HostStopMessage,
): boolean {
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    // The socket is closing; its close handler cleans up.
    return false;
  }
}
