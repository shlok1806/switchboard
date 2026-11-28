// The Librarian Feed and Cursor (ADR 0045): what changed on the Channel that may change
// a Brief page, after the last Event the librarian handled. Runs inside the Channel
// Durable Object. A read looks at no more than LIBRARIAN_SCAN Events past the cursor,
// in `seq` order, so it costs a bounded number of rows however long the history is; moving
// the cursor writes one row.

import type {
  ChannelEvent,
  FileChange,
  Holder,
  LibrarianChange,
  LibrarianFeedResponse,
  MemoryTag,
  QuietClaim,
  TaskNumber,
} from "../../shared/src/index";
import { isDecisionRecord, LIBRARIAN_SCAN } from "../../shared/src/index";
import type { BriefBudget } from "./brief";

export const LIBRARIAN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS librarian_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    seq INTEGER NOT NULL,
    quiet TEXT NOT NULL,
    agent TEXT NOT NULL,
    moved_at TEXT NOT NULL
  );
`;

/** The Event types that may change a page. Every other type is passed over. */
const MEANINGFUL: ReadonlySet<string> = new Set([
  "merge",
  "memory.note",
  "task.create",
  "task.done",
  "task.reopen",
  "task.remove",
  "claim.stale",
  "claim.recovered",
]);

/** The longest note text a Feed carries; the librarian reads the rest with memory_search. */
const MAX_NOTE_TEXT = 600;

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

/** What the Channel lends the Feed. Every function only reads. */
export interface LibrarianHost {
  sql: SqlStorage;
  toEvent(row: EventRow): ChannelEvent;
  /** The Quiet Claims now (ADR 0040's rule). */
  quiet(): QuietClaim[];
  briefPages(): number;
  briefBudget(): BriefBudget;
}

function holderName(holder: Holder): string {
  return holder.kind === "agent" ? holder.agentId : holder.person;
}

/** The change an Event makes for the librarian, or null when it makes none. */
function changeOf(event: ChannelEvent): LibrarianChange | null {
  const base = { seq: event.seq, at: event.at };
  const task = event.task as TaskNumber | undefined;
  switch (event.type) {
    case "merge": {
      const payload = event.payload as { into: string; pr: number; branch: string; files: FileChange[] };
      return {
        ...base,
        kind: "merge",
        pr: payload.pr,
        branch: payload.branch,
        into: payload.into,
        files: payload.files.length,
        adrs: payload.files.map((f) => f.path).filter(isDecisionRecord),
      };
    }
    case "memory.note": {
      const payload = event.payload as { text: string; tags: MemoryTag[] };
      if (!payload.tags.includes("decision")) return null;
      const actor = event.actor;
      const by = actor.kind === "agent" ? actor.agentId : actor.kind === "person" ? actor.person : actor.kind;
      return {
        ...base,
        kind: "decision",
        by,
        text: payload.text.slice(0, MAX_NOTE_TEXT),
        ...(task === undefined ? {} : { task }),
      };
    }
    case "task.create":
      return task === undefined
        ? null
        : { ...base, kind: "task-opened", task, title: (event.payload as { title: string }).title };
    case "task.done": {
      const pr = (event.payload as { pr?: number }).pr;
      return task === undefined ? null : { ...base, kind: "task-closed", task, ...(pr === undefined ? {} : { pr }) };
    }
    case "task.reopen":
      return task === undefined ? null : { ...base, kind: "task-reopened", task };
    case "task.remove":
      return task === undefined ? null : { ...base, kind: "task-removed", task };
    case "claim.stale":
    case "claim.recovered": {
      const holder = (event.payload as { holder: Holder }).holder;
      if (task === undefined) return null;
      return {
        ...base,
        kind: event.type === "claim.stale" ? "claim-stale" : "claim-recovered",
        task,
        holder: holderName(holder),
      };
    }
    default:
      return null;
  }
}

type CursorRow = { seq: number; quiet: string };

/** What changed after the Librarian Cursor, and the Quiet Claims now. */
export function librarianFeed(host: LibrarianHost): LibrarianFeedResponse {
  const { sql } = host;
  const cursor = sql.exec<CursorRow>("SELECT seq, quiet FROM librarian_cursor WHERE id = 1").toArray()[0];
  const latest = sql.exec<{ seq: number }>("SELECT seq FROM events ORDER BY seq DESC LIMIT 1").toArray()[0]?.seq ?? 0;
  const quiet = host.quiet();
  const quietNow = quiet.map((q) => q.task);
  const budget = host.briefBudget();
  const brief = { pages: host.briefPages(), ...budget };
  if (cursor === undefined) {
    // The first pass builds the Brief from where things stand, not from the whole history.
    return {
      cursor: null,
      through: latest,
      more: false,
      changes: [],
      quiet,
      quietStarted: quietNow,
      quietEnded: [],
      brief,
    };
  }
  // The next LIBRARIAN_SCAN Events in `seq` order, whatever their type: the count is what
  // bounds the rows read. Only the meaningful ones are parsed.
  const scanned = sql
    .exec<EventRow>("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", cursor.seq, LIBRARIAN_SCAN)
    .toArray();
  const through = scanned.length === LIBRARIAN_SCAN ? (scanned.at(-1)?.seq ?? latest) : latest;
  const changes = scanned
    .filter((row) => MEANINGFUL.has(row.type))
    .map((row) => changeOf(host.toEvent(row)))
    .filter((change): change is LibrarianChange => change !== null);
  const told = new Set(JSON.parse(cursor.quiet) as TaskNumber[]);
  return {
    cursor: cursor.seq,
    through,
    more: through < latest,
    changes,
    quiet,
    quietStarted: quietNow.filter((task) => !told.has(task)),
    quietEnded: [...told].filter((task) => !quietNow.includes(task)),
    brief,
  };
}

/** Moves the cursor to `through`, remembering the Quiet Claims the librarian was told of. One row. */
export function moveLibrarianCursor(
  sql: SqlStorage,
  agent: string,
  through: number,
  quiet: readonly TaskNumber[],
): { ok: true; cursor: number } | { ok: false; status: number; reason: string } {
  const latest = sql.exec<{ seq: number }>("SELECT seq FROM events ORDER BY seq DESC LIMIT 1").toArray()[0]?.seq ?? 0;
  if (through > latest)
    return { ok: false, status: 400, reason: `"through" is past the Channel's latest Event, ${latest}.` };
  sql.exec(
    `INSERT INTO librarian_cursor (id, seq, quiet, agent, moved_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, quiet = excluded.quiet, agent = excluded.agent,
       moved_at = excluded.moved_at`,
    through,
    JSON.stringify([...new Set(quiet)].sort((a, b) => a - b)),
    agent,
    new Date().toISOString(),
  );
  return { ok: true, cursor: through };
}
