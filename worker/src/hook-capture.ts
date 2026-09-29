// The Hook Capture on the Channel side. The laptop wrapper sends the Events its
// Agent's hooks saw over its WebSocket; this module checks them, records each as
// an Event labelled with the Hook Capture, and keeps every Agent's touched-files
// list from its `file.edit` Events (the Relay reads it later).
//
// - Only an Agent's own Person may send its Events, and only on a socket that
//   Person opened.
// - Each Event carries an ID the wrapper picked, so a message sent again after a
//   reconnect is recorded once, and a file edit is counted once.
// - Payloads stay small: text is cut to the shared limits here too, whatever the
//   wrapper did, and a `tool.call` never carries output.

import type {
  AgentId,
  ChannelEvent,
  EventPayloads,
  HookCaptureReply,
  HookEvent,
  HookEventType,
  PersonName,
  TouchedFile,
} from "../../shared/src/index";
import {
  HOOK_EVENT_TYPES,
  MAX_HOOK_ARG_LENGTH,
  MAX_HOOK_COMMAND_LENGTH,
  MAX_HOOK_EVENTS_PER_MESSAGE,
  MAX_HOOK_TEXT_LENGTH,
  truncate,
} from "../../shared/src/index";
import type { Refusal } from "./agents";

export const HOOK_CAPTURE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS touched_files (
    agent TEXT NOT NULL,
    path TEXT NOT NULL,
    edits INTEGER NOT NULL,
    first_edited_at TEXT NOT NULL,
    last_edited_at TEXT NOT NULL,
    last_seq INTEGER NOT NULL,
    PRIMARY KEY (agent, path)
  );
`;

type TouchedFileRow = {
  agent: string;
  path: string;
  edits: number;
  first_edited_at: string;
  last_edited_at: string;
  last_seq: number;
};

/** What the Hook Capture needs from the Channel that hosts it. */
export interface HookCaptureHost {
  sql: SqlStorage;
  /**
   * Checks that `person` may act for Agent `id`, and counts the Event as a sign of
   * life for Presence.
   */
  touchAgent(person: PersonName, id: AgentId): { ok: true } | Refusal;
  /** Records an Event with the given ID, or returns null when the Channel already has it. */
  appendOnce<K extends HookEventType>(
    id: string,
    event: { type: K; actor: { kind: "agent"; agentId: AgentId }; capture: "hook"; payload: EventPayloads[K] },
  ): ChannelEvent | null;
}

/** Hook Event IDs are UUIDs picked by the wrapper. */
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? truncate(value, max) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Checks one Event's payload and cuts its text to size. */
function parsePayload(type: HookEventType, raw: Record<string, unknown>): Parsed<HookEvent["payload"]> {
  const bad = (what: string): Parsed<never> => ({ ok: false, reason: `A "${type}" Event needs ${what}.` });
  switch (type) {
    case "session.start": {
      const cwd = text(raw.cwd, MAX_HOOK_TEXT_LENGTH);
      const source = text(raw.source, 40);
      if (cwd === undefined || typeof raw.resumed !== "boolean") return bad('"cwd" and "resumed"');
      return { ok: true, value: { cwd, resumed: raw.resumed, ...(source === undefined ? {} : { source }) } };
    }
    case "session.end": {
      if (raw.reason !== "exit" && raw.reason !== "timeout") return bad('"reason" of "exit" or "timeout"');
      const detail = text(raw.detail, 40);
      return { ok: true, value: { reason: raw.reason, ...(detail === undefined ? {} : { detail }) } };
    }
    case "tool.call": {
      const tool = text(raw.tool, 100);
      const arg = text(raw.arg, MAX_HOOK_ARG_LENGTH);
      if (!tool || arg === undefined || typeof raw.ok !== "boolean") return bad('"tool", "arg" and "ok"');
      const durationMs = count(raw.durationMs);
      // Tool output is never recorded: it can hold file contents.
      return { ok: true, value: { tool, arg, ok: raw.ok, ...(durationMs === undefined ? {} : { durationMs }) } };
    }
    case "file.edit": {
      const path = text(raw.path, MAX_HOOK_TEXT_LENGTH);
      const additions = count(raw.additions);
      const deletions = count(raw.deletions);
      if (!path || additions === undefined || deletions === undefined) {
        return bad('"path", "additions" and "deletions"');
      }
      return { ok: true, value: { path, additions, deletions } };
    }
    case "command": {
      const command = text(raw.command, MAX_HOOK_COMMAND_LENGTH);
      if (!command) return bad('"command"');
      const exitCode = typeof raw.exitCode === "number" && Number.isInteger(raw.exitCode) ? raw.exitCode : undefined;
      return { ok: true, value: { command, ...(exitCode === undefined ? {} : { exitCode }) } };
    }
    case "turn.end": {
      const turn = count(raw.turn);
      if (turn === undefined) return bad('"turn"');
      return { ok: true, value: { turn } };
    }
  }
}

function parseEvents(raw: unknown): Parsed<HookEvent[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_HOOK_EVENTS_PER_MESSAGE) {
    return { ok: false, reason: `"events" must hold 1 to ${MAX_HOOK_EVENTS_PER_MESSAGE} Events.` };
  }
  const events: HookEvent[] = [];
  for (const item of raw) {
    const { id, type, payload } = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof id !== "string" || !EVENT_ID.test(id)) return { ok: false, reason: 'Each Event needs a UUID "id".' };
    if (!HOOK_EVENT_TYPES.includes(type as HookEventType)) {
      return { ok: false, reason: `"type" must be one of ${HOOK_EVENT_TYPES.join(", ")}.` };
    }
    if (typeof payload !== "object" || payload === null) return { ok: false, reason: 'Each Event needs a "payload".' };
    const parsed = parsePayload(type as HookEventType, payload as Record<string, unknown>);
    if (!parsed.ok) return parsed;
    events.push({ id, type, payload: parsed.value } as HookEvent);
  }
  return { ok: true, value: events };
}

function rowToTouchedFile(row: TouchedFileRow): TouchedFile {
  return {
    path: row.path,
    edits: row.edits,
    firstEditedAt: row.first_edited_at,
    lastEditedAt: row.last_edited_at,
  };
}

export class HookCapture {
  constructor(private readonly host: HookCaptureHost) {}

  /** Handles one message from a wrapper's WebSocket, sent by `person`. */
  receive(person: PersonName, message: Record<string, unknown>): HookCaptureReply {
    const ids = Array.isArray(message.events)
      ? message.events.flatMap((e) => (typeof e?.id === "string" ? [e.id as string] : []))
      : [];
    const refuse = (reason: string): HookCaptureReply => ({ type: "hook.refused", ids, reason });

    const agent = message.agent;
    if (typeof agent !== "string" || agent.split("/").length !== 3) return refuse('"agent" must be an Agent ID.');
    const parsed = parseEvents(message.events);
    if (!parsed.ok) return refuse(parsed.reason);
    const allowed = this.host.touchAgent(person, agent as AgentId);
    if (!allowed.ok) return refuse(allowed.reason);

    const recorded: string[] = [];
    for (const event of parsed.value) {
      const stored = this.host.appendOnce(event.id, {
        type: event.type,
        actor: { kind: "agent", agentId: agent as AgentId },
        capture: "hook",
        payload: event.payload,
      } as Parameters<HookCaptureHost["appendOnce"]>[1]);
      if (stored?.type === "file.edit") this.touch(stored.actor, stored);
      // Null means the Channel already had it: recorded either way.
      recorded.push(event.id);
    }
    return { type: "hook.ack", recorded };
  }

  /** The files Agent `id` has edited, most recently edited first. */
  touchedFiles(id: AgentId): TouchedFile[] {
    return this.host.sql
      .exec<TouchedFileRow>("SELECT * FROM touched_files WHERE agent = ? ORDER BY last_seq DESC", id)
      .toArray()
      .map(rowToTouchedFile);
  }

  private touch(actor: ChannelEvent["actor"], event: Extract<ChannelEvent, { type: "file.edit" }>): void {
    if (actor.kind !== "agent") return;
    this.host.sql.exec(
      `INSERT INTO touched_files (agent, path, edits, first_edited_at, last_edited_at, last_seq)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT (agent, path) DO UPDATE SET
         edits = edits + 1, last_edited_at = excluded.last_edited_at, last_seq = excluded.last_seq`,
      actor.agentId,
      event.payload.path,
      event.at,
      event.at,
      event.seq,
    );
  }
}
