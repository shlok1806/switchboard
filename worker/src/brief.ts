// The Brief (ADR 0042): a few short Markdown pages per Channel, one row per page. A
// write replaces the page's row, carrying its last BRIEF_HISTORY earlier versions in
// the same row, so a write is one row whatever the history holds and pruning is a
// slice. A Channel takes at most BRIEF_WRITES_PER_DAY page writes a UTC day, counted
// in one row of its own: a write that changes a page writes two rows, one that
// changes nothing writes none.

import type { BriefAuthor, BriefPage, BriefPageSummary, WriteBriefRequest } from "../../shared/src/index";
import { BRIEF_HISTORY, BRIEF_OVERVIEW, briefOrder, defaultBriefTitle, MAX_BRIEF_PAGES } from "../../shared/src/index";
import { utcDay } from "./channel";

export const BRIEF_SCHEMA = `
  CREATE TABLE IF NOT EXISTS brief_pages (
    page TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    version INTEGER NOT NULL,
    text TEXT NOT NULL,
    author TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    earlier TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS brief_budget (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    day TEXT NOT NULL,
    writes INTEGER NOT NULL
  );
`;

type PageRow = {
  page: string;
  title: string;
  version: number;
  text: string;
  author: string;
  updated_at: string;
  earlier: string;
};

export type BriefResult<T> = { ok: true; value: T } | { ok: false; status: number; reason: string };

function summaryOf(row: Omit<PageRow, "text" | "earlier">): BriefPageSummary {
  return {
    page: row.page,
    title: row.title,
    version: row.version,
    author: JSON.parse(row.author) as BriefAuthor,
    updatedAt: row.updated_at,
  };
}

function pageOf(row: Omit<PageRow, "earlier">): BriefPage {
  return { ...summaryOf(row), text: row.text };
}

const SUMMARY_COLUMNS = "page, title, version, author, updated_at";

export class Brief {
  constructor(
    private readonly sql: SqlStorage,
    /** A Channel's page writes per UTC day. */
    private readonly perDay: number,
  ) {}

  /** Every page's current version, in the Brief's order. One row read per page. */
  pages(): BriefPage[] {
    return this.sql
      .exec<Omit<PageRow, "earlier">>(`SELECT ${SUMMARY_COLUMNS}, text FROM brief_pages`)
      .toArray()
      .map(pageOf)
      .sort(briefOrder);
  }

  /**
   * What the Connector's `brief` tool answers: one page and, for the overview or a page
   * there is none of, every page without its text. The overview reads one row per page;
   * another page reads one row.
   */
  ask(page: string): { page: BriefPage | null; pages?: BriefPageSummary[] } {
    if (page !== BRIEF_OVERVIEW) {
      const row = this.sql
        .exec<Omit<PageRow, "earlier">>(`SELECT ${SUMMARY_COLUMNS}, text FROM brief_pages WHERE page = ?`, page)
        .toArray()[0];
      if (row !== undefined) return { page: pageOf(row) };
    }
    const rows = this.sql
      .exec<Omit<PageRow, "earlier" | "text"> & { text: string | null }>(
        `SELECT ${SUMMARY_COLUMNS}, CASE WHEN page = ? THEN text END AS text FROM brief_pages`,
        page,
      )
      .toArray();
    const found = rows.find((row) => row.page === page && row.text !== null);
    return {
      page: found === undefined ? null : pageOf({ ...found, text: found.text ?? "" }),
      pages: rows.map(summaryOf).sort(briefOrder),
    };
  }

  /** One version of a page (the current one when `version` is left out), and every version kept. */
  read(page: string, version?: number): BriefResult<{ page: BriefPage; versions: number[] }> {
    const row = this.sql.exec<PageRow>("SELECT * FROM brief_pages WHERE page = ?", page).toArray()[0];
    if (row === undefined) return { ok: false, status: 404, reason: `The Brief has no page ${page} yet.` };
    const earlier = JSON.parse(row.earlier) as BriefPage[];
    const versions = [...earlier.map((v) => v.version).reverse(), row.version];
    if (version === undefined || version === row.version) return { ok: true, value: { page: pageOf(row), versions } };
    const kept = earlier.find((v) => v.version === version);
    if (kept === undefined) {
      return {
        ok: false,
        status: 404,
        reason: `${page} keeps versions ${versions.join(", ")} only; older ones are pruned.`,
      };
    }
    return { ok: true, value: { page: kept, versions } };
  }

  /**
   * Replaces a page for `author`, keeping its last BRIEF_HISTORY versions, or says why
   * not. A write that changes nothing writes nothing and is not counted.
   */
  write(
    author: BriefAuthor,
    page: string,
    write: WriteBriefRequest,
  ): BriefResult<{ page: BriefPage; written: boolean }> {
    const current = this.sql.exec<PageRow>("SELECT * FROM brief_pages WHERE page = ?", page).toArray()[0];
    const title = write.title ?? current?.title ?? defaultBriefTitle(page);
    if (current !== undefined && current.text === write.text && current.title === title) {
      return { ok: true, value: { page: pageOf(current), written: false } };
    }
    if (current === undefined) {
      const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM brief_pages").one().n;
      if (count >= MAX_BRIEF_PAGES) {
        return {
          ok: false,
          status: 409,
          reason: `The Brief has its ${MAX_BRIEF_PAGES} pages. Fold this into an existing area's page instead.`,
        };
      }
    }
    const admitted = this.admit();
    if (!admitted.ok) return admitted;
    const earlier = current === undefined ? [] : [pageOf(current), ...(JSON.parse(current.earlier) as BriefPage[])];
    const next: BriefPage = {
      page,
      title,
      version: (current?.version ?? 0) + 1,
      text: write.text,
      author,
      updatedAt: new Date().toISOString(),
    };
    this.sql.exec(
      `INSERT INTO brief_pages (page, title, version, text, author, updated_at, earlier)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (page) DO UPDATE SET title = excluded.title, version = excluded.version, text = excluded.text,
         author = excluded.author, updated_at = excluded.updated_at, earlier = excluded.earlier`,
      next.page,
      next.title,
      next.version,
      next.text,
      JSON.stringify(next.author),
      next.updatedAt,
      JSON.stringify(earlier.slice(0, BRIEF_HISTORY)),
    );
    return { ok: true, value: { page: next, written: true } };
  }

  /** Whether the Channel takes another page write today, counting it if so. */
  private admit(): { ok: true } | { ok: false; status: 429; reason: string } {
    const day = utcDay();
    const used = this.sql
      .exec<{ day: string; writes: number }>("SELECT day, writes FROM brief_budget WHERE id = 1")
      .toArray()[0];
    if (used?.day === day && used.writes >= this.perDay) {
      return {
        ok: false,
        status: 429,
        reason: `This Channel has taken its ${this.perDay} Brief writes for today (UTC). Pages can be written again tomorrow.`,
      };
    }
    this.sql.exec(
      `INSERT INTO brief_budget (id, day, writes) VALUES (1, ?, 1)
       ON CONFLICT (id) DO UPDATE SET writes = CASE WHEN day = excluded.day THEN writes + 1 ELSE 1 END, day = excluded.day`,
      day,
    );
    return { ok: true };
  }
}
