// Directives (ADR 0005, ADR 0018): the one message with instruction weight. A Person
// sends one to one Agent, or a lead sends one to an Agent in its subtree for its
// Person (the Channel checks that); it is recorded as a `directive` Event naming both, and delivered
// to that Agent without the Relay. A Directive is addressed and always delivered,
// so it never waits on Jev or a Verdict (the Relay skips `directive` Events).
//
// 1. When the Agent's wrapper is connected and can type into its CLI, the Directive
//    is sent to it (`directive.interrupt`) and typed into the running session right
//    away, through the same path and guards as the Relay's Interrupts. A Directive
//    is exempt from the Interrupt rate limit, since a Person sent it.
//    A wrapper that has not attached yet, because its Agent registered moments ago or
//    its socket is reconnecting, gets a short bound to attach (ADR 0025): the
//    Directive is held, and typed once it attaches.
// 2. Otherwise, or when the wrapper could not type it (its Person was typing, a
//    dialog was open, the session was not ready), did not answer in time or did not
//    attach within the bound, it waits
//    for the Agent's next turn, the Relay's Queue path: it is pushed over the
//    wrapper's WebSocket and kept until the wrapper acknowledges it; one still kept
//    is handed over, once, in the next register or heartbeat answer.
// 3. Either way a `directive.delivery` Event records how it was delivered.

import type {
  Agent,
  AgentId,
  ChannelEvent,
  DirectiveDelivery,
  DirectiveInterruptMessage,
  DirectiveMessage,
  DirectiveQueueReason,
  PersonName,
} from "../../shared/src/index";
import { INTERRUPT_ANSWER_MS } from "../../shared/src/index";
import type { NewEvent } from "./channel";

export const DIRECTIVES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS directive_deliveries (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS directive_deliveries_by_agent ON directive_deliveries (agent, seq);
  CREATE TABLE IF NOT EXISTS directive_holds (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    seq INTEGER NOT NULL,
    until INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS directive_holds_by_agent ON directive_holds (agent, seq);
  CREATE INDEX IF NOT EXISTS directive_holds_by_until ON directive_holds (until);
`;

/** How long a Directive waits for its Agent's wrapper to attach before it goes to the Queue (ADR 0025). */
export const DEFAULT_ATTACH_WAIT_MS = 5_000;

/** What the Channel lends this module. */
export interface DirectivesHost {
  sql: SqlStorage;
  findAgent(id: AgentId): Agent | null;
  append(event: NewEvent<"directive"> | NewEvent<"directive.delivery">): ChannelEvent;
  /** Sends a message to every WebSocket `person` has open. */
  sendTo(person: PersonName, message: DirectiveMessage): void;
  /** Sends a Directive to type to Agent `agent`'s wrapper. False when that wrapper is not connected. */
  interruptTo(agent: AgentId, message: DirectiveInterruptMessage): boolean;
  /** Keeps the Durable Object working on `work` after the response. */
  waitUntil(work: Promise<unknown>): void;
  /** Sets (or, with null, clears) when the alarm next calls `alarm()`. */
  schedule(at: number | null): Promise<void>;
  /** How long a Directive waits for its Agent's wrapper to attach. */
  attachWaitMs: number;
}

/** Who sends a Directive: a Person, or a lead for its Person (ADR 0018). */
export type DirectiveSender = { person: PersonName; lead?: AgentId };

export type DirectiveResult = { ok: true; event: ChannelEvent } | { ok: false; status: 403 | 404; reason: string };

type Row = { id: string; agent: string; seq: number; data: string };
type HoldRow = Row & { until: number };

/** What a wrapper answered about typing a Directive. */
type Typed = "typed" | DirectiveQueueReason;

/** A Directive sent to a wrapper to type, waiting for its answer. */
interface Waiting {
  agent: AgentId;
  answer: (outcome: Typed) => void;
}

export class Directives {
  /** Directives sent to wrappers to type that have not been answered yet, by Directive ID. */
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly host: DirectivesHost) {}

  /**
   * A Person, or a lead for its Person, sending a Directive to Agent `to`. Whether a
   * lead may reach `to` is the Channel's check. Refused when the Channel has no such
   * Agent. A Gone Agent gets it when it resumes.
   */
  send(from: DirectiveSender, to: AgentId, text: string): DirectiveResult {
    const agent = this.host.findAgent(to);
    if (agent === null) return { ok: false, status: 404, reason: `The Channel has no Agent ${to}.` };
    const event = this.host.append({
      type: "directive",
      actor: from.lead === undefined ? { kind: "person", person: from.person } : { kind: "agent", agentId: from.lead },
      capture: from.lead === undefined ? null : "tool",
      payload: { to, text },
    });
    const directive: DirectiveDelivery = {
      id: event.id,
      seq: event.seq,
      at: event.at,
      from: from.person,
      ...(from.lead === undefined ? {} : { lead: from.lead }),
      to,
      text,
    };
    if (!agent.canReceiveInterrupts) {
      this.queue(agent, directive, "cli-cannot-interrupt");
    } else if (!this.type(agent, directive)) {
      // No wrapper has attached. A Gone Agent's is not about to; another's may be reconnecting (ADR 0025).
      if (agent.presence === "gone") this.queue(agent, directive, "wrapper-offline");
      else this.hold(agent, directive);
    }
    return { ok: true, event };
  }

  /** Agent `id`'s wrapper attached: the Directives held for it are typed now, oldest first. */
  attached(id: AgentId): void {
    const held = this.host.sql
      .exec<HoldRow>("DELETE FROM directive_holds WHERE agent = ? RETURNING *", id)
      .toArray()
      .sort((a, b) => a.seq - b.seq);
    if (held.length === 0) return;
    this.host.waitUntil(this.reschedule());
    const agent = this.host.findAgent(id);
    if (agent === null) return;
    for (const row of held) {
      const directive = JSON.parse(row.data) as DirectiveDelivery;
      if (!this.type(agent, directive)) this.queue(agent, directive, "wrapper-offline");
    }
  }

  /** The alarm: Directives whose wrapper did not attach within the bound go to the Queue. */
  async alarm(now = Date.now()): Promise<void> {
    const expired = this.host.sql
      .exec<HoldRow>("DELETE FROM directive_holds WHERE until <= ? RETURNING *", now)
      .toArray()
      .sort((a, b) => a.seq - b.seq);
    for (const row of expired) {
      const agent = this.host.findAgent(row.agent as AgentId);
      if (agent !== null) this.queue(agent, JSON.parse(row.data) as DirectiveDelivery, "wrapper-offline");
    }
    await this.reschedule();
  }

  /** Agent `agent`'s wrapper says whether it typed Directive `id`. Only an answer from that Agent counts. */
  answered(agent: AgentId, id: string, outcome: Typed): void {
    const waiting = this.waiting.get(id);
    if (waiting === undefined || waiting.agent !== agent) return;
    waiting.answer(outcome);
  }

  /** Directives waiting for Agent `id`, oldest first, handed over once. */
  takeDirectives(id: AgentId): DirectiveDelivery[] {
    return this.host.sql
      .exec<Row>("DELETE FROM directive_deliveries WHERE agent = ? RETURNING *", id)
      .toArray()
      .sort((a, b) => a.seq - b.seq)
      .map((row) => JSON.parse(row.data) as DirectiveDelivery);
  }

  /** Agent `id`'s wrapper holds these Directives: stop handing them over. */
  acknowledge(id: AgentId, ids: readonly string[]): void {
    for (const directive of ids) {
      this.host.sql.exec("DELETE FROM directive_deliveries WHERE agent = ? AND id = ?", id, directive);
    }
  }

  /**
   * Sends `directive` to Agent `agent`'s wrapper to type, and settles it on the
   * wrapper's answer. False when no wrapper of that Agent has attached.
   */
  private type(agent: Agent, directive: DirectiveDelivery): boolean {
    // Waiting for the wrapper's answer before sending, so an answer cannot arrive unheard.
    const answered = this.answer(directive);
    if (this.host.interruptTo(agent.id, { type: "directive.interrupt", agent: agent.id, directive })) {
      this.host.waitUntil(answered.then((outcome) => this.settle(agent, directive, outcome)));
      return true;
    }
    this.waiting.get(directive.id)?.answer("wrapper-offline");
    return false;
  }

  /** Keeps the Directive until the Agent's wrapper attaches, for at most the bound. */
  private hold(agent: Agent, directive: DirectiveDelivery): void {
    this.host.sql.exec(
      "INSERT INTO directive_holds (id, agent, seq, until, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      directive.id,
      agent.id,
      directive.seq,
      Date.now() + this.host.attachWaitMs,
      JSON.stringify(directive),
    );
    this.host.waitUntil(this.reschedule());
  }

  /** Sets the alarm for the next held Directive's bound, or clears it when none is held. */
  private reschedule(): Promise<void> {
    const next = this.host.sql
      .exec<{ next: number | null }>("SELECT MIN(until) AS next FROM directive_holds")
      .one().next;
    return this.host.schedule(next);
  }

  /** Resolves with the wrapper's answer about `directive`, or "no-answer" after INTERRUPT_ANSWER_MS. */
  private answer(directive: DirectiveDelivery): Promise<Typed> {
    return new Promise<Typed>((resolve) => {
      const timer = setTimeout(() => done("no-answer"), INTERRUPT_ANSWER_MS);
      const done = (outcome: Typed) => {
        clearTimeout(timer);
        this.waiting.delete(directive.id);
        resolve(outcome);
      };
      this.waiting.set(directive.id, { agent: directive.to, answer: done });
    });
  }

  /** Records a typed Directive, or holds one the wrapper could not type for the next turn. */
  private settle(agent: Agent, directive: DirectiveDelivery, outcome: Typed): void {
    if (outcome !== "typed") {
      this.queue(agent, directive, outcome);
      return;
    }
    this.record(agent, directive, "interrupt");
  }

  /** Keeps the Directive for the Agent's next turn, pushes it to the wrapper now, and records why. */
  private queue(agent: Agent, directive: DirectiveDelivery, reason: DirectiveQueueReason): void {
    this.host.sql.exec(
      "INSERT INTO directive_deliveries (id, agent, seq, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      directive.id,
      agent.id,
      directive.seq,
      JSON.stringify(directive),
    );
    this.host.sendTo(agent.person, { type: "directives", agent: agent.id, directives: [directive] });
    this.record(agent, directive, "queue", reason);
  }

  private record(
    agent: Agent,
    directive: DirectiveDelivery,
    delivered: "interrupt" | "queue",
    reason?: DirectiveQueueReason,
  ): void {
    this.host.append({
      type: "directive.delivery",
      actor: { kind: "agent", agentId: agent.id },
      capture: null,
      payload: {
        directive: directive.id,
        from: directive.from,
        delivered,
        ...(reason === undefined ? {} : { reason }),
      },
    });
  }
}
