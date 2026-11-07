// Skills shared on the Channel, on the laptop (ADR 0039, 0050): reading a skill's directory
// to publish it, and installing a published version, showing what it changes first. The
// MCP tools and `switchboard skills` both run this code.
//
// - Publishing reads `<scope>/skills/<name>/` and nothing outside it: no path climbs out,
//   and a symbolic link is refused rather than followed. Files of any type go, text as
//   text and anything else as base64.
// - It refuses a skill the shared rules refuse (shared/src/skills.ts), secrets first,
//   before anything leaves the machine. The Channel checks again.
// - A publish sends the manifest, uploads the files the Channel lacks in batches, then
//   sends the manifest again; a read fetches the manifest, then the files it needs. Every
//   file's SHA-256 is checked against the manifest, and the manifest against the version's
//   digest, before anything is shown or written.
// - Installing writes only inside `<scope>/skills/<name>/`, and only the version whose
//   digest the Person was shown.

import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type {
  PublishSkillResponse,
  ReadSkillFilesResponse,
  Skill,
  SkillEntry,
  SkillFile,
  SkillFilesMissing,
  SkillResponse,
  SkillSummary,
  SkillsResponse,
  UploadSkillFilesResponse,
} from "../../shared/src/index";
import {
  checkSkillFiles,
  describeSize,
  downloadSkillFiles,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  manifestDigest,
  SKILL_FILES_PATH,
  SKILL_FILES_READ_PATH,
  SKILL_NAME_PATTERN,
  SKILLS_PATH,
  sha256Hex,
  skillPath,
  sortedByPath,
  textOf,
  uploadSkillFiles,
} from "../../shared/src/index";
import { type ChannelClient, ChannelError } from "./channel-client";
import { claudeConfigDir } from "./claude-session";

/** Where a skill lives: the Person's own skills, or the repo's. */
export type SkillScope = "user" | "project";

/** A refusal said in words a Person can act on. */
export class SkillError extends Error {}

/** How long one request that carries files may take: up to 4 MiB of them. */
const TRANSFER_TIMEOUT_MS = 120_000;

/** The `skills` directory of `scope`: Claude Code's user directory, or the repo's `.claude/`. */
export async function skillsDir(scope: SkillScope, ctx: { env: NodeJS.ProcessEnv; cwd: string }): Promise<string> {
  if (scope === "user") return join(claudeConfigDir(ctx.env), "skills");
  const top = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd }).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );
  if (top === "") throw new SkillError(`${ctx.cwd} is not in a git repo, so it has no project skills.`);
  return join(top, ".claude", "skills");
}

function checkName(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillError(`"${name}" is not a skill name: lower-case letters, digits, ".", "_" and "-", up to 64.`);
  }
}

/**
 * The files of the skill directory `root/name`, by path inside it. Reads nothing
 * outside it: a symbolic link, or anything but a plain file or directory, is refused.
 * Only `root/name` itself may be a link to a directory, the way `npx skills add`
 * installs a skill; its files are read from where it points.
 * With `missing: "empty"`, a skill that is not there has no files.
 */
export async function readSkillDir(
  root: string,
  name: string,
  missing: "refuse" | "empty" = "refuse",
): Promise<SkillFile[]> {
  checkName(name);
  let dir = join(root, name);
  let top = await lstat(dir).catch(() => null);
  if (top?.isSymbolicLink()) {
    dir = await realpath(dir).catch(() => dir);
    top = await lstat(dir).catch(() => null);
  }
  if (top === null) {
    if (missing === "empty") return [];
    throw new SkillError(`There is no skill ${name} at ${dir}.`);
  }
  if (!top.isDirectory()) throw new SkillError(`${dir} is not a directory.`);
  const files: SkillFile[] = [];
  let bytes = 0;
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const inside = relative(dir, path).split(sep).join("/");
      if (entry.isSymbolicLink())
        throw new SkillError(`${name}/${inside} is a symbolic link; a shared skill holds plain files only.`);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) throw new SkillError(`${name}/${inside} is not a plain file.`);
      const size = (await lstat(path)).size;
      if (size > MAX_SKILL_FILE_BYTES) {
        throw new SkillError(
          `${name}/${inside} is ${describeSize(size)}; a skill's file may be at most ${describeSize(MAX_SKILL_FILE_BYTES)}.`,
        );
      }
      bytes += size;
      if (bytes > MAX_SKILL_BYTES)
        throw new SkillError(`${name} is over ${describeSize(MAX_SKILL_BYTES)}, the most a skill may be.`);
      if (files.length >= MAX_SKILL_FILES)
        throw new SkillError(`${name} has over ${MAX_SKILL_FILES} files, the most a skill may have.`);
      files.push({ path: inside, bytes: new Uint8Array(await readFile(path)) });
    }
  };
  await walk(dir);
  return sortedByPath(files);
}

/** A skill read from this machine and checked: its files, and the manifest that publishes them. */
export interface LocalSkill {
  files: SkillFile[];
  manifest: SkillEntry[];
}

/** The skill `name` of `scope`, checked as the Channel will check it, ready to publish. */
export async function localSkill(
  scope: SkillScope,
  name: string,
  ctx: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<LocalSkill> {
  const files = await readSkillDir(await skillsDir(scope, ctx), name);
  const checked = await checkSkillFiles(name, files);
  if (!checked.ok) throw new SkillError(checked.reason);
  return { files, manifest: checked.manifest };
}

/** The request's answer; a refusal in the Channel's own words. */
async function asked<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ChannelError) throw new SkillError(error.message);
    throw error;
  }
}

export function listSkills(client: ChannelClient): Promise<SkillsResponse> {
  return asked(client.request<SkillsResponse>(SKILLS_PATH));
}

/** A version's manifest, checked against its digest. */
export async function fetchSkill(client: ChannelClient, name: string, version?: number): Promise<SkillResponse> {
  checkName(name);
  const read = await asked(client.request<SkillResponse>(skillPath(name, version)));
  if ((await manifestDigest(read.skill.files)) !== read.skill.digest) {
    throw new SkillError(`${name} version ${read.skill.version}'s files do not match its digest ${read.skill.digest}.`);
  }
  return read;
}

/**
 * The bytes of `skill`'s files, by path: every file, or with `textOnly` the text files,
 * all that a reader is shown. Each is checked against its SHA-256.
 */
export async function fetchSkillFiles(
  client: ChannelClient,
  skill: Skill,
  { textOnly = false }: { textOnly?: boolean } = {},
): Promise<Map<string, Uint8Array>> {
  const wanted = textOnly ? skill.files.filter((file) => file.encoding === "utf8") : skill.files;
  try {
    return await downloadSkillFiles(wanted, (request) =>
      asked(
        client.request<ReadSkillFilesResponse>(
          SKILL_FILES_READ_PATH,
          { method: "POST", body: JSON.stringify(request) },
          TRANSFER_TIMEOUT_MS,
        ),
      ),
    );
  } catch (error) {
    if (error instanceof SkillError) throw error;
    throw new SkillError((error as Error).message);
  }
}

/**
 * Publishes `files` as the next version of `name`: the manifest first, then the files
 * the Channel does not hold yet, then the manifest again.
 */
export async function sendSkill(
  client: ChannelClient,
  name: string,
  { files, manifest }: LocalSkill,
): Promise<PublishSkillResponse> {
  const body = JSON.stringify({ files: manifest });
  const publish = () =>
    client.request<PublishSkillResponse>(skillPath(name), { method: "POST", body }, TRANSFER_TIMEOUT_MS);
  let missing: string[];
  try {
    return await publish();
  } catch (error) {
    const body = error instanceof ChannelError && error.status === 409 ? (error.body as SkillFilesMissing) : undefined;
    if (!Array.isArray(body?.missing)) return asked(Promise.reject(error));
    missing = body.missing;
  }
  await uploadSkillFiles(files, missing, (request) =>
    asked(
      client.request<UploadSkillFilesResponse>(
        SKILL_FILES_PATH,
        { method: "POST", body: JSON.stringify(request) },
        TRANSFER_TIMEOUT_MS,
      ),
    ),
  );
  return asked(publish());
}

// --- What an install changes ---

type Op = { kind: " " | "-" | "+"; line: string };

/** The line edits from `a` to `b`, by longest common subsequence; a pair too large to compare is replaced whole. */
function lineOps(a: string[], b: string[]): Op[] {
  if (a.length * b.length > 4_000_000) {
    return [...a.map((line) => ({ kind: "-" as const, line })), ...b.map((line) => ({ kind: "+" as const, line }))];
  }
  // lcs[i * w + j]: the longest common subsequence of a[i..] and b[j..].
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  const at = (i: number, j: number): number => lcs[i * w + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] ?? "" });
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || at(i + 1, j) >= at(i, j + 1))) {
      // A removed line before the line that replaces it, as diff shows them.
      ops.push({ kind: "-", line: a[i] ?? "" });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j] ?? "" });
      j++;
    }
  }
  return ops;
}

function lines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}

/** A unified diff of one file, with three lines of context. */
function fileDiff(path: string, before: string | undefined, after: string | undefined): string {
  const ops = lineOps(lines(before ?? ""), lines(after ?? ""));
  const out = [
    `--- ${before === undefined ? "/dev/null" : `installed/${path}`}`,
    `+++ ${after === undefined ? "/dev/null" : `shared/${path}`}`,
  ];
  const CONTEXT = 3;
  let k = 0;
  while (k < ops.length) {
    if (ops[k]?.kind === " ") {
      k++;
      continue;
    }
    let start = Math.max(0, k - CONTEXT);
    let end = k;
    // A hunk runs on while changes are closer than twice the context.
    for (let gap = 0; end < ops.length; end++) {
      gap = ops[end]?.kind === " " ? gap + 1 : 0;
      if (gap > 2 * CONTEXT) {
        end -= gap - CONTEXT;
        break;
      }
    }
    end = Math.min(end, ops.length);
    const hunk = ops.slice(start, end);
    const oldStart = ops.slice(0, start).filter((op) => op.kind !== "+").length + 1;
    const newStart = ops.slice(0, start).filter((op) => op.kind !== "-").length + 1;
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    out.push(
      `@@ -${oldCount === 0 ? oldStart - 1 : oldStart},${oldCount} +${newCount === 0 ? newStart - 1 : newStart},${newCount} @@`,
    );
    for (const op of hunk) out.push(`${op.kind}${op.line}`);
    k = end;
    start = end;
  }
  return out.join("\n");
}

/** A version read to show or install at `root`: it, what is installed there, and both as an install compares them. */
export interface InstallRead {
  skill: Skill;
  versions: number[];
  dir: string;
  installedFiles: SkillFile[];
  installed: Map<string, FileView>;
  shared: Map<string, FileView>;
  /** Every file's bytes with `all`, else the text files'. */
  bytes: Map<string, Uint8Array>;
}

/** Reads version `version` of `name` (the latest when left out) to show it, or with `all` to install it, at `root`. */
export async function readForInstall(
  client: ChannelClient,
  name: string,
  version: number | undefined,
  root: string,
  { all = false }: { all?: boolean } = {},
): Promise<InstallRead> {
  const { skill, versions } = await fetchSkill(client, name, version);
  const installedFiles = await readSkillDir(root, name, "empty");
  const bytes = await fetchSkillFiles(client, skill, { textOnly: !all });
  return {
    skill,
    versions,
    dir: join(root, name),
    installedFiles,
    installed: await installedView(installedFiles),
    shared: sharedView(skill, bytes),
    bytes,
  };
}

/** A file as an install compares it: its SHA-256 and size, and its text when it is text. */
export interface FileView {
  digest: string;
  size: number;
  /** Null for a binary file, which is shown by its size and SHA-256. */
  text: string | null;
}

/** The installed files as an install compares them. */
export async function installedView(files: readonly SkillFile[]): Promise<Map<string, FileView>> {
  const views = await Promise.all(
    files.map(
      async (file) =>
        [
          file.path,
          { digest: await sha256Hex(file.bytes), size: file.bytes.length, text: textOf(file.bytes) },
        ] as const,
    ),
  );
  return new Map(views);
}

/** A published version's files as an install compares them; `bytes` holds at least its text files'. */
export function sharedView(skill: Skill, bytes: ReadonlyMap<string, Uint8Array>): Map<string, FileView> {
  return new Map(
    skill.files.map((file: SkillEntry) => {
      const content = bytes.get(file.path);
      if (file.encoding === "utf8" && content === undefined) throw new SkillError(`${file.path} was not read.`);
      const text = file.encoding === "utf8" ? new TextDecoder().decode(content) : null;
      return [file.path, { digest: file.digest, size: file.size, text }] as const;
    }),
  );
}

/** "12,040 bytes, SHA-256 <hex>": what a binary file is shown as. */
function binaryLine(file: FileView): string {
  return `${file.size.toLocaleString("en-US")} bytes, SHA-256 ${file.digest}`;
}

/** What installing `after` over `before` changes, file by file, as unified diffs; empty when nothing does. */
export function skillDiff(before: ReadonlyMap<string, FileView>, after: ReadonlyMap<string, FileView>): string {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths
    .filter((path) => before.get(path)?.digest !== after.get(path)?.digest)
    .map((path) => {
      const old = before.get(path);
      const now = after.get(path);
      if ((old === undefined || old.text !== null) && (now === undefined || now.text !== null)) {
        return fileDiff(path, old?.text ?? undefined, now?.text ?? undefined);
      }
      // A binary on either side: shown by size and SHA-256, the only way it can be.
      const change =
        now === undefined
          ? `Binary file ${path} is removed (installed: ${binaryLine(old as FileView)}).`
          : old === undefined
            ? `Binary file ${path}: ${binaryLine(now)}.`
            : `Binary file ${path}: ${binaryLine(now)} (installed: ${binaryLine(old)}).`;
      return [
        `--- ${old === undefined ? "/dev/null" : `installed/${path}`}`,
        `+++ ${now === undefined ? "/dev/null" : `shared/${path}`}`,
        change,
      ].join("\n");
    })
    .join("\n");
}

/**
 * A published version in full: what it is, every text file's content, every binary
 * file's size and SHA-256, and what installing it at `dir` changes.
 */
export function describeInstall(
  skill: Skill,
  dir: string,
  installed: ReadonlyMap<string, FileView>,
  shared: ReadonlyMap<string, FileView>,
): string {
  const diff = skillDiff(installed, shared);
  const by = skill.publishedBy.agent ?? skill.publishedBy.person;
  const binaries = skill.files.filter((file) => file.encoding === "base64").length;
  const head = [
    `${skill.name} version ${skill.version}, published by ${by} at ${skill.publishedAt}. Digest ${skill.digest}.`,
    ...(skill.description === undefined ? [] : [skill.description]),
    `${skill.files.length} ${skill.files.length === 1 ? "file" : "files"}, ${describeSize(skill.size)}` +
      (binaries === 0
        ? "."
        : `, ${binaries} of them binary: shown by size and SHA-256, as they cannot be shown in full.`),
    "",
    ...skill.files.flatMap((file) => {
      const view = shared.get(file.path) as FileView;
      return [
        `===== ${file.path} =====`,
        view.text === null ? `Binary file: ${binaryLine(view)}.` : view.text.replace(/\n$/, ""),
        "",
      ];
    }),
  ];
  const change =
    installed.size === 0
      ? `Installing it creates ${dir}.`
      : diff === ""
        ? `${dir} already holds exactly this version: installing it changes nothing.`
        : `Installing it over ${dir} changes:\n${diff}`;
  return `${head.join("\n")}\n${change}`;
}

/**
 * Installs `skill` at `root/name` from `bytes` (every file's, checked against its
 * SHA-256), replacing what is there: files it does not have are removed, inside that
 * directory only.
 */
export async function writeSkill(
  root: string,
  skill: Skill,
  bytes: ReadonlyMap<string, Uint8Array>,
  installed: readonly SkillFile[],
): Promise<string> {
  const dir = join(root, skill.name);
  for (const file of skill.files) {
    const path = join(dir, ...file.path.split("/"));
    if (relative(dir, path).startsWith("..")) throw new SkillError(`${file.path} is outside the skill's directory.`);
    const content = bytes.get(file.path);
    if (content === undefined) throw new SkillError(`${file.path} was not read, so nothing was installed.`);
  }
  for (const file of skill.files) {
    const path = join(dir, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes.get(file.path) as Uint8Array);
  }
  const kept = new Set(skill.files.map((file) => file.path));
  for (const file of installed) {
    if (kept.has(file.path)) continue;
    const path = join(dir, ...file.path.split("/"));
    await rm(path, { force: true });
    // Directories it leaves empty go too, up to the skill's own.
    for (
      let at = dirname(path);
      at !== dir && relative(dir, at) !== "" && !relative(dir, at).startsWith("..");
      at = dirname(at)
    ) {
      if (
        !(await rmdir(at).then(
          () => true,
          () => false,
        ))
      )
        break;
    }
  }
  return dir;
}

/** One line per skill, for a listing. */
export function describeSkills(skills: readonly SkillSummary[]): string {
  if (skills.length === 0) return "No skills are shared on this Channel yet.";
  return skills
    .map((skill) => {
      const by = skill.publishedBy.agent ?? skill.publishedBy.person;
      const what = skill.description === undefined ? "" : `: ${skill.description}`;
      return `${skill.name} v${skill.version}${what} (${skill.paths.length} ${skill.paths.length === 1 ? "file" : "files"}, by ${by}, ${skill.publishedAt})`;
    })
    .join("\n");
}
