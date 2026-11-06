// The machine's local store of Local Events (ADR 0037): the per-call records of its
// Agents' work, which the Channel no longer keeps. One SQLite file, `<config>/events.db`,
// shared by every wrapper and the Host on the machine, keyed by Channel and Agent. The
// wrapper writes what the Channel acknowledged; the wrapper while it runs, and the Host
// after, answer the Channel's history reads from it.
//
// It uses Node's own `node:sqlite`, so the CLI needs no native module of its own. A Node
// without it, or a file that cannot be opened, leaves the machine with no store: the
// Agent's Local Events are then only live, and the wrapper says so in its log.

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentId, ChannelEvent, HistoryRequestMessage } from "../../shared/src/index";
import { isLocalEvent, LOCAL_RETENTION_DAYS, MAX_HISTORY_PAGE } from "../../shared/src/index";
import { configDir } from "./config";

/** The store's file. */
export function localStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "events.db");
}

/** How long a writer waits for another process's write to finish, in milliseconds. */
const BUSY_TIMEOUT_MS = 2000;

type Row = { event: string };

const require = createRequire(import.meta.url);

/** Loads `node:sqlite` without its "experimental" warning reaching the Person's terminal. */
function loadSqlite(): typeof import("node:sqlite") {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/sqlite/i.test(text)) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
}

export class LocalStore {
  private constructor(private readonly db: DatabaseSync) {}

  /** Opens (or creates) the store at `path`, or says why it cannot. */
  static open(path: string, now = Date.now()): LocalStore | { error: string } {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const { DatabaseSync } = loadSqlite();
      const db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          repo TEXT NOT NULL,
          id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          at TEXT NOT NULL,
          type TEXT NOT NULL,
          agent TEXT,
          task INTEGER,
          event TEXT NOT NULL,
          PRIMARY KEY (repo, id)
        );
        CREATE INDEX IF NOT EXISTS events_by_seq ON events (repo, seq);
        CREATE INDEX IF NOT EXISTS events_by_agent ON events (repo, agent, seq);
        CREATE INDEX IF NOT EXISTS events_by_task ON events (repo, task, seq);
        CREATE INDEX IF NOT EXISTS events_by_at ON events (at);
      `);
      const store = new LocalStore(db);
      store.prune(now);
      return store;
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  /**
   * Keeps the Local Events among `events`, for the Channel of `repo`. An Event kept
   * already is replaced: the Channel's latest word on it wins.
   */
  put(repo: string, events: readonly ChannelEvent[]): number {
    const insert = this.db.prepare(
      `INSERT INTO events (repo, id, seq, at, type, agent, task, event) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, id) DO UPDATE SET seq = excluded.seq, at = excluded.at, task = excluded.task,
         event = excluded.event`,
    );
    let kept = 0;
    for (const event of events) {
      if (!isLocalEvent(event)) continue;
      const agent = event.actor.kind === "agent" ? event.actor.agentId : this.agentOf(repo, event);
      insert.run(repo, event.id, event.seq, event.at, event.type, agent, event.task ?? null, JSON.stringify(event));
      kept += 1;
    }
    return kept;
  }

  /** Whether the store keeps an Event with this ID for the Channel of `repo`. */
  has(repo: string, id: string): boolean {
    return this.db.prepare("SELECT 1 FROM events WHERE repo = ? AND id = ?").get(repo, id) !== undefined;
  }

  /** A page of the Channel's Local Events, as a history request asks: newest `limit` below `before`, oldest first. */
  page(repo: string, asked: Pick<HistoryRequestMessage, "agent" | "task" | "before" | "limit">): ChannelEvent[] {
    const limit = Math.max(0, Math.min(asked.limit, MAX_HISTORY_PAGE));
    const where = ["repo = ?", "seq < ?"];
    const args: (string | number)[] = [repo, asked.before];
    if (asked.agent !== undefined) {
      where.push("agent = ?");
      args.push(asked.agent);
    }
    if (asked.task !== undefined) {
      where.push("task = ?");
      args.push(asked.task);
    }
    const rows = this.db
      .prepare(`SELECT event FROM events WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`)
      .all(...args, limit) as Row[];
    return rows.map((row) => JSON.parse(row.event) as ChannelEvent).reverse();
  }

  /** Drops what is older than the retention: a machine keeps its Agents' history for `LOCAL_RETENTION_DAYS`. */
  prune(now = Date.now()): void {
    const cutoff = new Date(now - LOCAL_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare("DELETE FROM events WHERE at < ?").run(cutoff);
  }

  private closed = false;

  /** Closes the store; closing it again does nothing. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** The Agent a Verdict's Event belongs to, when the store keeps that Event. */
  private agentOf(repo: string, event: ChannelEvent): AgentId | null {
    const about = (event.payload as { event?: unknown }).event;
    if (typeof about !== "string") return null;
    const row = this.db.prepare("SELECT agent FROM events WHERE repo = ? AND id = ?").get(repo, about) as
      | { agent: string | null }
      | undefined;
    return (row?.agent ?? null) as AgentId | null;
  }
}

/** The store, or null with the reason logged: the machine then keeps no Local Events. */
export function openLocalStore(log: (line: string) => void, env: NodeJS.ProcessEnv = process.env): LocalStore | null {
  const opened = LocalStore.open(localStorePath(env));
  if ("error" in opened) {
    log(`no local store of Local Events (${opened.error}): this machine's Agents' history is only live`);
    return null;
  }
  return opened;
}
