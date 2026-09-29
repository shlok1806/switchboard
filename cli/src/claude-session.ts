// Works out which Claude Code session a `switchboard run claude` launch will be,
// so its Agent ID is known, and rewrites the arguments when that needs help:
//
// - A new session: we pick the session ID and pass `--session-id <uuid>`.
// - `--session-id <uuid>`: the Person picked it.
// - `--resume <uuid>`: that session, resumed. Same session, same Agent ID.
// - `--resume`/`--continue` with `--fork-session`: a new session; we pass `--session-id`.
// - `--continue`: the most recent session in this directory. We look it up and pass
//   `--resume <uuid>` instead, which Claude Code treats the same way.
// - `--resume` with no ID (or a search term) opens Claude Code's picker. The session is
//   only known once the Person picks one, so we watch Claude Code's session files for it.

import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Flags that print something and exit without starting a session. */
const NO_SESSION_FLAGS = new Set(["-h", "--help", "-v", "--version"]);

export type SessionPlan =
  /** The session ID is known before launch. */
  | { kind: "known"; args: string[]; sessionId: string; resumed: boolean }
  /** Claude Code's picker chooses the session; find it once it is picked. */
  | { kind: "picker"; args: string[] }
  /** Not a session at all (`--help`, `--version`): run Claude Code as is. */
  | { kind: "none"; args: string[] };

/** Splits `--flag=value` and finds a flag's value, if any. */
function readFlag(args: string[], names: string[]): { index: number; value: string | undefined } | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") return null;
    for (const name of names) {
      if (arg === name) {
        const next = args[i + 1];
        return { index: i, value: next !== undefined && !next.startsWith("-") ? next : undefined };
      }
      if (arg.startsWith(`${name}=`)) return { index: i, value: arg.slice(name.length + 1) };
    }
  }
  return null;
}

function hasFlag(args: string[], names: string[]): boolean {
  return readFlag(args, names) !== null;
}

/** Removes a flag and, when `withValue`, the value that follows it. */
function withoutFlag(args: string[], names: string[], withValue: boolean): string[] {
  const found = readFlag(args, names);
  if (!found) return args;
  const inline = (args[found.index] ?? "").includes("=");
  const count = inline || !withValue || found.value === undefined ? 1 : 2;
  return [...args.slice(0, found.index), ...args.slice(found.index + count)];
}

export interface PlanOptions {
  cwd: string;
  claudeConfigDir: string;
  newSessionId?: () => string;
}

export async function planSession(args: string[], options: PlanOptions): Promise<SessionPlan> {
  const newId = options.newSessionId ?? randomUUID;
  if (args.some((arg) => NO_SESSION_FLAGS.has(arg))) return { kind: "none", args };

  const given = readFlag(args, ["--session-id"]);
  const resume = readFlag(args, ["--resume", "-r"]);
  const continuing = hasFlag(args, ["--continue", "-c"]);
  const fork = hasFlag(args, ["--fork-session"]);

  if (given?.value) {
    return { kind: "known", args, sessionId: given.value, resumed: false };
  }
  if ((resume || continuing) && fork) {
    const sessionId = newId();
    return { kind: "known", args: [...args, "--session-id", sessionId], sessionId, resumed: false };
  }
  if (resume) {
    if (resume.value && UUID.test(resume.value)) {
      return { kind: "known", args, sessionId: resume.value, resumed: true };
    }
    return { kind: "picker", args };
  }
  if (continuing) {
    const latest = await latestSession(projectDir(options.claudeConfigDir, options.cwd));
    if (!latest) throw new Error("No conversation found to continue in this directory.");
    const rest = withoutFlag(args, ["--continue", "-c"], false);
    return { kind: "known", args: ["--resume", latest.id, ...rest], sessionId: latest.id, resumed: true };
  }
  const sessionId = newId();
  return { kind: "known", args: ["--session-id", sessionId, ...args], sessionId, resumed: false };
}

/** Claude Code's config directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Where Claude Code keeps one directory's sessions: every non-alphanumeric becomes "-". */
export function projectDir(claudeDir: string, cwd: string): string {
  return join(claudeDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** The most recently written session in a project directory, if any. */
export async function latestSession(dir: string): Promise<{ id: string; mtimeMs: number } | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let latest: { id: string; mtimeMs: number } | null = null;
  for (const name of names) {
    const id = name.replace(/\.jsonl$/, "");
    if (id === name || !UUID.test(id)) continue;
    const { mtimeMs } = await stat(join(dir, name));
    if (!latest || mtimeMs > latest.mtimeMs) latest = { id, mtimeMs };
  }
  return latest;
}

/**
 * Waits for the session the Person picks in Claude Code's picker: the first session
 * file in this directory written after `since`. Resolves null when `signal` aborts.
 */
export async function waitForPickedSession(
  dir: string,
  since: number,
  signal: AbortSignal,
  pollMs = 1000,
): Promise<string | null> {
  while (!signal.aborted) {
    const latest = await latestSession(dir);
    if (latest && latest.mtimeMs > since) return latest.id;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}
