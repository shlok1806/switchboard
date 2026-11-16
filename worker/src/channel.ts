import { ARTIFACT_CSP, BRIEF_PAGE_PATTERN, checkArtifact, cleanBriefWrite, toBase64 } from "../../shared/src/index";
import { managedBriefConstituent, managedConnectorConstituents } from "./managed-connectors";
import { managedGitHubRead } from "./managed-github";
import { managedHistoryQuery, managedStoredEvent, managedStoredWindow } from "./managed-history";
import { extendedHistory, HistoryCursors } from "./managed-history-selectors";
import { managedLibrarian } from "./managed-librarian";
import { ManagedLocalHistory } from "./managed-local-history";
import { managedOutcome, OUTCOME_BATCH_SIZE, OUTCOME_TABLES, outcomeAuditId } from "./managed-outcomes";
import { type ConstituentDescriptor, managedQueryResponse } from "./managed-query";
import { managedAgentAttribution } from "./managed-query-attribution";
import {
  createManagedQuery,
  MANAGED_PREPARATIONS,
  MANAGED_QUERIES,
  type ManagedPreparationRequest,
  managedQueryId,
} from "./managed-query-registry";
import { appendManagedOutcome, MANAGED_OUTCOME_TTL_MS } from "./managed-retention";
import { managedSummary } from "./managed-summary";
import { parseSince } from "./mcp/since";
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
  AgentSummary,
  ApprovalDenyMessage,
  ArtifactSummary,
  BriefPage,
  BriefPageSummary,
  Capture,
  ChannelEvent,
  DeliveryMessage,
  DenyApprovalRequest,
  DirectiveInterruptMessage,
  DirectiveMessage,
  EventPayloads,
  EventType,
  HistoryGap,
  HistoryRequestMessage,
  Holder,
  HookCaptureReply,
  Host,
  HostAllowMessage,
  HostId,
  HostPauseMessage,
  HostResumeMessage,
  HostSpawnedMessage,
  HostSpawnMessage,
  HostStopMessage,
  InterruptAttached,
  InterruptMessage,
  InterruptResult,
  LibrarianFeedResponse,
  MemoryNote,
  MemoryQuery,
  MoveLibrarianCursorRequest,
  PendingApproval,
  Person,
  PersonName,
  PostNoteRequest,
  ProxyCaptureReply,
  ProxyMode,
  QuietClaim,
  RegisterAgentRequest,
  RegisterHostRequest,
  ReportedPresence,
  ReportedUsage,
  SetHostAllowRequest,
  Skill,
  SkillEntry,
  SkillSummary,
  SpawnAgentRequest,
  StreamMessage,
  Task,
  TaskNumber,
  TerminalInputFrame,
  TerminalReadRequestMessage,
  TerminalReadResponse,
  TerminalRefusedFrame,
  TerminalScreenFrame,
  TerminalWatchersMessage,
  TouchedFile,
  TranscriptRequestMessage,
  TranscriptResponse,
  WriteBriefRequest,
} from "../../shared/src/index";
import {
  agentIdFor,
  cleanHistoryPage,
  cleanNote,
  cleanTerminalText,
  cleanTranscriptPage,
  DEFAULT_ARTIFACT_PUBLISHES_PER_DAY,
  DEFAULT_BRIEF_WRITES_PER_DAY,
  DEFAULT_GONE_AFTER_SECONDS,
  DEFAULT_HOST_AGENTS_LIVE_CAP,
  DEFAULT_LEAD_AGENTS_LIVE_CAP,
  DEFAULT_MEMORY_NOTES_PER_DAY,
  describeActivity,
  HISTORY_WAIT_MS,
  hostIdFor,
  isLocalEvent,
  LIVE_PING,
  LIVE_PONG,
  MAX_ADDRESSEES,
  MAX_DIRECTIVE_LENGTH,
  MAX_FINISH_SUMMARY_LENGTH,
  MAX_SPAWN_FAILURE_LENGTH,
  MAX_UPDATE_LENGTH,
  mergePages,
  offlineReason,
  SESSION_COOKIE,
  SUMMARY_MAX_ACTIVITY,
  SUMMARY_MAX_FILES,
  SUMMARY_MAX_NOTES,
  SUMMARY_MAX_UPDATES,
  TRANSCRIPT_WAIT_MS,
} from "../../shared/src/index";
import type { SafeAgent } from "../../shared/src/m1";
import { Access, type AdmitResult, MEMBERSHIP_TTL_MS } from "./access";
import { AgentRoster, createAgentsTable, type RosterResult } from "./agents";
import { Alarms } from "./alarms";
import { ARTIFACTS_SCHEMA, type ArtifactResult, Artifacts } from "./artifacts";
import { askChannel, type ChannelAnswer, type ChannelQuestion, DEFAULT_QUIET_CLAIM_HOURS } from "./ask";
import type { Credential } from "./auth";
import { devMode, readCookie, readNativeActor, sessionSecret } from "./auth";
import { Branches, type CodeEventResult } from "./branches";
import { BRIEF_SCHEMA, Brief, type BriefResult, migrateBrief } from "./brief";
import { type Caller, type ClaimRefusal, type ClaimResult, Claims } from "./claims";
import { isAgentId } from "./claims-api";
import { DEFAULT_ATTACH_WAIT_MS, DIRECTIVES_SCHEMA, type DirectiveResult, Directives } from "./directives";
import { type CodeChange, type GitHub, gitHubFor, readerFor, type WebhookChange } from "./github/index";
import { HOOK_CAPTURE_SCHEMA, HookCapture } from "./hook-capture";
import { type ControlResult, DEFAULT_SPAWN_WAIT_MS, Hosts, type SpawnResult } from "./hosts";
import { readJson } from "./http";
import { LangfuseProject, type StoredLangfuse } from "./langfuse";
import { LIBRARIAN_SCHEMA, librarianFeed, moveLibrarianCursor } from "./librarian";
import { ManagedUpdateBudgets } from "./managed-budgets";
import {
  ManagedReadFailure,
  managedEnforcement,
  managedError,
  managedOperationRoute,
  managedQueryAuthorization,
} from "./managed-channel";
import { safeAgent } from "./managed-projection";
import { type GrantResult, McpGrants } from "./mcp/grants";
import { MEMORY_SCHEMA, Memory, type MemoryReadResult, type NoteResult } from "./memory";
import { memoryQuery } from "./memory-api";
import type { ChannelAuthorization } from "./organization";
import { workspaceParent } from "./policy";
import { authorityRequest, LocalMutationPermits, type MutationPermit } from "./policy-permits";
import { ProxyCapture } from "./proxy-capture";
import { jevFor } from "./relay/jev";
import { interruptIntervalMs, interruptThreshold, RELAY_SCHEMA, Relay, relaySettings } from "./relay/relay";
import { verifyPayload } from "./session";
import { migrateSkills, SKILLS_SCHEMA, type SkillResult, Skills, type UploadedChunk } from "./skills";
import { StaleClaims } from "./stale-claims";
import { StatusComments } from "./status-comment";
import { type NewTask, type TaskResult, Tasks, workingTasks } from "./tasks";
import {
  InputRate,
  MAX_WATCHED,
  parseAttached,
  parseInput,
  parseRefused,
  parseScreen,
  type WatchAttachment,
} from "./terminal";
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
 * The table holds the Channel's history apart from Local Events, which their machines
 * keep (ADR 0037; rows from before it stay and are read with the rest), so every
 * query on a hot path must reach its rows through an index; Durable Objects bill
 * each row a query reads. The
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
  // What People and Agents said, newest first, for the read-only connector (ADR 0040).
  { name: "events_said", on: "(seq)", where: "type IN ('update', 'directive')" },
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
/** A transcript page, or why there is none: no such Agent, Gone, already being read, no wrapper, or no answer in time. */
export type TranscriptResult =
  | { ok: true; page: TranscriptResponse }
  | { ok: false; status: 400 | 403 | 404 | 409 | 429 | 502 | 503 | 504; reason: string };

/** An Agent's screen, or why there is none: the same refusals as a transcript read (ADR 0024). */
export type TerminalReadResult =
  | { ok: true; screen: TerminalReadResponse }
  | { ok: false; status: 400 | 403 | 404 | 409 | 429 | 502 | 503 | 504; reason: string };

/** A read asked of a wrapper and not answered yet: whose, and how to hand back its answer or why not. */
interface WrapperRead<T> {
  agent: AgentId;
  answer: (answer: T | string) => void;
}

export type IndexPending = { pending: HistoryIndex };

/** A page of history: the Channel's stored Events merged with the machines' Local Events, and what it could not read (ADR 0037). */
export interface HistoryPage {
  events: ChannelEvent[];
  unavailable: HistoryGap[];
}

/** What a history read asks of a machine. */
type HistoryAsk = Pick<HistoryRequestMessage, "agent" | "task" | "before" | "limit">;

/** A history read asked of a wrapper's or Host's socket, waiting for its page. */
interface HistoryRead {
  /** The socket's tags: only that socket answers. */
  person: PersonName;
  tag: string;
  asked: HistoryAsk;
  answer: (events: ChannelEvent[] | null) => void;
}

/** A socket that keeps Local Events, and what to ask it. */
interface HistoryHolder {
  ws: WebSocket;
  asked: HistoryAsk;
}

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

// A request object created only by the trusted internal RPC carries its preparation
// context in memory. HTTP serialization cannot forge this identity; consume once.
const managedPreparationContexts = new WeakMap<Request, ManagedPreparationRequest>();

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
  private managedHistoryAdapter?: ManagedLocalHistory;
  private managedHistoryCursors?: HistoryCursors;
  /** Records the wrappers' idle wakes. */
  private readonly wakes: Wakes;
  private readonly inputRate = new InputRate();
  /** Who may use the Channel: membership of the repo, and Agent tokens (ADR 0007). */
  private readonly access: Access;
  /** Each Issue's one status comment (issue #2). */
  private readonly status: StatusComments;
  /** The notes Agents write for each other (ADR 0019). */
  private readonly memory: Memory;
  private readonly skills: Skills;
  /** The Brief's pages (ADR 0042). */
  private readonly brief: Brief;
  /** The HTML pages shared on the Channel (ADR 0053). */
  private readonly artifacts: Artifacts;
  /** The read-only connector's sign-ins (ADR 0040). */
  private readonly mcpGrants: McpGrants;
  /** The repo's own Langfuse project, its secret key sealed (ADR 0044). */
  private readonly langfuse: LangfuseProject;
  /** A Claim with no Update for this long is Quiet (ADR 0040). */
  private readonly quietAfterMs: number;
  /** How long a transcript read waits for the wrapper's page: TRANSCRIPT_WAIT_MS, or shorter in tests. */
  private readonly transcriptWaitMs: number;
  /** Transcript reads waiting for their wrapper's page, by request ID. In memory: a read lasts one request. */
  private readonly transcriptReads = new Map<string, WrapperRead<Omit<TranscriptResponse, "agent">>>();
  /** Screen reads waiting for their wrapper's text (ADR 0024), the same way. */
  private readonly terminalReads = new Map<string, WrapperRead<Omit<TerminalReadResponse, "agent">>>();
  /** History reads waiting for a machine's page (ADR 0037), the same way. */
  private readonly historyReads = new Map<string, HistoryRead>();
  /** How long a history read waits: HISTORY_WAIT_MS, or shorter in tests. */
  private readonly historyWaitMs: number;
  /** The last `seq` this object gave, read from the stored Events at its first Event (ADR 0037). */
  private lastSeq: number | null = null;
  /**
   * The newest Local Events, which the Channel does not store (ADR 0037), by ID: so an
   * Event sent again after a reconnect is recorded once and acknowledged as it was, and
   * a recent one is still read by ID. In memory, for as long as this object lives.
   */
  private readonly recentLocal = new Map<string, ChannelEvent>();
  /** The history indexes built so far (`buildHistoryIndexes`), and the UTC day they were last tried. */
  private historyIndexes: HistoryIndexes;
  private historyIndexesDay = utcDay();

  private managedRegistration: Promise<void> = Promise.resolve();

  private binding!: {
    version: number;
    generation: number;
    workspace: string | null;
    operation: string | null;
    state: string;
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Additive migration: never infer legacy access from an unknown managed version.
    let existed = true;
    try {
      const snapshot = ctx.storage.sql
        .exec<typeof this.binding>("SELECT version,generation,workspace,operation,state FROM m1_binding WHERE id=1")
        .toArray()[0];
      if (snapshot) this.binding = snapshot;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("no such table: m1_binding")) throw error;
      existed = false;
    }
    // Hibernation reconstructs the object. A durable snapshot needs no migration
    // writes or transaction on every wake (including terminal/Interrupt frames).
    if (!this.binding) {
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS m1_binding (
          id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL,
          generation INTEGER NOT NULL, workspace TEXT, operation TEXT, state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS m1_binding_outbox (
          operation TEXT PRIMARY KEY, generation INTEGER NOT NULL, body TEXT NOT NULL);`);
        // Missing state in a previously migrated object is not proof of legacy access.
        ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO m1_binding
        SELECT 1,1,0,NULL,NULL,CASE WHEN ? OR EXISTS(SELECT 1 FROM m1_binding_outbox)
        THEN 'recovery_required' ELSE 'unlinked' END`,
          existed ? 1 : 0,
        );
      });
      this.binding = ctx.storage.sql
        .exec<typeof this.binding>("SELECT version,generation,workspace,operation,state FROM m1_binding WHERE id=1")
        .one();
    }
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
    ctx.storage.sql.exec(SKILLS_SCHEMA);
    this.skills = new Skills(ctx.storage);
    void ctx.blockConcurrencyWhile(() => migrateSkills(ctx.storage));
    ctx.storage.sql.exec(BRIEF_SCHEMA);
    migrateBrief(ctx.storage.sql);
    ctx.storage.sql.exec(LIBRARIAN_SCHEMA);
    const briefWrites = Number(env.BRIEF_WRITES_PER_DAY);
    this.brief = new Brief(
      ctx.storage.sql,
      Number.isInteger(briefWrites) && briefWrites >= 0 ? briefWrites : DEFAULT_BRIEF_WRITES_PER_DAY,
    );
    ctx.storage.sql.exec(ARTIFACTS_SCHEMA);
    const artifactPublishes = Number(env.ARTIFACT_PUBLISHES_PER_DAY);
    this.artifacts = new Artifacts(
      ctx.storage,
      Number.isInteger(artifactPublishes) && artifactPublishes >= 0
        ? artifactPublishes
        : DEFAULT_ARTIFACT_PUBLISHES_PER_DAY,
    );
    this.mcpGrants = new McpGrants(ctx.storage.sql);
    this.langfuse = new LangfuseProject(ctx.storage.sql);
    const quietHours = Number(env.QUIET_CLAIM_HOURS);
    this.quietAfterMs = (quietHours > 0 ? quietHours : DEFAULT_QUIET_CLAIM_HOURS) * 60 * 60 * 1000;
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
        if (presence === "gone" && this.binding.workspace !== null) {
          const association = this.managedAssociation(id);
          if (association) {
            this.queueManagedEnd(id, association);
            this.ctx.waitUntil(this.deliverManagedEnd(id, association));
          }
        }
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
      recorded: (id) => this.eventsById([id])[0] ?? null,
    });
    this.proxy = new ProxyCapture({
      touchAgent: (person, id) => this.agents.touch(person, id),
      currentTask: (id) => this.currentTask(id),
      appendOnce: (id, event) => this.insert(id, event),
      recorded: (id) => this.eventsById([id])[0] ?? null,
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
      agent: (id) => this.agents.find(id),
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
    const attachWait = Number(env.DIRECTIVE_ATTACH_WAIT_SECONDS);
    this.directives = new Directives({
      sql: ctx.storage.sql,
      findAgent: (id) => this.agents.find(id),
      append: (event) => this.append(event),
      sendTo: (person, message) => {
        for (const ws of this.personSockets(person)) send(ws, message);
      },
      interruptTo: (agent, message) => this.interruptTo(agent, message),
      waitUntil: (work) => this.ctx.waitUntil(work),
      schedule: (at) => this.alarms.set("directives", at),
      attachWaitMs: attachWait > 0 ? attachWait * 1000 : DEFAULT_ATTACH_WAIT_MS,
    });
    this.wakes = new Wakes({ sql: ctx.storage.sql, append: (event) => this.append(event) });
    const transcriptWait = Number(env.TRANSCRIPT_WAIT_SECONDS);
    this.transcriptWaitMs = transcriptWait > 0 ? transcriptWait * 1000 : TRANSCRIPT_WAIT_MS;
    const historyWait = Number(env.HISTORY_WAIT_SECONDS);
    this.historyWaitMs = historyWait > 0 ? historyWait * 1000 : HISTORY_WAIT_MS;
    const wait = Number(env.HOST_SPAWN_WAIT_SECONDS);
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
      pauseAgent: (id) => {
        this.agents.pause(id);
      },
      unpauseAgent: (id) => this.ctx.waitUntil(this.agents.unpause(id)),
      endPausedAgent: (id) => {
        this.agents.endPaused(id);
      },
      revokeAgent: (id) => {
        if (this.access.revokeAgent(id))
          this.closeSockets(agentTag(id), 4001, "Agent token revoked: the Agent is Paused.");
      },
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
      if (this.binding.state === "linked" && due.has("managed-outcomes")) await this.#exportManagedOutcomes();
      if (due.has("tasks")) await this.tasks.alarm();
      if (due.has("presence")) await this.agents.expireSilent();
      if (due.has("executions")) await this.retryManagedEnds();
      if (due.has("members")) await this.recheckMembers();
      if (due.has("hosts")) await this.hosts.alarm();
      if (due.has("directives")) await this.directives.alarm();
    } finally {
      await this.alarms.arm();
    }
  }

  /** Queue durably inside the same transaction as the managed outcome. */
  #queueManagedOutcomes(): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO alarm_deadlines VALUES('managed-outcomes',?) ON CONFLICT(job) DO UPDATE SET at=MIN(at,excluded.at)",
      Date.now() + 1000,
    );
  }

  /** Bounded, redacted batches; lost replies replay and acknowledgments compare the original row. */
  async #exportManagedOutcomes(): Promise<void> {
    // No new storage or RPC work on an unlinked Channel's alarm path.
    const binding = this.binding;
    if (binding.version !== 1 || binding.state !== "linked" || !binding.workspace || !binding.operation) return;
    const organizationId = workspaceParent(binding.workspace);
    if (!organizationId) return;
    const current = () =>
      this.binding.version === 1 &&
      this.binding.state === "linked" &&
      this.binding.generation === binding.generation &&
      this.binding.workspace === binding.workspace &&
      this.binding.operation === binding.operation;
    // Persist a retry before the RPC, including crashes after the authority commits.
    await this.alarms.set("managed-outcomes", Date.now() + 60_000);
    if (!current()) return;
    let remaining = false;
    for (const table of OUTCOME_TABLES) {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, body TEXT NOT NULL)`);
      sql.exec(
        `DELETE FROM ${table} WHERE COALESCE(json_extract(body, '$.at'),0)<=?`,
        Date.now() - MANAGED_OUTCOME_TTL_MS,
      );
      // Retained historical/unverifiable rows must not starve later evidence.
      // Persist before transport so a lost reply also advances to the next bounded batch.
      sql.exec("CREATE TABLE IF NOT EXISTS managed_outcome_cursors (name TEXT PRIMARY KEY, after_id TEXT NOT NULL)");
      const after =
        sql.exec<{ after_id: string }>("SELECT after_id FROM managed_outcome_cursors WHERE name=?", table).toArray()[0]
          ?.after_id ?? "";
      const rows = sql
        .exec<{ id: string; body: string }>(
          `SELECT id,body FROM ${table} WHERE id>? AND (?='managed_outcome_outbox' OR json_extract(body, '$.outcome') IN ('pr_created','pr_failed')) ORDER BY id LIMIT ?`,
          after,
          table,
          OUTCOME_BATCH_SIZE,
        )
        .toArray();
      sql.exec("INSERT OR REPLACE INTO managed_outcome_cursors VALUES(?,?)", table, rows.at(-1)?.id ?? "");
      const prepared = rows.flatMap((row) => {
        try {
          const outcome = managedOutcome(table, row.id, JSON.parse(row.body));
          return outcome &&
            outcome.resource.organizationId === organizationId &&
            outcome.resource.id === binding.workspace
            ? [{ row, outcome }]
            : [];
        } catch {
          return [];
        }
      });
      if (prepared.length) {
        try {
          const acknowledged = await authorityRequest(() =>
            this.env.ORGANIZATION.getByName(organizationId).recordChannelOutcomes(
              prepared.map(({ outcome }) => outcome),
            ),
          );
          if (!current()) return;
          const ids = new Set(acknowledged);
          this.ctx.storage.transactionSync(() => {
            for (const { row, outcome } of prepared)
              if (ids.has(outcomeAuditId(outcome)))
                sql.exec(`DELETE FROM ${table} WHERE id=? AND body=?`, row.id, row.body);
          });
        } catch {
          // The durable retry survives transport failure; never delete unacknowledged evidence.
        }
      }
      remaining ||= sql.exec(`SELECT id FROM ${table} LIMIT 1`).toArray().length > 0;
    }
    if (current() && !remaining) await this.alarms.set("managed-outcomes", null);
  }

  /** The GitHub for this Channel's repo, or null when the App is not configured. */
  private gitHub(): GitHub | null {
    const repo = this.access.repo();
    return repo === null ? null : gitHubFor(this.env, repo);
  }

  /** Internal binding snapshot. Unknown schemas and pending bindings deny all admission. */
  bindingState(): {
    version: number;
    generation: number;
    workspace: string | null;
    operation: string | null;
    state: string;
  } {
    return { ...this.binding };
  }

  /** Trusted internal Organization RPC: can only invalidate, never grant access. */
  invalidateManagedPolicy(workspace: string, revision: number): void {
    // No managed storage or extra work for legacy Channels.
    if (this.binding.state !== "linked" || this.binding.version !== 1 || this.binding.workspace !== workspace) return;
    this.managedHistoryAdapter?.invalidate();
    new LocalMutationPermits(this.ctx.storage.sql).observeRevision(workspace, revision);
  }

  /** Synchronous transition fence, immediately before dispatch or result release. */
  bindingCurrent(generation: number, managed = false): boolean {
    if (managed)
      return (
        this.binding.version === 1 &&
        this.binding.state === "linked" &&
        this.binding.workspace !== null &&
        this.binding.operation !== null &&
        this.binding.generation === generation
      );
    return !this.managedClosed() && this.binding.generation === generation;
  }

  private managedClosed(): boolean {
    const binding = this.binding;
    return (
      binding.version !== 1 ||
      !Number.isSafeInteger(binding.generation) ||
      binding.generation < 0 ||
      binding.state !== "unlinked" ||
      binding.workspace !== null ||
      binding.operation !== null
    );
  }

  /** Trusted internal RPC. Actor-free calls and unknown plans deny before content access. */
  async prepareManagedQuery(repo: string, preparation: ManagedPreparationRequest): Promise<Response> {
    if (
      this.binding.state !== "linked" ||
      !preparation?.actor ||
      typeof preparation.actor !== "object" ||
      ("token" in preparation.actor
        ? typeof preparation.actor.token !== "string" || preparation.actor.token.length > 4096
        : preparation.actor.kind !== "person" ||
          typeof preparation.actor.personId !== "string" ||
          typeof preparation.actor.githubId !== "string" ||
          !Number.isFinite(preparation.credentialExpiresAt) ||
          (preparation.credentialExpiresAt ?? 0) <= Date.now()) ||
      (preparation.selectors !== undefined &&
        (typeof preparation.selectors !== "string" || preparation.selectors.length > 8192)) ||
      preparation.generation !== this.binding.generation ||
      !Object.hasOwn(MANAGED_PREPARATIONS, preparation.id)
    )
      return managedError(404, "resource_denied");
    const descriptor = MANAGED_PREPARATIONS[preparation.id];
    const url = new URL(`https://managed.invalid/r/${repo}${descriptor.path}`);
    url.search = preparation.selectors ?? "";
    if (preparation.id === "local.history") url.searchParams.set("source", "local");
    const request = new Request(url);
    managedPreparationContexts.set(request, preparation);
    return this.managedRequest(request, repo);
  }

  /** Native credentials are resolved here, never from HTTP Person/Agent query fields. */
  async managedRequest(request: Request, repo: string): Promise<Response> {
    const binding = this.bindingState();
    if (binding.version !== 1 || binding.state !== "linked" || !binding.workspace || !binding.operation)
      return managedError(404, "resource_denied");
    const preparation = managedPreparationContexts.get(request);
    managedPreparationContexts.delete(request);
    const url = new URL(request.url);
    // Bind the HTTP route to the actual named DO, even for direct internal invocations.
    if (!this.env.CHANNEL.idFromName(repo).equals(this.ctx.id) || !url.pathname.startsWith(`/r/${repo}/api/`))
      return managedError(404, "resource_denied");
    const path = url.pathname.slice(`/r/${repo}`.length);
    const prepared = preparation ? MANAGED_PREPARATIONS[preparation.id] : undefined;
    const route =
      preparation && prepared
        ? {
            ...MANAGED_QUERIES[preparation.id],
            operation: preparation.id,
            targetId: prepared.targetId,
            mode: "read" as const,
          }
        : managedOperationRoute(request.method, path);
    if (!route) return managedError(404, "resource_denied");
    const organizationId = workspaceParent(binding.workspace);
    if (!organizationId) return managedError(404, "resource_denied");
    const preparationDeadline = Date.now() + 10000;
    const bindingCurrent = () =>
      this.binding.version === 1 &&
      this.binding.state === "linked" &&
      this.binding.generation === binding.generation &&
      this.binding.workspace === binding.workspace &&
      this.binding.operation === binding.operation;
    try {
      const token = request.headers.get("Authorization")?.startsWith("Bearer m1.")
        ? request.headers.get("Authorization")?.slice(7).trim()
        : undefined;
      const actor =
        preparation?.actor ??
        (token ? { token } : await authorityRequest(() => readNativeActor(request, url, this.env)));
      if (!actor || !bindingCurrent()) return managedError(404, "resource_denied");
      const org = this.env.ORGANIZATION.getByName(organizationId);
      const input: ChannelAuthorization = {
        actor,
        ...(preparation?.credentialExpiresAt === undefined
          ? {}
          : { credentialExpiresAt: preparation.credentialExpiresAt }),
        action: route.action,
        generation: binding.generation,
        requestId: crypto.randomUUID(),
        ...(route.action.startsWith("agent.private_") || (route.action === "agent.view" && route.targetId !== "agents")
          ? { targetExecutionId: this.managedAssociation(route.targetId as AgentId)?.executionId }
          : {}),
        resource: {
          kind: "workspace",
          organizationId,
          id: binding.workspace,
          channel: repo,
          targetId: route.targetId,
          operation: route.operation,
        },
      };
      const rosterChecks: ChannelAuthorization[] = [];
      const current = () =>
        bindingCurrent() &&
        rosterChecks.every((check) => {
          const association = this.managedAssociation(check.resource.targetId as AgentId);
          return association?.active === 1 && association.executionId === check.targetExecutionId;
        });
      const enforcement = managedEnforcement({ current, authorize: (check) => org.authorizeChannelRead(check) });
      if (route.mode === "write") return await this.#managedWrite(request, path, input, current);
      const queryId = managedQueryId(route.operation);
      if (queryId) {
        const pinnedTargets = new Set<string>();
        const pinTarget = (check: ChannelAuthorization) => {
          const key = JSON.stringify([check.resource.targetId, check.targetExecutionId]);
          if (!pinnedTargets.has(key)) {
            pinnedTargets.add(key);
            rosterChecks.push(check);
          }
        };
        const workspaceId = binding.workspace;
        const permits = new LocalMutationPermits(this.ctx.storage.sql);
        const guard = {
          preparationDeadline,
          bindingCurrent: current,
          revisionFloor: () => permits.revisionFloor(workspaceId),
          now: () => Date.now(),
        };
        let streamPersons: unknown;
        const authorizeQuery = async (check: ChannelAuthorization) => {
          if (streamPersons !== undefined && check.resource.operation === "persons.read") {
            const latest = await org.readChannelPersons(check);
            if (!latest.ok || !current() || JSON.stringify(latest.value) !== JSON.stringify(streamPersons))
              return { ok: false as const, status: 403 as const, reason: "resource_denied", policyRevision: 0 };
          }
          if (!token && !preparation) {
            const actor = await readNativeActor(request, url, this.env);
            if (
              !actor ||
              !current() ||
              "token" in check.actor ||
              actor.personId !== check.actor.personId ||
              actor.githubId !== check.actor.githubId
            )
              return { ok: false as const, status: 403 as const, reason: "resource_denied", policyRevision: 0 };
            check = { ...check, actor };
          }
          return org.authorizeChannelRead(check);
        };
        const queryEnforcement = managedEnforcement({ current, authorize: authorizeQuery });
        const scope = {
          id: queryId,
          binding: {
            organizationId,
            workspaceId: binding.workspace,
            channel: repo,
            generation: binding.generation,
            operation: binding.operation,
          },
          authorization: input,
        };
        const page = { source: "stored" as const, selector: { kind: "tail" as const }, wakesOnly: false, limit: 1000 };
        const constituents: ConstituentDescriptor<unknown>[] = [];
        let assemble: (parts: ReadonlyMap<string, readonly unknown[]>) => unknown;
        const sourceId = prepared?.base ?? queryId;
        let about: string | undefined;
        let since: number | undefined;
        if (queryId === "connector.channel") {
          for (const key of url.searchParams.keys())
            if (!["about", "since", "limit"].includes(key) || url.searchParams.getAll(key).length !== 1)
              throw new ManagedReadFailure(404);
          about = url.searchParams.get("about")?.trim().toLowerCase();
          const sinceText = url.searchParams.get("since");
          const parsedSince = parseSince(sinceText, Date.now());
          if ((about?.length ?? 0) > 200 || "error" in parsedSince) throw new ManagedReadFailure(404);
          since = Date.parse(parsedSince.at);
          url.searchParams.delete("about");
          url.searchParams.delete("since");
        }
        if (sourceId === "brief") {
          for (const key of url.searchParams.keys())
            if (key !== "area" || url.searchParams.getAll(key).length !== 1) throw new ManagedReadFailure(404);
          const area = url.searchParams.get("area") ?? undefined;
          if (area !== undefined && !BRIEF_PAGE_PATTERN.test(area)) throw new ManagedReadFailure(404);
          constituents.push(managedBriefConstituent(this.ctx.storage.sql, input, area));
          assemble = (parts) => ({ pages: parts.get("brief") });
        } else if (queryId === "librarian") {
          const feed = managedLibrarian({
            sql: this.ctx.storage.sql,
            input,
            agent: (id) => this.agents.find(id),
            association: (id) => this.managedAssociation(id),
            event: (row) => rowToEvent(row as EventRow),
            pin: pinTarget,
            budget: () => this.brief.budget(),
            now: Date.now(),
            quietAfterMs: this.quietAfterMs,
          });
          constituents.push(...feed.constituents);
          assemble = feed.assemble;
        } else if (queryId === "summary") {
          if (input.targetExecutionId) pinTarget(input);
          this.managedHistoryAdapter ??= new ManagedLocalHistory();
          const localHistory = this.managedHistoryAdapter;
          const summary = managedSummary({
            localActivity: () => localHistory.unavailableActivity(),
            sql: this.ctx.storage.sql,
            input,
            agent: (id) => this.agents.find(id),
            association: (id) => this.managedAssociation(id),
            event: (row) => rowToEvent(row as EventRow),
            pin: pinTarget,
          });
          constituents.push(...summary.constituents);
          assemble = summary.assemble;
        } else if (sourceId === "history") {
          const selection = extendedHistory(url.searchParams);
          // B4 has not admitted any managed recipient transport. Do not derive native
          // Host ownership/local limits from advisory login-based legacy Host rows.
          // Keep a lazy Channel-owned cancellation boundary ready for admitted holders.
          if (selection) this.managedHistoryCursors ??= new HistoryCursors();
          const cursors = selection ? this.managedHistoryCursors : undefined;
          const boundary = selection && cursors ? await cursors.decode(scope.binding, selection) : 0;
          if (!current()) throw new ManagedReadFailure(404);
          const query = selection
            ? { after: 0, limit: selection.limit + 1, wakes: false }
            : managedHistoryQuery(url.searchParams);
          // Explicit exhaustion uses an empty SQL window, never a short window.
          constituents.push({
            id: "events",
            authorization: { ...input, action: "channel.update.read" },
            page: {
              ...page,
              ...(selection ? { source: selection.source, agentId: selection.agent, taskNumber: selection.task } : {}),
              selector: query.ids ? { kind: "ids", ids: query.ids } : { kind: "forward", after: query.after },
              wakesOnly: query.wakes,
              limit: query.limit,
            },
            projection: {
              id: "stored-event",
              project: async (row, context) => {
                const event = rowToEvent(row.value as EventRow);
                const projected = managedStoredEvent(event);
                if (
                  selection &&
                  ((selection.agent !== undefined &&
                    (event.actor.kind !== "agent" || event.actor.agentId !== selection.agent)) ||
                    (selection.task !== undefined && event.task !== selection.task))
                )
                  return null;
                if (!projected || (query.wakes && projected.type !== "wake") || event.actor.kind !== "agent")
                  return null;
                const association = this.managedAssociation(event.actor.agentId);
                if (association?.active !== 1) return null;
                const check: ChannelAuthorization = {
                  ...input,
                  action: "agent.view",
                  targetExecutionId: association.executionId,
                  eventAt: Date.parse(event.at),
                  resource: { ...input.resource, targetId: event.actor.agentId, operation: "history.author" },
                };
                const allowed = await context.check(check);
                context.boundary();
                const latest = this.managedAssociation(event.actor.agentId);
                if (!allowed || latest?.active !== 1 || latest.executionId !== association.executionId) return null;
                context.onRetain(() => pinTarget(check));
                if (!selection || !cursors) return projected;
                const cursor = await cursors.encode(scope.binding, selection, projected.seq);
                context.boundary();
                return { event: projected, cursor };
              },
            },
            readWindow: async (position, limit) => {
              if (!selection) return managedStoredWindow<EventRow>(this.ctx.storage.sql, query, position, limit);
              if (selection.source !== "stored") this.managedHistoryAdapter ??= new ManagedLocalHistory();
              // No holder is eligible until native enrollment, local ceiling AND B4
              // recipient lease exist. Unavailability is not exhaustion evidence.
              if (selection.source === "local") return { rows: [], nextInternal: null, exhausted: true };
              const forward = selection.direction === "forward";
              const rows = this.ctx.storage.sql
                .exec<EventRow>(
                  forward
                    ? "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?"
                    : "SELECT * FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?",
                  position === null ? boundary : Number(position),
                  limit,
                )
                .toArray();
              return {
                rows: rows.map((row) => ({ key: row.id, value: row })),
                nextInternal: rows.length ? String(rows.at(-1)?.seq) : null,
                exhausted: rows.length === 0,
              };
            },
          });
          // AV is an independently protected constituent, admitted before any Event scan.
          constituents.unshift({
            id: "agents",
            authorization: { ...input, action: "agent.view", resource: { ...input.resource, targetId: "agents" } },
            page,
            projection: {
              id: "safe-prepared-agent",
              project: async (row, context) =>
                managedAgentAttribution(
                  {
                    input,
                    agent: (id) => this.agents.find(id),
                    association: (id) => this.managedAssociation(id),
                    pin: pinTarget,
                  },
                  row.value as AgentId,
                  context,
                ),
            },
            readWindow: async () => ({
              rows:
                queryId === "connector.channel" || queryId === "stream.backlog" || queryId === "stream.event"
                  ? this.agents.list(false).map((agent) => ({ key: agent.id, value: agent.id }))
                  : [],
              nextInternal: null,
              exhausted: true,
            }),
          });
          assemble = (parts) => {
            if (!selection) {
              const events = parts.get("events") as { seq: number }[];
              return { events, cursor: events.at(-1)?.seq ?? query.after };
            }
            const candidates = parts.get("events") as { event: { seq: number; id: string }; cursor: string }[];
            const selected = candidates.slice(0, selection.limit);
            const cursor = selected.at(-1)?.cursor ?? selection.cursor ?? null;
            // Lookahead comes only from an additional admitted Event, never raw rows.
            const more = candidates.length > selection.limit ? true : selection.source === "stored" ? false : undefined;
            return {
              events: selected.map((row) => row.event).sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id)),
              cursor,
              ...(more === undefined ? {} : { more }),
              ...(selection.source === "stored"
                ? {}
                : { unavailable: [{ reason: "managed_local_history_unavailable" }] }),
            };
          };
        } else if (queryId === "agents") {
          constituents.push({
            id: "agents",
            authorization: input,
            page,
            readWindow: async () => ({
              rows: this.agents.list(false).map((agent) => ({ key: agent.id, value: agent })),
              nextInternal: null,
              exhausted: true,
            }),
            projection: {
              id: "safe-agent",
              project: async (row, context) => {
                const candidate = row.value as Agent;
                const association = this.managedAssociation(candidate.id);
                if (association?.active !== 1) return null;
                const check = {
                  ...input,
                  targetExecutionId: association.executionId,
                  resource: { ...input.resource, targetId: candidate.id },
                };
                const result = await context.check(check);
                context.boundary();
                const latest = this.managedAssociation(candidate.id);
                const agent = this.agents.find(candidate.id);
                if (
                  !result?.target ||
                  !agent ||
                  agent.presence === "gone" ||
                  latest?.active !== 1 ||
                  latest.executionId !== association.executionId
                )
                  return null;
                pinTarget(check);
                return safeAgent(agent, result.target);
              },
            },
          });
          assemble = (parts) => ({ agents: parts.get("agents") });
        } else {
          let snapshot: unknown;
          const read = async () => {
            if (sourceId === "github") return managedGitHubRead(this.env, repo, url);
            const result = await authorityRequest(async () => await org.readChannelPersons(input));
            if (!result.ok || !current()) throw new ManagedReadFailure(404);
            snapshot = result.value;
            return snapshot;
          };
          constituents.push({
            id: queryId === "persons" ? "persons" : "tasks",
            authorization: input,
            page: { ...page, limit: queryId === "persons" ? 1000 : 1 },
            readWindow: async () => {
              const value = await read();
              const rows =
                queryId === "persons"
                  ? (value as { persons: { personId: string }[] }).persons.map((person) => ({
                      key: person.personId,
                      value: person,
                    }))
                  : [{ key: queryId, value }];
              return { rows, nextInternal: null, exhausted: true };
            },
            projection: { id: queryId, project: async (row) => row.value },
          });
          assemble = (parts) => (queryId === "persons" ? { persons: parts.get("persons") } : parts.get("tasks")?.[0]);
          // The roster adapter independently checks subject memberships at release.
          const queryFacade = managedEnforcement({
            current,
            authorize: async (check) => {
              if (snapshot !== undefined && queryId === "persons") {
                const latest = await org.readChannelPersons(check);
                if (!latest.ok || !current() || JSON.stringify(latest.value) !== JSON.stringify(snapshot))
                  return { ok: false as const, status: 403 as const, reason: "resource_denied", policyRevision: 0 };
              }
              return authorizeQuery(check);
            },
          });
          const result = await queryFacade.query(createManagedQuery({ scope, constituents, assemble }), guard);
          return managedQueryResponse(result, guard);
        }
        if (queryId === "stream.event" || queryId === "stream.backlog") {
          const host = {
            sql: this.ctx.storage.sql,
            input,
            agent: (id: AgentId) => this.agents.find(id),
            association: (id: AgentId) => this.managedAssociation(id),
            event: (row: unknown) => rowToEvent(row as EventRow),
            pin: pinTarget,
            budget: () => this.brief.budget(),
            now: Date.now(),
            quietAfterMs: this.quietAfterMs,
          };
          const tasks = managedLibrarian(host).constituents.find((part) => part.id === "tasks");
          if (!tasks) throw new ManagedReadFailure(404);
          const personsInput: ChannelAuthorization = {
            ...input,
            action: "workspace.read",
            resource: { ...input.resource, targetId: "persons", operation: "persons.read" },
          };
          constituents.push(tasks, {
            id: "persons",
            authorization: personsInput,
            page,
            readWindow: async () => {
              const result = await org.readChannelPersons(personsInput);
              if (!result.ok || !current()) throw new ManagedReadFailure(404);
              streamPersons = result.value;
              return {
                rows: result.value.persons.map((person) => ({ key: person.personId, value: person })),
                nextInternal: null,
                exhausted: true,
              };
            },
            projection: { id: "native-person", project: async (row) => row.value },
          });
          const events = assemble;
          assemble = (parts) => ({
            ...(events(parts) as object),
            agents: parts.get("agents"),
            tasks: parts.get("tasks"),
            persons: parts.get("persons"),
          });
        }
        if (queryId === "connector.channel") {
          const host = {
            sql: this.ctx.storage.sql,
            input,
            agent: (id: AgentId) => this.agents.find(id),
            association: (id: AgentId) => this.managedAssociation(id),
            event: (row: unknown) => rowToEvent(row as EventRow),
            pin: pinTarget,
            budget: () => this.brief.budget(),
            now: Date.now(),
            quietAfterMs: this.quietAfterMs,
          };
          const tasks = managedLibrarian(host).constituents.find((part) => part.id === "tasks");
          if (!tasks) throw new ManagedReadFailure(404);
          const [historyScope, notes] = managedConnectorConstituents(host);
          if (!historyScope || !notes) throw new ManagedReadFailure(404);
          constituents.unshift(historyScope);
          constituents.push(tasks, notes);
          // Filter projected rows before the executor retains row dependencies/cursors.
          for (let index = 0; index < constituents.length; index++) {
            const part = constituents[index];
            if (!part) throw new ManagedReadFailure(404);
            const projection = part.projection;
            constituents[index] = {
              ...part,
              projection: {
                id: projection.id,
                project: async (row, context) => {
                  const projected = await projection.project(row, context);
                  context.boundary();
                  if (projected === null) return null;
                  const value = projected as { at?: string };
                  if (since !== undefined && value.at && Date.parse(value.at) < since) return null;
                  return !about || JSON.stringify(projected).toLowerCase().includes(about) ? projected : null;
                },
              },
            };
          }
          assemble = (parts) => ({
            tasks: parts.get("tasks"),
            events: parts.get("events"),
            agents: parts.get("agents"),
            notes: parts.get("notes"),
          });
        }
        const result = await queryEnforcement.query(createManagedQuery({ scope, constituents, assemble }), guard);
        return managedQueryResponse(result, guard);
      }

      return managedEnforcement({
        current,
        authorize: async (input) => {
          // Return local denials: authorityRequest maps thrown errors to authority outages.
          const denied = { ok: false, status: 403, reason: "resource_denied", policyRevision: 0 } as const;
          let authorization = input;
          if (!token) {
            const currentActor = await readNativeActor(request, url, this.env);
            if (!current()) return denied;
            if (!currentActor)
              return { ok: false, status: 403, reason: "native_authentication_required", policyRevision: 0 };
            authorization = { ...input, actor: currentActor };
          }
          return managedQueryAuthorization(
            authorization,
            rosterChecks,
            (check) => org.authorizeChannelRead(check),
            current,
          );
        },
      }).read(input, async () => {
        if (path === "/api/relay") return { relay: relaySettings(this.env) };
        if (route.operation === "skill-files.read") {
          // Parsing and bytes stay behind initial authorization. The local Skills
          // store only releases completed blobs held by this Channel's publications.
          const { chunks } = await readJson(request);
          if (!current()) throw new ManagedReadFailure(404);
          if (!Array.isArray(chunks) || chunks.length === 0) return managedError(400, "invalid_skill_chunks");
          const wanted: { digest: string; index: number }[] = [];
          for (const chunk of chunks) {
            if (
              typeof chunk?.digest !== "string" ||
              !/^[0-9a-f]{64}$/.test(chunk.digest) ||
              !Number.isSafeInteger(chunk.index) ||
              chunk.index < 0
            )
              throw new ManagedReadFailure(404);
            wanted.push({ digest: chunk.digest, index: chunk.index });
          }
          const result = this.skills.readChunks(wanted);
          if (!result.ok) {
            if (result.status === 413) return managedError(413, "skill_transfer_limit");
            throw new ManagedReadFailure(404);
          }
          return {
            chunks: result.value.map(({ digest, index, data }) => ({ digest, index, data: toBase64(data) })),
          };
        }
        if (route.operation === "memory.read") {
          const parsed = memoryQuery(url.searchParams);
          if (!parsed.ok) return managedError(400, "invalid_memory_query");
          const authors: AgentId[] = [];
          for (const agent of this.agents.list(false)) {
            const association = this.managedAssociation(agent.id);
            if (association?.active !== 1) continue;
            const check: ChannelAuthorization = {
              ...input,
              action: "agent.view",
              targetExecutionId: association.executionId,
              resource: { ...input.resource, targetId: agent.id, operation: "memory.author" },
            };
            const allowed = await enforcement.check(check);
            if (!current()) throw new ManagedReadFailure(404);
            const latest = this.managedAssociation(agent.id);
            if (!allowed.ok || latest?.active !== 1 || latest.executionId !== association.executionId) continue;
            rosterChecks.push(check);
            authors.push(agent.id);
          }
          const result = this.memory.read(parsed.query, authors);
          if (!result.ok) return managedError(400, "invalid_memory_query");
          return { notes: result.notes, ...(result.more ? { more: true } : {}) };
        }
        if (route.action === "channel.update.read") {
          const versionText = url.searchParams.get("version");
          if (versionText !== null && !/^[1-9]\d{0,8}$/.test(versionText)) throw new ManagedReadFailure(404);
          const version = versionText === null ? undefined : Number(versionText);
          if (path === "/api/skills") return { skills: this.skills.list() };
          if (path === "/api/artifacts") return { artifacts: this.artifacts.list() };
          if (path === "/api/brief") return { pages: this.brief.pages() };
          const separator = route.targetId.indexOf("/");
          const family = route.targetId.slice(0, separator);
          const name = route.targetId.slice(separator + 1);
          const result =
            family === "skills"
              ? this.skills.read(name, version)
              : family === "brief"
                ? this.brief.read(name, version)
                : route.operation === "content.page"
                  ? this.artifacts.page(name, version)
                  : this.artifacts.read(name, version);
          if (!result.ok) throw new ManagedReadFailure(404);
          if (route.operation === "content.page" && "html" in result.value) {
            return new Response(result.value.html, {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": ARTIFACT_CSP,
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                "Cache-Control": "no-store",
                ...(url.searchParams.get("download") === "1" ? { "Content-Disposition": "attachment" } : {}),
              },
            });
          }
          return result.value;
        }

        if (route.action === "agent.view") {
          const candidates =
            route.targetId === "agents"
              ? this.agents.list(false)
              : [this.agents.find(route.targetId as AgentId)].filter((a): a is Agent => a !== null);
          const agents: SafeAgent[] = [];
          for (const candidate of candidates) {
            const association = this.managedAssociation(candidate.id);
            if (association?.active !== 1) continue;
            const check: ChannelAuthorization = {
              ...input,
              targetExecutionId: association.executionId,
              resource: { ...input.resource, targetId: candidate.id },
            };
            const result = await enforcement.check(check);
            if (!current()) throw new ManagedReadFailure(404);
            if (!result.ok || !result.value.target) continue;
            const agent = this.agents.find(candidate.id);
            if (!agent || agent.presence === "gone") continue;
            rosterChecks.push(check);
            agents.push(safeAgent(agent, result.value.target));
          }
          if (route.targetId !== "agents" && !agents[0]) throw new ManagedReadFailure(404);
          return route.targetId === "agents" ? { agents } : { agent: agents[0] };
        }

        if (route.action.startsWith("agent.private_")) {
          const id = route.targetId as AgentId;
          const agent = this.agents.find(id);
          if (!agent || agent.presence === "gone") throw new ManagedReadFailure(404);
          if (route.operation === "touched-files") return { agent: id, files: this.hooks.touchedFiles(id) };
          if (route.operation === "terminal") {
            const screen = await this.askWrapper(
              this.terminalReads,
              id,
              (request): TerminalReadRequestMessage => ({ type: "terminal.read.request", agent: id, id: request }),
            );
            if (!screen || typeof screen === "string") throw new ManagedReadFailure(503);
            return { screen: { agent: id, ...screen } };
          }
          const from = Number(url.searchParams.get("from") ?? 0);
          if (!Number.isSafeInteger(from) || from < 0) throw new ManagedReadFailure(404);
          const page = await this.askWrapper(
            this.transcriptReads,
            id,
            (request): TranscriptRequestMessage => ({
              type: "transcript.request",
              agent: id,
              id: request,
              from,
              ...(url.searchParams.get("latest") === "true" ? { latest: true } : {}),
            }),
          );
          if (!page || typeof page === "string") throw new ManagedReadFailure(503);
          return { page: { agent: id, ...page } };
        }

        const result = path === "/api/tasks" ? await this.tasks.list() : await this.tasks.get(Number(route.targetId));
        if (!result.ok) throw new ManagedReadFailure(result.status);
        return path === "/api/tasks" ? { tasks: result.value } : { task: result.value };
      });
    } catch (error) {
      if (error instanceof ManagedReadFailure) return managedError(error.status, "resource_denied");
      return managedError(503, "authority_unavailable");
    }
  }

  /** Exact, request-local permits; never an ambient authorization flag. */
  async #managedWrite(
    request: Request,
    path: string,
    input: ChannelAuthorization,
    current: () => boolean,
  ): Promise<Response> {
    const body = await readJson(request);
    if (!current()) throw new ManagedReadFailure(404);
    if (path === "/api/directives") {
      if (!isAgentId(body.to)) return managedError(400, "invalid_target");
      input = {
        ...input,
        targetExecutionId: this.managedAssociation(body.to)?.executionId,
        resource: { ...input.resource, targetId: body.to },
      };
    }
    const org = this.env.ORGANIZATION.getByName(input.resource.organizationId);
    const enforcement = managedEnforcement({
      current,
      authorize: async (check) => {
        if (!("token" in check.actor)) {
          const actor = await readNativeActor(request, new URL(request.url), this.env);
          if (
            !actor ||
            actor.personId !== check.actor.personId ||
            actor.githubId !== check.actor.githubId ||
            !current()
          )
            return { ok: false as const, status: 403 as const, reason: "resource_denied", policyRevision: 0 };
          check = { ...check, actor };
        }
        return org.authorizeChannelRead(check);
      },
    });
    const login = "token" in input.actor ? null : await authorityRequest(() => this.nativeLogin(request));
    if (!current()) throw new ManagedReadFailure(404);
    const verified =
      "token" in input.actor
        ? await authorityRequest(
            async () => await org.verifyExecution(input.actor && "token" in input.actor ? input.actor.token : ""),
          )
        : input.actor;
    const caller = verified ? this.#managedCaller(verified, login) : undefined;
    if (!verified || !caller || !current()) throw new ManagedReadFailure(404);
    let outcome = "committed";
    let intentRevision = 0;
    const prepare = async (intent = false, issuedPermit?: MutationPermit) => {
      // Preparation (including artifact hashing) may yield before requesting a permit.
      if (!current()) throw new ManagedReadFailure(404);
      if (!("token" in input.actor)) {
        const actor = await authorityRequest(() => readNativeActor(request, new URL(request.url), this.env));
        if (!actor || actor.personId !== input.actor.personId || actor.githubId !== input.actor.githubId || !current())
          throw new ManagedReadFailure(404);
        // The same immutable credential was just verified; parsing only narrows its permit deadline.
        const credential = request.headers.get("Authorization")?.slice(7).trim() ?? readCookie(request, SESSION_COOKIE);
        const encoded = credential?.split(".")[1];
        if (!encoded) throw new ManagedReadFailure(404);
        const expiry = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))).exp;
        if (typeof expiry !== "number" || !Number.isFinite(expiry)) throw new ManagedReadFailure(404);
        input = { ...input, credentialExpiresAt: expiry * 1000 };
      }
      return enforcement.prepare(
        {
          actor: verified,
          action: input.action,
          resource: input.resource,
          requestId: input.requestId,
          generation: input.generation,
        },
        async () =>
          issuedPermit
            ? { ok: true as const, value: issuedPermit, policyRevision: issuedPermit.policyRevision }
            : await org.issueMutationPermit(input),
        (permit) => {
          if (intent) intentRevision = permit.policyRevision;

          const permits = new LocalMutationPermits(this.ctx.storage.sql);
          permits.observeRevision(input.resource.id, permit.policyRevision);
          permits.install(permit);
          return {
            commit: (write: () => void) => {
              this.ctx.storage.transactionSync(() => {
                if (
                  !current() ||
                  !this.#managedCaller(permit.actor, login) ||
                  !permits.consume(permit.id, {
                    actor: verified,
                    action: input.action,
                    resource: input.resource,
                    requestId: input.requestId,
                    generation: this.binding.generation,
                    policyRevision: permit.policyRevision,
                  })
                )
                  throw new ManagedReadFailure(404);
                if (intent)
                  appendManagedOutcome(this.ctx.storage.sql, "managed_external_outcomes", input.requestId, {
                    requestId: input.requestId,
                    actor: permit.actor,
                    action: permit.action,
                    resource: permit.resource,
                    policyRevision: permit.policyRevision,
                    outcome: "external_pending",
                  });
                // Reserve evidence capacity before append/broadcast/Relay side effects.
                appendManagedOutcome(this.ctx.storage.sql, "managed_outcome_outbox", permit.id, {
                  requestId: input.requestId,
                  actor: permit.actor,
                  action: permit.action,
                  resource: permit.resource,
                  policyRevision: permit.policyRevision,
                  outcome: "pending_commit",
                });
                write();
                appendManagedOutcome(this.ctx.storage.sql, "managed_outcome_outbox", permit.id, {
                  requestId: input.requestId,
                  actor: permit.actor,
                  action: permit.action,
                  resource: permit.resource,
                  policyRevision: permit.policyRevision,
                  outcome: intent ? "external_intent" : outcome,
                  at: Date.now(),
                });
                this.#queueManagedOutcomes();
              });
              this.ctx.waitUntil(this.alarms.arm());
            },
          };
        },
      );
    };
    if (input.resource.operation === "brief.write") {
      // Response includes page content: admit and release that read independently of the write permit.
      const readInput = { ...input, action: "channel.update.read" };
      const admitted = await enforcement.check(readInput);
      if (!admitted.ok || !current()) return managedError(404, "resource_denied");
      const page = input.resource.targetId?.slice("brief/".length) ?? "";
      const checked = cleanBriefWrite(page, body);
      // Keep resource denials outside the authority transport error path.
      let issuedPermit: MutationPermit | undefined;
      if ("token" in input.actor) {
        const issued = await authorityRequest(async () => await org.issueMutationPermit(input));
        if (!issued.ok || !current()) return managedError(404, "resource_denied");
        issuedPermit = issued.value;
      }
      const prepared = await prepare(false, issuedPermit);
      if (!caller.agent) return managedError(403, "brief_requires_agent");
      if (!checked.ok) return managedError(400, "invalid_brief");
      let result: ReturnType<Channel["writeBriefPage"]> | undefined;
      prepared.commit(() => {
        result = this.#writeBriefPage(
          {
            person: caller.person,
            agent: caller.agent,
            ...(this.agents.find(caller.agent as AgentId)?.librarian ? { librarian: true as const } : {}),
          },
          page,
          checked.write,
        );
        if (!result.ok) outcome = "local_restriction_denied";
      });
      const released = await enforcement.check(readInput);
      if (!released.ok || !current()) return managedError(404, "resource_denied");
      if (!result) throw new ManagedReadFailure(404);
      return result.ok
        ? Response.json(
            { ok: true, ...result.value },
            { status: result.value.written ? 201 : 200, headers: { "Cache-Control": "no-store" } },
          )
        : managedError(result.status, "resource_denied");
    }
    if (input.resource.operation === "memory.write") {
      // Preserve the existing Agent-only writer predicate; never accept a body author.
      const note = cleanNote(body);
      const prepared = await prepare();
      if (!caller.agent) return managedError(403, "memory_requires_agent");
      if (!note.ok) return managedError(400, "invalid_note");
      let result: NoteResult | ClaimRefusal | undefined;
      prepared.commit(() => {
        result =
          caller.agent && this.agents.find(caller.agent)?.librarian
            ? { ok: false, status: 403, reason: "librarian_write_denied" }
            : this.#writeNote(caller, note.note);
        if (!result.ok) outcome = "local_restriction_denied";
      });
      if (!result) return managedError(404, "resource_denied");
      return result.ok
        ? Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } })
        : managedError(result.status, "resource_denied");
    }
    if (input.resource.operation === "artifact.publish") {
      // Admission precedes payload validation/preparation, so even malformed
      // publications from nonmembers receive the same denial. This permit is
      // deliberately not installed or used: hashing precedes a fresh commit permit.
      const admitted = await authorityRequest(async () => await org.issueMutationPermit(input));
      if (!admitted.ok || !current()) throw new ManagedReadFailure(404);
      const name = input.resource.targetId?.slice("artifacts/".length) ?? "";
      const checked = checkArtifact(name, body);
      if (!checked.ok) return managedError(400, "invalid_artifact");
      const result = await this.artifacts.publish(
        { person: caller.person, ...(caller.agent ? { agent: caller.agent } : {}) },
        name,
        checked.publish,
        async () => {
          const prepared = await prepare();
          return {
            commit: (write: () => void) =>
              prepared.commit(() => {
                if (caller.agent && this.agents.find(caller.agent)?.librarian) throw new ManagedReadFailure(404);
                write();
              }),
          };
        },
        (result) => {
          if (!result.ok) outcome = "local_restriction_denied";
        },
      );
      return result.ok
        ? Response.json(result.value, {
            status: result.value.published ? 201 : 200,
            headers: { "Cache-Control": "no-store" },
          })
        : managedError(result.status, "resource_denied");
    }
    if (input.resource.operation === "artifact.delete") {
      if (caller.agent) return managedError(403, "artifact_delete_requires_person");
      const prepared = await prepare();
      let result: ReturnType<Artifacts["delete"]> | undefined;
      prepared.commit(() => {
        result = this.artifacts.delete(caller.person, input.resource.targetId?.slice("artifacts/".length) ?? "");
        if (!result.ok) outcome = "local_restriction_denied";
      });
      if (!result) return managedError(404, "resource_denied");
      return result.ok
        ? Response.json({ ok: true, ...result.value }, { headers: { "Cache-Control": "no-store" } })
        : managedError(result.status, "resource_denied");
    }
    if (path === "/api/directives") {
      if (caller.agent || !isAgentId(body.to)) return managedError(403, "directive_denied");
      const to = body.to;
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > MAX_DIRECTIVE_LENGTH) return managedError(400, "invalid_directive");
      const prepared = await prepare();
      let result: DirectiveResult | undefined;
      prepared.commit(() => {
        result = this.directives.send({ person: caller.person }, to, text);
      });
      if (!result) return managedError(404, "resource_denied");
      return Response.json(result, {
        status: result.ok ? 201 : result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (path === "/api/updates") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > MAX_UPDATE_LENGTH) return managedError(400, "invalid_update");
      const task = body.task;
      if (task !== undefined && !(typeof task === "number" && Number.isSafeInteger(task) && task > 0))
        return managedError(400, "invalid_task");
      const to = Array.isArray(body.to) && body.to.every(isAgentId) ? [...new Set(body.to)] : undefined;
      if (body.to !== undefined && (!to || to.length < 1 || to.length > MAX_ADDRESSEES))
        return managedError(400, "invalid_addressees");
      const prepared = await prepare();
      let answer: ReturnType<Channel["postUpdate"]> | undefined;
      let retry = 0;
      prepared.commit(() => {
        const executionId = caller?.agent ? this.managedAssociation(caller.agent)?.executionId : undefined;
        retry = new ManagedUpdateBudgets(this.ctx.storage.sql).consume(executionId);
        if (!retry && caller) answer = this.#postUpdate(caller, text, task as number | undefined, to);
        if (retry || !answer?.ok) outcome = retry ? "update_budget_exhausted" : "local_restriction_denied";
      });
      if (retry)
        return Response.json(
          { ok: false, reason: "update_budget_exhausted" },
          {
            status: 429,
            headers: { "Retry-After": String(retry), "Cache-Control": "no-store" },
          },
        );
      if (!answer) return managedError(404, "resource_denied");
      return Response.json(answer, {
        status: answer.ok ? 201 : answer.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const admitted = await enforcement.check({ ...input, action: "task.read" });
    if (!admitted.ok || !current()) return managedError(404, "resource_denied");

    const number = Number(input.resource.targetId);
    const mutation = {
      prepare,
      prepareIntent: () => prepare(true),
      externalOutcome: (pr: { number: number; url: string } | null) => {
        this.ctx.storage.transactionSync(() => {
          appendManagedOutcome(this.ctx.storage.sql, "managed_external_outcomes", input.requestId, {
            actor: verified,
            requestId: input.requestId,
            action: input.action,
            resource: input.resource,
            policyRevision: intentRevision,
            outcome: pr ? "pr_created" : "pr_failed",
            pr: pr?.number,
            at: Date.now(),
          });
          this.#queueManagedOutcomes();
        });
        this.ctx.waitUntil(this.alarms.arm());
      },
    };
    let result: ClaimResult;
    if (input.resource.operation === "task.claim") {
      if (body.for !== undefined && !isAgentId(body.for)) return managedError(400, "invalid_agent");
      result = await this.claims.claim(caller, number, body.for as AgentId | undefined, mutation);
    } else if (input.resource.operation === "task.release")
      result = await this.claims.release(caller, number, mutation);
    else if (input.resource.operation === "task.branch") {
      if (typeof body.branch !== "string" || body.branch.length > 255) return managedError(400, "invalid_branch");
      result = await this.branches.record(caller, number, body.branch, mutation);
    } else if (input.resource.operation === "task.finish") {
      if (
        body.summary !== undefined &&
        (typeof body.summary !== "string" || body.summary.length > MAX_FINISH_SUMMARY_LENGTH)
      )
        return managedError(400, "invalid_summary");
      result = await this.branches.finish(caller, number, body.summary as string | undefined, mutation);
    } else if (input.resource.operation === "task.takeover") {
      const to = body.to;
      if (caller.agent || !to || typeof to !== "object") return managedError(403, "takeover_denied");
      const holder = to as Partial<Holder>;
      if (holder.kind === "person" && "person" in holder && holder.person === caller.person)
        result = await this.staleClaims.takeover(caller, number, { kind: "person", person: caller.person }, mutation);
      else if (holder.kind === "agent" && "agentId" in holder && isAgentId(holder.agentId))
        result = await this.staleClaims.takeover(caller, number, { kind: "agent", agentId: holder.agentId }, mutation);
      else return managedError(400, "invalid_holder");
    } else
      result = await this.claims.completeStep(
        caller,
        number,
        Number(input.resource.operation?.split("/")[1]),
        mutation,
      );
    const released = await enforcement.check({ ...input, action: "task.read" });
    if (!released.ok || !current()) return managedError(404, "resource_denied");
    return Response.json(result, { status: result.ok ? 200 : result.status, headers: { "Cache-Control": "no-store" } });
  }

  #managedCaller(actor: MutationPermit["actor"], login: string | null): Caller | undefined {
    if (actor.kind === "person") return login ? { person: login } : undefined;
    const row = this.ctx.storage.sql
      .exec<{ agent: AgentId }>(
        "SELECT agent FROM m1_agent_executions WHERE executionId=? AND active=1",
        actor.executionId,
      )
      .toArray()[0];
    const agent = row ? this.agents.find(row.agent) : null;
    return agent ? { person: agent.person, agent: agent.id } : undefined;
  }

  /** Bare legacy RPCs carry no managed actor and must never authorize linked content. */
  private requireLegacyAccess(): void {
    if (this.managedClosed()) throw new Error("managed_actor_required");
  }

  async bindingOwner(repo: string, person: PersonName, githubId: string): Promise<boolean> {
    this.access.setRepo(repo);
    const result = await this.isOwner(person, false);
    if (!result.ok || !result.owner) return false;
    // Bind the fresh permission proof to the numeric native identity, including after login recycling.
    const reader = readerFor(this.env, repo);
    if (!reader) return false;
    try {
      const response = await reader.call(`/repos/${repo}/collaborators/${encodeURIComponent(person)}/permission`);
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      const proof = (await response.json()) as { user?: { id?: number }; permission?: string; role_name?: string };
      return (
        Number.isSafeInteger(proof.user?.id) &&
        String(proof.user?.id) === githubId &&
        (proof.permission === "admin" || proof.role_name === "admin")
      );
    } catch {
      return false;
    }
  }

  /** Keep recoverable storage failures inside the owning DO, rather than throwing over RPC. */
  transitionBinding(
    phase: "prepare" | "finish",
    workspace: string,
    operation: string,
    generation: number,
    unlink: boolean,
  ): { ok: true; accepted: boolean } | { ok: false } {
    try {
      if (phase !== "prepare" && phase !== "finish") return { ok: false };
      const accepted =
        phase === "prepare"
          ? this.prepareBinding(workspace, operation, generation, unlink)
          : this.finishBinding(workspace, operation, generation, unlink);
      return { ok: true, accepted };
    } catch {
      return { ok: false };
    }
  }

  /** Server-only CAS; operation evidence and fence commit in the same local transaction. */
  prepareBinding(workspace: string, operation: string, expectedGeneration: number, unlink = false): boolean {
    if (
      !workspace ||
      !operation ||
      !Number.isSafeInteger(expectedGeneration) ||
      expectedGeneration < 0 ||
      expectedGeneration >= Number.MAX_SAFE_INTEGER
    )
      return false;
    const accepted = this.ctx.storage.transactionSync(() => {
      const old = this.bindingState();
      if (old.version !== 1) return false;
      if (old.operation === operation) {
        if (
          old.workspace === workspace &&
          old.generation === expectedGeneration + 1 &&
          (old.state === (unlink ? "pending_unlink" : "pending") || (!unlink && old.state === "linked"))
        )
          return old;
        return false;
      }
      if (
        old.generation !== expectedGeneration ||
        (unlink ? old.state !== "linked" || old.workspace !== workspace : this.managedClosed())
      )
        return false;
      this.ctx.storage.sql.exec(
        "UPDATE m1_binding SET generation=generation+1,workspace=?,operation=?,state=? WHERE id=1",
        workspace,
        operation,
        unlink ? "pending_unlink" : "pending",
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO m1_binding_outbox VALUES(?,?,?)",
        operation,
        expectedGeneration + 1,
        JSON.stringify({ workspace, outcome: "pending" }),
      );
      return {
        ...old,
        generation: expectedGeneration + 1,
        workspace,
        operation,
        state: unlink ? "pending_unlink" : "pending",
      };
    });
    if (accepted) {
      this.managedHistoryAdapter?.invalidate();
      this.binding = accepted;
      // Resolve outstanding reads before closing their transports. Their completion
      // checks below discard data captured before the pending transition.
      for (const read of this.transcriptReads.values()) read.answer("");
      for (const read of this.terminalReads.values()) read.answer("");
      for (const read of this.historyReads.values()) read.answer(null);
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1008, "Channel binding changed; managed access is closed.");
        } catch {
          /* Already closed. */
        }
      }
    }
    return accepted !== false;
  }

  /** Finalization follows the Organization commit; RPC is server-only. */
  finishBinding(workspace: string, operation: string, generation: number, unlink: boolean): boolean {
    const accepted = this.ctx.storage.transactionSync(() => {
      const old = this.bindingState();
      if (old.version !== 1 || old.generation !== generation) return false;
      const evidence = this.ctx.storage.sql
        .exec<{ body: string }>(
          "SELECT body FROM m1_binding_outbox WHERE operation=? AND generation=?",
          operation,
          generation,
        )
        .toArray()[0];
      if (!evidence) return false;
      const outcome = JSON.parse(evidence.body) as { workspace: string; outcome: string };
      if (outcome.workspace !== workspace) return false;
      if (outcome.outcome === (unlink ? "unlinked" : "linked")) {
        const same = unlink
          ? old.state === "unlinked" && old.workspace === null && old.operation === null
          : old.state === "linked" && old.operation === operation && old.workspace === workspace;
        return same ? old : false;
      }
      if (
        old.workspace !== workspace ||
        old.operation !== operation ||
        old.state !== (unlink ? "pending_unlink" : "pending")
      )
        return false;
      this.ctx.storage.sql.exec(
        "UPDATE m1_binding SET workspace=?,operation=?,state=? WHERE id=1",
        unlink ? null : workspace,
        unlink ? null : operation,
        unlink ? "unlinked" : "linked",
      );
      this.ctx.storage.sql.exec(
        "UPDATE m1_binding_outbox SET body=? WHERE operation=?",
        JSON.stringify({ workspace, outcome: unlink ? "unlinked" : "linked" }),
        operation,
      );
      return {
        ...old,
        workspace: unlink ? null : workspace,
        operation: unlink ? null : operation,
        state: unlink ? "unlinked" : "linked",
      };
    });
    if (accepted) {
      this.managedHistoryAdapter?.invalidate();
      this.binding = accepted;
    }
    return accepted !== false;
  }

  /**
   * Admits a call to the Channel of `repo` (ADR 0007): a live Agent token, and a
   * Person with write access to the repo, checked with GitHub at most every few
   * minutes. `fresh` asks GitHub now, as sign-in does.
   */
  async admit(
    repo: string,
    credential: Credential,
    dev: boolean,
    fresh = false,
  ): Promise<AdmitResult & { generation?: number }> {
    if (this.managedClosed()) return { ok: false, status: 403, reason: "Managed Channel access is closed until P3." };
    const generation = this.bindingState().generation;
    this.access.setRepo(repo);
    const admitted = await this.access.admit(credential, dev, fresh);
    // GitHub admission may yield while a pending binding closes this Channel.
    if (this.managedClosed() || this.bindingState().generation !== generation)
      return { ok: false, status: 403, reason: "Managed Channel access is closed until P3." };
    return admitted.ok ? { ...admitted, generation } : admitted;
  }

  /**
   * While streams are open, re-checks their Persons' access every few minutes, so
   * someone removed from the repo stops seeing the Channel even without a new call.
   */
  private async recheckMembers(): Promise<void> {
    const persons = new Set(this.ctx.getWebSockets().flatMap((ws) => this.socketIdentityTags(ws).slice(0, 1)));
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
    this.requireLegacyAccess();
    return this.tasks.list();
  }

  getTask(number: TaskNumber): Promise<TaskResult<Task>> {
    this.requireLegacyAccess();
    return this.tasks.get(number);
  }

  /** A Person creating a Task, which creates its GitHub Issue first. */
  createTask(name: PersonName, task: NewTask): Promise<TaskResult<Task>> {
    this.requireLegacyAccess();
    this.#joinPerson(name);
    return this.tasks.create(name, task);
  }

  /** Claims a Task for the caller, or, for a Person, for one of their own Agents. */
  claimTask(caller: Caller, number: TaskNumber, forAgent?: AgentId): Promise<ClaimResult> {
    this.requireLegacyAccess();
    this.#joinPerson(caller.person);
    return this.claims.claim(caller, number, forAgent);
  }

  releaseTask(caller: Caller, number: TaskNumber): Promise<ClaimResult> {
    this.requireLegacyAccess();
    return this.claims.release(caller, number);
  }

  completeStep(caller: Caller, number: TaskNumber, index: number): Promise<ClaimResult> {
    this.requireLegacyAccess();
    return this.claims.completeStep(caller, number, index);
  }

  /** The holder's wrapper reporting the Task branch it created (ADR 0006). */
  recordBranch(caller: Caller, number: TaskNumber, branch: string): Promise<ClaimResult> {
    this.requireLegacyAccess();
    return this.branches.record(caller, number, branch);
  }

  /** The holder finishing a Task: a pull request that closes the Issue, and the Task goes to review. */
  finishTask(caller: Caller, number: TaskNumber, summary?: string): Promise<ClaimResult> {
    this.requireLegacyAccess();
    return this.branches.finish(caller, number, summary);
  }

  /** A verified GitHub `push` or `pull_request` delivery, recorded once per delivery ID. */
  gitHubCodeWebhook(repo: string, delivery: string, change: CodeChange): Promise<CodeEventResult> {
    this.access.setRepo(repo);
    return this.branches.codeEvent(delivery, change);
  }

  /** A Person moving a Stale Claim to themselves or one of their own Agents (ADR 0002). */
  takeoverTask(caller: Caller, number: TaskNumber, to: Holder): Promise<ClaimResult> {
    this.requireLegacyAccess();
    this.#joinPerson(caller.person);
    return this.staleClaims.takeover(caller, number, to);
  }

  /** An Agent reporting one call to a Switchboard tool, recorded with the Tool Capture. */
  recordToolCall(
    caller: Caller,
    call: EventPayloads["tool.call"],
    task?: TaskNumber,
  ): { ok: true; event: ChannelEvent } | ClaimRefusal {
    this.requireLegacyAccess();
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
  listAgents(includeGone = false): Agent[] {
    this.requireLegacyAccess();
    return this.agents.list(includeGone);
  }

  /** Only association IDs enter Channel storage. Managed content stays closed until P3. */
  async registerManagedAgent(request: Request, registration: RegisterAgentRequest, intent: unknown): Promise<Response> {
    const deny = (status: number) =>
      Response.json(
        { ok: false, reason: "Managed registration denied." },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    const previous = this.managedRegistration;
    let release!: () => void;
    this.managedRegistration = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (!intent || typeof intent !== "object" || Array.isArray(intent)) return deny(400);
      const fields = intent as Record<string, unknown>;
      if (
        Object.keys(fields).some((k) => k !== "principalId" && k !== "workspaceId") ||
        typeof fields.principalId !== "string" ||
        typeof fields.workspaceId !== "string"
      )
        return deny(400);
      const actor = await readNativeActor(request, new URL(request.url), this.env);
      if (!actor) return deny(401);
      const organizationId = workspaceParent(fields.workspaceId);
      const channel = this.access.repo();
      const generation = this.binding.generation;
      // A finalized link retains its operation ID for binding replay evidence.
      // The state distinguishes it from pending transitions.
      if (
        !organizationId ||
        !channel ||
        this.binding.version !== 1 ||
        this.binding.state !== "linked" ||
        this.binding.operation === null ||
        this.binding.workspace !== fields.workspaceId
      )
        return deny(403);
      const org = this.env.ORGANIZATION.getByName(organizationId);
      const workspace = await org.workspace(actor, fields.workspaceId);
      if (!workspace || workspace.channel !== channel) return deny(403);
      // Login is read only from the same signed native session just authenticated above.
      const person = await this.nativeLogin(request);
      if (!person) return deny(401);
      const id = agentIdFor(person, registration.cli, registration.sessionId);
      if (registration.continues) return deny(403);
      const prior = this.managedAssociation(id);
      if (
        prior &&
        !(await this.env.ORGANIZATION.getByName(prior.organizationId).registeredExecutionOwnedBy(
          prior.executionId,
          actor.personId,
        ))
      )
        return deny(403);
      const key = request.headers.get("Idempotency-Key");
      if (!key || key.length > 128) return deny(400);
      const issued = await org.mutateIdentity({
        actor,
        key,
        requestId: crypto.randomUUID(),
        command: {
          kind: "execution.start",
          principalId: fields.principalId,
          workspaceId: fields.workspaceId,
          cli: registration.cli,
          registration: { agentId: id, sessionId: registration.sessionId, channel },
        },
      });
      if (!issued.ok) return deny(issued.status);
      const execution = issued.value.execution;
      // An idempotent retry cannot recover the secret or re-register the session.
      if (!execution || !issued.value.secret) return deny(409);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS m1_agent_executions (
        agent TEXT PRIMARY KEY, organizationId TEXT NOT NULL, executionId TEXT NOT NULL, active INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS m1_agent_execution_ends (
          executionId TEXT PRIMARY KEY, organizationId TEXT NOT NULL, agent TEXT NOT NULL)`);
      const cancel = () => {
        const association = { organizationId, executionId: execution.id };
        this.queueManagedEnd(id, association);
        return this.deliverManagedEnd(id, association);
      };
      if (this.binding.generation !== generation || this.binding.workspace !== fields.workspaceId) {
        await cancel();
        return deny(403);
      }
      try {
        const result = await this.#registerAgentInternal(person, registration);
        if (!result.ok) {
          await cancel();
          return deny(result.status);
        }
        if (this.binding.generation !== generation || this.binding.workspace !== fields.workspaceId) {
          await cancel();
          return deny(403);
        }
        await this.endManagedAssociation(id);
        if (this.binding.generation !== generation || this.binding.workspace !== fields.workspaceId) {
          await cancel();
          return deny(403);
        }
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO m1_agent_executions VALUES(?,?,?,1)",
          id,
          organizationId,
          execution.id,
        );
        return Response.json(
          { ok: true, agent: result.agent, execution, token: issued.value.secret },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch {
        await cancel();
        return deny(503);
      }
    } catch {
      return deny(503);
    } finally {
      release();
    }
  }

  private async nativeLogin(request: Request): Promise<string | null> {
    const secret = sessionSecret(this.env, devMode(this.env, new URL(request.url)));
    const token = request.headers.get("Authorization")?.slice(7).trim() ?? readCookie(request, SESSION_COOKIE);
    const payload = secret && token ? await verifyPayload(secret, token) : null;
    return payload?.kind === "native-session" && typeof payload.login === "string" ? payload.login.toLowerCase() : null;
  }

  private managedAssociation(id: AgentId): { organizationId: string; executionId: string; active: number } | undefined {
    try {
      return this.ctx.storage.sql
        .exec<{ organizationId: string; executionId: string; active: number }>(
          "SELECT organizationId,executionId,active FROM m1_agent_executions WHERE agent=?",
          id,
        )
        .toArray()[0];
    } catch (error) {
      if (error instanceof Error && error.message.includes("no such table: m1_agent_executions")) return undefined;
      throw error;
    }
  }

  /** Managed-only verification; no legacy request performs this RPC or SQL read. */
  registeredExecutionActive(id: AgentId, executionId: string): boolean {
    const association = this.managedAssociation(id);
    const agent = this.agents.find(id);
    // Match finalized binding semantics; operation is cleared only on unlink.
    return (
      association?.executionId === executionId &&
      association.active === 1 &&
      agent !== null &&
      agent !== undefined &&
      agent.presence !== "gone" &&
      this.binding.version === 1 &&
      this.binding.state === "linked" &&
      this.binding.operation !== null
    );
  }

  private queueManagedEnd(id: AgentId, association: { organizationId: string; executionId: string }): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE m1_agent_executions SET active=0 WHERE agent=? AND executionId=?",
        id,
        association.executionId,
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO m1_agent_execution_ends VALUES(?,?,?)",
        association.executionId,
        association.organizationId,
        id,
      );
    });
    const next = Date.now() + 1000;
    if ((this.alarms.deadline("executions") ?? Infinity) > next)
      this.ctx.waitUntil(this.alarms.set("executions", next));
  }

  private async deliverManagedEnd(
    id: AgentId,
    association: { organizationId: string; executionId: string },
  ): Promise<void> {
    try {
      if (
        !(await this.env.ORGANIZATION.getByName(association.organizationId).endRegisteredExecution(
          association.executionId,
          id,
        ))
      )
        throw new Error("Execution end unavailable.");
      this.ctx.storage.sql.exec("DELETE FROM m1_agent_execution_ends WHERE executionId=?", association.executionId);
    } catch {
      // The inactive association already denies use. Retry only metadata, never credentials.
      const next = Date.now() + 1000;
      if ((this.alarms.deadline("executions") ?? Infinity) > next) await this.alarms.set("executions", next);
    }
  }

  private async retryManagedEnds(): Promise<void> {
    let rows: { organizationId: string; executionId: string; agent: string }[];
    try {
      rows = this.ctx.storage.sql
        .exec<{ organizationId: string; executionId: string; agent: string }>(
          "SELECT * FROM m1_agent_execution_ends LIMIT 20",
        )
        .toArray();
    } catch (error) {
      if (error instanceof Error && error.message.includes("no such table: m1_agent_execution_ends")) return;
      throw error;
    }
    for (const row of rows) await this.deliverManagedEnd(row.agent as AgentId, row);
    if (rows.length === 20) {
      const next = Date.now() + 1000;
      if ((this.alarms.deadline("executions") ?? Infinity) > next) await this.alarms.set("executions", next);
    }
  }

  private async endManagedAssociation(id: AgentId): Promise<void> {
    const association = this.managedAssociation(id);
    if (association) {
      this.queueManagedEnd(id, association);
      await this.deliverManagedEnd(id, association);
    }
  }

  /**
   * Registers the Agent for a CLI session, or brings it back on resume, and joins
   * its Person. This is where `switchboard run` trades the Person's session for a
   * new Agent token, bound to this one Agent (ADR 0007).
   */
  registerAgent(person: PersonName, request: RegisterAgentRequest): Promise<RosterResult> {
    this.requireLegacyAccess();
    return this.#registerAgentInternal(person, request);
  }

  async #registerAgentInternal(person: PersonName, request: RegisterAgentRequest): Promise<RosterResult> {
    if (request.host !== undefined && this.hosts.find(person, request.host) === null) {
      return { ok: false, status: 409, reason: `You have no Host named ${request.host} on this Channel.` };
    }
    if (request.continues !== undefined) {
      if (request.continues === agentIdFor(person, request.cli, request.sessionId)) {
        return { ok: false, status: 409, reason: "A session cannot continue its own Agent." };
      }
      if (!this.agents.has(request.continues)) {
        return { ok: false, status: 404, reason: `No Agent ${request.continues} on this Channel to continue.` };
      }
    }
    // A Paused Agent (ADR 0028) comes back only for a Resume its Host was asked for, from that Host.
    const paused = this.agents.find(agentIdFor(person, request.cli, request.sessionId));
    if (paused?.presence === "paused") {
      const from = request.host === undefined ? null : hostIdFor(person, request.host);
      if (from !== paused.host || !this.hosts.takeResume(paused.id)) {
        return {
          ok: false,
          status: 409,
          reason: `Agent ${paused.id} is Paused on ${paused.host ?? "a Host"}. Resume it from the Dashboard or with \`switchboard resume\`.`,
        };
      }
    }
    if (this.binding.workspace !== null)
      await this.endManagedAssociation(agentIdFor(person, request.cli, request.sessionId));
    this.#joinPerson(person);
    // A machine's Host the Channel does not know answers for nothing (ADR 0037).
    if (request.historyHost !== undefined && this.hosts.find(person, request.historyHost) === null) {
      const { historyHost: _, ...rest } = request;
      request = rest;
    }
    const result = this.withNextTurn(await this.agents.register(person, request));
    if (!result.ok) return result;
    const agent =
      request.continues !== undefined && this.handOff(result.agent.id, request.continues)
        ? (this.agents.find(result.agent.id) ?? result.agent)
        : result.agent;
    if (request.usage !== undefined) this.recordUsage(request.usage);
    if (request.host !== undefined && request.spawn !== undefined) {
      this.hosts.spawned(person, request.host, request.spawn, agent);
    }
    return { ...result, agent, token: await this.access.issueAgentToken(agent.id, person, agent.librarian === true) };
  }

  /**
   * Agent `successor` carries on Agent `from`'s work (ADR 0024): set once, and recorded
   * as an `agent.handoff` Event about the Task `from` works on, if any. Moves no Claim.
   * False when `successor` continued an Agent already.
   */
  private handOff(successor: AgentId, from: AgentId): boolean {
    if (!this.agents.setContinues(successor, from)) return false;
    const task = this.currentTask(from);
    this.append({
      type: "agent.handoff",
      actor: { kind: "agent", agentId: successor },
      capture: null,
      ...(task === null ? {} : { task }),
      payload: { from },
    });
    return true;
  }

  /**
   * What the Channel knows of Agent `id` (ADR 0024): the Agent, the Tasks it holds, its
   * latest Updates, the files it edited, the notes that matter for it and the Agents
   * that continue it. Read from indexed rows, for any Person or Agent, Gone or not;
   * reading records nothing. Null when there is no such Agent.
   */
  async agentSummary(id: AgentId): Promise<AgentSummary | null> {
    this.requireLegacyAccess();
    const agent = this.agents.find(id);
    if (agent === null) return null;
    // Its latest activity and the files it edited last, from the machine that keeps them (ADR 0037).
    const local = await this.withLocalEvents([], { agent: id, before: Number.MAX_SAFE_INTEGER, limit: 100 });
    const reached = local.unavailable.length === 0;
    const activity = local.events
      .toReversed()
      .flatMap((event) => {
        const item = describeActivity(event);
        return item === null ? [] : [item];
      })
      .slice(0, SUMMARY_MAX_ACTIVITY);
    const lastEdited = local.events
      .toReversed()
      .flatMap((event) => (event.type === "file.edit" ? [event.payload.path] : []));
    const tasks = this.tasks
      .held(id)
      .filter((task) => task.status !== "done")
      .sort((a, b) => (b.claim?.claimedAt ?? "").localeCompare(a.claim?.claimedAt ?? "") || b.number - a.number);
    const updates = this.ctx.storage.sql
      .exec<{ payload: string; at: string; seq: number; task: number | null }>(
        `SELECT payload, at, seq, task FROM events INDEXED BY events_updates_by_actor
         WHERE type = 'update' AND actor_kind = 'agent' AND actor_id = ? ORDER BY seq DESC LIMIT ?`,
        id,
        SUMMARY_MAX_UPDATES,
      )
      .toArray()
      .map((row) => ({
        seq: row.seq,
        at: row.at,
        text: (JSON.parse(row.payload) as { text: string }).text,
        ...(row.task === null ? {} : { task: row.task as TaskNumber }),
      }));
    const files = [...new Set([...lastEdited, ...this.hooks.touchedFiles(id).map((file) => file.path)])].slice(
      0,
      SUMMARY_MAX_FILES,
    );
    // Its own notes, and the open questions and dead ends anyone wrote on its Tasks.
    const notes = new Map<number, MemoryNote>();
    const add = (result: MemoryReadResult) => {
      if (result.ok) for (const note of result.notes) notes.set(note.seq, note);
    };
    add(this.memory.read({ author: id, limit: SUMMARY_MAX_NOTES }));
    for (const task of tasks) {
      add(this.memory.read({ task: task.number, tag: "question", limit: SUMMARY_MAX_NOTES }));
      add(this.memory.read({ task: task.number, tag: "dead-end", limit: SUMMARY_MAX_NOTES }));
    }
    return {
      agent,
      tasks,
      updates,
      files,
      notes: [...notes.values()].sort((a, b) => b.seq - a.seq).slice(0, SUMMARY_MAX_NOTES),
      successors: this.agents.successorsOf(id),
      ...(reached ? { activity } : { historyUnavailable: local.unavailable[0]?.reason ?? offlineReason(id) }),
    };
  }

  async heartbeat(
    person: PersonName,
    id: AgentId,
    presence: ReportedPresence,
    usage?: ReportedUsage,
    context?: AgentContext,
  ): Promise<RosterResult> {
    if (this.managedClosed()) {
      this.requireManagedLifecycle(person, id);
      // Trusted Worker-only lifecycle RPC: never drain content queues or report usage.
      const result = await this.agents.heartbeat(person, id, presence);
      const association = this.managedAssociation(id);
      if (result.ok && association?.active === 1)
        await this.env.ORGANIZATION.getByName(association.organizationId).touchRegisteredExecution(
          association.executionId,
          id,
        );
      return result;
    }
    const result = this.withNextTurn(await this.agents.heartbeat(person, id, presence, usage, context));
    if (result.ok && usage !== undefined) this.recordUsage(usage);
    if (result.ok && this.binding.workspace !== null) {
      const association = this.managedAssociation(id);
      if (association?.active === 1)
        await this.env.ORGANIZATION.getByName(association.organizationId).touchRegisteredExecution(
          association.executionId,
          id,
        );
    }
    return result;
  }

  /** D1: internal lifecycle only, scoped to a recorded active execution and its owner. */
  private requireManagedLifecycle(person: PersonName, id: AgentId): void {
    const binding = this.binding;
    if (binding.version !== 1 || binding.state !== "linked" || !binding.workspace || !binding.operation)
      throw new Error("managed_actor_required");
    const association = this.managedAssociation(id);
    const agent = this.agents.find(id);
    if (
      association?.active !== 1 ||
      !agent ||
      agent.person !== person ||
      association.organizationId !== workspaceParent(binding.workspace)
    )
      throw new Error("managed_actor_required");
  }

  /** Every account the Channel has usage readings for (ADR 0011). */
  listAccounts(): AccountUsage[] {
    this.requireLegacyAccess();
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
    if (this.managedClosed()) this.requireManagedLifecycle(person, id);
    return this.agents.endSession(person, id, detail);
  }

  /**
   * A Person sending a Directive to one Agent, or a lead sending one to an Agent in its
   * subtree (ADR 0018). Refused through any other Agent's credentials.
   */
  sendDirective(caller: Caller, to: AgentId, text: string): DirectiveResult {
    this.requireLegacyAccess();
    if (caller.agent === undefined) {
      this.#joinPerson(caller.person);
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
    this.requireLegacyAccess();
    if (caller.agent !== undefined) {
      return {
        ok: false,
        status: 403,
        reason: "Only the Agent's own Person grants or revokes a role, never an Agent.",
      };
    }
    this.#joinPerson(caller.person);
    return this.agents.setRole(caller.person, id, role);
  }

  /**
   * Renames an Agent (ADR 0009): the Agent itself, through its token (the Tool
   * Capture), or any Person on the Channel. Everyone hears on the stream.
   */
  renameAgent(caller: Caller, id: AgentId, nickname: string | null): RosterResult {
    this.requireLegacyAccess();
    if (caller.agent !== undefined && caller.agent !== id) {
      return {
        ok: false,
        status: 403,
        reason: `This token belongs to Agent ${caller.agent}. An Agent renames itself only.`,
      };
    }
    if (caller.agent === undefined) this.#joinPerson(caller.person);
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
    this.requireLegacyAccess();
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
    this.requireLegacyAccess();
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
    this.requireLegacyAccess();
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
    this.requireLegacyAccess();
    return this.agents.setProxyMode(person, id, mode);
  }

  /**
   * Joins a Person to the Channel. The first time a name is seen it records a
   * `person.join` Event; later calls return the existing Person, updating the
   * time zone when a valid one is given.
   */
  join(name: PersonName, timeZone?: string): Person {
    this.requireLegacyAccess();
    return this.#joinPerson(name, timeZone);
  }

  #joinPerson(name: PersonName, timeZone?: string): Person {
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
   * or one an Agent posted through Switchboard's tools (the Tool Capture). `to`
   * addresses it to Agents on the Channel, Gone ones too, never the sender (ADR 0026).
   */
  postUpdate(
    caller: Caller,
    text: string,
    task?: TaskNumber,
    to?: readonly AgentId[],
  ): { ok: true; event: ChannelEvent } | ClaimRefusal {
    this.requireLegacyAccess();
    return this.#postUpdate(caller, text, task, to);
  }

  #postUpdate(
    caller: Caller,
    text: string,
    task?: TaskNumber,
    to?: readonly AgentId[],
  ): { ok: true; event: ChannelEvent } | ClaimRefusal {
    this.#joinPerson(caller.person);
    const who = this.claims.resolve(caller);
    if (!who.ok) return who;
    if (to !== undefined) {
      if (caller.agent !== undefined && to.includes(caller.agent)) {
        return { ok: false, status: 400, reason: "An Agent cannot address an Update to itself." };
      }
      const unknown = to.filter((id) => this.agents.find(id) === null);
      if (unknown.length > 0) {
        return {
          ok: false,
          status: 400,
          reason:
            `No Agent on this Channel is called ${unknown.join(", ")}. ` +
            "Address Agents by their Agent ID, as list_agents shows it.",
        };
      }
    }
    const event = this.append({
      type: "update",
      actor: who.acting.actor,
      capture: who.acting.capture,
      payload: { text, ...(to === undefined ? {} : { to: [...to] }) },
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
    this.requireLegacyAccess();
    return this.#writeNote(caller, note);
  }

  #writeNote(caller: Caller, note: PostNoteRequest): NoteResult | ClaimRefusal {
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

  /**
   * A page of Agent `id`'s transcript from entry `from`, for any Person or Agent on the
   * Channel (ADR 0019). Asked of its wrapper, which reads, condenses and redacts it; the
   * Channel keeps none of it, and records only that it was read.
   */
  async readTranscript(caller: Caller, id: AgentId, from: number, latest = false): Promise<TranscriptResult> {
    if (this.managedClosed()) return { ok: false, status: 403, reason: "Managed Channel access is closed until P3." };
    const generation = this.bindingState().generation;
    const ready = this.readable(caller, id, "transcript", this.transcriptReads);
    if (!ready.ok) return ready;
    const page = await this.askWrapper(
      this.transcriptReads,
      id,
      (request): TranscriptRequestMessage => ({
        type: "transcript.request",
        agent: id,
        id: request,
        from,
        ...(latest ? { latest } : {}),
      }),
    );
    if (this.managedClosed() || this.bindingState().generation !== generation)
      return { ok: false, status: 403, reason: "Managed Channel access is closed until P3." };
    if (page === false) {
      return {
        ok: false,
        status: 503,
        reason: `${id}'s wrapper is not connected to the Channel, so its transcript cannot be read now.`,
      };
    }
    if (page === null) {
      return { ok: false, status: 504, reason: `${id}'s wrapper did not send its transcript in time.` };
    }
    if (typeof page === "string")
      return { ok: false, status: 502, reason: `${id}'s wrapper could not read it: ${page}` };
    this.append({
      type: "transcript.read",
      actor: ready.who.actor,
      capture: ready.who.capture,
      payload: { agent: id, from: page.from, entries: page.entries.length },
    });
    return { ok: true, page: { agent: id, ...page } };
  }

  /**
   * Agent `id`'s screen as its wrapper shows watchers, redacted, for any Person or Agent
   * on the Channel (ADR 0024). Asked of its wrapper; the Channel keeps none of it, and
   * records only that it was read.
   */
  async readTerminal(caller: Caller, id: AgentId): Promise<TerminalReadResult> {
    if (this.managedClosed()) return { ok: false, status: 403, reason: "Managed Channel access is closed until P3." };
    const generation = this.bindingState().generation;
    const ready = this.readable(caller, id, "terminal", this.terminalReads);
    if (!ready.ok) return ready;
    const screen = await this.askWrapper(
      this.terminalReads,
      id,
      (request): TerminalReadRequestMessage => ({ type: "terminal.read.request", agent: id, id: request }),
    );
    if (this.managedClosed() || this.bindingState().generation !== generation)
      return { ok: false, status: 403, reason: "Managed Channel access is closed until P3." };
    if (screen === false) {
      return {
        ok: false,
        status: 503,
        reason: `${id}'s wrapper is not connected to the Channel, so its terminal cannot be read now.`,
      };
    }
    if (screen === null) return { ok: false, status: 504, reason: `${id}'s wrapper did not send its screen in time.` };
    if (typeof screen === "string")
      return { ok: false, status: 502, reason: `${id}'s wrapper could not read it: ${screen}` };
    this.append({
      type: "terminal.read",
      actor: ready.who.actor,
      capture: ready.who.capture,
      payload: { agent: id, rows: screen.lines.length },
    });
    return { ok: true, screen: { agent: id, ...screen } };
  }

  /**
   * Whether Agent `id`'s running session can be read for `caller` now: it exists, is not
   * Gone, and no other read of the same kind waits on its wrapper (each makes the wrapper
   * read and redact). With who is reading, for the Event the read records.
   */
  private readable<T>(
    caller: Caller,
    id: AgentId,
    what: "transcript" | "terminal",
    reads: Map<string, WrapperRead<T>>,
  ): { ok: true; who: { actor: Actor; capture: Capture | null } } | Extract<TranscriptResult, { ok: false }> {
    const agent = this.agents.find(id);
    if (agent === null) return { ok: false, status: 404, reason: `No Agent ${id} on this Channel.` };
    if (agent.presence === "gone") {
      return {
        ok: false,
        status: 409,
        reason: `${id} is Gone. Its ${what} is read from its running session, so it can be read again once the session resumes.`,
      };
    }
    const who = this.claims.resolve(caller);
    if (!who.ok) return who;
    if ([...reads.values()].some((read) => read.agent === id)) {
      return {
        ok: false,
        status: 429,
        reason: `${id}'s ${what} is being read for someone else right now. Try again in a moment.`,
      };
    }
    return { ok: true, who: who.acting };
  }

  /**
   * Sends Agent `id`'s wrapper the request `message` makes, and waits for its answer in
   * `reads`: what it sent, a string saying why it could not, null when it did not answer
   * in time, or false at once when no wrapper of it is connected.
   */
  private askWrapper<T>(
    reads: Map<string, WrapperRead<T>>,
    id: AgentId,
    message: (request: string) => TranscriptRequestMessage | TerminalReadRequestMessage,
  ): Promise<T | string | null> | false {
    const request = crypto.randomUUID();
    const answered = new Promise<T | string | null>((resolve) => {
      const timer = setTimeout(() => {
        reads.delete(request);
        resolve(null);
      }, this.transcriptWaitMs);
      reads.set(request, {
        agent: id,
        answer: (answer) => {
          clearTimeout(timer);
          reads.delete(request);
          resolve(answer);
        },
      });
    });
    if (!this.interruptTo(id, message(request))) {
      reads.get(request)?.answer("");
      return false;
    }
    return answered;
  }

  /** Each shared skill's latest version (ADR 0039). */
  listSkills(): SkillSummary[] {
    this.requireLegacyAccess();
    return this.skills.list();
  }

  /** One version of a shared skill with its manifest, the latest when `version` is left out. */
  readSkill(name: string, version?: number): SkillResult<{ skill: Skill; versions: number[] }> {
    this.requireLegacyAccess();
    return this.skills.read(name, version);
  }

  /** Publishes the next version of a skill for `caller`, a Person or one of their Agents. */
  publishSkill(
    caller: Caller,
    name: string,
    files: SkillEntry[],
  ): Promise<SkillResult<{ skill: SkillSummary; published: boolean }>> {
    this.requireLegacyAccess();
    return this.skills.publish(caller, name, files);
  }

  /** Stores chunks of skill files, keeping each file once its bytes match its digest (ADR 0050). */
  uploadSkillFiles(chunks: UploadedChunk[]): Promise<SkillResult<{ complete: string[] }>> {
    this.requireLegacyAccess();
    return this.skills.upload(chunks);
  }

  /** Chunks of the files published skills hold. */
  readSkillFiles(
    chunks: { digest: string; index: number }[],
  ): SkillResult<{ digest: string; index: number; data: Uint8Array }[]> {
    this.requireLegacyAccess();
    return this.skills.readChunks(chunks);
  }

  /** Each artifact's latest version, the latest published first (ADR 0053). */
  listArtifacts(): ArtifactSummary[] {
    this.requireLegacyAccess();
    return this.artifacts.list();
  }

  /** One version of an artifact, the latest when `version` is left out, and every version kept. */
  readArtifact(name: string, version?: number): ArtifactResult<{ artifact: ArtifactSummary; versions: number[] }> {
    this.requireLegacyAccess();
    return this.artifacts.read(name, version);
  }

  /** One version of an artifact with its page. */
  artifactPage(name: string, version?: number): ArtifactResult<{ artifact: ArtifactSummary; html: string }> {
    this.requireLegacyAccess();
    return this.artifacts.page(name, version);
  }

  /** Publishes the next version of an artifact for `caller`, a Person or one of their Agents. */
  async publishArtifact(
    caller: Caller,
    name: string,
    page: { html: string; title: string },
  ): Promise<ArtifactResult<{ artifact: ArtifactSummary; published: boolean }>> {
    this.requireLegacyAccess();
    const who = this.claims.resolve(caller);
    if (!who.ok) return who;
    if (caller.agent === undefined) return this.artifacts.publish({ person: caller.person }, name, page);
    const nickname = this.agents.find(caller.agent)?.nickname;
    return this.artifacts.publish(
      { person: caller.person, agent: caller.agent, ...(nickname === undefined ? {} : { nickname }) },
      name,
      page,
    );
  }

  /** Deletes an artifact with every kept version, for its owner as a Person (ADR 0053). */
  deleteArtifact(person: PersonName, name: string): ArtifactResult<{ deleted: string; versions: number }> {
    this.requireLegacyAccess();
    return this.artifacts.delete(person, name);
  }

  /** Every page of the Brief, current versions, for any Person or Agent on the Channel (ADR 0042). */
  briefPages(): BriefPage[] {
    this.requireLegacyAccess();
    return this.brief.pages();
  }

  /** One page of the Brief, current or one of its kept earlier versions. */
  readBriefPage(page: string, version?: number): BriefResult<{ page: BriefPage; versions: number[] }> {
    this.requireLegacyAccess();
    return this.brief.read(page, version);
  }

  /** Replaces a page of the Brief. Only an Agent writes one, for its Person (ADR 0042). */
  writeBriefPage(
    caller: Caller,
    page: string,
    write: WriteBriefRequest,
  ): BriefResult<{ page: BriefPage; written: boolean }> | ClaimRefusal {
    this.requireLegacyAccess();
    return this.#writeBriefPage(caller, page, write);
  }

  #writeBriefPage(
    caller: Caller,
    page: string,
    write: WriteBriefRequest,
  ): BriefResult<{ page: BriefPage; written: boolean }> | ClaimRefusal {
    if (caller.agent === undefined) {
      return {
        ok: false,
        status: 403,
        reason: "Only Agents write the Brief, through their own MCP. A Person asks their Agent to.",
      };
    }
    const who = this.claims.resolve(caller);
    if (!who.ok) return who;
    const nickname = this.agents.find(caller.agent)?.nickname;
    return this.brief.write(
      { agent: caller.agent, person: caller.person, ...(nickname === undefined ? {} : { nickname }) },
      page,
      write,
      caller.librarian === true,
    );
  }

  /**
   * The Librarian Feed (ADR 0045): what changed after the Librarian Cursor that may
   * change a Brief page, the Quiet Claims now, and the Brief's budget today. Only reads.
   */
  librarianFeed(): LibrarianFeedResponse {
    this.requireLegacyAccess();
    return librarianFeed({
      sql: this.ctx.storage.sql,
      toEvent: rowToEvent,
      quiet: () => {
        const answer = this.askChannel({ since: new Date().toISOString() });
        return answer.tasks.flatMap((task): QuietClaim[] => {
          const since = answer.quiet[task.number];
          const holder = task.claim?.holder;
          if (since === undefined || holder === undefined) return [];
          return [
            {
              task: task.number,
              title: task.title,
              holder: holder.kind === "agent" ? holder.agentId : holder.person,
              since,
            },
          ];
        });
      },
      briefPages: () => this.brief.count(),
      briefBudget: () => this.brief.budget(),
    });
  }

  /** Moves the Librarian Cursor: the librarian's token only (ADR 0045). */
  moveLibrarianCursor(
    caller: Caller,
    request: MoveLibrarianCursorRequest,
  ): { ok: true; cursor: number } | { ok: false; status: number; reason: string } {
    this.requireLegacyAccess();
    if (caller.agent === undefined || caller.librarian !== true) {
      return { ok: false, status: 403, reason: "Only the Channel's librarian moves its cursor." };
    }
    return moveLibrarianCursor(this.ctx.storage.sql, caller.agent, request.through, request.quiet);
  }

  /**
   * The Connector's `brief` tool (ADR 0042): one page and, for the overview or a page
   * there is none of, the list of pages. Bounded by the Brief's page cap, and no write.
   */
  askBrief(page: string, generation = this.binding.generation): { page: BriefPage | null; pages?: BriefPageSummary[] } {
    if (!this.bindingCurrent(generation)) throw new Error("Managed Channel access is closed until P3.");
    return this.brief.ask(page);
  }

  /** Whether `person` is the Channel's owner, an admin of its repo, asked of GitHub now (ADR 0044). */
  isOwner(person: PersonName, dev: boolean): Promise<{ ok: true; owner: boolean } | { ok: false; reason: string }> {
    return this.access.isOwner(person, dev);
  }

  /**
   * The Channel's Langfuse project with its secret key still sealed, for the Worker
   * alone: the settings route shows only `connection(...)` of it, and the Connector's
   * costs tool opens the key for its calls to Langfuse (ADR 0044). One row read.
   */
  langfuseProject(generation = this.binding.generation): StoredLangfuse | null {
    if (!this.bindingCurrent(generation)) throw new Error("Managed Channel access is closed until P3.");
    return this.langfuse.get();
  }

  /** Connects the Channel's Langfuse project, or replaces it. The Worker checked the owner and the keys. */
  setLangfuseProject(stored: StoredLangfuse): void {
    this.requireLegacyAccess();
    this.langfuse.set(stored);
  }

  /** Removes the Channel's Langfuse project. True when there was one. */
  removeLangfuseProject(): boolean {
    this.requireLegacyAccess();
    return this.langfuse.remove();
  }

  /** The Channel's notes, for any Person or Agent on it (ADR 0019). */
  /**
   * The `channel` tool of the read-only connector (ADR 0040): what is in progress,
   * what is stuck, what was said since `since`, narrowed by `about`. Bounded reads
   * through indexes, and no write.
   */
  askChannel(question: ChannelQuestion, generation = this.binding.generation): ChannelAnswer {
    if (!this.bindingCurrent(generation)) throw new Error("Managed Channel access is closed until P3.");
    const sql = this.ctx.storage.sql;
    return askChannel(
      {
        sql,
        claimedTasks: (limit) => this.tasks.claimed(limit),
        task: (number) => this.tasks.read(number),
        agent: (id) => this.agents.find(id),
        liveAgents: (limit) => this.agents.live(limit),
        isPerson: (name) => sql.exec("SELECT name FROM persons WHERE name = ?", name).toArray().length > 0,
        notes: (query) => this.memory.read(query),
        indexed: (name) => this.historyIndexes.built.has(name),
        toEvent: rowToEvent,
        quietAfterMs: this.quietAfterMs,
      },
      question,
    );
  }

  /**
   * Admits a call to the read-only connector (ADR 0040): its access token's grant must
   * still be live (one read by key), and its Person a Member, as for every Channel call.
   */
  admitConnector(
    repo: string,
    person: PersonName,
    grant: string,
    dev: boolean,
  ): Promise<AdmitResult & { generation?: number }> {
    if (!this.mcpGrants.live(grant)) {
      return Promise.resolve({ ok: false, status: 401, reason: "This sign-in ended. Connect the app again." });
    }
    return this.admit(repo, { kind: "session", person }, dev);
  }

  /** Starts the grant of a connector sign-in whose code was redeemed (ADR 0040). */
  startMcpGrant(id: string, person: PersonName, client: string, expiresAt: number): GrantResult {
    this.requireLegacyAccess();
    return this.mcpGrants.start(id, person, client, expiresAt);
  }

  /** Rotates a connector sign-in's grant for a refresh (ADR 0040). */
  rotateMcpGrant(id: string, generation: number, client: string, expiresAt: number): GrantResult {
    this.requireLegacyAccess();
    return this.mcpGrants.rotate(id, generation, client, expiresAt);
  }

  readMemory(query: MemoryQuery): MemoryReadResult {
    this.requireLegacyAccess();
    return this.memory.read(query);
  }

  /** Events with `seq` greater than `after`, oldest first. */
  history(after: number, limit: number): ChannelEvent[] {
    this.requireLegacyAccess();
    return this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit)
      .toArray()
      .map(rowToEvent);
  }

  /**
   * The latest `count` Events with `seq` below `before`, oldest first: the stored ones and
   * the Local Events every reachable machine keeps (ADR 0037), with the Hosts it could not reach.
   */
  async latestEvents(count: number, before = Number.MAX_SAFE_INTEGER): Promise<HistoryPage> {
    if (this.managedClosed()) throw new Error("Managed Channel access is closed until P3.");
    const stored = this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?", before, count)
      .toArray()
      .map(rowToEvent);
    return this.withLocalEvents(stored, { before, limit: count });
  }

  /**
   * The latest `count` Events about Agent `agent` with `seq` below `before`, oldest
   * first: what it did, the Directives to it and its renames by others.
   */
  async latestEventsOfAgent(
    agent: AgentId,
    count: number,
    before = Number.MAX_SAFE_INTEGER,
  ): Promise<HistoryPage | IndexPending | IndexTooLarge> {
    this.requireLegacyAccess();
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
    // An Agent that renamed itself is in two of the reads: merging keeps each Event once.
    return this.withLocalEvents(rows.map(rowToEvent), { agent, before, limit: count });
  }

  /**
   * The latest `count` Events on Task `task` with `seq` below `before`, oldest first.
   * Verdicts are left out, as from the index: there are many per Event, and the
   * Dashboard reads them with the Events they judge.
   */
  async latestEventsOfTask(
    task: TaskNumber,
    count: number,
    before = Number.MAX_SAFE_INTEGER,
  ): Promise<HistoryPage | IndexPending | IndexTooLarge> {
    this.requireLegacyAccess();
    const pending = this.pendingIndex("events_by_task");
    if (pending) return pending;
    const stored = this.ctx.storage.sql
      .exec<EventRow>(
        `SELECT * FROM events INDEXED BY events_by_task
         WHERE task = ? AND type <> 'verdict' AND seq < ? ORDER BY seq DESC LIMIT ?`,
        task,
        before,
        count,
      )
      .toArray()
      .map(rowToEvent);
    const page = await this.withLocalEvents(stored, { task, before, limit: count });
    // As from the index: a Task's history leaves its Verdicts out.
    return { ...page, events: page.events.filter((event) => event.type !== "verdict") };
  }

  /**
   * `stored`, merged with the Local Events the machines that keep them answer with for
   * `asked` (ADR 0037), cut to its limit, and what could not be read. Machines are asked
   * at once, each waited for at most the history wait.
   */
  private async withLocalEvents(stored: ChannelEvent[], asked: HistoryAsk): Promise<HistoryPage> {
    if (this.managedClosed()) throw new Error("Managed Channel access is closed until P3.");
    const generation = this.bindingState().generation;
    const { holders, unavailable } = this.historyHolders(asked);
    const pages = await Promise.all(
      holders.map(async (holder) => {
        const events = await this.askHistory(holder);
        return { holder, events };
      }),
    );
    if (this.managedClosed() || this.bindingState().generation !== generation)
      throw new Error("Managed Channel access is closed until P3.");
    for (const { holder, events } of pages) {
      if (events !== null) continue;
      const [person, tag] = this.socketIdentityTags(holder.ws);
      const who = tag?.startsWith(HOST_TAG) ? tag.slice(HOST_TAG.length) : (holder.asked.agent ?? person ?? "");
      unavailable.push({
        ...(tag?.startsWith(HOST_TAG) ? { host: who as HostId } : {}),
        agents: holder.asked.agent === undefined ? [] : [holder.asked.agent],
        reason: `history unavailable: ${who} did not answer in time`,
      });
    }
    return {
      events: mergePages([stored, ...pages.map((page) => page.events ?? [])], asked.limit),
      unavailable,
    };
  }

  /**
   * Which sockets to ask for `asked`, and which history is out of reach (ADR 0037). For one
   * Agent: its wrapper while attached, else its Host. For the feed or a Task: every attached
   * Host, and every attached wrapper whose machine has no attached Host.
   */
  private historyHolders(asked: HistoryAsk): { holders: HistoryHolder[]; unavailable: HistoryGap[] } {
    const holders: HistoryHolder[] = [];
    const unavailable: HistoryGap[] = [];
    if (asked.agent !== undefined) {
      const agent = this.agents.find(asked.agent);
      if (agent === null) return { holders, unavailable };
      const wrapper = this.wrapperSocket(agent.id, true);
      const host = agent.historyHost === undefined ? null : this.hostSocket(agent.historyHost, true);
      if (wrapper !== null) holders.push({ ws: wrapper, asked });
      else if (host !== null) holders.push({ ws: host, asked });
      else {
        unavailable.push({
          ...(agent.historyHost === undefined ? {} : { host: agent.historyHost }),
          agents: [agent.id],
          reason:
            agent.historyHost !== undefined
              ? this.unreachable(agent.historyHost)
              : this.wrapperSocket(agent.id) !== null
                ? oldSwitchboard(agent.id)
                : offlineReason(agent.id),
        });
      }
      return { holders, unavailable };
    }
    const hosts = new Set<HostId>();
    for (const host of this.hosts.list()) {
      const ws = this.hostSocket(host.id, true);
      if (ws !== null) {
        hosts.add(host.id);
        holders.push({ ws, asked });
      } else {
        unavailable.push({ host: host.id, agents: [], reason: this.unreachable(host.id) });
      }
    }
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const attached = ws.deserializeAttachment() as WrapperAttachment | null;
      if (attached?.agent === undefined || attached.history !== true) continue;
      if (this.wrapperSocket(attached.agent, true) !== ws) continue;
      const agent = this.agents.find(attached.agent);
      if (agent === null || (agent.historyHost !== undefined && hosts.has(agent.historyHost))) continue;
      holders.push({ ws, asked: { ...asked, agent: agent.id } });
    }
    return { holders, unavailable };
  }

  /** Why Host `id`'s Local Events cannot be read: it is away, or it runs a switchboard that keeps none. */
  private unreachable(id: HostId): string {
    return this.hostSocket(id) === null ? offlineReason(id) : oldSwitchboard(id);
  }

  /** Asks one socket for a page of the Local Events it keeps: its page, or null when it does not answer in time. */
  private askHistory(holder: HistoryHolder): Promise<ChannelEvent[] | null> {
    const [person, tag] = this.socketIdentityTags(holder.ws);
    if (person === undefined || tag === undefined) return Promise.resolve(null);
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.historyReads.delete(id);
        resolve(null);
      }, this.historyWaitMs);
      this.historyReads.set(id, {
        person,
        tag,
        asked: holder.asked,
        answer: (events) => {
          clearTimeout(timer);
          this.historyReads.delete(id);
          resolve(events);
        },
      });
      const request: HistoryRequestMessage = { type: "history.request", id, ...holder.asked };
      if (!send(holder.ws, request)) this.historyReads.get(id)?.answer(null);
    });
  }

  /** `history.page` from a wrapper's or a Host's socket: the answer to a read asked of that socket. */
  private historyAnswered(ws: WebSocket, body: Record<string, unknown>): void {
    const read = typeof body.id === "string" ? this.historyReads.get(body.id) : undefined;
    if (read === undefined) return;
    const [person, tag] = this.socketIdentityTags(ws);
    if (person !== read.person || tag !== read.tag) return;
    if (typeof body.error === "string") {
      read.answer(null);
      return;
    }
    // Only its own Person's Agents' Local Events, inside what was asked.
    read.answer(cleanHistoryPage(body.events, person, read.asked));
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
    this.requireLegacyAccess();
    if (ids.length === 0) return [];
    const stored = this.ctx.storage.sql
      .exec<EventRow>(`SELECT * FROM events WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY seq`, ...ids)
      .toArray()
      .map(rowToEvent);
    // A recent Local Event is still known here; older ones are only on their machine.
    const recent = ids.flatMap((id) => this.recentLocal.get(id) ?? []);
    return recent.length === 0 ? stored : mergePages([stored, recent], Number.MAX_SAFE_INTEGER);
  }

  /** The first `count` Wakes with `seq` above `after`, oldest first. */
  wakesAfter(after: number, count: number): ChannelEvent[] | IndexPending | IndexTooLarge {
    this.requireLegacyAccess();
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
    this.requireLegacyAccess();
    return this.ctx.storage.sql.exec<PersonRow>("SELECT * FROM persons ORDER BY name").toArray().map(rowToPerson);
  }

  /**
   * Upgrades an already-admitted request to the live stream. The Worker passes the
   * admitted Person as `?person=`, the Agent when the stream was opened with an
   * Agent token as `?agent=`, and the resume cursor as `?after=`. An Agent's stream
   * is its wrapper's: only it may send that Agent's Hook and Proxy Events.
   */
  override async fetch(request: Request): Promise<Response> {
    if (this.managedClosed()) return new Response("Managed Channel access is closed until P3.", { status: 403 });
    const generation = this.binding.generation;
    const url = new URL(request.url);
    if (url.searchParams.has("generation") && Number(url.searchParams.get("generation")) !== generation)
      return new Response("Binding changed", { status: 403 });
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
      this.ctx.acceptWebSocket(server, this.socketTags([name, hostTag(hostIdFor(name, host))], generation));
      server.serializeAttachment({
        at: Date.now(),
        ...(url.searchParams.get("history") === "1" ? { history: true } : {}),
      } satisfies HostAttachment);
      this.hosts.attach(name, host);
      await this.watchMembers();
      if (!this.bindingCurrent(generation)) return new Response("Binding changed", { status: 403 });
      return new Response(null, { status: 101, webSocket: client });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(
      server,
      this.socketTags(agent === null ? [name] : [name, agentTag(agent as AgentId)], generation),
    );
    // Everything below is synchronous, so no other Event can be appended
    // between the backlog and the live stream: none is missed or sent twice.
    if (after !== null) {
      for (const event of this.history(Number(after), Number.MAX_SAFE_INTEGER)) {
        send(server, { type: "event", event });
      }
    }
    for (const agent of this.agents.list()) send(server, { type: "agent", agent });
    this.#joinPerson(name);
    await this.watchMembers();
    if (!this.bindingCurrent(generation)) return new Response("Binding changed", { status: 403 });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Generation zero is implicit for legacy and never-linked sockets. */
  private socketTags(identity: string[], generation: number): string[] {
    return generation === 0 ? identity : [...identity, `binding:${generation}`];
  }

  /** Binding metadata must not occupy the legacy Person/Agent/Host identity slots. */
  private socketIdentityTags(ws: WebSocket, tags = this.ctx.getTags(ws)): string[] {
    // Generation zero sockets use precisely the legacy identity tags. Once a
    // transition has occurred, also handle old sockets still completing close.
    return this.binding.generation === 0 && !tags.includes("binding:0")
      ? tags
      : tags.filter((tag) => !tag.startsWith("binding:"));
  }

  /**
   * The stream is receive-only except for what a wrapper says about its own Agent: its Hook
   * and Proxy Events (with the reply on the same socket), what it holds for the next turn,
   * whether it typed an Interrupt or Directive, and its Wakes. Clients do everything else
   * over HTTP.
   */
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // No transition has ever occurred at generation zero. Missing tags remain
    // generation zero after a restart; a later transition checks them as stale.
    if (
      this.managedClosed() ||
      (this.binding.generation !== 0 &&
        (this.ctx.getTags(ws).find((tag) => tag.startsWith("binding:")) ?? "binding:0") !==
          `binding:${this.binding.generation}`)
    ) {
      ws.close(1008, "Managed Channel access is closed until P3.");
      return;
    }
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
      type !== "transcript.page" &&
      type !== "terminal.text" &&
      type !== "host.spawn.failed" &&
      type !== "host.control.failed" &&
      type !== "host.paused" &&
      type !== "host.allow.result" &&
      type !== "terminal.watch" &&
      type !== "terminal.input" &&
      type !== "terminal.screen" &&
      type !== "terminal.refused" &&
      type !== "terminal.attached" &&
      type !== "history.page"
    ) {
      return;
    }
    const [person, tag] = this.socketIdentityTags(ws);
    if (person === undefined) return;
    if (type === "history.page") {
      this.historyAnswered(ws, frame as Record<string, unknown>);
      return;
    }
    if (type === "host.spawn.failed") {
      // Only a Host's own socket answers for its spawns.
      const host = tag?.startsWith(HOST_TAG) ? tag.slice(HOST_TAG.length + person.length + 1) : null;
      const { spawn, reason } = frame as { spawn?: unknown; reason?: unknown };
      if (host === null || typeof spawn !== "string" || typeof reason !== "string") return;
      this.hosts.hostFailed(person, host, spawn, reason.slice(0, MAX_SPAWN_FAILURE_LENGTH) || "no reason given");
      return;
    }
    if (type === "host.allow.result") {
      const host = tag?.startsWith(HOST_TAG) ? tag.slice(HOST_TAG.length + person.length + 1) : null;
      const { id, ok, reason } = frame as Record<string, unknown>;
      if (host === null || typeof id !== "string" || typeof ok !== "boolean") return;
      const why = typeof reason === "string" ? reason.slice(0, MAX_SPAWN_FAILURE_LENGTH) : undefined;
      this.hosts.allowAnswered(hostIdFor(person, host), id, ok, why);
      return;
    }
    if (type === "host.control.failed" || type === "host.paused") {
      // Only a Host's own socket answers for its Agents (ADR 0028).
      const host = tag?.startsWith(HOST_TAG) ? tag.slice(HOST_TAG.length + person.length + 1) : null;
      if (host === null) return;
      const { action, agent, by, reason } = frame as Record<string, unknown>;
      if (typeof agent !== "string" || agent.split("/").length !== 3) return;
      if (type === "host.paused") {
        this.hosts.hostPaused(person, host, agent as AgentId);
        return;
      }
      if ((action !== "stop" && action !== "pause" && action !== "resume") || typeof by !== "string") return;
      if (typeof reason !== "string") return;
      this.hosts.controlFailed(person, host, {
        action,
        agent: agent as AgentId,
        by,
        reason: reason.slice(0, MAX_SPAWN_FAILURE_LENGTH) || "no reason given",
      });
      return;
    }
    // The Agent whose token opened this socket; a Person's socket speaks for no Agent.
    const socketAgent = tag?.startsWith(AGENT_TAG) ? (tag.slice(AGENT_TAG.length) as AgentId) : null;
    const body = frame as Record<string, unknown>;
    if (type === "terminal.watch" || type === "terminal.input") {
      // Only a Person's own socket, the Dashboard's, watches and types (ADR 0021).
      if (tag !== undefined) return;
      if (type === "terminal.watch") this.terminalWatch(ws, body);
      else this.terminalInput(ws, person, body);
      return;
    }
    if (type === "terminal.screen" || type === "terminal.refused" || type === "terminal.attached") {
      // Only the Agent's own wrapper speaks for its terminal.
      if (socketAgent === null || body.agent !== socketAgent) return;
      if (type === "terminal.attached") {
        const attached = parseAttached(body, socketAgent);
        if (attached === null) return;
        const { type: _, ...payload } = attached;
        this.append({
          type: "terminal.attached",
          actor: { kind: "agent", agentId: socketAgent },
          capture: null,
          payload,
        });
        return;
      }
      const out = type === "terminal.screen" ? parseScreen(body, socketAgent) : parseRefused(body, socketAgent);
      if (out === null) return;
      for (const watcher of this.watchersOf(socketAgent)) send(watcher, out);
      return;
    }
    if (type === "interrupt.attach" || type === "interrupt.result" || type === "directive.result") {
      // Only the Agent's own wrapper may speak for it.
      const agent = body.agent;
      if (typeof agent !== "string" || agent !== socketAgent) return;
      if (type === "interrupt.attach") {
        // Kept on the socket itself, so it survives hibernation and goes when the socket does.
        // A wrapper that keeps its Agent's Local Events says so (ADR 0037).
        const attached: WrapperAttachment = {
          agent: agent as AgentId,
          at: Date.now(),
          ...(body.history === true ? { history: true } : {}),
        };
        ws.serializeAttachment(attached);
        // Tells the wrapper its Agent's Interrupts and Directives come here from now on.
        send(ws, { type: "interrupt.attached", agent: agent as AgentId });
        // And whether anyone watches its terminal, so a new run of the wrapper starts streaming.
        send(ws, this.watchersMessage(agent as AgentId));
        // Directives sent before it attached are typed now (ADR 0025).
        this.directives.attached(agent as AgentId);
        return;
      }
      const result = parseInterruptResult(body);
      if (result === null) return;
      if (type === "interrupt.result") this.relay.interruptAnswered(result);
      else this.directives.answered(result.agent, result.id, result.typed ? "typed" : result.reason);
      return;
    }
    if (type === "transcript.page") {
      // Only the read Agent's own wrapper answers for its transcript, and only what was asked of it.
      const read = typeof body.id === "string" ? this.transcriptReads.get(body.id) : undefined;
      if (read === undefined || body.agent !== read.agent || body.agent !== socketAgent) return;
      if (typeof body.error === "string") {
        read.answer(body.error.slice(0, 300) || "no reason given");
        return;
      }
      const page = cleanTranscriptPage(body.page);
      read.answer(page ?? "its page was not one the Channel can read");
      return;
    }
    if (type === "terminal.text") {
      // Only the read Agent's own wrapper answers for its screen, and only what was asked of it.
      const read = typeof body.id === "string" ? this.terminalReads.get(body.id) : undefined;
      if (read === undefined || body.agent !== read.agent || body.agent !== socketAgent) return;
      if (typeof body.error === "string") {
        read.answer(body.error.slice(0, 300) || "no reason given");
        return;
      }
      read.answer(cleanTerminalText(body) ?? "its screen was not one the Channel can read");
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
    message:
      | InterruptMessage
      | DirectiveInterruptMessage
      | ApprovalDenyMessage
      | TranscriptRequestMessage
      | TerminalReadRequestMessage
      | TerminalWatchersMessage
      | TerminalInputFrame,
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
    this.requireLegacyAccess();
    return this.agents.has(id) ? this.hooks.touchedFiles(id) : null;
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      // The close is answered, or the client's connection never ends (ADR 0052). A code the
      // client may not send back (1005 "no code", 1006, 1015) is answered with 1000.
      ws.close(answerableCode(code), reason);
    } catch {
      // Already closed.
    }
    if (this.binding.state === "linked") this.managedHistoryAdapter?.disconnect(ws);
    const [person, tag] = this.socketIdentityTags(ws);
    if (person !== undefined && tag?.startsWith(HOST_TAG)) {
      await this.hosts.detached(person, tag.slice(HOST_TAG.length + person.length + 1));
    }
    if (tag === undefined) {
      // A watcher left: each Agent it watched is told how many are left.
      const watched = (ws.deserializeAttachment() as WatchAttachment | null)?.watch ?? [];
      for (const agent of watched) this.tellWatchers(agent);
    }
  }

  /** `terminal.watch` from a Person's socket: start or stop watching an Agent's terminal. */
  private terminalWatch(ws: WebSocket, body: Record<string, unknown>): void {
    const { agent, on } = body;
    if (typeof agent !== "string" || typeof on !== "boolean" || !this.agents.has(agent as AgentId)) return;
    const id = agent as AgentId;
    const watch = (ws.deserializeAttachment() as WatchAttachment | null)?.watch ?? [];
    const next = on ? (watch.includes(id) ? watch : [...watch, id]) : watch.filter((a) => a !== id);
    if (next.length > MAX_WATCHED) return;
    ws.serializeAttachment({ watch: next } satisfies WatchAttachment);
    this.tellWatchers(id);
  }

  /** `terminal.input` from a Person's socket: carried to the Agent's wrapper, which decides. */
  private terminalInput(ws: WebSocket, person: string, body: Record<string, unknown>): void {
    const input = parseInput(body, person);
    if (input === null) return;
    const refuse = (reason: string) =>
      send(ws, { type: "terminal.refused", agent: input.agent, fingerprint: "", seq: input.seq, reason });
    if (!this.inputRate.take(ws)) {
      refuse("too many keystrokes a second; this one was dropped");
      return;
    }
    if (!this.agents.has(input.agent) || !this.interruptTo(input.agent, input)) {
      refuse("the Agent's wrapper is not connected");
    }
  }

  /** Every open Person's socket watching Agent `id`. A closing one is not open. */
  private watchersOf(id: AgentId): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) return false;
      if (this.socketIdentityTags(ws)[1] !== undefined) return false;
      return (ws.deserializeAttachment() as WatchAttachment | null)?.watch?.includes(id) === true;
    });
  }

  /** Tells Agent `id`'s wrapper who watches it, so it streams only while someone does. */
  private tellWatchers(id: AgentId): void {
    this.interruptTo(id, this.watchersMessage(id));
  }

  private watchersMessage(id: AgentId): TerminalWatchersMessage {
    const watchers = this.watchersOf(id);
    const persons = [...new Set(watchers.map((ws) => this.socketIdentityTags(ws)[0] ?? ""))]
      .filter((p) => p !== "")
      .sort();
    return { type: "terminal.watchers", agent: id, count: watchers.length, persons };
  }

  /** Every Host on the Channel, with whether it is Live. */
  listHosts(): { hosts: Host[]; cap: number; running: number } {
    this.requireLegacyAccess();
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
    this.requireLegacyAccess();
    this.#joinPerson(person);
    return this.hosts.register(person, request);
  }

  /** A signed allow-list change for one of `person`'s Hosts, passed on to the Host to judge (ADR 0028). */
  setHostAllow(person: PersonName, name: string, request: SetHostAllowRequest) {
    this.requireLegacyAccess();
    this.#joinPerson(person);
    return this.hosts.setAllow(person, name, request);
  }

  removeHost(person: PersonName, name: string): boolean {
    this.requireLegacyAccess();
    return this.hosts.remove(person, name);
  }

  /** Starts an Agent on one of the caller's Person's Hosts (ADR 0015), for the Person or their lead (ADR 0018). */
  async spawnAgent(caller: Caller, request: SpawnAgentRequest): Promise<SpawnResult> {
    this.requireLegacyAccess();
    // A hand-off names an Agent the Channel knows (ADR 0024); the new session reads its summary.
    if (request.from !== undefined && !this.agents.has(request.from)) {
      return { ok: false, status: 404, reason: `No Agent ${request.from} on this Channel to continue.` };
    }
    if (caller.agent === undefined) {
      this.#joinPerson(caller.person);
      return this.hosts.spawn({ person: caller.person }, request);
    }
    const lead = this.lead(caller.agent, "start Agents");
    if (!lead.ok) return lead;
    return this.hosts.spawn({ person: caller.person, lead: caller.agent }, request);
  }

  /**
   * Stops an Agent a Host runs: for the Person (their own, or on a Host that allows them,
   * ADR 0028), or their lead over it.
   */
  stopAgent(caller: Caller, id: AgentId): ControlResult {
    this.requireLegacyAccess();
    if (caller.agent === undefined) {
      this.#joinPerson(caller.person);
      return this.hosts.control({ person: caller.person }, id, "stop");
    }
    const lead = this.lead(caller.agent, "stop Agents");
    if (!lead.ok) return lead;
    return this.hosts.control({ person: caller.person, lead: caller.agent }, id, "stop");
  }

  /** Pauses (ends the process of, keeping the session of) or resumes an Agent a Host runs: for a Person only (ADR 0028). */
  controlAgent(person: PersonName, id: AgentId, action: "pause" | "resume"): ControlResult {
    this.requireLegacyAccess();
    this.#joinPerson(person);
    return this.hosts.control({ person }, id, action);
  }

  /** Host `id`'s newest open socket, or null when it is Offline; with `history`, only one that answers history reads. */
  private hostSocket(id: HostId, history = false): WebSocket | null {
    let newest: { ws: WebSocket; at: number } | null = null;
    for (const ws of this.ctx.getWebSockets(hostTag(id))) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const attached = ws.deserializeAttachment() as HostAttachment | null;
      const at = attached?.at ?? 0;
      if (newest === null || at > newest.at) newest = { ws, at };
    }
    if (newest === null) return null;
    if (history && (newest.ws.deserializeAttachment() as HostAttachment | null)?.history !== true) return null;
    return newest.ws;
  }

  /**
   * The socket that most recently said it is Agent `id`'s wrapper, or null; with
   * `history`, only when that wrapper answers history reads (ADR 0037).
   */
  private wrapperSocket(id: AgentId, history = false): WebSocket | null {
    const person = id.split("/")[0];
    if (person === undefined) return null;
    let target: { ws: WebSocket; attached: WrapperAttachment } | null = null;
    for (const ws of this.ctx.getWebSockets(person)) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const attached = ws.deserializeAttachment() as WrapperAttachment | null;
      if (attached?.agent !== id) continue;
      if (target === null || attached.at > target.attached.at) target = { ws, attached };
    }
    if (target === null || (history && target.attached.history !== true)) return null;
    return target.ws;
  }

  /** `person`'s sockets that carry the stream: theirs and their wrappers', not their Hosts'. */
  private personSockets(person: PersonName): WebSocket[] {
    return this.ctx.getWebSockets(person).filter((ws) => !this.socketIdentityTags(ws)[1]?.startsWith(HOST_TAG));
  }

  private append<K extends EventType>(event: NewEvent<K>): ChannelEvent {
    const stored = this.insert(crypto.randomUUID(), event);
    if (!stored) throw new Error("Event ID collision");
    return stored;
  }

  /**
   * Records an Event under `id` and broadcasts it, or returns null when the Channel
   * already has that ID. A Local Event is given its place and broadcast but not stored:
   * its machine keeps it (ADR 0037).
   */
  private insert<K extends EventType>(id: string, event: NewEvent<K>): ChannelEvent | null {
    const at = new Date().toISOString();
    let recorded: ChannelEvent;
    if (isLocalEvent(event)) {
      if (this.recentLocal.has(id) || this.eventsById([id]).length > 0) return null;
      recorded = JSON.parse(
        JSON.stringify({
          id,
          seq: this.nextSeq(),
          at,
          type: event.type,
          actor: event.actor,
          capture: event.capture,
          ...(event.task === undefined ? {} : { task: event.task }),
          ...(event.turn === undefined ? {} : { turn: event.turn }),
          payload: event.payload,
        }),
      ) as ChannelEvent;
      this.recentLocal.set(id, recorded);
      for (const oldest of this.recentLocal.keys()) {
        if (this.recentLocal.size <= RECENT_LOCAL_EVENTS) break;
        this.recentLocal.delete(oldest);
      }
    } else {
      const row = this.ctx.storage.sql
        .exec<EventRow>(
          `INSERT INTO events (seq, id, at, type, actor, capture, task, turn, payload, actor_kind, actor_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING *`,
          this.peekSeq(),
          id,
          at,
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
      this.lastSeq = row.seq;
      recorded = rowToEvent(row);
    }
    this.broadcast({ type: "event", event: recorded });
    // The Relay decides who hears about it, after this request.
    this.relay.consider(recorded);
    return recorded;
  }

  /** The next `seq`, taken: see `peekSeq`. */
  private nextSeq(): number {
    const seq = this.peekSeq();
    this.lastSeq = seq;
    return seq;
  }

  /**
   * The `seq` the next Event gets: the time in microseconds, or one more than the last
   * `seq` given, whichever is larger (ADR 0037). It only grows and needs no stored
   * counter, and leaves room between stored Events for the Local Events made between them.
   */
  private peekSeq(): number {
    if (this.lastSeq === null) {
      this.lastSeq =
        this.ctx.storage.sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM events").one().seq ?? 0;
    }
    return Math.max(this.lastSeq + 1, Date.now() * 1000);
  }

  private broadcast(message: StreamMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if ((tags.find((tag) => tag.startsWith("binding:")) ?? "binding:0") !== `binding:${this.binding.generation}`)
        continue;
      if (!this.socketIdentityTags(ws, tags)[1]?.startsWith(HOST_TAG)) send(ws, message);
    }
  }
}

/** How many Local Events the Channel remembers by ID (`recentLocal`). */
const RECENT_LOCAL_EVENTS = 5000;

/** Why a machine that is attached keeps no history to read: its switchboard is from before ADR 0037. */
function oldSwitchboard(holder: string): string {
  return `history unavailable: ${holder} runs a switchboard from before local history; update it to read its history`;
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

/** What a Host's socket carries: when it attached, so the newest one gets the Host's requests, and whether it answers history reads (ADR 0037). */
interface HostAttachment {
  at: number;
  history?: true;
}

/** What a wrapper's socket carries: the Agent whose Interrupts it types, since when, and whether it answers history reads. */
interface WrapperAttachment {
  agent: AgentId;
  at: number;
  history?: true;
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
    | TranscriptRequestMessage
    | TerminalReadRequestMessage
    | HistoryRequestMessage
    | HostSpawnMessage
    | HostSpawnedMessage
    | HostStopMessage
    | HostPauseMessage
    | HostResumeMessage
    | HostAllowMessage
    | TerminalWatchersMessage
    | TerminalInputFrame
    | TerminalScreenFrame
    | TerminalRefusedFrame,
): boolean {
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    // The socket is closing; its close handler cleans up.
    return false;
  }
}

/**
 * The code to answer a client's close with: its own, unless no endpoint may send it (RFC
 * 6455 7.4): 1005 and 1006 stand for a close without a code or without a frame, and 1004
 * and 1015 are reserved. Answering with one of those throws, the close is never answered,
 * and the client's connection stays open until the client process ends (ADR 0052).
 */
export function answerableCode(code: number): number {
  const sendable = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
  return sendable ? code : 1000;
}
