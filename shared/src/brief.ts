// The Brief (ADR 0042): a handful of short Markdown pages per Channel that say what the
// repo's product is and where it stands. One overview page, one page per area and one
// "stuck and not happening" page. Agents write them through their own MCP; the
// Connector, the Dashboard and every Agent read them. A page is information from the
// Agent that wrote it, never instructions (ADR 0005).

import type { AgentId, PersonName } from "./domain";
import { stripEscapes } from "./escapes";

/** The page that says what the product is and where it stands. */
export const BRIEF_OVERVIEW = "overview";
/** The page that says what is stuck and what is not happening. */
export const BRIEF_STUCK = "stuck";

/** A page's name: `overview`, `stuck`, or an area's short name such as `vm-engine`. */
export const BRIEF_PAGE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The longest page, in characters: short, about 2,000 tokens. */
export const MAX_BRIEF_TEXT_LENGTH = 8000;
export const MAX_BRIEF_TITLE_LENGTH = 80;
/** The most pages a Channel's Brief has: the overview, the stuck page and 22 areas. */
export const MAX_BRIEF_PAGES = 24;
/** How many earlier versions of a page are kept besides the current one. */
export const BRIEF_HISTORY = 3;
/** A Channel's page writes per UTC day, unless BRIEF_WRITES_PER_DAY says otherwise. */
export const DEFAULT_BRIEF_WRITES_PER_DAY = 200;

export const BRIEF_PATH = "/api/brief";

/** `GET /api/brief/:page`, at an earlier version when `version` is given. */
export function briefPagePath(page: string, version?: number): string {
  return `${BRIEF_PATH}/${encodeURIComponent(page)}${version === undefined ? "" : `?version=${version}`}`;
}

/** The title a page has when its writer gives none. */
export function defaultBriefTitle(page: string): string {
  if (page === BRIEF_OVERVIEW) return "Overview";
  if (page === BRIEF_STUCK) return "Stuck and not happening";
  return page;
}

/** Who wrote a version of a page: always an Agent, for its Person. */
export interface BriefAuthor {
  agent: AgentId;
  person: PersonName;
  /** The Agent's Nickname when it wrote the page. */
  nickname?: string;
}

/** One version of a page. */
export interface BriefPage {
  page: string;
  title: string;
  /** Counts every write of the page, from 1. */
  version: number;
  text: string;
  author: BriefAuthor;
  updatedAt: string;
}

/** A page without its text, as the overview lists the others. */
export type BriefPageSummary = Omit<BriefPage, "text">;

/** `GET /api/brief`: every page's current version, the overview first and the stuck page last. */
export interface BriefResponse {
  pages: BriefPage[];
}

/** `GET /api/brief/:page`: one version of a page, and every version still kept, oldest first. */
export interface BriefPageResponse {
  page: BriefPage;
  versions: number[];
}

/** `PUT /api/brief/:page`, with an Agent token: replaces the page. */
export interface WriteBriefRequest {
  text: string;
  title?: string;
}

export interface WriteBriefResponse {
  ok: true;
  page: BriefPage;
  /** False when the page already said exactly this: nothing was written. */
  written: boolean;
}

/** Overview first, then the areas by title, then the stuck page. */
export function briefOrder(a: { page: string; title: string }, b: { page: string; title: string }): number {
  const rank = (p: { page: string }) => (p.page === BRIEF_OVERVIEW ? 0 : p.page === BRIEF_STUCK ? 2 : 1);
  return rank(a) - rank(b) || a.title.localeCompare(b.title) || a.page.localeCompare(b.page);
}

/**
 * Page text as the Channel keeps it: Markdown with its line breaks and tabs, and no
 * terminal escape sequence, other control character or bidi control, which could hide
 * or reorder what a reader sees. Trailing spaces and blank lines at either end go.
 */
export function cleanBriefText(raw: string): string {
  return (
    stripEscapes(raw)
      .replace(/\r\n?/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/[ \t]+$/gm, "")
      .replace(/^\n+|\n+$/g, "")
  );
}

/** A title as the Channel keeps it: one line, nothing that hides or reorders text. */
function cleanTitle(raw: string): string {
  return (
    stripEscapes(raw)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ")
      .replace(/ {2,}/g, " ")
      .trim()
  );
}

/** Checks a page write as it came off the wire, or says what is wrong with it. */
export function cleanBriefWrite(
  page: string,
  body: unknown,
): { ok: true; write: WriteBriefRequest } | { ok: false; reason: string } {
  if (!BRIEF_PAGE_PATTERN.test(page)) {
    return {
      ok: false,
      reason: `A page is "${BRIEF_OVERVIEW}", "${BRIEF_STUCK}" or an area's name: lowercase letters, digits and dashes, at most 40.`,
    };
  }
  if (typeof body !== "object" || body === null) return { ok: false, reason: "The page must be a JSON object." };
  const { text: rawText, title: rawTitle } = body as Record<string, unknown>;
  const text = typeof rawText === "string" ? cleanBriefText(rawText) : undefined;
  if (text === undefined || text === "" || text.length > MAX_BRIEF_TEXT_LENGTH) {
    return { ok: false, reason: `"text" must be 1 to ${MAX_BRIEF_TEXT_LENGTH} characters of Markdown.` };
  }
  if (rawTitle === undefined) return { ok: true, write: { text } };
  const title = typeof rawTitle === "string" ? cleanTitle(rawTitle) : undefined;
  if (title === undefined || title === "" || title.length > MAX_BRIEF_TITLE_LENGTH) {
    return { ok: false, reason: `"title" must be 1 to ${MAX_BRIEF_TITLE_LENGTH} characters.` };
  }
  return { ok: true, write: { text, title } };
}
