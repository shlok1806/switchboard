// What one Claude Code session has used itself (ADR 0011), from its own transcript:
// every model response there carries its request ID, its model and its token
// usage. A streamed response is written more than once, so each request counts
// once, as its last entry says. Subagents write their own transcripts next to the
// session's, and they count too. The transcript only grows, so each read takes the
// new lines alone.

import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionUsage } from "../../../shared/src/index";

/** US dollars per million tokens: input, output, cache read. A cache write is 1.25x input (5 min) or 2x (1 h). */
type Price = [input: number, output: number, cacheRead: number];

/**
 * API list prices, first match wins. Subscriptions are not billed per token: the
 * cost is an estimate for comparing Agents, never a bill.
 */
const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25]],
  [/(fable|mythos)-5/, [10, 50, 1]],
  [/opus-5-5/, [4, 20, 0.2]],
  [/opus-(5|4-[5-9])/, [5, 25, 0.5]],
  [/opus-4|opus/, [15, 75, 1.5]],
  [/sonnet-5/, [2, 10, 0.2]],
  [/sonnet/, [3, 15, 0.3]],
  [/haiku-4/, [1, 5, 0.1]],
  [/haiku/, [0.8, 4, 0.08]],
];

function priceOf(model: string): Price | undefined {
  return PRICES.find(([pattern]) => pattern.test(model))?.[1];
}

interface Request {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** One transcript line's model response, if it is one. */
function requestOf(line: string): { id: string; request: Request } | null {
  if (!line.includes('"usage"')) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = entry.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
  const usage = message?.usage;
  const model = message?.model;
  if (entry.type !== "assistant" || usage === undefined || typeof model !== "string" || model.startsWith("<")) {
    return null;
  }
  const id = typeof entry.requestId === "string" ? entry.requestId : message?.id;
  if (typeof id !== "string") return null;
  const written = tokens(usage.cache_creation_input_tokens);
  const split = usage.cache_creation as { ephemeral_1h_input_tokens?: unknown } | undefined;
  const write1h = Math.min(written, tokens(split?.ephemeral_1h_input_tokens));
  return {
    id,
    request: {
      model,
      input: tokens(usage.input_tokens),
      output: tokens(usage.output_tokens),
      cacheRead: tokens(usage.cache_read_input_tokens),
      write5m: written - write1h,
      write1h,
    },
  };
}

/** Follows one session's transcripts and adds up what it used. */
export class SessionTally {
  private readonly requests = new Map<string, Request>();
  private readonly offsets = new Map<string, number>();
  private readonly partial = new Map<string, string>();

  constructor(
    /** The session's own transcript, `<project dir>/<session id>.jsonl`. */
    private transcript: string,
  ) {}

  /** The transcript moved (a hook named its path): follow that one from now on. */
  follow(transcript: string): void {
    this.transcript = transcript;
  }

  /** Reads what the transcripts gained since the last read. A file that is not there yet counts nothing. */
  async read(): Promise<SessionUsage> {
    const subagents = join(this.transcript.replace(/\.jsonl$/, ""), "subagents");
    let files = [this.transcript];
    try {
      const names = await readdir(subagents);
      files = files.concat(names.filter((n) => n.endsWith(".jsonl")).map((n) => join(subagents, n)));
    } catch {
      // No subagents.
    }
    for (const file of files) await this.readFile(file);
    return this.total();
  }

  private async readFile(file: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(file, "r");
    } catch {
      return;
    }
    try {
      const from = this.offsets.get(file) ?? 0;
      const { size } = await handle.stat();
      if (size <= from) return;
      const buffer = Buffer.alloc(size - from);
      await handle.read(buffer, 0, buffer.length, from);
      this.offsets.set(file, size);
      const text = (this.partial.get(file) ?? "") + buffer.toString("utf8");
      const lines = text.split("\n");
      // The last line may still be being written: keep it for the next read.
      this.partial.set(file, lines.pop() ?? "");
      for (const line of lines) {
        const found = requestOf(line);
        if (found) this.requests.set(found.id, found.request);
      }
    } finally {
      await handle.close();
    }
  }

  private total(): SessionUsage {
    const sum: SessionUsage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let cost = 0;
    let priced = false;
    for (const r of this.requests.values()) {
      sum.requests += 1;
      sum.inputTokens += r.input;
      sum.outputTokens += r.output;
      sum.cacheReadTokens += r.cacheRead;
      sum.cacheWriteTokens += r.write5m + r.write1h;
      const price = priceOf(r.model);
      if (price === undefined) continue;
      priced = true;
      const [input, output, cacheRead] = price;
      cost +=
        (r.input * input + r.output * output + r.cacheRead * cacheRead + (r.write5m * 1.25 + r.write1h * 2) * input) /
        1e6;
    }
    return priced ? { ...sum, costUsd: Math.round(cost * 10_000) / 10_000 } : sum;
  }
}
