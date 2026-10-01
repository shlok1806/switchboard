// The Proxy Capture on the Channel side. The laptop wrapper sends one Proxy Event
// per model turn over its WebSocket, already masked on the laptop; this module
// checks it and records it labelled with the Proxy Capture.
//
// - Only an Agent's own wrapper may send its Events: on a socket opened with that
//   Agent's token.
// - A Raw Proxy Event is refused unless the Agent's Proxy mode is raw, so a Person
//   switching back to digest stops raw content at once, even from a wrapper that
//   has not heard yet.
// - Each Event carries an ID the wrapper picked, so one sent again after a
//   reconnect is recorded once.
// - Sizes stay bounded here too, whatever the wrapper did.
// - Each is about the Task the Agent works on as it arrives (its newest Claim not yet
//   finished), as Hook Events are (#56, #88).
//
// Raw Proxy Events are for the Dashboard only: nothing may deliver one into an
// Agent. Every path into an Agent goes through `agentDeliverable` (shared/src/proxy.ts).

import type {
  Agent,
  AgentId,
  ChannelEvent,
  EventPayloads,
  PersonName,
  ProxyCaptureReply,
  ProxyEvent,
  ProxyEventType,
  ProxyTurn,
  TaskNumber,
  ToolCall,
} from "../../shared/src/index";
import {
  MAX_HOOK_ARG_LENGTH,
  MAX_PROXY_MODEL_LENGTH,
  MAX_PROXY_REPLY_LENGTH,
  MAX_PROXY_TOOL_CALLS,
  PROXY_EVENT_TYPES,
  RAW_PROXY_CAP_BYTES,
  truncate,
} from "../../shared/src/index";
import type { Refusal } from "./agents";

/** What the Proxy Capture needs from the Channel that hosts it. */
export interface ProxyCaptureHost {
  /** Checks that `person` may act for Agent `id` and counts it as heard from; gives the Agent. */
  touchAgent(person: PersonName, id: AgentId): { ok: true; agent: Agent } | Refusal;
  /** The Task Agent `id` works on now (its newest Claim not yet finished), or null. */
  currentTask(id: AgentId): TaskNumber | null;
  /** Records an Event with the given ID, or returns null when the Channel already has it. */
  appendOnce<K extends ProxyEventType>(
    id: string,
    event: {
      type: K;
      actor: { kind: "agent"; agentId: AgentId };
      capture: "proxy";
      task?: TaskNumber;
      payload: EventPayloads[K];
    },
  ): ChannelEvent | null;
}

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseTurn(raw: Record<string, unknown>): Parsed<ProxyTurn> {
  const tokens = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "maskedSecrets"] as const;
  const numbers: Partial<Record<(typeof tokens)[number], number>> = {};
  for (const key of tokens) {
    const value = count(raw[key]);
    if (value === undefined) return { ok: false, reason: `"${key}" must be a count.` };
    numbers[key] = value;
  }
  if (typeof raw.model !== "string" || typeof raw.reply !== "string" || !Array.isArray(raw.toolCalls)) {
    return { ok: false, reason: 'A Proxy Event needs "model", "reply" and "toolCalls".' };
  }
  const toolCalls: ToolCall[] = [];
  for (const call of raw.toolCalls.slice(0, MAX_PROXY_TOOL_CALLS)) {
    const { name, arg } = (call ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || typeof arg !== "string") {
      return { ok: false, reason: 'Each tool call needs "name" and "arg".' };
    }
    toolCalls.push({ name: truncate(name, 100), arg: truncate(arg, MAX_HOOK_ARG_LENGTH) });
  }
  return {
    ok: true,
    value: {
      model: truncate(raw.model, MAX_PROXY_MODEL_LENGTH),
      inputTokens: numbers.inputTokens ?? 0,
      outputTokens: numbers.outputTokens ?? 0,
      cacheReadTokens: numbers.cacheReadTokens ?? 0,
      cacheCreationTokens: numbers.cacheCreationTokens ?? 0,
      reply: truncate(raw.reply, MAX_PROXY_REPLY_LENGTH),
      toolCalls,
      maskedSecrets: numbers.maskedSecrets ?? 0,
    },
  };
}

/** Cuts text to at most `max` bytes of UTF-8. */
function capBytes(text: string, max: number): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return { text, cut: false };
  return { text: new TextDecoder().decode(bytes.subarray(0, max)).replace(/�+$/, ""), cut: true };
}

function parseEvent(raw: unknown): Parsed<ProxyEvent> {
  const { id, type, payload } = (raw ?? {}) as Record<string, unknown>;
  if (typeof id !== "string" || !EVENT_ID.test(id)) return { ok: false, reason: '"event.id" must be a UUID.' };
  if (!PROXY_EVENT_TYPES.includes(type as ProxyEventType)) {
    return { ok: false, reason: `"event.type" must be one of ${PROXY_EVENT_TYPES.join(", ")}.` };
  }
  if (typeof payload !== "object" || payload === null) return { ok: false, reason: 'The Event needs a "payload".' };
  const fields = payload as Record<string, unknown>;
  const turn = parseTurn(fields);
  if (!turn.ok) return turn;
  if (type === "proxy.digest") return { ok: true, value: { id, type, payload: turn.value } };

  if (typeof fields.context !== "string" || typeof fields.response !== "string") {
    return { ok: false, reason: 'A Raw Proxy Event needs "context" and "response".' };
  }
  const truncated = (fields.truncated ?? {}) as Record<string, unknown>;
  const context = capBytes(fields.context, RAW_PROXY_CAP_BYTES);
  const response = capBytes(fields.response, RAW_PROXY_CAP_BYTES);
  return {
    ok: true,
    value: {
      id,
      type: "proxy.raw",
      payload: {
        ...turn.value,
        context: context.text,
        response: response.text,
        capBytes: RAW_PROXY_CAP_BYTES,
        truncated: {
          context: truncated.context === true || context.cut,
          response: truncated.response === true || response.cut,
        },
      },
    },
  };
}

export class ProxyCapture {
  constructor(private readonly host: ProxyCaptureHost) {}

  /** Handles one message from a wrapper's WebSocket, opened by `person` with Agent `socketAgent`'s token. */
  receive(person: PersonName, socketAgent: AgentId | null, message: Record<string, unknown>): ProxyCaptureReply {
    const rawId = (message.event as { id?: unknown } | undefined)?.id;
    const id = typeof rawId === "string" ? rawId : "";
    const refuse = (reason: string): ProxyCaptureReply => ({ type: "proxy.refused", id, reason });

    const agent = message.agent;
    if (typeof agent !== "string" || agent.split("/").length !== 3) return refuse('"agent" must be an Agent ID.');
    if (agent !== socketAgent) return refuse(`Only Agent ${agent}'s own token may send its Events.`);
    const parsed = parseEvent(message.event);
    if (!parsed.ok) return refuse(parsed.reason);
    const allowed = this.host.touchAgent(person, agent as AgentId);
    if (!allowed.ok) return refuse(allowed.reason);
    if (parsed.value.type === "proxy.raw" && allowed.agent.proxyMode !== "raw") {
      return refuse(`Agent ${agent} is in digest mode: its Person has not chosen raw.`);
    }

    const event = parsed.value;
    const actor = { kind: "agent", agentId: agent as AgentId } as const;
    // The model turn is about the Task the Agent works on as it arrives.
    const task = this.host.currentTask(agent as AgentId);
    const about = task === null ? {} : { task };
    if (event.type === "proxy.raw") {
      this.host.appendOnce(event.id, { type: "proxy.raw", actor, capture: "proxy", ...about, payload: event.payload });
    } else {
      this.host.appendOnce(event.id, {
        type: "proxy.digest",
        actor,
        capture: "proxy",
        ...about,
        payload: event.payload,
      });
    }
    return { type: "proxy.ack", id: event.id };
  }
}
