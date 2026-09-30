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
  DeliveryMessage,
  DirectiveInterruptMessage,
  DirectiveMessage,
  EventPayloads,
  EventType,
  Holder,
  HookCaptureReply,
  InterruptMessage,
  InterruptResult,
  Person,
  PersonName,
  ProxyCaptureReply,
  ProxyMode,
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
import { Branches, type CodeEventResult } from "./branches";
import { type Caller, type ClaimRefusal, type ClaimResult, Claims } from "./claims";
import { DIRECTIVES_SCHEMA, type DirectiveResult, Directives } from "./directives";
import { type CodeChange, gitHubFor, type WebhookChange } from "./github/index";
import { HOOK_CAPTURE_SCHEMA, HookCapture } from "./hook-capture";
import { ProxyCapture } from "./proxy-capture";
import { jevFor } from "./relay/jev";
import { interruptIntervalMs, interruptThreshold, RELAY_SCHEMA, Relay } from "./relay/relay";
import { StaleClaims } from "./stale-claims";
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
  /** Directives from Persons to Agents, delivered without the Relay (ADR 0005). */
  private readonly directives: Directives;

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
    ctx.storage.sql.exec(RELAY_SCHEMA);
    ctx.storage.sql.exec(DIRECTIVES_SCHEMA);
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
      changed: (task) => this.staleClaims.taskChanged(task),
    });
    const goneAfterSeconds = Number(env.PRESENCE_GONE_AFTER_SECONDS);
    this.agents = new AgentRoster({
      sql: ctx.storage.sql,
      schedulePresenceCheck: (at) => this.alarms.set("presence", at),
      goneAfterMs: (goneAfterSeconds > 0 ? goneAfterSeconds : DEFAULT_GONE_AFTER_SECONDS) * 1000,
      append: (event) => this.append(event),
      broadcast: (message) => this.broadcast(message),
      presenceChanged: (id, presence) => this.staleClaims.presenceChanged(id, presence),
    });
    this.hooks = new HookCapture({
      sql: ctx.storage.sql,
      touchAgent: (person, id) => this.agents.touch(person, id),
      appendOnce: (id, event) => this.insert(id, event),
    });
    this.proxy = new ProxyCapture({
      touchAgent: (person, id) => this.agents.touch(person, id),
      appendOnce: (id, event) => this.insert(id, event),
    });
    this.claims = new Claims({
      tasks: this.tasks,
      agents: this.agents,
      gitHub: () => gitHubFor(env),
      append: (event) => this.append(event),
    });
    this.branches = new Branches({
      tasks: this.tasks,
      claims: this.claims,
      gitHub: () => gitHubFor(env),
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
      agents: () => this.agents.list(),
      tasks: () => this.tasks.stored(),
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
        for (const ws of this.ctx.getWebSockets(person)) send(ws, message);
      },
      interruptTo: (agent, message) => this.interruptTo(agent, message),
      waitUntil: (work) => this.ctx.waitUntil(work),
    });
    this.directives = new Directives({
      sql: ctx.storage.sql,
      findAgent: (id) => this.agents.find(id),
      append: (event) => this.append(event),
      sendTo: (person, message) => {
        for (const ws of this.ctx.getWebSockets(person)) send(ws, message);
      },
      interruptTo: (agent, message) => this.interruptTo(agent, message),
      waitUntil: (work) => this.ctx.waitUntil(work),
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
  gitHubCodeWebhook(delivery: string, change: CodeChange): Promise<CodeEventResult> {
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
  gitHubWebhook(change: WebhookChange): Promise<TaskResult<null>> {
    return this.tasks.webhook(change);
  }

  /** Every Agent the Channel has seen, most recently seen first. */
  listAgents(): Agent[] {
    return this.agents.list();
  }

  /** Registers an Agent for a CLI session, or brings it back on resume. Joins its Person too. */
  async registerAgent(person: PersonName, request: RegisterAgentRequest): Promise<RosterResult> {
    this.join(person);
    return this.withNextTurn(await this.agents.register(person, request));
  }

  async heartbeat(person: PersonName, id: AgentId, presence: ReportedPresence): Promise<RosterResult> {
    return this.withNextTurn(await this.agents.heartbeat(person, id, presence));
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

  endSession(person: PersonName, id: AgentId): Promise<RosterResult> {
    return this.agents.endSession(person, id);
  }

  /** A Person sending a Directive to one Agent. Refused through an Agent's credentials. */
  sendDirective(caller: Caller, to: AgentId, text: string): DirectiveResult {
    this.join(caller.person);
    return this.directives.send(caller, to, text);
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
    return { ok: true, event };
  }

  /** Events with `seq` greater than `after`, oldest first. */
  history(after: number, limit: number): ChannelEvent[] {
    return this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit)
      .toArray()
      .map(rowToEvent);
  }

  /** The latest `count` Events, oldest first. */
  latestEvents(count: number): ChannelEvent[] {
    return this.ctx.storage.sql
      .exec<EventRow>("SELECT * FROM (SELECT * FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq", count)
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
   * The stream is receive-only except for the Hook and Proxy Captures: a wrapper sends its
   * Agent's Hook and Proxy Events here and gets the reply on the same socket. Clients do
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
    if (typeof frame !== "object" || frame === null) return;
    const type = (frame as { type?: unknown }).type;
    if (
      type !== "hook" &&
      type !== "proxy" &&
      type !== "delivery.ack" &&
      type !== "directive.ack" &&
      type !== "interrupt.attach" &&
      type !== "interrupt.result" &&
      type !== "directive.result"
    ) {
      return;
    }
    const person = this.ctx.getTags(ws)[0];
    if (person === undefined) return;
    const body = frame as Record<string, unknown>;
    if (type === "interrupt.attach" || type === "interrupt.result" || type === "directive.result") {
      // Only the Agent's own Person's wrapper may speak for it.
      const agent = body.agent;
      if (typeof agent !== "string" || this.agents.find(agent as AgentId)?.person !== person) return;
      if (type === "interrupt.attach") {
        // Kept on the socket itself, so it survives hibernation and goes when the socket does.
        const attached: WrapperAttachment = { agent: agent as AgentId, at: Date.now() };
        ws.serializeAttachment(attached);
        return;
      }
      const result = parseInterruptResult(body);
      if (result === null) return;
      if (type === "interrupt.result") this.relay.interruptAnswered(result);
      else this.directives.answered(result.agent, result.id, result.typed ? "typed" : result.reason);
      return;
    }
    if (type === "delivery.ack" || type === "directive.ack") {
      // The wrapper holds these for its Agent's next turn. Only the Agent's own Person may say so.
      const agent = body.agent;
      if (typeof agent !== "string" || !Array.isArray(body.ids)) return;
      if (this.agents.find(agent as AgentId)?.person !== person) return;
      const ids = body.ids.filter((id): id is string => typeof id === "string");
      if (type === "delivery.ack") this.relay.acknowledge(agent as AgentId, ids);
      else this.directives.acknowledge(agent as AgentId, ids);
      return;
    }
    send(ws, type === "hook" ? this.hooks.receive(person, body) : this.proxy.receive(person, body));
  }

  /**
   * Sends an Interrupt to the wrapper of Agent `id`: the socket that most recently
   * said it belongs to that wrapper. False when there is none.
   */
  private interruptTo(id: AgentId, message: InterruptMessage | DirectiveInterruptMessage): boolean {
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
    // The Relay decides who hears about it, after this request.
    this.relay.consider(stored);
    return stored;
  }

  private broadcast(message: StreamMessage): void {
    for (const ws of this.ctx.getWebSockets()) send(ws, message);
  }
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
  message: StreamMessage | HookCaptureReply | ProxyCaptureReply | DeliveryMessage | InterruptMessage | DirectiveMessage | DirectiveInterruptMessage,
): boolean {
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    // The socket is closing; its close handler cleans up.
    return false;
  }
}
