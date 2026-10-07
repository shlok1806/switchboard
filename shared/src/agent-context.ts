/** The latest reading of one Agent's own session (ADR 0012). */
export interface AgentContext {
  readAt: string;
  tokens?: number;
  window?: number;
  autoCompactions?: number;
  task?: string;
  brief?: string;
  activity?: string;
  model?: string;
  cwd?: string;
  branch?: string;
}

/** Optional telemetry must never prevent a Presence heartbeat. */
export function cleanContext(value: unknown): AgentContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.readAt !== "string" || !Number.isFinite(Date.parse(raw.readAt))) return undefined;
  const out: AgentContext = { readAt: new Date(raw.readAt).toISOString() };
  for (const key of ["tokens", "window", "autoCompactions"] as const) {
    const n = raw[key];
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 1e13 && (key !== "window" || n > 0))
      out[key] = n;
  }
  for (const [key, max] of [
    ["task", 160],
    ["brief", 65536],
    ["activity", 120],
    ["model", 160],
    ["cwd", 4096],
    ["branch", 256],
  ] as const) {
    if (typeof raw[key] === "string") out[key] = raw[key].slice(0, max);
  }
  return out;
}
