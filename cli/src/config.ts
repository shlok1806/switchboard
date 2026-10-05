// The wrapper's local config: the Person's Switchboard session, the Worker that
// issued it and their default Channel (ADR 0007, ADR 0008). The session works for
// every Channel on that Worker the Person has write access to, and is never sent to
// any other origin. It lives in the user's config directory, never in a repo,
// because the session acts as the Person.
//
//   $SWITCHBOARD_CONFIG_DIR, else $XDG_CONFIG_HOME/switchboard, else ~/.config/switchboard

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PersonName } from "../../shared/src/index";

export interface Config {
  /** The origin of the Worker that issued the session, such as `https://switchboard.example.workers.dev`. */
  url: string;
  /**
   * The default Channel's repo, `owner/name`: the one named at `switchboard login`.
   * A command uses it unless channel-choice.ts picks another on the same Worker.
   */
  repo: string;
  /** The Person's Switchboard session, from `switchboard login`. Only ever sent to `url`. */
  session: string;
  /** The Person's GitHub login. */
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
  const { url, repo, session, person } = parsed;
  if (
    typeof url !== "string" ||
    typeof repo !== "string" ||
    typeof session !== "string" ||
    typeof person !== "string"
  ) {
    throw new Error(
      `${configPath(env)} is from an older Switchboard. Run \`switchboard login --url <channel url>\` again.`,
    );
  }
  return { url, repo, session, person };
}

/** Writes the config readable by its owner only, since it holds the Person's session. */
export async function writeConfig(config: Config, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = configPath(env);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
