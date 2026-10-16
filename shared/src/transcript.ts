// Reading another session's transcript (ADR 0019). The Channel stores none of it: a
// read asks the Agent's wrapper over its socket for one page, which the wrapper reads
// from its session's file, condenses and redacts before it leaves the machine.

import type { AgentId } from "./domain";
import { stripEscapes } from "./escapes";

/** The most a page holds, in bytes of its entries' text: the wrapper stops before it. */
export const TRANSCRIPT_PAGE_BYTES = 32_000;
/** How long the Channel waits for the wrapper's page. */
export const TRANSCRIPT_WAIT_MS = 10_000;

/** What an entry is: the Person's prompt, the model's text, a tool call and its result, or a compaction. */
export type TranscriptKind = "prompt" | "text" | "tool" | "result" | "compaction";

export interface TranscriptEntry {
  /** Its place in the session, from 0: where to read from again. */
  n: number;
  at?: string;
  kind: TranscriptKind;
  /** Condensed and redacted. A tool call is its name and main argument; a result is cut short. */
  text: string;
}

/** `GET /api/agents/:id/transcript?from=<n>`: a page of Agent `agent`'s session, from entry `from`. */
export interface TranscriptResponse {
  agent: AgentId;
  from: number;
  entries: TranscriptEntry[];
  /** The entry to ask for next; absent when the page reaches the end of the session so far. */
  next?: number;
  /** How many secrets the wrapper redacted in this page. */
  redacted: number;
}

/**
 * The path that reads an Agent's transcript: from entry `from`, or, with `latest`, the
 * page that ends at its newest entry (ADR 0024).
 */
export function transcriptPath(id: AgentId, from = 0, latest = false): string {
  const query = latest ? "?latest=1" : from > 0 ? `?from=${from}` : "";
  return `/api/agents/${encodeURIComponent(id)}/transcript${query}`;
}

/**
 * Channel to wrapper: read a page of Agent `agent`'s transcript from entry `from`, and
 * answer with `id`. With `latest`, the page that ends at the newest entry instead.
 */
export interface TranscriptRequestMessage {
  type: "transcript.request";
  agent: AgentId;
  id: string;
  from: number;
  latest?: boolean;
}

/** Wrapper to Channel: the page asked for as `id`, or why there is none. */
export type TranscriptPageFrame = {
  type: "transcript.page";
  agent: AgentId;
  id: string;
} & ({ page: Omit<TranscriptResponse, "agent"> } | { error: string });

/** An entry's time as the CLIs write it, an ISO 8601 timestamp: printed on its own header line, so nothing else. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The kinds of entry, in the order the wire names them. */
export const TRANSCRIPT_KINDS: readonly TranscriptKind[] = ["prompt", "text", "tool", "result", "compaction"];

/**
 * Transcript text as it may be shown: lines kept, but no terminal escape sequence (each
 * removed whole, OSC 52 included), no other control character and no bidi control that
 * could reorder what a reader sees. Carriage returns become newlines.
 */
export function cleanTranscriptText(raw: string): string {
  return (
    stripEscapes(raw)
      .replace(/\r\n?|[\u0085\u2028\u2029\v\f]/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
      .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
  );
}

/** A page as it came off a wrapper's socket, cleaned, or null when it is not one. */
export function cleanTranscriptPage(raw: unknown): Omit<TranscriptResponse, "agent"> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { from, entries, next, redacted } = raw as Record<string, unknown>;
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!count(from) || !count(redacted) || !Array.isArray(entries) || (next !== undefined && !count(next))) return null;
  const clean: TranscriptEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return null;
    const { n, at, kind, text } = entry as Record<string, unknown>;
    if (!count(n) || typeof text !== "string" || !TRANSCRIPT_KINDS.includes(kind as TranscriptKind)) return null;
    bytes += text.length;
    // A wrapper keeps a page under the cap; one far past it is not a page.
    if (bytes > TRANSCRIPT_PAGE_BYTES * 2) return null;
    clean.push({
      n: n as number,
      ...(typeof at === "string" && ISO_TIME.test(at) ? { at } : {}),
      kind: kind as TranscriptKind,
      text: cleanTranscriptText(text),
    });
  }
  return {
    from: from as number,
    entries: clean,
    ...(next === undefined ? {} : { next: next as number }),
    redacted: redacted as number,
  };
}
