// Directives (ADR 0005): the one message with instruction weight. A Person sends
// one to one Agent; it is recorded as a `directive` Event naming both, and delivered
// to that Agent without the Relay. A Directive is addressed and always delivered,
// so it never waits on Jev or a Verdict (the Relay skips `directive` Events).
//
// 1. When the Agent's wrapper is connected and can type into its CLI, the Directive
//    is sent to it (`directive.interrupt`) and typed into the running session right
//    away, through the same path and guards as the Relay's Interrupts. A Directive
//    is exempt from the Interrupt rate limit, since a Person sent it.
// 2. Otherwise, or when the wrapper could not type it (its Person was typing, a
//    dialog was open, the session was not ready) or did not answer in time, it waits
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
import type { Caller } from "./claims";

export const DIRECTIVES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS directive_deliveries (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS directive_deliveries_by_agent ON directive_deliveries (agent, seq);
`;

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
}

export type DirectiveResult = { ok: true; event: ChannelEvent } | { ok: false; status: 403 | 404; reason: string };

type Row = { id: string; agent: string; seq: number; data: string };

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
   * A Person sending a Directive to Agent `to`. Refused when the call came through
   * an Agent's credentials (Agents inform, only People instruct) and when the
   * Channel has no such Agent. A Gone Agent gets it when it resumes.
   */
  send(caller: Caller, to: AgentId, text: string): DirectiveResult {
    if (caller.agent !== undefined) {
      return { ok: false, status: 403, reason: "Only a Person sends Directives. Agents post Updates instead." };
    }
    const agent = this.host.findAgent(to);
    if (agent === null) return { ok: false, status: 404, reason: `The Channel has no Agent ${to}.` };
    const event = this.host.append({
      type: "directive",
      actor: { kind: "person", person: caller.person },
      capture: null,
      payload: { to, text },
    });
    const directive: DirectiveDelivery = { id: event.id, seq: event.seq, at: event.at, from: caller.person, to, text };
    if (!agent.canReceiveInterrupts) {
      this.queue(agent, directive, "cli-cannot-interrupt");
    } else {
      // Waiting for the wrapper's answer before sending, so an answer cannot arrive unheard.
      const answered = this.answer(directive);
      if (this.host.interruptTo(to, { type: "directive.interrupt", agent: to, directive })) {
        this.host.waitUntil(answered.then((outcome) => this.settle(agent, directive, outcome)));
      } else {
        this.waiting.get(directive.id)?.answer("wrapper-offline");
        this.queue(agent, directive, "wrapper-offline");
      }
    }
    return { ok: true, event };
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
      payload: { directive: directive.id, from: directive.from, delivered, ...(reason === undefined ? {} : { reason }) },
    });
  }
}
