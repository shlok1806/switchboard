// A stand-in for a Langfuse project's public API, as far as Switchboard reads it
// (ADR 0044): the project its keys belong to, and the Metrics API v2 over the
// `observations` view. It keeps observations and answers a metrics query from them, as
// Langfuse does: filters, grouping by a dimension or by day or week, the aggregations
// asked for, named `<aggregation>_<measure>`. A test says what is in Langfuse and reads
// what the costs tool made of it. Every request reaches it through a spied `fetch`.

import { vi } from "vitest";

export const LANGFUSE_HOST = "https://langfuse.test";
export const PUBLIC_KEY = "pk-lf-1111-2222-3333-abcd";
export const SECRET_KEY = "sk-lf-9999-8888-7777-wxyz";
export const PROJECT = { id: "cm-greenroom", name: "greenroom" };

export interface FakeObservation {
  type: "GENERATION" | "SPAN" | "EVENT";
  traceName: string;
  model?: string;
  environment?: string;
  level?: "DEFAULT" | "DEBUG" | "WARNING" | "ERROR";
  /** ISO time. */
  startTime: string;
  latencyMs: number;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** A trace's root observation. */
  root?: boolean;
}

type Filter = { column: string; operator: string; value: unknown; type: string };
interface MetricsQuery {
  view: string;
  dimensions?: { field: string }[];
  metrics: { measure: string; aggregation: string }[];
  filters?: Filter[];
  timeDimension?: { granularity: string } | null;
  fromTimestamp: string;
  toTimestamp: string;
  config?: { row_limit?: number };
}

function field(o: FakeObservation, name: string): unknown {
  switch (name) {
    case "environment":
      return o.environment ?? "default";
    case "type":
      return o.type;
    case "level":
      return o.level ?? "DEFAULT";
    case "traceName":
      return o.traceName;
    case "providedModelName":
      return o.model ?? null;
    case "isRootObservation":
      return o.root === true;
    default:
      throw new Error(`The fake has no field ${name}`);
  }
}

function measure(o: FakeObservation, name: string): number {
  switch (name) {
    case "count":
      return 1;
    case "latency":
      return o.latencyMs;
    case "totalCost":
      return o.cost ?? 0;
    case "inputTokens":
      return o.inputTokens ?? 0;
    case "outputTokens":
      return o.outputTokens ?? 0;
    case "totalTokens":
      return (o.inputTokens ?? 0) + (o.outputTokens ?? 0);
    default:
      throw new Error(`The fake has no measure ${name}`);
  }
}

/** A percentile by nearest rank. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function aggregate(values: number[], aggregation: string): number {
  if (aggregation === "sum") return values.reduce((a, b) => a + b, 0);
  if (aggregation === "count") return values.length;
  const p = /^p(\d\d)$/.exec(aggregation);
  if (p?.[1] !== undefined) return percentile(values, Number(p[1]));
  throw new Error(`The fake has no aggregation ${aggregation}`);
}

function bucket(iso: string, granularity: string): string {
  const day = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (granularity === "week") day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  // Langfuse's ClickHouse answers with a space and no zone.
  return `${day.toISOString().slice(0, 10)} 00:00:00`;
}

export class FakeLangfuse {
  readonly observations: FakeObservation[] = [];
  /** Every request, as `METHOD path`. */
  readonly requests: string[] = [];
  /** Every metrics query, parsed. */
  readonly queries: MetricsQuery[] = [];
  /** Every Authorization header sent. */
  readonly authorizations: string[] = [];
  /** The project's key pairs, public to secret. */
  readonly keys = new Map([[PUBLIC_KEY, SECRET_KEY]]);
  /** What a test makes Langfuse answer instead, for one request. */
  fault: ((url: URL) => Response | null) | null = null;

  /** Answers every request to LANGFUSE_HOST from now on; every other `fetch` goes where it was going. */
  listen(): void {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== LANGFUSE_HOST) return real(input, init);
      return this.answer(request, url);
    });
  }

  private answer(request: Request, url: URL): Response {
    this.requests.push(`${request.method} ${url.pathname}`);
    this.authorizations.push(request.headers.get("Authorization") ?? "");
    const fault = this.fault?.(url) ?? null;
    if (fault !== null) return fault;
    const sent = request.headers.get("Authorization") ?? "";
    if (![...this.keys].some(([pk, sk]) => sent === `Basic ${btoa(`${pk}:${sk}`)}`)) {
      return Response.json({ message: "Invalid credentials" }, { status: 401 });
    }
    if (request.method !== "GET") return Response.json({ message: "Method not allowed" }, { status: 405 });
    if (url.pathname === "/api/public/projects") {
      return Response.json({ data: [{ ...PROJECT, organization: { id: "org", name: "org" }, metadata: {} }] });
    }
    if (url.pathname === "/api/public/v2/metrics") return Response.json({ data: this.metrics(url) });
    return Response.json({ message: "Not found" }, { status: 404 });
  }

  private metrics(url: URL): Record<string, unknown>[] {
    const query = JSON.parse(url.searchParams.get("query") ?? "") as MetricsQuery;
    this.queries.push(query);
    if (query.view !== "observations") throw new Error(`The fake has no view ${query.view}`);
    const from = Date.parse(query.fromTimestamp);
    const to = Date.parse(query.toTimestamp);
    const matching = this.observations.filter((o) => {
      const at = Date.parse(o.startTime);
      if (at < from || at > to) return false;
      return (query.filters ?? []).every((f) => {
        if (f.operator !== "=") throw new Error(`The fake has no operator ${f.operator}`);
        return field(o, f.column) === f.value;
      });
    });
    const dims = (query.dimensions ?? []).map((d) => d.field);
    const granularity = query.timeDimension?.granularity;
    const groups = new Map<string, { key: Record<string, unknown>; rows: FakeObservation[] }>();
    for (const o of matching) {
      const key: Record<string, unknown> = {};
      for (const d of dims) key[d] = field(o, d);
      if (granularity !== undefined) key.time_dimension = bucket(o.startTime, granularity);
      const id = JSON.stringify(key);
      const group = groups.get(id) ?? { key, rows: [] };
      group.rows.push(o);
      groups.set(id, group);
    }
    return [...groups.values()].slice(0, query.config?.row_limit ?? 100).map(({ key, rows }) => {
      const row: Record<string, unknown> = { ...key };
      for (const m of query.metrics) {
        // Langfuse sends some numbers as strings.
        const value = aggregate(
          rows.map((o) => measure(o, m.measure)),
          m.aggregation,
        );
        row[`${m.aggregation}_${m.measure}`] = m.aggregation === "count" ? String(value) : value;
      }
      return row;
    });
  }
}
