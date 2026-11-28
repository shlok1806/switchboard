// Where the Dataset reads sessions from, and whose sessions it keeps (ADR 0054). Only the
// owner's own: local files of the agent CLIs on this machine, under the accounts in
// `sources.json`. The first sync writes that file with the accounts logged in here, and
// from then on it is the owner's to edit: a session under any other account is skipped.

import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DATASET_SCHEMA, type DatasetCli } from "./schema";

/** One agent CLI's home on this machine, and the accounts whose sessions in it are kept. */
export interface DatasetSource {
  cli: DatasetCli;
  /** The CLI's config home: `~/.claude`, a `CLAUDE_CONFIG_DIR`, or `~/.codex`. */
  dir: string;
  /** Account IDs as the CLI records them in its sessions (Claude Code's account UUID, Codex's account ID). */
  accounts: string[];
  /** What the accounts are, for the owner reading the file: an email address, when the CLI says. */
  note?: string;
}

/** `sources.json`. */
export interface DatasetSources {
  schema: typeof DATASET_SCHEMA;
  sources: DatasetSource[];
  /**
   * Whether a session that records no account at all is kept. Older Claude Code wrote
   * none; such a file is in the owner's own CLI home, so it is theirs. True by default.
   */
  keepUnattributed: boolean;
}

/** The Dataset's directory: `$SWITCHBOARD_DATASET_DIR`, else `~/.switchboard/dataset`. */
export function datasetDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SWITCHBOARD_DATASET_DIR || join(env.HOME || homedir(), ".switchboard", "dataset");
}

export function sourcesPath(dir: string): string {
  return join(dir, "sources.json");
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The login of a Claude Code home: its account UUID and email, from `.claude.json`. */
async function claudeLogin(dir: string, home: string): Promise<{ id: string; email?: string } | null> {
  const file = dir === join(home, ".claude") ? join(home, ".claude.json") : join(dir, ".claude.json");
  const account = (await readJson(file))?.oauthAccount as Record<string, unknown> | undefined;
  if (typeof account?.accountUuid !== "string") return null;
  return {
    id: account.accountUuid,
    ...(typeof account.emailAddress === "string" ? { email: account.emailAddress } : {}),
  };
}

/** The accounts a Codex home's own session files name: Codex keeps its login where Switchboard does not read. */
async function codexAccounts(dir: string): Promise<string[]> {
  const found = new Set<string>();
  const walk = async (path: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(path);
    } catch {
      return;
    }
    for (const name of names) {
      const child = join(path, name);
      if (name.endsWith(".jsonl")) {
        const lines = createInterface({ input: createReadStream(child, { encoding: "utf8" }) });
        for await (const line of lines) {
          try {
            const entry = JSON.parse(line) as { type?: string; payload?: { creator_account_id?: unknown } };
            if (entry.type === "session_meta" && typeof entry.payload?.creator_account_id === "string") {
              found.add(entry.payload.creator_account_id);
            }
          } catch {
            // Not JSON.
          }
          break;
        }
        lines.close();
      } else if (await isDir(child)) await walk(child);
    }
  };
  await walk(join(dir, "sessions"));
  await walk(join(dir, "archived_sessions"));
  return [...found].sort();
}

/**
 * The sources a first sync starts from: every Claude Code home here (`~/.claude`,
 * `$CLAUDE_CONFIG_DIR`, and `~/.claude-*` homes with sessions) with the account logged
 * in to it, and Codex's home with the accounts its sessions name.
 */
export async function discoverSources(env: NodeJS.ProcessEnv = process.env): Promise<DatasetSources> {
  const home = env.HOME || homedir();
  const claudeDirs = new Set<string>();
  if (env.CLAUDE_CONFIG_DIR) claudeDirs.add(env.CLAUDE_CONFIG_DIR);
  claudeDirs.add(join(home, ".claude"));
  for (const name of await readdir(home).catch(() => [] as string[])) {
    if (name.startsWith(".claude-")) claudeDirs.add(join(home, name));
  }
  const sources: DatasetSource[] = [];
  for (const dir of claudeDirs) {
    if (!(await isDir(join(dir, "projects")))) continue;
    const login = await claudeLogin(dir, home);
    sources.push({
      cli: "claude-code",
      dir,
      accounts: login === null ? [] : [login.id],
      note: login === null ? "no login found" : (login.email ?? "logged in"),
    });
  }
  const codex = env.CODEX_HOME || join(home, ".codex");
  if (await isDir(join(codex, "sessions"))) {
    sources.push({
      cli: "codex",
      dir: codex,
      accounts: await codexAccounts(codex),
      note: "accounts its sessions name",
    });
  }
  return { schema: DATASET_SCHEMA, sources, keepUnattributed: true };
}

/** Reads `sources.json`, or null when there is none yet. */
export async function readSources(dir: string): Promise<DatasetSources | null> {
  const raw = await readJson(sourcesPath(dir));
  if (raw === null || !Array.isArray(raw.sources)) return null;
  const sources = raw.sources.flatMap((s): DatasetSource[] => {
    const source = s as Partial<DatasetSource>;
    if ((source.cli !== "claude-code" && source.cli !== "codex") || typeof source.dir !== "string") return [];
    const accounts = Array.isArray(source.accounts)
      ? source.accounts.filter((a): a is string => typeof a === "string")
      : [];
    return [
      { cli: source.cli, dir: source.dir, accounts, ...(typeof source.note === "string" ? { note: source.note } : {}) },
    ];
  });
  return { schema: DATASET_SCHEMA, sources, keepUnattributed: raw.keepUnattributed !== false };
}

/** Whether a session under `account`, read from `source`, is the owner's to keep. */
export function keeps(sources: DatasetSources, cli: DatasetCli, account: string | null): boolean {
  if (account === null) return sources.keepUnattributed;
  return sources.sources.some((s) => s.cli === cli && s.accounts.includes(account));
}
