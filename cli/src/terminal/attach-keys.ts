// The attach keys this machine's Person allowed to type into their Agents (ADR 0021),
// kept in attach.json in Switchboard's config folder. Only this file decides who may
// type: nothing in it comes from the Channel.
//
//   switchboard attach allow <fingerprint> [--person <name>] [--agent <id>]
//   switchboard attach revoke <fingerprint>
//   switchboard attach list
//   switchboard attach prompts on|off

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { normalizeFingerprint } from "../../../shared/src/index";
import { configDir, readConfig } from "../config";

export interface AllowedKey {
  fingerprint: string;
  /** The name the wrapper shows for this key: the owner's label, never the Channel's. */
  person: string;
  /** Only this Agent; absent for every Agent this Person runs. */
  agent?: string;
  addedAt: string;
}

export interface AttachList {
  /** Assumption A of ADR 0021: an attacher's keys reach an open permission dialog. */
  attachersAnswerPrompts: boolean;
  keys: AllowedKey[];
}

export const ATTACH_USAGE = `Usage:
  switchboard attach allow <fingerprint> [--person <name>] [--agent <agent id>]
  switchboard attach revoke <fingerprint>
  switchboard attach list
  switchboard attach prompts on|off`;

export function attachPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "attach.json");
}

const EMPTY: AttachList = { attachersAnswerPrompts: true, keys: [] };

/** The list as the file holds it. A missing file allows no one; a damaged one is an error, never "allow all". */
export async function readAttachList(env: NodeJS.ProcessEnv = process.env): Promise<AttachList> {
  let raw: string;
  try {
    raw = await readFile(attachPath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, keys: [] };
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<AttachList>;
  const keys = Array.isArray(parsed.keys)
    ? parsed.keys.flatMap((k): AllowedKey[] => {
        const fingerprint = typeof k?.fingerprint === "string" ? normalizeFingerprint(k.fingerprint) : null;
        if (fingerprint === null || typeof k.person !== "string" || k.person === "") return [];
        return [
          {
            fingerprint,
            person: k.person,
            ...(typeof k.agent === "string" ? { agent: k.agent } : {}),
            addedAt: typeof k.addedAt === "string" ? k.addedAt : "",
          },
        ];
      })
    : [];
  return { attachersAnswerPrompts: parsed.attachersAnswerPrompts !== false, keys };
}

/** Writes the list readable by its owner only, through a rename so a reader never sees half of it. */
export async function writeAttachList(list: AttachList, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = attachPath(env);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  return path;
}

/** `switchboard attach ...`. */
export async function attachCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [verb, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { person: { type: "string" }, agent: { type: "string" } },
  });
  const list = await readAttachList(env);
  switch (verb) {
    case "allow": {
      const fingerprint = positionals.length === 1 ? normalizeFingerprint(positionals[0] ?? "") : null;
      if (fingerprint === null) {
        console.error(
          `switchboard: a fingerprint is five groups of four letters and digits, as the Dashboard shows it.\n\n${ATTACH_USAGE}`,
        );
        return 2;
      }
      const person = values.person ?? (await readConfig(env))?.person;
      if (person === undefined) {
        console.error("switchboard: say whose key this is with --person, or log in first.");
        return 2;
      }
      const keys = list.keys.filter((k) => k.fingerprint !== fingerprint);
      keys.push({
        fingerprint,
        person,
        ...(values.agent === undefined ? {} : { agent: values.agent }),
        addedAt: new Date().toISOString(),
      });
      const path = await writeAttachList({ ...list, keys }, env);
      console.log(
        `Allowed ${fingerprint} as ${person} to type into ${values.agent ?? "every Agent you run"}. Saved to ${path}.`,
      );
      return 0;
    }
    case "revoke": {
      const fingerprint = positionals.length === 1 ? normalizeFingerprint(positionals[0] ?? "") : null;
      if (fingerprint === null) {
        console.error(ATTACH_USAGE);
        return 2;
      }
      const keys = list.keys.filter((k) => k.fingerprint !== fingerprint);
      if (keys.length === list.keys.length) {
        console.error(`switchboard: ${fingerprint} is not allowed.`);
        return 1;
      }
      await writeAttachList({ ...list, keys }, env);
      console.log(`Revoked ${fingerprint}. Running wrappers refuse it from its next keystroke.`);
      return 0;
    }
    case "list": {
      if (list.keys.length === 0) console.log("No attach keys are allowed.");
      for (const k of list.keys)
        console.log(`${k.fingerprint}  ${k.person}  ${k.agent ?? "every Agent"}  ${k.addedAt}`);
      console.log(
        `Attachers ${list.attachersAnswerPrompts ? "may" : "may not"} answer permission prompts (switchboard attach prompts on|off).`,
      );
      return 0;
    }
    case "prompts": {
      const [setting] = positionals;
      if (setting !== "on" && setting !== "off") {
        console.error(ATTACH_USAGE);
        return 2;
      }
      await writeAttachList({ ...list, attachersAnswerPrompts: setting === "on" }, env);
      console.log(
        setting === "on"
          ? "Attachers may answer permission prompts."
          : "Attachers may not answer permission prompts: while one is open, only your own keys type.",
      );
      return 0;
    }
    default:
      console.error(ATTACH_USAGE);
      return 2;
  }
}
