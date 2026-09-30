// The Relay (ADR 0003, ADR 0005). For every new Event and every connected Agent,
// except the Agent that caused it, it gives one Verdict: Drop, Queue or Interrupt.
//
// 1. It works out overlap in code (see overlap.ts) and whether the Event is
//    addressed to the Agent: its Task, a Directive to it, its Claim changing.
// 2. With neither, it Drops without asking Jev, and still records the Verdict
//    (source "rule").
// 3. Otherwise it asks Jev one choice question with structured state (issue #3).
//    An Interrupt below the threshold becomes a Queue. Jev failing or timing out
//    never loses the Event: it is Queued (source "fallback") and logged.
// 4. Every Verdict is an Event (`verdict`, actor `relay`) with its probabilities
//    and the state sent. A Queue or Interrupt becomes a Delivery for the Agent's
//    next turn; Interrupts are delivered as Queue until #13.
//
// The Relay runs after the Event is stored, off the request that stored it, so it
// never slows or breaks Event intake. It asks Jev about one Event's Agents
// together, a few calls at a time.

import type {
  Actor,
  Agent,
  AgentDeliverable,
  AgentId,
  ChannelEvent,
  Delivery,
  DeliveryMessage,
  EventType,
  FileChange,
  PersonName,
  RelayState,
  Task,
  TaskNumber,
  TouchedFile,
  Verdict,
} from "../../../shared/src/index";
import {
  agentDeliverable,
  DEFAULT_INTERRUPT_THRESHOLD,
  truncate,
  UNRELAYED_EVENT_TYPES,
} from "../../../shared/src/index";
import type { NewEvent } from "../channel";
import { buildDelivery, diffText, summarizeEvent } from "./delivery";
import type { Jev, JevAnswer } from "./jev";
import { corpusOf, eventFiles, overlapOf } from "./overlap";

export const RELAY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS deliveries_by_agent ON deliveries (agent, seq);
`;

/** How long the Relay waits for Jev before it falls back to Queue. */
export const JEV_TIMEOUT_MS = 5000;
/** The most Jev calls in flight at once, across Events. */
const MAX_JEV_CALLS = 4;
/** How many recent pushes and merges make up an Agent's code corpus. */
const RECENT_CODE_EVENTS = 50;
/** The most Deliveries kept for one Agent; the oldest go first. */
const MAX_PENDING_DELIVERIES = 200;
/** The longest Task description sent to Jev, in characters. */
const MAX_DESCRIPTION = 1000;
/** The most touched files sent to Jev. */
const MAX_TOUCHED = 50;

/** What the Channel lends the Relay. */
export interface RelayHost {
  sql: SqlStorage;
  agents(): Agent[];
  tasks(): Task[];
  task(number: TaskNumber): Task | null;
  touchedFiles(id: AgentId): TouchedFile[];
  /** The Jev to ask, or null when it is not configured. */
  jev(): Jev | null;
  /** An Interrupt below this probability becomes a Queue. */
  threshold: number;
  append(event: NewEvent<"verdict">): ChannelEvent;
  /** Sends a message to every WebSocket `person` has open. */
  sendTo(person: PersonName, message: DeliveryMessage): void;
  /** Keeps the Durable Object working on `work` after the response. */
  waitUntil(work: Promise<unknown>): void;
}

type DeliveryRow = { id: string; agent: string; seq: number; data: string };
type CodeRow = { type: string; task: number | null; payload: string };

/** A recent push or merge, for corpora and Task files. */
interface CodeEvent {
  type: "push" | "merge";
  task: TaskNumber | null;
  files: FileChange[];
}

/** One Agent the Relay is deciding for. */
interface Plan {
  agent: Agent;
  /** Who the Event came from, as the Agent is told. */
  sender: Actor;
  overlap: { files: string[]; symbols: string[] };
  addressed: string | null;
  /** Files it touched and its Task's files: the ones it gets hunks for. */
  mine: Set<string>;
  state: RelayState;
}

function actorName(actor: Actor): string {
  switch (actor.kind) {
    case "agent":
      return actor.agentId;
    case "person":
      return actor.person;
    case "github":
      return "github";
    case "relay":
      return "relay";
  }
}

/** Parses RELAY_INTERRUPT_THRESHOLD, or the default when it is not a probability. */
export function interruptThreshold(raw: string | undefined): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_INTERRUPT_THRESHOLD;
}

const CLAIM_EVENTS: ReadonlySet<EventType> = new Set([
  "claim",
  "claim.release",
  "claim.stale",
  "claim.recovered",
  "claim.blocked",
  "claim.unblocked",
]);

/** Why `event` is addressed to Agent `id`, which holds `held`, or null when it is not. */
export function addressedTo(event: ChannelEvent, id: AgentId, held: ReadonlySet<TaskNumber>): string | null {
  const names = (holder: { kind: string; agentId?: string }) => holder.kind === "agent" && holder.agentId === id;
  const task = event.task === undefined ? "" : ` on Task #${event.task}`;
  if (event.type === "directive" && event.payload.to === id) return "it is a Directive to you";
  if (CLAIM_EVENTS.has(event.type) && "holder" in event.payload && names(event.payload.holder)) {
    return `your Claim${task} changed`;
  }
  if (event.type === "takeover" && (names(event.payload.from) || names(event.payload.to))) {
    return `your Claim${task} changed`;
  }
  if (event.task !== undefined && held.has(event.task)) return `it is about Task #${event.task}, which you hold`;
  return null;
}

/** Runs `work` over `items`, at most `limit` at a time. */
class Limiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running += 1;
    try {
      return await work();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }
}

export class Relay {
  private readonly calls = new Limiter(MAX_JEV_CALLS);

  constructor(private readonly host: RelayHost) {}

  /** A new Event was stored. Gives its Verdicts after the current request, never in it. */
  consider(event: ChannelEvent): void {
    if (UNRELAYED_EVENT_TYPES.includes(event.type)) return;
    // Raw Proxy content never reaches an Agent (ADR 0005): the guard runs before anything else.
    const deliverable = agentDeliverable(event);
    if (deliverable === null) return;
    this.host.waitUntil(
      Promise.resolve()
        .then(() => this.relay(deliverable))
        .catch((error) => console.error(`Relay failed on Event ${event.id}: ${(error as Error).stack ?? error}`)),
    );
  }

  /** Deliveries waiting for Agent `id`, handed over once. */
  takeDeliveries(id: AgentId): Delivery[] {
    return this.host.sql
      .exec<DeliveryRow>("DELETE FROM deliveries WHERE agent = ? RETURNING *", id)
      .toArray()
      .sort((a, b) => a.seq - b.seq)
      .map((row) => JSON.parse(row.data) as Delivery);
  }

  /** Agent `id`'s wrapper holds these Deliveries: stop handing them over. */
  acknowledge(id: AgentId, ids: readonly string[]): void {
    for (const delivery of ids) this.host.sql.exec("DELETE FROM deliveries WHERE agent = ? AND id = ?", id, delivery);
  }

  private async relay(event: AgentDeliverable): Promise<void> {
    const plans = this.plan(event);
    const asked: Plan[] = [];
    for (const plan of plans) {
      if (plan.overlap.files.length === 0 && plan.overlap.symbols.length === 0 && plan.addressed === null) {
        this.record(event, plan, {
          option: "drop",
          delivered: "drop",
          source: "rule",
        });
      } else {
        asked.push(plan);
      }
    }
    await Promise.all(asked.map((plan) => this.calls.run(() => this.ask(event, plan))));
  }

  /** Asks Jev for one Agent, applies the threshold, records the Verdict and queues the Delivery. */
  private async ask(event: AgentDeliverable, plan: Plan): Promise<void> {
    const jev = this.host.jev();
    const started = Date.now();
    let answer: JevAnswer;
    try {
      if (jev === null) throw new Error("Jev is not configured: set the JEV_API_KEY Worker secret.");
      answer = await jev.verdict(plan.state, AbortSignal.timeout(JEV_TIMEOUT_MS));
    } catch (error) {
      const reason = truncate((error as Error).message || String(error), 300);
      console.warn(`Relay: Jev gave no Verdict on Event ${event.id} for ${plan.agent.id}, queued instead: ${reason}`);
      this.record(event, plan, {
        option: "queue",
        delivered: "queue",
        source: "fallback",
        state: plan.state,
        error: reason,
        latencyMs: Date.now() - started,
      });
      return;
    }
    let option = answer.choice;
    let downgraded: Verdict["downgraded"];
    if (option === "interrupt" && answer.probabilities.interrupt < this.host.threshold) {
      option = "queue";
      downgraded = { from: "interrupt", reason: "below-threshold" };
    } else if (option === "interrupt" && !plan.agent.canReceiveInterrupts) {
      option = "queue";
      downgraded = { from: "interrupt", reason: "cli-cannot-interrupt" };
    }
    this.record(event, plan, {
      option,
      // Interrupt delivery is #13: until then an Interrupt reaches the Agent as a Queue.
      delivered: option === "drop" ? "drop" : "queue",
      source: "jev",
      probabilities: answer.probabilities,
      confidence: answer.confidence,
      ...(downgraded === undefined ? {} : { downgraded }),
      state: plan.state,
      latencyMs: Date.now() - started,
    });
  }

  private record(
    event: AgentDeliverable,
    plan: Plan,
    decision: Omit<Verdict, "event" | "agent" | "at" | "overlap" | "addressed">,
  ): void {
    const verdict: Verdict = {
      event: event.id,
      agent: plan.agent.id,
      at: new Date().toISOString(),
      ...decision,
      overlap: plan.overlap,
      ...(plan.addressed === null ? {} : { addressed: plan.addressed }),
    };
    const stored = this.host.append({
      type: "verdict",
      actor: { kind: "relay" },
      capture: null,
      ...(event.task === undefined ? {} : { task: event.task }),
      payload: verdict,
    });
    if (verdict.delivered === "drop") return;
    const delivery = buildDelivery(event, plan.sender, { id: stored.id, ...verdict }, plan.mine, (n) =>
      this.host.task(n),
    );
    this.queue(plan.agent, delivery);
  }

  /** Keeps a Delivery until the Agent's wrapper has it, and pushes it there now. */
  private queue(agent: Agent, delivery: Delivery): void {
    const { sql } = this.host;
    sql.exec(
      "INSERT INTO deliveries (id, agent, seq, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      delivery.id,
      agent.id,
      delivery.seq,
      JSON.stringify(delivery),
    );
    sql.exec(
      `DELETE FROM deliveries WHERE agent = ? AND id NOT IN
         (SELECT id FROM deliveries WHERE agent = ? ORDER BY seq DESC LIMIT ?)`,
      agent.id,
      agent.id,
      MAX_PENDING_DELIVERIES,
    );
    this.host.sendTo(agent.person, { type: "delivery", agent: agent.id, deliveries: [delivery] });
  }

  /** Works out, for every connected Agent but the one that caused the Event, what the Relay knows. */
  private plan(event: AgentDeliverable): Plan[] {
    const tasks = this.host.tasks();
    const sender = this.senderOf(event, tasks);
    const cause = sender.kind === "agent" ? sender.agentId : null;
    const agents = this.host.agents().filter((agent) => agent.presence !== "gone" && agent.id !== cause);
    if (agents.length === 0) return [];
    const recent = this.recentCode(event.seq);
    const files = eventFiles(event);
    const changes = event.type === "push" || event.type === "merge" ? event.payload.files : [];
    const eventTask = event.task === undefined ? null : (tasks.find((t) => t.number === event.task) ?? null);

    return agents.map((agent): Plan => {
      const held = tasks.filter((t) => t.claim?.holder.kind === "agent" && t.claim.holder.agentId === agent.id);
      const heldNumbers = new Set(held.map((t) => t.number));
      const touched = this.host.touchedFiles(agent.id).map((f) => f.path);
      const own = recent.filter((code) => code.type === "push" && code.task !== null && heldNumbers.has(code.task));
      const taskFiles = [...new Set(own.flatMap((code) => code.files.map((f) => f.path)))];
      const mine = new Set([...touched, ...taskFiles]);
      const corpus = corpusOf([
        ...own.flatMap((code) => code.files),
        ...recent.flatMap((code) => code.files.filter((f) => mine.has(f.path))),
      ]);
      const overlap = overlapOf(event, { touched, taskFiles, corpus });
      const addressed = addressedTo(event, agent.id, heldNumbers);
      const task = held[0];
      const state: RelayState = {
        agent: {
          id: agent.id,
          task:
            task === undefined
              ? null
              : { number: task.number, title: task.title, description: truncate(task.description, MAX_DESCRIPTION) },
          currentStep: task?.steps.find((step) => !step.done)?.text ?? null,
          filesTouched: touched.slice(0, MAX_TOUCHED),
        },
        event: {
          sender: actorName(sender),
          type: event.type,
          task: eventTask === null ? null : { number: eventTask.number, title: eventTask.title },
          summary: summarizeEvent(event),
          files,
          diff: diffText(changes, mine),
        },
        overlap: { sharedFiles: overlap.files, symbolsAgentUses: overlap.symbols, addressedToAgent: addressed },
      };
      return { agent, sender, overlap, addressed, mine, state };
    });
  }

  /**
   * Who an Event came from: its actor, or for a push or merge GitHub reported on a
   * Task branch, the holder of that Task, who did the work.
   */
  private senderOf(event: ChannelEvent, tasks: readonly Task[]): Actor {
    if (
      event.actor.kind === "github" &&
      (event.type === "push" || event.type === "merge") &&
      event.task !== undefined
    ) {
      const holder = tasks.find((t) => t.number === event.task)?.claim?.holder;
      if (holder?.kind === "agent") return { kind: "agent", agentId: holder.agentId };
      if (holder?.kind === "person") return { kind: "person", person: holder.person };
    }
    return event.actor;
  }

  /** The latest pushes and merges before `seq`, newest first. */
  private recentCode(seq: number): CodeEvent[] {
    return this.host.sql
      .exec<CodeRow>(
        "SELECT type, task, payload FROM events WHERE type IN ('push', 'merge') AND seq < ? ORDER BY seq DESC LIMIT ?",
        seq,
        RECENT_CODE_EVENTS,
      )
      .toArray()
      .map((row) => ({
        type: row.type as "push" | "merge",
        task: row.task,
        files: (JSON.parse(row.payload) as { files: FileChange[] }).files,
      }));
  }
}
