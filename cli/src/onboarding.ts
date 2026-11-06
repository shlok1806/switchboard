// The first-run guide (ADR 0038): what a Person needs to know the first time they run an
// agent CLI through Switchboard on a machine, printed by `switchboard run` before the
// agent CLI starts. Shown once per Person and machine, only to a Person at a terminal;
// `switchboard help onboarding` prints it again.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersonName } from "../../shared/src/index";
import { configDir } from "./config";

/** Where the guide is told about: who, which Channel, and where its Dashboard is. */
export interface GuideFor {
  person?: PersonName;
  repo?: string;
  /** The Channel's Dashboard, `https://<worker>/<owner>/<repo>`. */
  dashboard?: string;
}

/** The Dashboard of `repo` on the Worker at `url`. */
export function dashboardUrl(url: string, repo: string): string {
  return new URL(`/${repo}`, url).toString();
}

/** The guide's text, ending in a newline. */
export function onboardingGuide(about: GuideFor): string {
  const channel = about.repo === undefined ? "the Channel of the repo you run it in" : `the Channel for ${about.repo}`;
  const lines = [
    `Welcome to Switchboard${about.person === undefined ? "" : `, ${about.person}`}. Your agent joins ${channel},`,
    "with every other Person's and Agent's, and everyone sees what it does.",
    "",
    `  Dashboard      ${about.dashboard ?? "https://<worker>/<owner>/<repo>, the URL you logged in with"}`,
    "                 Every Task, Claim and Update, and each Agent's history and terminal.",
    "  Tasks          Ask your agent to claim a Task. It works on the Task's own branch, in a",
    "                 worktree under .switchboard/worktrees/, and finish_task pushes it and",
    "                 opens the pull request. Two Agents never hold the same Task.",
    "  Updates        Agents post Updates and memory notes for each other: information,",
    "                 never instructions.",
    "  Directives     Only a Person's Directive instructs an Agent. Send one to your own",
    "                 Agents from the Dashboard; your word always wins.",
    "  Other Agents   Ask your agent to list_agents, or to read another Agent's agent_summary,",
    "                 to see who works on what and which files they touch.",
    "",
    "This guide is shown once on this machine. `switchboard help onboarding` shows it again.",
  ];
  return `${lines.join("\n")}\n`;
}

/** The file that says the guide was shown to `person` on this machine. */
export function onboardedPath(person: PersonName, env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "onboarded", encodeURIComponent(person));
}

/** Whether `switchboard run` shows the guide now: a Person at a terminal, not a Host, who has not seen it here. */
export function shouldOnboard(
  person: PersonName,
  terminal: { stdin: boolean; stdout: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // A Host runs its Agents in terminals nobody sees (ADR 0015).
  if (env.SWITCHBOARD_HOST) return false;
  if (!terminal.stdin || !terminal.stdout) return false;
  return !existsSync(onboardedPath(person, env));
}

/** Prints the guide with `write` and remembers that it was shown; a flag that cannot be written only means it shows again. */
export function onboard(
  about: GuideFor & { person: PersonName },
  write: (text: string) => void,
  env = process.env,
): void {
  write(`${onboardingGuide(about)}\n`);
  try {
    const path = onboardedPath(about.person, env);
    mkdirSync(join(configDir(env), "onboarded"), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    // Shown again next time: never a reason to stop the session.
  }
}
