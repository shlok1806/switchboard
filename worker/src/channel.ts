// One Durable Object per Channel (ADR 0004). It owns the Channel's Persons, its
// append-only Event stream in SQLite, and every live WebSocket, using WebSocket
// hibernation so idle subscribers cost nothing.

import { DurableObject } from "cloudflare:workers";
import type {
  Actor,
  Agent,
  AgentId,
  Capture,
  ChannelEvent,
  EventPayloads,
  EventType,
  HookCaptureReply,
  Person,
  PersonName,
  RegisterAgentRequest,
  ReportedPresence,
  StreamMessage,
  Task,
  TaskNumber,
  TouchedFile,
} from "../../shared/src/index";
import { DEFAULT_GONE_AFTER_SECONDS, LIVE_PING, LIVE_PONG } from "../../shared/src/index";
import { AGENTS_SCHEMA, AgentRoster, type RosterResult } from "./agents";
import { Alarms } from "./alarms";
import { gitHubFor, type WebhookChange } from "./github/index";
import { HOOK_CAPTURE_SCHEMA, HookCapture } from "./hook-capture";
import { type NewTask, type TaskResult, Tasks } from "./tasks";

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Events are append-only: this object only ever INSERTs into `events`.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        capture TEXT,
        task INTEGER,
        turn TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS persons (
        name TEXT PRIMARY KEY,
        time_zone TEXT NOT NULL,
        joined_at TEXT NOT NULL
      );
    `);
    ctx.storage.sql.exec(AGENTS_SCHEMA);
    ctx.storage.sql.exec(HOOK_CAPTURE_SCHEMA);
    // Answer keepalive pings without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(LIVE_PING, LIVE_PONG));
    this.alarms = new Alarms(ctx.storage);
    this.tasks = new Tasks({
      storage: ctx.storage,
      gitHub: () => gitHubFor(env),
      nextReconcile: () => this.alarms.deadline("tasks"),
      scheduleReconcile: (at) => this.alarms.set("tasks", at),
      append: (event) => this.append(event),
      broadcast: (message) => this.broadcast(message),
    });
    const goneAfterSeconds = Number(env.PRESENCE_GONE_AFTER_SECONDS);
    this.agents = new AgentRoster({
      sql: ctx.storage.sql,
      schedulePresenceCheck: (at) => this.alarms.set("presence", at),
      goneAfterMs: (goneAfterSeconds > 0 ? goneAfterSeconds : DEFAULT_GONE_AFTER_SECONDS) * 1000,
      append: (event) => this.append(event),
      broadcast: (message) => this.broadcast(message),
    });
    this.hooks = new HookCapture({
      sql: ctx.storage.sql,
      touchAgent: (person, id) => this.agents.touch(person, id),
      appendOnce: (id, event) => this.insert(id, event),
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
    } finally {
      await this.alarms.arm();
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

  /** A verified GitHub webhook delivery, reduced to the Issues it touched. */
  gitHubWebhook(change: WebhookChange): Promise<TaskResult<null>> {
    return this.tasks.webhook(change);
  }

  /** Every Agent the Channel has seen, most recently seen first. */
  listAgents(): Agent[] {
    return this.agents.list();
  }

  /** Registers an Agent for a CLI session, or brings it back on resume. Joins its Person too. */
  registerAgent(person: PersonName, request: RegisterAgentRequest): Promise<RosterResult> {
    this.join(person);
    return this.agents.register(person, request);
  }

  heartbeat(person: PersonName, id: AgentId, presence: ReportedPresence): Promise<RosterResult> {
    return this.agents.heartbeat(person, id, presence);
  }

  endSession(person: PersonName, id: AgentId): Promise<RosterResult> {
    return this.agents.endSession(person, id);
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

  /** Records an Update a Person wrote directly, for example from the CLI or the Dashboard. */
  postUpdate(name: PersonName, text: string, task?: TaskNumber): ChannelEvent {
    this.join(name);
    return this.append({
      type: "update",
      actor: { kind: "person", person: name },
      capture: null,
      payload: { text },
      ...(task === undefined ? {} : { task }),
    });
  }

  /** Events with `seq` greater than `after`, oldest first. */
  history(after: number, limit: number): ChannelEvent[] {
    return this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit)
      .toArray()
      .map(rowToEvent);
  }

  /**
   * Upgrades an already-authenticated request to a live stream. The Worker
   * passes the verified Person as `?person=` and the resume cursor as `?after=`.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("person");
    const after = url.searchParams.get("after");
    if (name === null) return new Response("Missing person", { status: 400 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [name]);
    // Everything below is synchronous, so no other Event can be appended
    // between the backlog and the live stream: none is missed or sent twice.
    if (after !== null) {
      for (const event of this.history(Number(after), Number.MAX_SAFE_INTEGER)) {
        send(server, { type: "event", event });
      }
    }
    for (const agent of this.agents.list()) send(server, { type: "agent", agent });
    this.join(name);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * The stream is receive-only except for the Hook Capture: a wrapper sends its
   * Agent's Hook Events here and gets the reply on the same socket. Clients do
   * everything else over HTTP.
   */
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null || (frame as { type?: unknown }).type !== "hook") return;
    const person = this.ctx.getTags(ws)[0];
    if (person === undefined) return;
    send(ws, this.hooks.receive(person, frame as Record<string, unknown>));
  }

  /** The files Agent `id` has edited, most recently first, or null when the Channel has no such Agent. */
  touchedFiles(id: AgentId): TouchedFile[] | null {
    return this.agents.has(id) ? this.hooks.touchedFiles(id) : null;
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
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
        `INSERT INTO events (id, at, type, actor, capture, task, turn, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING *`,
        id,
        new Date().toISOString(),
        event.type,
        JSON.stringify(event.actor),
        event.capture,
        event.task ?? null,
        event.turn ?? null,
        JSON.stringify(event.payload),
      )
      .toArray()[0];
    if (!row) return null;
    const stored = rowToEvent(row);
    this.broadcast({ type: "event", event: stored });
    return stored;
  }

  private broadcast(message: StreamMessage): void {
    for (const ws of this.ctx.getWebSockets()) send(ws, message);
  }
}

function send(ws: WebSocket, message: StreamMessage | HookCaptureReply): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The socket is closing; its close handler cleans up.
  }
}
