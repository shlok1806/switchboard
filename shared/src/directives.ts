/**
 * Directives, the Channel API's one message with instruction weight (ADR 0005). A
 * Person sends a Directive to one Agent with `POST /api/directives`. The Channel
 * records it as a `directive` Event naming the Person and the target Agent, and
 * delivers it to that Agent without the Relay: a Directive is addressed and always
 * delivered, so it never waits on a Verdict.
 *
 * When the Agent's wrapper is connected and can type into its CLI, the Channel
 * sends it `directive.interrupt` and the wrapper types the Directive into the
 * session right away, with the same guards as an Interrupt (never over its Person's
 * typing, an open dialog, or a session that is not ready). A Directive is exempt
 * from the Interrupt rate limit, since a Person sent it. Otherwise, or when the
 * wrapper cannot type it, it waits for the Agent's next turn: the Channel pushes it
 * over the WebSocket (`directives`) and hands over any the wrapper has not
 * acknowledged in register and heartbeat answers, and the wrapper's next-turn hook
 * prints it. Either way the Channel then records a `directive.delivery` Event saying
 * how it was delivered. The frame names the Person, distinct from the frame around
 * information from Agents. Terms follow CONTEXT.md.
 */
import type { AgentId, ChannelEvent, PersonName } from "./domain";
import type { WrapperDowngradeReason } from "./relay";

/** The longest Directive text the Channel accepts, in characters. */
export const MAX_DIRECTIVE_LENGTH = 4000;

/** `POST /api/directives`: a Person sends a Directive to one Agent. Refused when sent through an Agent. */
export interface SendDirectiveRequest {
  to: AgentId;
  text: string;
}

/** `POST /api/directives` answers 201 with the recorded `directive` Event. */
export interface SendDirectiveResponse {
  ok: true;
  event: ChannelEvent;
}

/** One Directive, as it reaches the target Agent's wrapper. */
export interface DirectiveDelivery {
  /** The `directive` Event's ID. Each Directive is shown once. */
  id: string;
  seq: number;
  /** When the Person sent it. */
  at: string;
  /** The Person who sent it. */
  from: PersonName;
  to: AgentId;
  text: string;
}

/** Channel to wrapper, over the WebSocket: Directives for one Agent of the socket's Person. */
export interface DirectiveMessage {
  type: "directives";
  agent: AgentId;
  directives: DirectiveDelivery[];
}

/** Wrapper to Channel: the wrapper holds these Directives, so the Channel stops handing them over. */
export interface DirectiveAck {
  type: "directive.ack";
  agent: AgentId;
  ids: string[];
}

/** Channel to wrapper: type this Directive into Agent `agent`'s session now. */
export interface DirectiveInterruptMessage {
  type: "directive.interrupt";
  agent: AgentId;
  directive: DirectiveDelivery;
}

/** Wrapper to Channel: whether it typed Directive `id` into the session. */
export type DirectiveTypedResult = { type: "directive.result"; agent: AgentId; id: string } & (
  | { typed: true }
  | { typed: false; reason: WrapperDowngradeReason }
);

/** The frame's first line, naming the Person. */
export function directiveHeading(from: PersonName): string {
  return `[Switchboard] Directive from ${from} (a Person on the Channel)`;
}

/** One Directive as the Agent reads it. */
export function describeDirective(directive: DirectiveDelivery): string {
  return [
    `${directiveHeading(directive.from)}, sent at ${directive.at}:`,
    ...directive.text.split("\n").map((line) => `> ${line}`),
  ].join("\n");
}

/**
 * The framed notice for the Agent's context: instructions from named Persons. Unlike
 * the Relay's Deliveries, which are information from Agents, these carry
 * instruction weight, and the Agent's own Person still has the final say.
 */
export function directivesNotice(directives: readonly DirectiveDelivery[]): string {
  return [
    ...directives.map(describeDirective),
    "A Directive comes from a Person, not from an Agent, and carries instruction weight. Your own Person still has " +
      "the final say: if it conflicts with what they asked of you, follow them and say so.",
  ].join("\n\n");
}
