// The Claude Code settings the wrapper adds to one wrapped session, and only that
// session: they go in a file of their own, passed with `claude --settings <file>`.
// The Person's `~/.claude/settings.json` is never touched.
//
// Each part of the wrapper that needs settings (the Hook Capture today) hands in
// its own `SessionSettings`; `mergeSettings` puts them together. If the Person
// passed `--settings` themselves, theirs are kept and ours are added to them.

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** One command hook, as Claude Code's settings describe it. */
export interface CommandHook {
  type: "command";
  command: string;
  /** Seconds before Claude Code gives up on the hook. */
  timeout?: number;
}

/** A group of hooks for one hook name, optionally only for matching tools. */
export interface HookMatcher {
  matcher?: string;
  hooks: CommandHook[];
}

/** The part of Claude Code's settings the wrapper writes. Other keys pass through. */
export interface SessionSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

/**
 * Merges settings. Hooks add up: every part's hooks for a hook name all run.
 * `env` adds up by variable. Any other key takes the value of the last part that sets it.
 */
export function mergeSettings(...parts: SessionSettings[]): SessionSettings {
  const merged: SessionSettings = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key === "env") {
        // Environment variables add up too; a later part wins for the same name.
        merged.env = { ...(merged.env as Record<string, string> | undefined), ...(value as Record<string, string>) };
        continue;
      }
      if (key !== "hooks") {
        merged[key] = value;
        continue;
      }
      const hooks = { ...merged.hooks };
      for (const [name, matchers] of Object.entries((value ?? {}) as Record<string, HookMatcher[]>)) {
        hooks[name] = [...(hooks[name] ?? []), ...matchers];
      }
      merged.hooks = hooks;
    }
  }
  return merged;
}

/** Finds `--settings <value>` or `--settings=<value>` before any `--`. */
function findSettingsFlag(args: string[]): { index: number; count: number; value: string } | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") return null;
    if (arg === "--settings" && args[i + 1] !== undefined) return { index: i, count: 2, value: args[i + 1] ?? "" };
    if (arg.startsWith("--settings=")) return { index: i, count: 1, value: arg.slice("--settings=".length) };
  }
  return null;
}

/** Reads the Person's own `--settings` value: a JSON string or a path to a JSON file. */
async function readPersonSettings(value: string, cwd: string): Promise<SessionSettings> {
  const text = value.trimStart().startsWith("{") ? value : await readFile(resolve(cwd, value), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--settings must be a JSON object.");
  }
  return parsed as SessionSettings;
}

/**
 * Writes the session's settings to `<dir>/settings.json` and returns the agent CLI's
 * arguments with `--settings` pointing at it, in place of any `--settings` the Person gave.
 */
export async function applySessionSettings(
  args: string[],
  dir: string,
  cwd: string,
  parts: SessionSettings[],
): Promise<string[]> {
  const given = findSettingsFlag(args);
  const rest = given ? [...args.slice(0, given.index), ...args.slice(given.index + given.count)] : args;
  const own = given ? await readPersonSettings(given.value, cwd) : {};
  const path = join(dir, "settings.json");
  await writeFile(path, `${JSON.stringify(mergeSettings(own, ...parts), null, 2)}\n`, { mode: 0o600 });
  return ["--settings", path, ...rest];
}
