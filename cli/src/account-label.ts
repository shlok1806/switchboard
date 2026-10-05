// The Account Label (ADR 0009): which login of its agent CLI an Agent runs under,
// so a Person running Agents from two accounts can tell them apart on the
// Dashboard. The wrapper picks it once per session: `--account-label`, else
// $SWITCHBOARD_ACCOUNT_LABEL, else what the CLI's own config says about its login.
// Only non-secret files are read, and an email address is masked: the label is
// shown to everyone on the Channel.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Cli } from "../../shared/src/index";
import { cleanAccountLabel } from "../../shared/src/index";

/** The environment variable that sets the Account Label; empty sends none. */
export const ACCOUNT_LABEL_ENV = "SWITCHBOARD_ACCOUNT_LABEL";

/** `shlokat2@illinois.edu` becomes `sh…@illinois.edu`: enough to tell accounts apart, not the address. */
export function maskEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return `${email.slice(0, Math.min(2, at))}…${email.slice(at)}`;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The email address an agent CLI's config names for its login, from files that hold
 * no tokens. Codex keeps its login in `auth.json` next to its tokens, so it has none.
 */
async function loginEmail(cli: Cli, env: NodeJS.ProcessEnv): Promise<string | null> {
  switch (cli) {
    case "claude-code": {
      // Claude Code keeps `.claude.json` in $CLAUDE_CONFIG_DIR, or in the home directory without it.
      const dir = env.CLAUDE_CONFIG_DIR || homedir();
      const account = (await readJson(join(dir, ".claude.json")))?.oauthAccount;
      const email = (account as { emailAddress?: unknown } | undefined)?.emailAddress;
      return typeof email === "string" ? email : null;
    }
    case "gemini": {
      const active = (await readJson(join(env.GEMINI_CLI_HOME || homedir(), ".gemini", "google_accounts.json")))
        ?.active;
      return typeof active === "string" ? active : null;
    }
    case "codex":
      return null;
  }
}

/**
 * The Account Label to send when registering: the flag, else the environment
 * variable, else the CLI login's masked email address. Null sends none (an empty
 * flag or variable clears a stored one).
 */
export async function accountLabel(cli: Cli, flag: string | undefined, env: NodeJS.ProcessEnv): Promise<string | null> {
  const given = flag ?? env[ACCOUNT_LABEL_ENV];
  if (given !== undefined) return cleanAccountLabel(given);
  const email = await loginEmail(cli, env);
  const masked = email === null ? null : maskEmail(email.trim());
  return masked === null ? null : cleanAccountLabel(masked);
}
