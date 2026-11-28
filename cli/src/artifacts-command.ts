// `switchboard artifacts`: a Person lists, shows, publishes, opens, saves and deletes the
// HTML pages shared on the Channel (ADR 0053), as themselves. Thin over cli/src/artifacts.ts,
// which the MCP tools run too. A delete cannot be undone, so it shows what goes and asks on
// the terminal, unless --yes says the Person has decided; there is no MCP tool for it.

import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { describeSize } from "../../shared/src/index";
import {
  ArtifactError,
  artifactLink,
  artifactsDir,
  deleteArtifact,
  describeArtifact,
  describeArtifacts,
  describeOpened,
  fetchArtifact,
  listArtifacts,
  openInBrowser,
  preparePublish,
  readArtifact,
  savePage,
  sendArtifact,
} from "./artifacts";
import { ChannelChoiceError, chooseChannel, describeChoice } from "./channel-choice";
import { ChannelClient, targetOf } from "./channel-client";
import { readConfig } from "./config";

export const ARTIFACTS_USAGE = `Usage:
  switchboard artifacts list [--repo <owner>/<repo>]
  switchboard artifacts show <name> [--version <n>] [--repo <owner>/<repo>]
  switchboard artifacts publish <file.html> [--name <name>] [--title <title>] [--no-open] [--repo <owner>/<repo>]
  switchboard artifacts open <name> [--version <n>] [--repo <owner>/<repo>]
  switchboard artifacts pull <name> [--version <n>] [--to <file>] [--repo <owner>/<repo>]
  switchboard artifacts delete <name> [--yes] [--repo <owner>/<repo>]`;

const VERBS = ["list", "show", "publish", "open", "pull", "delete"];

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

function versionOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,8}$/.test(value)) throw new ArtifactError(`--version is a version number, not ${value}.`);
  return Number(value);
}

export async function artifactsCommand(args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === undefined || !VERBS.includes(verb)) {
    console.error(ARTIFACTS_USAGE);
    return 2;
  }
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(rest);
  } catch (error) {
    console.error(`switchboard: ${(error as Error).message}\n\n${ARTIFACTS_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const target = positionals[0];
  if ((verb === "list") !== (target === undefined) || positionals.length > 1) {
    console.error(ARTIFACTS_USAGE);
    return 2;
  }
  const config = await readConfig();
  if (!config) {
    console.error("switchboard: not logged in. Run `switchboard login` first.");
    return 1;
  }
  const cwd = process.cwd();
  try {
    const choice = await chooseChannel(config, {
      ...(values.repo === undefined ? {} : { flag: values.repo }),
      env: process.env,
      cwd,
    });
    if (choice.reason !== "default") console.error(`Using ${describeChoice(choice)}.`);
    const client = new ChannelClient(targetOf(config, choice.repo));
    const link = (name: string, version?: number) => artifactLink(config.url, choice.repo, name, version);
    if (verb === "list") {
      console.log(describeArtifacts((await listArtifacts(client)).artifacts, (name) => link(name)));
      return 0;
    }
    const name = target as string;
    if (verb === "publish") {
      const page = await preparePublish(
        {
          path: name,
          ...(values.name === undefined ? {} : { name: values.name }),
          ...(values.title === undefined ? {} : { title: values.title }),
        },
        cwd,
      );
      const { artifact, published } = await sendArtifact(client, page);
      const at = link(artifact.name, artifact.version);
      console.log(
        published
          ? `Published ${artifact.name} version ${artifact.version} "${artifact.title}" (${describeSize(artifact.size)}) to ${choice.repo}: ${at}`
          : `${artifact.name} version ${artifact.version} on ${choice.repo} already holds exactly this page and title: nothing was published. ${at}`,
      );
      if (!values["no-open"]) console.log(describeOpened(await openInBrowser(at), at));
      return 0;
    }
    if (verb === "delete") {
      const { artifact, versions } = await fetchArtifact(client, name);
      const kept = versions.length === 1 ? "its 1 version" : `all ${versions.length} of its versions`;
      console.log(
        `${describeArtifact(artifact)}\nDeleting it removes ${kept} (${versions.join(", ")}) for everyone on ${choice.repo}. It cannot be undone.`,
      );
      if (!values.yes && !(await confirm(`\nDelete ${artifact.name}? [y/N] `))) {
        console.error(
          process.stdin.isTTY
            ? "Nothing was deleted."
            : "Nothing was deleted: read the above, then pass --yes to delete it without a terminal to ask on.",
        );
        return 1;
      }
      const deleted = await deleteArtifact(client, name);
      console.log(
        `Deleted ${deleted.deleted} and its ${deleted.versions === 1 ? "1 version" : `${deleted.versions} versions`} from ${choice.repo}.`,
      );
      return 0;
    }
    const version = versionOf(values.version);
    if (verb === "show") {
      const { artifact, versions } = await fetchArtifact(client, name, version);
      console.log(describeArtifact(artifact));
      console.log(`Versions: ${versions.join(", ")}.`);
      console.log(link(artifact.name, artifact.version));
      return 0;
    }
    if (verb === "open") {
      // Asked first, so a name there is none of says so instead of opening an empty view.
      const { artifact } = await fetchArtifact(client, name, version);
      const at = link(artifact.name, version === undefined ? undefined : artifact.version);
      const opened = await openInBrowser(at);
      console.log(describeOpened(opened, at));
      return opened.opened ? 0 : 1;
    }
    const { artifact, html } = await readArtifact(client, name, version);
    const file = `${artifact.name}.html`;
    // Into the repo's artifacts folder, else here.
    const dir = await artifactsDir(cwd);
    const saved = await savePage(resolve(cwd, values.to ?? (dir === null ? file : join(dir, file))), html);
    console.log(
      `Saved ${artifact.name} version ${artifact.version} (${describeSize(artifact.size)}) to ${saved.path}.`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof ArtifactError || error instanceof ChannelChoiceError)) throw error;
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
      name: { type: "string" },
      title: { type: "string" },
      to: { type: "string" },
      "no-open": { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
}
