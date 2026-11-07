// `switchboard skills`: a Person lists, reads, publishes and installs the skills shared on
// the Channel (ADR 0039, 0050). Thin over cli/src/skills.ts, which the MCP tools run too. A
// Person typing the command is the Person asking, so it needs no permission prompt; an
// install still shows the full content and what it changes, and asks before it writes
// unless --yes says the Person has read it.

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { describeSize } from "../../shared/src/index";
import { ChannelChoiceError, chooseChannel, describeChoice } from "./channel-choice";
import { ChannelClient, targetOf } from "./channel-client";
import { readConfig } from "./config";
import {
  describeInstall,
  describeSkills,
  listSkills,
  localSkill,
  readForInstall,
  SkillError,
  type SkillScope,
  sendSkill,
  skillDiff,
  skillsDir,
  writeSkill,
} from "./skills";

export const SKILLS_USAGE = `Usage:
  switchboard skills list [--repo <owner>/<repo>]
  switchboard skills show <name> [--version <n>] [--target user|project] [--repo <owner>/<repo>]
  switchboard skills publish <name> [--from user|project] [--repo <owner>/<repo>]
  switchboard skills install <name> [--version <n>] [--target user|project] [--yes] [--repo <owner>/<repo>]`;

function scopeOf(value: string | undefined, flag: string): SkillScope {
  if (value === undefined || value === "user" || value === "project") return value ?? "user";
  throw new SkillError(`--${flag} is user or project, not ${value}.`);
}

function versionOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,8}$/.test(value)) throw new SkillError(`--version is a version number, not ${value}.`);
  return Number(value);
}

/** Asks the Person on the terminal; false when there is no terminal to ask on. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export async function skillsCommand(args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === undefined || !["list", "show", "publish", "install"].includes(verb)) {
    console.error(SKILLS_USAGE);
    return 2;
  }
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(rest);
  } catch (error) {
    console.error(`switchboard: ${(error as Error).message}\n\n${SKILLS_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const name = positionals[0];
  if ((verb === "list") !== (name === undefined) || positionals.length > 1) {
    console.error(SKILLS_USAGE);
    return 2;
  }
  const config = await readConfig();
  if (!config) {
    console.error("switchboard: not logged in. Run `switchboard login` first.");
    return 1;
  }
  const ctx = { env: process.env, cwd: process.cwd() };
  try {
    const choice = await chooseChannel(config, {
      ...(values.repo === undefined ? {} : { flag: values.repo }),
      ...ctx,
    });
    if (choice.reason !== "default") console.error(`Using ${describeChoice(choice)}.`);
    const client = new ChannelClient(targetOf(config, choice.repo));
    if (verb === "list") {
      console.log(describeSkills((await listSkills(client)).skills));
      return 0;
    }
    const skillName = name as string;
    if (verb === "publish") {
      const from = scopeOf(values.from, "from");
      const local = await localSkill(from, skillName, ctx);
      const { skill, published } = await sendSkill(client, skillName, local);
      console.log(
        published
          ? `Published ${skillName} version ${skill.version} (${skill.paths.length} ${skill.paths.length === 1 ? "file" : "files"}, ${describeSize(skill.size)}) to ${choice.repo}.`
          : `${skillName} version ${skill.version} on ${choice.repo} already holds exactly these files: nothing was published.`,
      );
      return 0;
    }
    const target = scopeOf(values.target, "target");
    const root = await skillsDir(target, ctx);
    const read = await readForInstall(client, skillName, versionOf(values.version), root, { all: verb === "install" });
    const { skill, versions } = read;
    console.log(describeInstall(skill, read.dir, read.installed, read.shared));
    if (verb === "show") {
      console.log(`\nVersions: ${versions.join(", ")}.`);
      return 0;
    }
    if (read.installedFiles.length > 0 && skillDiff(read.installed, read.shared) === "") return 0;
    if (!values.yes && !(await confirm(`\nInstall ${skillName} version ${skill.version}? [y/N] `))) {
      console.error(
        process.stdin.isTTY
          ? "Nothing was installed."
          : "Nothing was installed: read the above, then pass --yes to install it without a terminal to ask on.",
      );
      return 1;
    }
    console.log(
      `Installed ${skillName} version ${skill.version} at ${await writeSkill(root, skill, read.bytes, read.installedFiles)}.`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof SkillError || error instanceof ChannelChoiceError)) throw error;
    console.error(`switchboard: ${error.message}`);
    return 1;
  }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      version: { type: "string" },
      target: { type: "string" },
      from: { type: "string" },
      yes: { type: "boolean" },
    },
  });
}
