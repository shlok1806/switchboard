/**
 * The Hook Capture part of the Channel API. The laptop wrapper installs hooks in
 * the agent CLI's session; each hook hands its event to the wrapper locally, and
 * the wrapper sends it to the Channel over its WebSocket as a `HookCaptureMessage`.
 * The Channel records each as an Event labelled with the Hook Capture and answers
 * with a `HookCaptureReply`. Terms follow CONTEXT.md.
 */
import type { AgentId, EventPayloads } from "./domain";

/** The Event types the Hook Capture records. */
export const HOOK_EVENT_TYPES = ["session.start", "session.end", "tool.call", "file.edit", "command", "turn.end"] as const;

export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

/** One Event the Hook Capture saw, before the Channel records it. */
export type HookEvent = {
  [K in HookEventType]: {
    /**
     * Picked by the wrapper (a UUID) so a message sent again after a reconnect is
     * recorded once. It becomes the Event's `id`.
     */
    id: string;
    type: K;
    payload: EventPayloads[K];
  };
}[HookEventType];

/** Wrapper to Channel, over the WebSocket: Hook Events for one Agent of the socket's Person. */
export interface HookCaptureMessage {
  type: "hook";
  agent: AgentId;
  events: HookEvent[];
}

/**
 * Channel to wrapper, sent to that socket only. `recorded` lists the Event IDs the
 * Channel now holds (including ones it already had). A refused message is not
 * retried: the reason says why.
 */
export type HookCaptureReply =
  | { type: "hook.ack"; recorded: string[] }
  | { type: "hook.refused"; ids: string[]; reason: string };

/** Most Events in one `HookCaptureMessage`. */
export const MAX_HOOK_EVENTS_PER_MESSAGE = 50;

/** Longest `tool.call` argument summary, in characters. Longer ones are cut. */
export const MAX_HOOK_ARG_LENGTH = 200;
/** Longest `command`, in characters. Longer ones are cut. */
export const MAX_HOOK_COMMAND_LENGTH = 500;
/** Longest file path or other short text in a Hook Event, in characters. */
export const MAX_HOOK_TEXT_LENGTH = 500;

/** Cuts `text` to `max` characters, marking the cut with "…". */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One file an Agent has edited, from its `file.edit` Events. */
export interface TouchedFile {
  path: string;
  /** How many `file.edit` Events named it. */
  edits: number;
  firstEditedAt: string;
  lastEditedAt: string;
}

/** `GET /api/agents/:id/touched-files`: the files an Agent has edited, most recently edited first. */
export interface TouchedFilesResponse {
  agent: AgentId;
  files: TouchedFile[];
}
