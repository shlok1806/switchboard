// Shared memory on the Channel (ADR 0019). An Agent writes a note with `memory_note`;
// the Channel records it as a `memory.note` Event, which reaches every wrapper on the
// stream, and keeps a copy here so `memory_recent` and `memory_search` read notes
// through indexes instead of scanning the Events.
//
// Every query reaches its rows through an index: the notes by `seq` (the table's key),
// by author, by Task, by tag, or the full-text index. Notes cost rows written, so a
// Channel takes at most MEMORY_NOTES_PER_DAY of them per UTC day.

import type { ChannelEvent, MemoryNote, MemoryQuery } from "../../shared/src/index";
import { MAX_MEMORY_LIMIT, noteFromEvent } from "../../shared/src/index";
import { utcDay } from "./channel";

export const MEMORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_notes (
    seq INTEGER PRIMARY KEY,
    author TEXT NOT NULL,
    task INTEGER,
    note TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_notes_by_author ON memory_notes (author, seq);
  CREATE INDEX IF NOT EXISTS memory_notes_by_task ON memory_notes (task, seq) WHERE task IS NOT NULL;
  CREATE TABLE IF NOT EXISTS memory_tags (
    tag TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (tag, seq)
  ) WITHOUT ROWID;
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5 (text, files, content = '', tokenize = 'porter unicode61');
  CREATE TABLE IF NOT EXISTS memory_days (
    day TEXT PRIMARY KEY,
    notes INTEGER NOT NULL
  );
`;

/** The longest search, in words: each one is a term every match must have. */
const MAX_SEARCH_TERMS = 12;

export type NoteResult = { ok: true; note: MemoryNote } | { ok: false; status: 429; reason: string };
export type MemoryReadResult =
  | { ok: true; notes: MemoryNote[]; more: boolean }
  | { ok: false; status: 400; reason: string };

/**
 * A search as FTS5 reads it: each word of `q` quoted, so nothing in it is syntax,
 * and all of them required. Null when `q` has no words.
 */
export function ftsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}_]+/gu)?.slice(0, MAX_SEARCH_TERMS) ?? [];
  return words.length === 0 ? null : words.map((word) => `"${word}"`).join(" ");
}

export class Memory {
  constructor(
    private readonly sql: SqlStorage,
    /** A Channel's notes per UTC day. */
    private readonly perDay: number,
  ) {}

  /**
   * Whether the Channel takes another note today, counting it if so. Called before
   * the note's Event is appended, so a refused note writes nothing.
   */
  admit(): { ok: true } | { ok: false; status: 429; reason: string } {
    const day = utcDay();
    const used = this.sql.exec<{ notes: number }>("SELECT notes FROM memory_days WHERE day = ?", day).toArray()[0];
    if ((used?.notes ?? 0) >= this.perDay) {
      return {
        ok: false,
        status: 429,
        reason:
          `This Channel has taken its ${this.perDay} notes for today (UTC). Notes resume tomorrow; ` +
          "post an Update for anything others must hear now.",
      };
    }
    this.sql.exec(
      "INSERT INTO memory_days (day, notes) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET notes = notes + 1",
      day,
    );
    return { ok: true };
  }

  /** Keeps the note a `memory.note` Event carries. */
  keep(event: ChannelEvent): MemoryNote {
    const note = noteFromEvent(event);
    if (note === null) throw new Error(`Event ${event.id} is not an Agent's memory.note`);
    this.sql.exec(
      "INSERT INTO memory_notes (seq, author, task, note) VALUES (?, ?, ?, ?)",
      note.seq,
      note.author,
      note.task ?? null,
      JSON.stringify(note),
    );
    for (const tag of note.tags) this.sql.exec("INSERT INTO memory_tags (tag, seq) VALUES (?, ?)", tag, note.seq);
    this.sql.exec(
      "INSERT INTO memory_fts (rowid, text, files) VALUES (?, ?, ?)",
      note.seq,
      note.text,
      (note.files ?? []).join(" "),
    );
    return note;
  }

  /** Notes matching `query`: best match first for a search, else newest first. */
  read(query: MemoryQuery): MemoryReadResult {
    const limit = Math.min(query.limit ?? 20, MAX_MEMORY_LIMIT);
    const where: string[] = [];
    const args: (string | number)[] = [];
    let from = "memory_notes n";
    // The column the newest-first order and the seq bounds read. With a tag it is the
    // tag index's own, so a tag's notes are found in order without reading the others.
    let key = "n.seq";
    if (query.q !== undefined) {
      const match = ftsQuery(query.q);
      if (match === null) return { ok: false, status: 400, reason: '"q" must have at least one word to search for.' };
      from = "memory_fts f JOIN memory_notes n ON n.seq = f.rowid";
      where.push("memory_fts MATCH ?");
      args.push(match);
    }
    if (query.tag !== undefined) {
      from += " JOIN memory_tags t ON t.seq = n.seq";
      key = "t.seq";
      where.push("t.tag = ?");
      args.push(query.tag);
    }
    if (query.task !== undefined) {
      where.push("n.task = ?");
      args.push(query.task);
    }
    if (query.author !== undefined) {
      where.push("n.author = ?");
      args.push(query.author);
    }
    if (query.after !== undefined) {
      where.push(`${key} > ?`);
      args.push(query.after);
    }
    if (query.before !== undefined) {
      where.push(`${key} < ?`);
      args.push(query.before);
    }
    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const order = query.q === undefined ? `${key} DESC` : "f.rank";
    // One row past the limit says whether more matched, without counting them all.
    const rows = this.sql
      .exec<{ note: string }>(`SELECT n.note FROM ${from} ${clause} ORDER BY ${order} LIMIT ?`, ...args, limit + 1)
      .toArray();
    const notes = rows.slice(0, limit).map((row) => JSON.parse(row.note) as MemoryNote);
    return { ok: true, notes, more: rows.length > limit };
  }
}
