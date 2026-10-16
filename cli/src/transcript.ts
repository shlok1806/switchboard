// A page of this session's transcript, for another session on the Channel (ADR 0019).
// The wrapper reads the CLI's own session file, condenses each entry (prompts, the
// model's text, each tool call with its main argument, results cut short), and redacts
// every page before it leaves the machine. Redaction is always on: no setting skips it.

import { readFile, stat } from "node:fs/promises";
import type { Cli, TranscriptEntry, TranscriptKind, TranscriptResponse } from "../../shared/src/index";
import { cleanTranscriptText, ESCAPE_SEQUENCE, TRANSCRIPT_PAGE_BYTES } from "../../shared/src/index";
import { MASK, maskSecrets } from "./proxy/mask";

/** The longest an entry of each kind runs, after redaction. */
const MAX_CHARS: Record<TranscriptKind, number> = {
  prompt: 4000,
  text: 4000,
  tool: 300,
  result: 600,
  compaction: 200,
};

/**
 * HTTP credentials in headers, as a curl command, a log or a request dump shows them:
 * `Authorization: Bearer ...`, `-H "authorization: Basic ..."`, `"Proxy-Authorization": "..."`,
 * `X-Api-Key: ...`. The header's name and its scheme keep; the value is masked.
 */
const HEADER =
  /(?<![A-Za-z0-9_-])((?:proxy-)?authorization|x-api-key|api-key|x-auth-token)(\\?["']?[ \t]*[:=][ \t]*\\?["']?)((?:bearer|basic|token|digest|negotiate)[ \t]+)?([^\s"'\\]+)/gi;
/** A cookie header's whole value: it holds several cookies, any of which may be a session. */
const COOKIE = /(?<![A-Za-z0-9_-])((?:set-)?cookie)(\\?["']?[ \t]*:[ \t]*\\?["']?)()([^\r\n"'\\]+)/gi;

/** Masks what `maskSecrets` finds, and the credentials in HTTP headers. */
export function redactTranscript(text: string): { text: string; count: number } {
  let count = 0;
  const mask = (match: string, name: string, separator: string, scheme: string | undefined, value: string) => {
    if (value.includes(MASK)) return match;
    count += 1;
    return `${name}${separator}${scheme ?? ""}${MASK}`;
  };
  const headers = text.replace(HEADER, mask).replace(COOKIE, mask);
  const masked = maskSecrets(headers);
  return { text: masked.text, count: count + masked.count };
}

/** One entry before it is numbered, redacted and cut. */
interface Raw {
  at?: string;
  kind: TranscriptKind;
  text: string;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (typeof value === "object" && value !== null ? (value as Json) : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** A tool input's main argument: the command, path, pattern or URL, else its JSON, short. */
function mainArg(input: unknown): string {
  if (typeof input === "string") {
    try {
      return mainArg(JSON.parse(input));
    } catch {
      return input;
    }
  }
  const fields = obj(input);
  for (const name of [
    "command",
    "cmd",
    "file_path",
    "path",
    "notebook_path",
    "pattern",
    "url",
    "query",
    "description",
  ]) {
    const value = fields[name];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  }
  return JSON.stringify(input ?? {});
}

/** The text in a message's content: a string, or the text parts of an array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = obj(part);
      return p.type === "text" || p.type === "input_text" || p.type === "output_text" ? str(p.text) : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

/** Claude Code's session file: one JSON entry a line. */
function claudeEntries(lines: Json[]): Raw[] {
  const out: Raw[] = [];
  for (const e of lines) {
    if (e.isSidechain === true) continue;
    const at = str(e.timestamp) || undefined;
    const message = obj(e.message);
    if (e.type === "system" && e.subtype === "compact_boundary") {
      out.push({
        at,
        kind: "compaction",
        text: `Context compacted (${str(obj(e.compactMetadata).trigger) || "auto"})`,
      });
      continue;
    }
    if (e.type === "user" && e.isMeta !== true && e.isCompactSummary !== true) {
      const content = message.content;
      if (typeof content === "string") {
        if (!content.startsWith("<local-command") && !content.startsWith("<command-")) {
          out.push({ at, kind: "prompt", text: content });
        }
        continue;
      }
      for (const part of Array.isArray(content) ? content : []) {
        const p = obj(part);
        if (p.type === "text") out.push({ at, kind: "prompt", text: str(p.text) });
        if (p.type === "tool_result") {
          const result = typeof p.content === "string" ? p.content : textOf(p.content);
          out.push({ at, kind: "result", text: `${p.is_error === true ? "Error: " : ""}${result}` });
        }
      }
    }
    if (e.type === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const p = obj(part);
        if (p.type === "text" && str(p.text).trim() !== "") out.push({ at, kind: "text", text: str(p.text) });
        if (p.type === "tool_use") out.push({ at, kind: "tool", text: `${str(p.name)}: ${mainArg(p.input)}` });
      }
    }
  }
  return out;
}

/** Codex's rollout file: one JSON entry a line, its item in `payload`. */
function codexEntries(lines: Json[]): Raw[] {
  const out: Raw[] = [];
  for (const e of lines) {
    const at = str(e.timestamp) || undefined;
    const p = obj(e.payload);
    if (e.type === "compacted" || (e.type === "event_msg" && p.type === "context_compacted")) {
      out.push({ at, kind: "compaction", text: "Context compacted" });
    } else if (e.type === "event_msg" && p.type === "user_message") {
      out.push({ at, kind: "prompt", text: str(p.message) });
    } else if (e.type === "event_msg" && p.type === "agent_message") {
      out.push({ at, kind: "text", text: str(p.message) });
    } else if (e.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
      out.push({ at, kind: "tool", text: `${str(p.name)}: ${mainArg(p.arguments ?? p.input)}` });
    } else if (
      e.type === "response_item" &&
      (p.type === "function_call_output" || p.type === "custom_tool_call_output")
    ) {
      const output = typeof p.output === "string" ? p.output : textOf(obj(p.output).content ?? p.output);
      out.push({ at, kind: "result", text: output });
    }
  }
  return out;
}

/** Gemini CLI's session file: one JSON document with its `messages`. */
function geminiEntries(messages: Json[]): Raw[] {
  const out: Raw[] = [];
  for (const m of messages) {
    const at = str(m.timestamp) || undefined;
    const content = typeof m.content === "string" ? m.content : textOf(m.content);
    if (m.type === "user") out.push({ at, kind: "prompt", text: content });
    if (m.type === "gemini") {
      if (content.trim() !== "") out.push({ at, kind: "text", text: content });
      for (const call of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        const c = obj(call);
        out.push({ at, kind: "tool", text: `${str(c.name)}: ${mainArg(c.args)}` });
        const result = c.resultDisplay ?? c.result;
        if (result !== undefined) {
          out.push({ at, kind: "result", text: typeof result === "string" ? result : JSON.stringify(result) });
        }
      }
    }
  }
  return out;
}

/** Every entry of a session file's text, condensed, in order. */
export function condense(cli: Cli, file: string): Raw[] {
  if (cli === "gemini") {
    try {
      const messages = obj(JSON.parse(file)).messages;
      return geminiEntries(Array.isArray(messages) ? messages.map(obj) : []);
    } catch {
      return [];
    }
  }
  const lines: Json[] = [];
  for (const line of file.split("\n")) {
    if (line.trim() === "") continue;
    try {
      lines.push(obj(JSON.parse(line)));
    } catch {
      // A line still being written.
    }
  }
  return cli === "codex" ? codexEntries(lines) : claudeEntries(lines);
}

const SPLIT_TAIL = new RegExp(`${MASK.replace(/\*/g, "\\*")}(?:(?:${ESCAPE_SEQUENCE})+[A-Za-z0-9_-]+)+`, "g");

/**
 * Redacted and cut to its kind's length; redacted first, as cutting a secret can hide it.
 * Redacted twice, around removing escape sequences: before, a colour code is the break
 * that shows where a key glued to a word starts (`OK\e[32mghp_...`); after, a key that
 * colour codes split (`sk-ant-\e[1m...`) is whole again.
 */
function shown(raw: Raw): { text: string; count: number } {
  const first = redactTranscript(raw.text);
  // A mask, then a colour code, then more of a token: the rest of a key both glued and
  // split (`OK\e[32mghp_abc\e[1mdef`). It goes with the mask.
  const joined = first.text.replace(SPLIT_TAIL, MASK);
  const second = redactTranscript(cleanTranscriptText(joined).trim());
  const max = MAX_CHARS[raw.kind];
  const text = second.text;
  return { text: text.length > max ? `${text.slice(0, max - 1)}…` : text, count: first.count + second.count };
}

/**
 * Where the page that ends at the newest entry begins (ADR 0024): as far back as
 * TRANSCRIPT_PAGE_BYTES of text reach, and at least the newest entry.
 */
export function latestPageStart(entries: readonly Raw[]): number {
  let bytes = 0;
  let n = entries.length;
  while (n > 0) {
    const size = Buffer.byteLength(shown(entries[n - 1] as Raw).text);
    if (n < entries.length && bytes + size > TRANSCRIPT_PAGE_BYTES) break;
    bytes += size;
    n--;
  }
  return n;
}

/** The page of `entries` from entry `from`, at most TRANSCRIPT_PAGE_BYTES of text. */
export function transcriptPage(entries: readonly Raw[], from: number): Omit<TranscriptResponse, "agent"> {
  const page: TranscriptEntry[] = [];
  let bytes = 0;
  let redacted = 0;
  let n = from;
  for (; n < entries.length; n++) {
    const raw = entries[n] as Raw;
    const { text, count } = shown(raw);
    const size = Buffer.byteLength(text);
    if (page.length > 0 && bytes + size > TRANSCRIPT_PAGE_BYTES) break;
    bytes += size;
    redacted += count;
    page.push({ n, ...(raw.at === undefined ? {} : { at: raw.at }), kind: raw.kind, text });
  }
  return { from, entries: page, ...(n < entries.length ? { next: n } : {}), redacted };
}

/**
 * Reads pages of one session's transcript, one read at a time. The condensed entries are
 * kept while the file's size and modification time stay the same, so paging through a
 * long session parses its file once, not once a page.
 */
export class TranscriptReader {
  private cached: { path: string; size: number; mtimeMs: number; entries: Raw[] } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cli: Cli) {}

  /**
   * A page of the session in `path` from entry `from`, or with `latest` the page that
   * ends at its newest entry, after every read asked before it.
   */
  page(path: string, from: number, latest = false): Promise<Omit<TranscriptResponse, "agent">> {
    const result = this.queue.then(async () => {
      const entries = await this.entries(path);
      return transcriptPage(entries, latest ? latestPageStart(entries) : from);
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private async entries(path: string): Promise<Raw[]> {
    const { size, mtimeMs } = await stat(path);
    const known = this.cached;
    if (known?.path === path && known.size === size && known.mtimeMs === mtimeMs) return known.entries;
    const entries = condense(this.cli, await readFile(path, "utf8"));
    this.cached = { path, size, mtimeMs, entries };
    return entries;
  }
}
