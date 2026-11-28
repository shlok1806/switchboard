// `since`, as the connector's tools take it (ADR 0040, ADR 0041).

/** How far back `since` reaches when it is left out. */
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * `since` as a time and a label: a span (`90m`, `24h`, `7d`, `2w`) or an ISO 8601 time.
 * Left out, it is `fallback` (24 hours unless a tool says otherwise).
 */
export function parseSince(
  raw: unknown,
  now: number,
  fallback: { ms: number; label: string } = { ms: DEFAULT_SINCE_MS, label: "the last 24 hours" },
): { at: string; label: string } | { error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { at: new Date(now - fallback.ms).toISOString(), label: fallback.label };
  }
  if (typeof raw !== "string") return { error: '"since" must be a string such as "24h", "7d" or an ISO 8601 time.' };
  const span = /^\s*(\d{1,5})\s*([mhdw])\s*$/i.exec(raw);
  if (span?.[1] !== undefined && span[2] !== undefined) {
    const amount = Number(span[1]);
    const unit = span[2].toLowerCase();
    const names: Record<string, string> = { m: "minute", h: "hour", d: "day", w: "week" };
    return {
      at: new Date(now - amount * (UNITS[unit] ?? 0)).toISOString(),
      label: `the last ${amount} ${names[unit]}${amount === 1 ? "" : "s"}`,
    };
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at))
    return { error: `"since" must be a span such as "24h" or "7d", or an ISO 8601 time, not ${raw}.` };
  return { at: new Date(Math.min(at, now)).toISOString(), label: "the time asked for" };
}
