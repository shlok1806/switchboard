// The Connector's `costs` tool (ADR 0044): what running the repo's product costs, read
// live from the repo's own Langfuse project through its Metrics API v2. Nothing is
// copied into the Channel: a question reads the Channel's one Langfuse row besides the
// rows that admit the call, writes none, and makes three GETs to Langfuse.
//
// The three queries, all over the `observations` view in one environment and period:
//   1. generations (type GENERATION): cost, input, output and total tokens, the number
//      of calls, and their latency's p50 and p95, by the grouping asked for;
//   2. errors: the observations at level ERROR, counted by the same grouping;
//   3. traces: the root observations, counted, with their latency's p50 and p95, by
//      trace name or time (one total when grouped by model, which a trace has none of).

import type { LangfuseConnection } from "../../../shared/src/index";
import { oneLine } from "../../../shared/src/index";
import { type LangfuseKeys, langfuseGet, langfuseRefusal, unreachable } from "../langfuse";
import type { McpTool, ToolContext, ToolResult } from "./tools";

const DAY_MS = 86_400_000;
const DEFAULT_PERIOD_DAYS = 30;
/** The longest period asked for, and the longest one grouped by day. */
const MAX_PERIOD_DAYS = 366;
const MAX_DAILY_DAYS = 92;
/** Rows asked of Langfuse per query, and lines an answer lists. */
const ROW_LIMIT = 100;
const LISTED = 30;
const ENVIRONMENT = /^[A-Za-z0-9_.-]{1,40}$/;
const DEFAULT_ENVIRONMENT = "production";

export const METRICS_PATH = "/api/public/v2/metrics";

type By = "model" | "trace" | "day" | "week";
const BYS: readonly By[] = ["model", "trace", "day", "week"];

/** What the costs tool gets of the Channel's Langfuse project, read only when the tool runs. */
export interface CostsSource {
  connection: LangfuseConnection;
  /** Null when the sealed secret key no longer opens: SESSION_SECRET changed since it was connected. */
  keys: LangfuseKeys | null;
}

interface Period {
  from: Date;
  to: Date;
  label: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m, d));

/**
 * `period` as a UTC range: a span back from now (`24h`, `7d`, `4w`), a calendar name
 * (`today`, `yesterday`, `this week`, `last week`, `this month`, `last month`), a month
 * (`2026-10`), a day (`2026-10-14`) or two days (`2026-10-01..2026-10-14`, both included).
 */
export function parsePeriod(raw: unknown, now: number): Period | { error: string } {
  const at = new Date(now);
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const today = utc(y, m, at.getUTCDate());
  const weekStart = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY_MS);
  if (raw === undefined || raw === null || raw === "") {
    return {
      from: new Date(now - DEFAULT_PERIOD_DAYS * DAY_MS),
      to: at,
      label: `the last ${DEFAULT_PERIOD_DAYS} days`,
    };
  }
  const usage =
    '"period" is a span such as "7d" or "24h", "today", "yesterday", "this week", "last week", "this month", ' +
    '"last month", a month such as "2026-10", a day such as "2026-10-14", or "2026-10-01..2026-10-14"';
  if (typeof raw !== "string") return { error: `${usage}.` };
  const text = raw.trim().toLowerCase();
  // "last-month" and "this_week" are the calendar's names too.
  const words = text.replace(/[\s_-]+/g, " ");
  let period: Period | null = null;
  const span = /^(\d{1,4})\s*([hdw])$/.exec(text);
  if (span?.[1] !== undefined && span[2] !== undefined) {
    const amount = Number(span[1]);
    const unit = { h: ["hour", 3_600_000], d: ["day", DAY_MS], w: ["week", 7 * DAY_MS] }[span[2]] as [string, number];
    period = {
      from: new Date(now - amount * unit[1]),
      to: at,
      label: `the last ${amount} ${unit[0]}${amount === 1 ? "" : "s"}`,
    };
  } else if (words === "today") {
    period = { from: today, to: at, label: `today (${day(today)})` };
  } else if (words === "yesterday") {
    const from = new Date(today.getTime() - DAY_MS);
    period = { from, to: today, label: `yesterday (${day(from)})` };
  } else if (words === "this week") {
    period = { from: weekStart, to: at, label: `this week (from Monday ${day(weekStart)})` };
  } else if (words === "last week") {
    const from = new Date(weekStart.getTime() - 7 * DAY_MS);
    period = {
      from,
      to: weekStart,
      label: `last week (${day(from)} to ${day(new Date(weekStart.getTime() - DAY_MS))})`,
    };
  } else if (words === "this month") {
    const from = utc(y, m);
    period = { from, to: at, label: `this month (${day(from).slice(0, 7)})` };
  } else if (words === "last month") {
    const from = utc(y, m - 1);
    period = { from, to: utc(y, m), label: `last month (${day(from).slice(0, 7)})` };
  } else if (/^\d{4}-\d{2}$/.test(text)) {
    const [yy, mm] = text.split("-").map(Number) as [number, number];
    if (mm >= 1 && mm <= 12) period = { from: utc(yy, mm - 1), to: utc(yy, mm), label: text };
  } else {
    const days = /^(\d{4}-\d{2}-\d{2})(?:\s*\.\.\s*(\d{4}-\d{2}-\d{2}))?$/.exec(text);
    const first = days?.[1] === undefined ? Number.NaN : Date.parse(`${days[1]}T00:00:00Z`);
    const last = days?.[2] === undefined ? first : Date.parse(`${days[2]}T00:00:00Z`);
    if (!Number.isNaN(first) && !Number.isNaN(last) && last >= first) {
      const from = new Date(first);
      const lastDay = new Date(last);
      period = {
        from,
        to: new Date(last + DAY_MS),
        label: first === last ? day(from) : `${day(from)} to ${day(lastDay)}`,
      };
    }
  }
  if (period === null) return { error: `${usage}, not ${oneLine(raw, 60)}.` };
  if (period.to.getTime() > now) period.to = at;
  if (period.from.getTime() >= period.to.getTime()) return { error: `${period.label} has not started yet.` };
  if (period.to.getTime() - period.from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    return { error: `A period is at most ${MAX_PERIOD_DAYS} days. Ask for a shorter one.` };
  }
  return period;
}

type MetricRow = Record<string, unknown>;

interface Query {
  view: "observations";
  dimensions: { field: string }[];
  metrics: { measure: string; aggregation: string }[];
  filters: { column: string; operator: string; value: unknown; type: string }[];
  timeDimension?: { granularity: "day" | "week" };
  fromTimestamp: string;
  toTimestamp: string;
  orderBy?: { field: string; direction: "asc" | "desc" }[];
  config: { row_limit: number };
}

const DIMENSION: Record<"model" | "trace", string> = { model: "providedModelName", trace: "traceName" };

function query(
  by: By,
  period: Period,
  environment: string,
  filters: Query["filters"],
  metrics: Query["metrics"],
  grouped: boolean,
): Query {
  const time = by === "day" || by === "week";
  const orderBy = metrics.find((m) => m.measure === "totalCost")
    ? "sum_totalCost"
    : `${metrics[0]?.aggregation}_${metrics[0]?.measure}`;
  return {
    view: "observations",
    dimensions: grouped && !time ? [{ field: DIMENSION[by as "model" | "trace"] }] : [],
    metrics,
    filters: [{ column: "environment", operator: "=", value: environment, type: "string" }, ...filters],
    ...(grouped && time ? { timeDimension: { granularity: by } } : {}),
    fromTimestamp: period.from.toISOString(),
    // A period ends just before its end, so the first moment of the next is not in both.
    toTimestamp: new Date(period.to.getTime() - 1).toISOString(),
    ...(grouped ? { orderBy: [{ field: time ? "time_dimension" : orderBy, direction: time ? "asc" : "desc" }] } : {}),
    config: { row_limit: ROW_LIMIT },
  };
}

/** A question Langfuse could not answer, in words. */
class Unanswered extends Error {}

async function metrics(keys: LangfuseKeys, q: Query): Promise<MetricRow[]> {
  let response: Response;
  try {
    response = await langfuseGet(keys, METRICS_PATH, { query: JSON.stringify(q) });
  } catch (error) {
    throw new Unanswered(unreachable(keys, error));
  }
  if (response.status === 404) {
    throw new Unanswered(
      `Langfuse at ${keys.host} has no Metrics API v2 (${METRICS_PATH}). It needs Langfuse Cloud or a self-hosted Langfuse v4 or later.`,
    );
  }
  if (!response.ok) throw new Unanswered(await langfuseRefusal(response, keys));
  let body: { data?: unknown };
  try {
    body = await response.json();
  } catch {
    throw new Unanswered(`Langfuse at ${keys.host} answered with something that is not JSON.`);
  }
  if (!Array.isArray(body.data)) throw new Unanswered(`Langfuse at ${keys.host} answered without data.`);
  return body.data.filter((row): row is MetricRow => typeof row === "object" && row !== null);
}

/** A metric's value: Langfuse may send numbers as strings, and null for none. */
function num(row: MetricRow | undefined, field: string): number {
  const value = Number(row?.[field] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function nullable(row: MetricRow | undefined, field: string): number | null {
  const raw = row?.[field];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** The group a row is in: its model, trace name or day. */
function groupOf(row: MetricRow, by: By): string {
  if (by === "day" || by === "week") {
    const raw = String(row.time_dimension ?? "");
    const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
    return Number.isNaN(parsed) ? raw.slice(0, 10) : day(new Date(parsed));
  }
  const name = row[DIMENSION[by]];
  return typeof name === "string" && name !== "" ? oneLine(name, 120) : "";
}

function usd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function count(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function tokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  return count(value);
}

function ms(value: number | null): string {
  if (value === null) return "n/a";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 120_000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

const GENERATION_METRICS = [
  { measure: "totalCost", aggregation: "sum" },
  { measure: "inputTokens", aggregation: "sum" },
  { measure: "outputTokens", aggregation: "sum" },
  { measure: "totalTokens", aggregation: "sum" },
  { measure: "count", aggregation: "count" },
  { measure: "latency", aggregation: "p50" },
  { measure: "latency", aggregation: "p95" },
];

interface Group {
  cost: number;
  input: number;
  output: number;
  tokens: number;
  calls: number;
  p50: number | null;
  p95: number | null;
  errors: number;
  traces: number;
  traceP50: number | null;
  traceP95: number | null;
}

const empty = (): Group => ({
  cost: 0,
  input: 0,
  output: 0,
  tokens: 0,
  calls: 0,
  p50: null,
  p95: null,
  errors: 0,
  traces: 0,
  traceP50: null,
  traceP95: null,
});

function label(name: string, by: By): string {
  if (by === "week") return `week of ${name}`;
  if (name !== "") return name;
  return by === "model" ? "(no model)" : "(no trace name)";
}

function line(name: string, g: Group, by: By, totalCost: number): string {
  const parts: string[] = [];
  if (by === "trace") {
    parts.push(plural(g.traces, "trace"));
    if (g.traces > 0) parts.push(`trace latency p50 ${ms(g.traceP50)}, p95 ${ms(g.traceP95)}`);
  }
  const share = totalCost > 0 && by !== "day" && by !== "week" ? ` (${Math.round((g.cost / totalCost) * 100)}%)` : "";
  parts.push(`${usd(g.cost)}${share}`);
  parts.push(plural(g.calls, "generation call"));
  parts.push(`${tokens(g.tokens)} tokens (${tokens(g.input)} in, ${tokens(g.output)} out)`);
  if (g.calls > 0) parts.push(`generation latency p50 ${ms(g.p50)}, p95 ${ms(g.p95)}`);
  if (by === "day" || by === "week") parts.push(plural(g.traces, "trace"));
  parts.push(plural(g.errors, "error"));
  return `- ${label(name, by)}: ${parts.join(", ")}`;
}

export async function costsAnswer(
  source: CostsSource,
  args: { period: Period; periodLabel: string; by: By; environment: string },
): Promise<ToolResult> {
  const { connection: project } = source;
  if (source.keys === null) {
    return {
      text:
        `The Channel's Langfuse key can no longer be read: the Worker's SESSION_SECRET changed since it was connected. ` +
        "The Channel's owner connects the project again on the Dashboard's Settings page.",
      isError: true,
    };
  }
  const keys = source.keys;
  const { period, by, environment } = args;
  const generations = query(
    by,
    period,
    environment,
    [{ column: "type", operator: "=", value: "GENERATION", type: "string" }],
    GENERATION_METRICS,
    true,
  );
  const errors = query(
    by,
    period,
    environment,
    [{ column: "level", operator: "=", value: "ERROR", type: "string" }],
    [{ measure: "count", aggregation: "count" }],
    true,
  );
  const traces = query(
    by,
    period,
    environment,
    [{ column: "isRootObservation", operator: "=", value: true, type: "boolean" }],
    [
      { measure: "count", aggregation: "count" },
      { measure: "latency", aggregation: "p50" },
      { measure: "latency", aggregation: "p95" },
    ],
    by !== "model",
  );
  let rows: [MetricRow[], MetricRow[], MetricRow[]];
  try {
    rows = await Promise.all([metrics(keys, generations), metrics(keys, errors), metrics(keys, traces)]);
  } catch (error) {
    if (error instanceof Unanswered) return { text: error.message, isError: true };
    throw error;
  }
  const [generationRows, errorRows, traceRows] = rows;

  const groups = new Map<string, Group>();
  const group = (name: string) => {
    let g = groups.get(name);
    if (g === undefined) {
      g = empty();
      groups.set(name, g);
    }
    return g;
  };
  for (const row of generationRows) {
    const g = group(groupOf(row, by));
    g.cost += num(row, "sum_totalCost");
    g.input += num(row, "sum_inputTokens");
    g.output += num(row, "sum_outputTokens");
    g.tokens += num(row, "sum_totalTokens");
    g.calls += num(row, "count_count");
    g.p50 = nullable(row, "p50_latency");
    g.p95 = nullable(row, "p95_latency");
  }
  for (const row of errorRows) group(groupOf(row, by)).errors += num(row, "count_count");
  let totalTraces = 0;
  for (const row of traceRows) {
    const n = num(row, "count_count");
    totalTraces += n;
    if (by === "model") continue;
    const g = group(groupOf(row, by));
    g.traces += n;
    g.traceP50 = nullable(row, "p50_latency");
    g.traceP95 = nullable(row, "p95_latency");
  }

  const all = [...groups.entries()];
  const total = all.reduce((t, [, g]) => {
    t.cost += g.cost;
    t.input += g.input;
    t.output += g.output;
    t.tokens += g.tokens;
    t.calls += g.calls;
    t.errors += g.errors;
    return t;
  }, empty());
  if (by === "day" || by === "week") all.sort(([a], [b]) => (a < b ? -1 : 1));
  else all.sort(([, a], [, b]) => b.cost - a.cost || b.traces - a.traces || b.calls - a.calls);

  const projectLink = `${project.host}/project/${encodeURIComponent(project.project.id)}`;
  const heading = {
    model: "By model",
    trace: "By trace name",
    day: "By day (UTC)",
    week: "By week (UTC, from Monday)",
  }[by];
  const lines = [
    `# What it cost: ${environment}, ${args.periodLabel}`,
    "",
    `Read live from the Langfuse project "${project.project.name}" (${projectLink}), environment "${environment}", ` +
      `${period.from.toISOString().slice(0, 16).replace("T", " ")} to ${period.to.toISOString().slice(0, 16).replace("T", " ")} UTC. ` +
      "Cost is in US dollars as Langfuse computes it from its model prices. Langfuse's own UI shows times in the viewer's time zone, so its day edges can differ from these.",
    "",
  ];
  if (all.length === 0 && totalTraces === 0) {
    lines.push(
      `Langfuse has nothing in environment "${environment}" for this period. ` +
        'Another environment (such as "bench") or a longer period may have.',
    );
  } else {
    lines.push(
      `Total: ${usd(total.cost)}, ${plural(total.calls, "generation call")}, ${tokens(total.tokens)} tokens ` +
        `(${tokens(total.input)} in, ${tokens(total.output)} out), ${plural(totalTraces, "trace")}, ${plural(total.errors, "error")}.`,
    );
    if (generationRows.length >= ROW_LIMIT || errorRows.length >= ROW_LIMIT || traceRows.length >= ROW_LIMIT) {
      lines.push(`Langfuse returned its ${ROW_LIMIT} largest groups; the totals cover those.`);
    }
    lines.push("", `## ${heading} (${all.length})`);
    const shown = by === "day" || by === "week" ? all.slice(-LISTED) : all.slice(0, LISTED);
    for (const [name, g] of shown) lines.push(line(name, g, by, total.cost));
    if (all.length > shown.length) {
      lines.push(`- and ${all.length - shown.length} more${by === "day" || by === "week" ? ", earlier" : ", smaller"}`);
    }
  }
  lines.push(
    "",
    `Latency is per generation call (and per trace, by trace name), p50 and p95. Errors are observations at level ERROR. ` +
      `Traces: ${projectLink}/traces. Sessions: ${projectLink}/sessions.`,
  );
  return { text: lines.join("\n") };
}

export const costsTool: McpTool = {
  name: "costs",
  title: "Read what the product costs, from Langfuse",
  description:
    "What running this repo's product costs and how that is trending, read live from the repo's own Langfuse " +
    "project: cost (USD), tokens in and out, generation calls, traces, errors and latency (p50, p95), grouped by " +
    'model, by trace name, by day or by week. `period` is a span ("7d", "24h"), "today", "yesterday", ' +
    '"this week", "last week", "this month", "last month", a month ("2026-10"), a day ("2026-10-14") or a range ' +
    '("2026-10-01..2026-10-14"), in UTC; 30 days by default. `environment` is the Langfuse environment, ' +
    '"production" by default (Greenroom sends bench runs as "bench"). Read-only.',
  inputSchema: {
    type: "object",
    properties: {
      period: { type: "string", description: 'The time to cover, in UTC. Default "30d".' },
      by: {
        type: "string",
        enum: [...BYS],
        description: 'Group by "model" (default), "trace" (trace name), "day" or "week".',
      },
      environment: { type: "string", description: 'The Langfuse environment. Default "production".' },
    },
    additionalProperties: false,
  },
  async run(context: ToolContext, args) {
    const period = parsePeriod(args.period, context.now);
    if ("error" in period) return { text: period.error, isError: true };
    const by = args.by ?? "model";
    if (typeof by !== "string" || !(BYS as readonly string[]).includes(by)) {
      return { text: '"by" is one of "model", "trace", "day" or "week".', isError: true };
    }
    if (by === "day" && period.to.getTime() - period.from.getTime() > MAX_DAILY_DAYS * DAY_MS) {
      return { text: `By day covers at most ${MAX_DAILY_DAYS} days. Ask by week for a longer period.`, isError: true };
    }
    const environment = args.environment ?? DEFAULT_ENVIRONMENT;
    if (typeof environment !== "string" || !ENVIRONMENT.test(environment)) {
      return { text: '"environment" is a Langfuse environment name such as "production" or "bench".', isError: true };
    }
    const source = await context.langfuse();
    if (source === null) {
      return {
        text:
          `No Langfuse project is connected to the Channel of ${context.repo}, so there are no costs to read. ` +
          `The Channel's owner (an admin of the repo) connects one on the Dashboard's Settings page: ` +
          `${context.origin}/${context.repo}#/settings`,
      };
    }
    return costsAnswer(source, { period, periodLabel: period.label, by: by as By, environment });
  },
};
