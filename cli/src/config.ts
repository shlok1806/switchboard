// The wrapper's local config: which Channel to join and as whom. It lives in the
// user's config directory, never in a repo, because it holds the join secret.
//
//   $SWITCHBOARD_CONFIG_DIR, else $XDG_CONFIG_HOME/switchboard, else ~/.config/switchboard

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PersonName } from "../../shared/src/index";

export interface Config {
  /** The Channel's base URL, such as `https://switchboard.example.workers.dev`. */
  url: string;
  secret: string;
  person: PersonName;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SWITCHBOARD_CONFIG_DIR) return env.SWITCHBOARD_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "switchboard");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

/** Reads the config, or returns null when the Person has not logged in. */
export async function readConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(env), "utf8");
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as Partial<Config>;
  if (typeof parsed.url !== "string" || typeof parsed.secret !== "string" || typeof parsed.person !== "string") {
    throw new Error(`${configPath(env)} is incomplete. Run \`switchboard login\` again.`);
  }
  return { url: parsed.url, secret: parsed.secret, person: parsed.person };
}

/** Writes the config readable by its owner only, since it holds the join secret. */
export async function writeConfig(config: Config, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = configPath(env);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
