// Artifacts on the laptop (ADR 0053): single HTML pages a Person or their Agent shares on
// the Channel, and the local folder they are saved into. The MCP tools and `switchboard
// artifacts` both run this code.
//
// - A publish reads one .html file (or takes the page itself), checks it with the shared
//   rules (shared/src/artifacts.ts), secrets first, before anything leaves the machine. The
//   Channel checks again.
// - A read fetches the version's summary, then its page, checks the page against the
//   summary's SHA-256, and saves it to `.switchboard/artifacts/<name>.html` in the repo, a
//   folder kept out of `git status`, where it can be read, edited and published again.
// - Opening one opens its page on the Dashboard in the Person's own browser, never for an
//   Agent on a Host, which has no screen anyone sees.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type {
  ArtifactPublisher,
  ArtifactResponse,
  ArtifactSummary,
  ArtifactsResponse,
  DeleteArtifactResponse,
  PublishArtifactResponse,
} from "../../shared/src/index";
import {
  ARTIFACTS_PATH,
  artifactNameFrom,
  artifactPagePath,
  artifactPath,
  checkArtifact,
  describeSize,
  MAX_ARTIFACT_BYTES,
  oneLine,
} from "../../shared/src/index";
import { type ChannelClient, ChannelError } from "./channel-client";
import { dashboardUrl } from "./onboarding";
import { switchboardDir } from "./task-worktree";

/**
 * The env var that tells the MCP server its Agent runs on a Host (ADR 0015), set by the
 * wrapper. Its CLI never sees SWITCHBOARD_HOST itself, which the wrapper keeps from it.
 */
export const HEADLESS_ENV = "SWITCHBOARD_HEADLESS";

/** A refusal said in words a Person can act on. */
export class ArtifactError extends Error {}

/** How long one request that carries a page may take: up to 8 MiB of it. */
const TRANSFER_TIMEOUT_MS = 120_000;

/** The Dashboard's view of artifact `name`, at `version` when given. */
export function artifactLink(url: string, repo: string, name: string, version?: number): string {
  return `${dashboardUrl(url, repo)}#/artifacts/${encodeURIComponent(name)}${version === undefined ? "" : `/${version}`}`;
}

/** The request's answer; a refusal in the Channel's own words. */
async function asked<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ChannelError) throw new ArtifactError(error.message);
    throw error;
  }
}

/** How long ago `at` was, in words: "just now", "5 minutes ago", "3 days ago". */
export function ageOf(at: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";
  const [count, unit] =
    seconds < 3600
      ? [Math.floor(seconds / 60), "minute"]
      : seconds < 86_400
        ? [Math.floor(seconds / 3600), "hour"]
        : [Math.floor(seconds / 86_400), "day"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** Who published a version: `shlok`, or `shlok/claude/7f3a "scout" for shlok`. */
export function publisherName(by: ArtifactPublisher): string {
  if (by.agent === undefined) return by.person;
  return `${by.agent}${by.nickname === undefined ? "" : ` "${by.nickname}"`} for ${by.person}`;
}

/** One version's line: name, version, title, size, who and when. */
export function describeArtifact(artifact: ArtifactSummary, now = Date.now()): string {
  return (
    `${artifact.name} v${artifact.version} "${oneLine(artifact.title, 80)}" (${describeSize(artifact.size)}, ` +
    `by ${publisherName(artifact.publishedBy)}, ${ageOf(artifact.publishedAt, now)})`
  );
}

/** One line per artifact, each with its Dashboard link. `link` makes the link of a name. */
export function describeArtifacts(
  artifacts: readonly ArtifactSummary[],
  link: (name: string) => string,
  now = Date.now(),
): string {
  if (artifacts.length === 0) return "No artifacts are shared on this Channel yet.";
  return artifacts.map((artifact) => `${describeArtifact(artifact, now)} ${link(artifact.name)}`).join("\n");
}

export function listArtifacts(client: ChannelClient): Promise<ArtifactsResponse> {
  return asked(client.request<ArtifactsResponse>(ARTIFACTS_PATH));
}

/** What to publish, as a tool call or the command gives it: a file on this machine, or the page itself. */
export interface PublishInput {
  name?: string;
  path?: string;
  html?: string;
  title?: string;
}

/** A page ready to publish, checked on this machine. `from` is the file it was read from. */
export interface PreparedPublish {
  name: string;
  html: string;
  title?: string;
  from?: string;
}

/** The name a publish goes under: the one given, else one made from the file's name. */
export function publishName(input: PublishInput): string | undefined {
  return input.name ?? (input.path === undefined ? undefined : artifactNameFrom(input.path));
}

/** A file's text exactly as its bytes say, byte order mark and all. */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Reads and checks what `input` names, with a path resolved against `cwd`: exactly one of a
 * .html file or the page itself, and a name. Throws an ArtifactError saying what is wrong,
 * so nothing that fails the Channel's own check, a secret above all, leaves the machine.
 */
export async function preparePublish(input: PublishInput, cwd: string): Promise<PreparedPublish> {
  if ((input.path === undefined) === (input.html === undefined)) {
    throw new ArtifactError("Give exactly one of path (an .html file on this machine) or html (the page itself).");
  }
  const name = publishName(input);
  if (name === undefined) throw new ArtifactError("A page given as html needs a name, such as receipt-splitter.");
  let html: string;
  let from: string | undefined;
  if (input.path !== undefined) {
    from = resolve(cwd, input.path);
    if (!/^\.html?$/i.test(extname(from))) throw new ArtifactError(`${from} is not an .html or .htm file.`);
    const info = await stat(from).catch(() => null);
    if (info === null) throw new ArtifactError(`There is no file ${from}.`);
    if (!info.isFile()) throw new ArtifactError(`${from} is not a file.`);
    if (info.size > MAX_ARTIFACT_BYTES) {
      throw new ArtifactError(`${from} is over ${describeSize(MAX_ARTIFACT_BYTES)}, the most an artifact may be.`);
    }
    try {
      html = utf8.decode(await readFile(from));
    } catch {
      throw new ArtifactError(`${from} is not UTF-8 text.`);
    }
  } else {
    html = input.html as string;
  }
  const checked = checkArtifact(name, { html, ...(input.title === undefined ? {} : { title: input.title }) });
  if (!checked.ok) throw new ArtifactError(checked.reason);
  return {
    name,
    html,
    ...(input.title === undefined ? {} : { title: checked.publish.title }),
    ...(from === undefined ? {} : { from }),
  };
}

/** Publishes the next version of a checked page; `published` is false when the latest already holds it. */
export function sendArtifact(client: ChannelClient, page: PreparedPublish): Promise<PublishArtifactResponse> {
  const body = JSON.stringify({ html: page.html, ...(page.title === undefined ? {} : { title: page.title }) });
  return asked(
    client.request<PublishArtifactResponse>(artifactPath(page.name), { method: "PUT", body }, TRANSFER_TIMEOUT_MS),
  );
}

/** One version's summary, and every version kept. */
export function fetchArtifact(client: ChannelClient, name: string, version?: number): Promise<ArtifactResponse> {
  return asked(client.request<ArtifactResponse>(artifactPath(name, version)));
}

/** Deletes artifact `name` with every kept version, as its owner; it cannot be undone. */
export function deleteArtifact(client: ChannelClient, name: string): Promise<DeleteArtifactResponse> {
  return asked(client.request<DeleteArtifactResponse>(artifactPath(name), { method: "DELETE" }));
}

/** One version and its page, checked against the version's SHA-256. */
export async function readArtifact(
  client: ChannelClient,
  name: string,
  version?: number,
): Promise<ArtifactResponse & { html: string }> {
  const read = await fetchArtifact(client, name, version);
  // The page of the version just read, by number, so a publish in between cannot mix the two.
  const html = await asked(client.requestText(artifactPagePath(name, read.artifact.version), TRANSFER_TIMEOUT_MS));
  const digest = createHash("sha256").update(html, "utf8").digest("hex");
  if (digest !== read.artifact.digest) {
    throw new ArtifactError(`${name} version ${read.artifact.version}'s page does not match its digest.`);
  }
  return { ...read, html };
}

/** The repo's artifacts folder, `.switchboard/artifacts/`, kept out of `git status`; null outside a git repo. */
export async function artifactsDir(cwd: string): Promise<string | null> {
  const dir = await switchboardDir(cwd);
  return dir === null ? null : join(dir, "artifacts");
}

/** Writes `html` to `path`; `replaced` says a different file was there before. */
export async function savePage(path: string, html: string): Promise<{ path: string; replaced: boolean }> {
  const before = await readFile(path, "utf8").catch(() => null);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, html);
  return { path, replaced: before !== null && before !== html };
}

/** The first `max` characters of a page, every line indented, so none of it can pass for a line of Switchboard's own. */
export function pageExcerpt(html: string, max = 4000): string {
  const shown = html.length > max ? html.slice(0, max) : html;
  const lines = shown
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => `    ${line}`);
  const rest = html.length - shown.length;
  return rest > 0
    ? `${lines.join("\n")}\n(${rest.toLocaleString("en-US")} more characters in the file.)`
    : lines.join("\n");
}

/** Whether the page opened in a browser, or why not. */
export type Opened = { opened: true } | { opened: false; reason: string };

/**
 * Opens `url` in the Person's default browser: $BROWSER when set, else the system's own
 * opener. Never for an Agent on a Host (HEADLESS_ENV). The browser runs detached, so it
 * outlives the call; a failure to start it is answered, not thrown.
 */
export function openInBrowser(url: string, env: NodeJS.ProcessEnv = process.env): Promise<Opened> {
  if (env[HEADLESS_ENV] === "1") {
    return Promise.resolve({ opened: false, reason: "this Agent runs on a Host, with no screen anyone sees" });
  }
  const [command, ...args] = env.BROWSER
    ? [env.BROWSER, url]
    : process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? // `start`'s first quoted argument is a window title; `&` would end cmd's command.
          ["cmd", "/c", "start", '""', url.replaceAll("&", "^&")]
        : ["xdg-open", url];
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command as string, args, { detached: true, stdio: "ignore", env });
    } catch (error) {
      done({ opened: false, reason: (error as Error).message });
      return;
    }
    child.once("error", (error) => done({ opened: false, reason: `${command} did not start: ${error.message}` }));
    child.once("spawn", () => {
      child.unref();
      done({ opened: true });
    });
  });
}

/** What to say about opening a page, after the publish or read itself. */
export function describeOpened(opened: Opened, link: string): string {
  return opened.opened
    ? `Opened ${link} in the browser.`
    : `It was not opened in a browser (${opened.reason}): the link is ${link}.`;
}
