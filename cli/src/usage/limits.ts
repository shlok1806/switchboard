// Reads an account's limits the way Claude Code itself reports them (ADR 0011):
// `claude -p "/usage"` prints lines such as
//
//   Current session: 80% used · resets Oct 7 at 1:59am (America/Chicago)
//   Current week (all models): 44% used · resets Oct 7 at 5:59am (America/Chicago)
//   Current week (Fable): 32% used · resets Oct 7 at 5:59am (America/Chicago)
//
// and costs no model call. `claude auth status` names the login. Either may be
// missing a line, or say nothing useful (an API key has no limits): what is there is
// kept, and nothing here ever throws.

import { execFile } from "node:child_process";
import type { LimitsReading, ModelLimit, UsageLimit } from "../../../shared/src/index";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** `Current session: 80% used · resets ...`, with any wording around the parts that matter. */
const LIMIT_LINE =
  /^current\s+(session|week)\b\s*(?:\(([^)]*)\))?[^%\d]*?(\d+(?:\.\d+)?)\s*%\s*used\b(?:.*?\bresets?\b\s*(.*?))?\s*$/i;

/** The wall-clock parts of `at` in time zone `tz`. */
function wallClock(at: number, tz: string | undefined): { year: number; month: number; day: number; ms: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const year = get("year");
  const month = get("month") - 1;
  const day = get("day");
  return { year, month, day, ms: Date.UTC(year, month, day, get("hour"), get("minute"), get("second")) };
}

/** The instant a wall-clock time (as a UTC timestamp of its parts) is in time zone `tz`. */
function fromWallClock(wall: number, tz: string | undefined): number {
  const offset = (at: number) => wallClock(at, tz).ms - Math.floor(at / 1000) * 1000;
  const guess = wall - offset(wall);
  return wall - offset(guess);
}

function validZone(tz: string | undefined): string | undefined {
  if (tz === undefined) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/**
 * When a window resets, from what `/usage` wrote after "resets": "Oct 7 at 1:59am
 * (America/Chicago)", "Oct 7 at 2am (...)", "1:59am (...)", "Oct 13, 2026", or "in
 * 3h 20m". Without a year it is the next such date; without a date, the next such
 * time. Undefined when it reads as none of these.
 */
export function parseReset(raw: string, now: number): string | undefined {
  const said = raw.trim().replace(/[.,;]+$/, "");
  const relative = /^in\s+(?:(\d+)\s*d\w*\s*)?(?:(\d+)\s*h\w*\s*)?(?:(\d+)\s*m\w*)?$/i.exec(said);
  if (relative && (relative[1] || relative[2] || relative[3])) {
    const [d = 0, h = 0, m = 0] = [relative[1], relative[2], relative[3]].map((n) => Number(n ?? 0));
    return new Date(now + ((d * 24 + h) * 60 + m) * 60_000).toISOString();
  }
  const match =
    /^(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:,?\s*(?:at)?\s*)?)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\s*(?:\(([^)]+)\))?$/i.exec(
      said,
    );
  if (!match) return undefined;
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem, zone] = match;
  const month = monthName === undefined ? -1 : MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
  if (monthName !== undefined && month === -1) return undefined;
  if (monthName === undefined && hourText === undefined) return undefined;
  if (hourText !== undefined && meridiem === undefined && minuteText === undefined) return undefined;
  const tz = validZone(zone?.trim());
  let hour = Number(hourText ?? 0);
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  const minute = Number(minuteText ?? 0);
  if (hour > 23 || minute > 59) return undefined;
  const today = wallClock(now, tz);
  const at = (year: number, m: number, day: number) => fromWallClock(Date.UTC(year, m, day, hour, minute), tz);

  if (monthName === undefined) {
    // A time only: today's, or tomorrow's once today's has passed.
    const todays = at(today.year, today.month, today.day);
    return new Date(todays >= now - 60_000 ? todays : at(today.year, today.month, today.day + 1)).toISOString();
  }
  const day = Number(dayText);
  if (day < 1 || day > 31) return undefined;
  if (yearText !== undefined) return new Date(at(Number(yearText), month, day)).toISOString();
  // No year: this year's, or next year's once this year's is well past.
  const thisYear = at(today.year, month, day);
  return new Date(thisYear >= now - 2 * 86_400_000 ? thisYear : at(today.year + 1, month, day)).toISOString();
}

/** The limits in what `claude -p "/usage"` printed. Every line is optional. */
export function parseUsage(output: string, now: number): LimitsReading {
  const reading: LimitsReading = { readAt: new Date(now).toISOString(), models: [] };
  for (const rawLine of output.split(/\r?\n/)) {
    // Box drawing, bullets and colour codes around the line are not part of it.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes are what it removes.
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, "").replace(/^[^A-Za-z]+/, "");
    const match = LIMIT_LINE.exec(line);
    if (!match) continue;
    const [, kind, paren, percentText, resetsText] = match;
    const resets = resetsText?.trim() || undefined;
    const resetsAt = resets === undefined ? undefined : parseReset(resets, now);
    const limit: UsageLimit = {
      percent: Number(percentText),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(resets === undefined ? {} : { resets }),
    };
    const model = paren?.trim();
    if (kind?.toLowerCase() === "session") reading.session ??= limit;
    else if (model === undefined || model === "" || /^all\b/i.test(model)) reading.week ??= limit;
    else if (!reading.models.some((m) => m.model === model)) reading.models.push({ model, ...limit } as ModelLimit);
  }
  return reading;
}

/** Whether a reading found any limit at all. */
export function hasLimits(reading: LimitsReading): boolean {
  return reading.session !== undefined || reading.week !== undefined || reading.models.length > 0;
}

/** The login `claude auth status` reports: its email address and plan. Null when it is not logged in. */
export function parseAuthStatus(output: string): { email?: string; plan?: string } | null {
  let status: unknown;
  try {
    status = JSON.parse(output);
  } catch {
    return null;
  }
  if (status === null || typeof status !== "object") return null;
  const { loggedIn, email, subscriptionType } = status as Record<string, unknown>;
  if (loggedIn === false) return null;
  return {
    ...(typeof email === "string" && email.includes("@") ? { email: email.trim() } : {}),
    ...(typeof subscriptionType === "string" && subscriptionType.trim() !== ""
      ? { plan: subscriptionType.trim() }
      : {}),
  };
}

/** How long one `claude` call may take before it is given up on. */
const CALL_TIMEOUT_MS = 45_000;

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { env, cwd, timeout: CALL_TIMEOUT_MS, maxBuffer: 1 << 20 }, (error, stdout) => {
      // `auth status` exits 1 when logged out, and still prints its JSON.
      if (error && stdout === "") reject(error);
      else resolve(stdout);
    });
    // Nothing to read: `claude -p` otherwise waits for its input before it answers.
    child.stdin?.end();
  });
}

/** What one reading of the account found. Each part is absent when it could not be read. */
export interface AccountReading {
  email?: string;
  plan?: string;
  limits?: LimitsReading;
}

/**
 * Reads the account Claude Code runs under and its limits, with the environment of
 * the wrapped session, so the same `CLAUDE_CONFIG_DIR` and login. The `/usage` call
 * loads no settings, hooks or MCP servers and keeps no session.
 */
export async function readAccount(
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  now: () => number = Date.now,
): Promise<AccountReading> {
  const [usage, auth] = await Promise.allSettled([
    run(bin, ["-p", "/usage", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config"], env, cwd),
    run(bin, ["auth", "status"], env, cwd),
  ]);
  const login = auth.status === "fulfilled" ? parseAuthStatus(auth.value) : null;
  const limits = usage.status === "fulfilled" ? parseUsage(usage.value, now()) : null;
  return {
    ...(login?.email === undefined ? {} : { email: login.email }),
    ...(login?.plan === undefined ? {} : { plan: login.plan }),
    ...(limits !== null && hasLimits(limits) ? { limits } : {}),
  };
}
