/**
 * The Proxy Capture part of the Channel API. The laptop wrapper runs a local proxy
 * between the agent CLI and its model API. For each model turn it builds a Proxy
 * Digest or a Raw Proxy Event, depending on the Agent's Proxy mode, masks detected
 * secrets, and sends it to the Channel over its WebSocket as a `ProxyCaptureMessage`.
 * The Channel records it as an Event labelled with the Proxy Capture. Terms follow
 * CONTEXT.md; raw content never reaches another Agent (ADR 0005).
 */
import type { AgentId, ChannelEvent, EventPayloads, ProxyMode } from "./domain";

/** The Event types the Proxy Capture records. */
export const PROXY_EVENT_TYPES = ["proxy.digest", "proxy.raw"] as const;

export type ProxyEventType = (typeof PROXY_EVENT_TYPES)[number];

/** Every Proxy mode, as the Channel API accepts it. */
export const PROXY_MODES: readonly ProxyMode[] = ["digest", "raw"];

/** A new Agent's Proxy mode when its Person does not pick one. */
export const DEFAULT_PROXY_MODE: ProxyMode = "digest";

/** One Proxy Event, before the Channel records it. */
export type ProxyEvent = {
  [K in ProxyEventType]: {
    /** A UUID the wrapper picks, so a message sent again after a reconnect is recorded once. */
    id: string;
    type: K;
    payload: EventPayloads[K];
  };
}[ProxyEventType];

/**
 * Wrapper to Channel, over the WebSocket: one Proxy Event for one Agent of the
 * socket's Person. A `proxy.raw` Event is refused unless the Agent's Proxy mode on
 * the Channel is raw, so a mode change reaches the Channel before any raw content does.
 */
export interface ProxyCaptureMessage {
  type: "proxy";
  agent: AgentId;
  event: ProxyEvent;
}

/** Channel to wrapper, sent to that socket only. A refused Event is not retried. */
export type ProxyCaptureReply =
  | { type: "proxy.ack"; id: string }
  | { type: "proxy.refused"; id: string; reason: string };

/** `POST /api/agents/:id/proxy-mode`: only the Agent's own Person may change it. Answers with the Agent. */
export interface SetProxyModeRequest {
  mode: ProxyMode;
}

/** The most bytes of the request and of the response body a Raw Proxy Event keeps. */
export const RAW_PROXY_CAP_BYTES = 256 * 1024;

/** Longest reply text in a Proxy Event, in characters. */
export const MAX_PROXY_REPLY_LENGTH = 4000;

/** Most tool calls listed in a Proxy Event. */
export const MAX_PROXY_TOOL_CALLS = 64;

/** Longest model name, in characters. */
export const MAX_PROXY_MODEL_LENGTH = 100;

declare const agentDeliverableBrand: unique symbol;

/**
 * An Event that has passed `agentDeliverable`: the only kind anything may put into
 * an Agent's session (the Relay's Queue and Interrupt deliveries, the `read_channel`
 * tool). The brand means the compiler refuses an Event that skipped the guard.
 */
export type AgentDeliverable = Exclude<ChannelEvent, { type: "proxy.raw" }> & {
  readonly [agentDeliverableBrand]: true;
};

/**
 * The guard between the Channel and every Agent (ADR 0005): raw Proxy content is
 * shown on the Dashboard only and is never delivered into any Agent, so a Raw Proxy
 * Event gives null. Every other Event passes through unchanged.
 */
export function agentDeliverable(event: ChannelEvent): AgentDeliverable | null {
  if (event.type === "proxy.raw") return null;
  return event as AgentDeliverable;
}

/** The Events of `events` that may be delivered into an Agent, in order. */
export function agentDeliverables(events: readonly ChannelEvent[]): AgentDeliverable[] {
  return events.flatMap((event) => {
    const deliverable = agentDeliverable(event);
    return deliverable ? [deliverable] : [];
  });
}
