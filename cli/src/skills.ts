// Skills shared on the Channel, on the laptop (ADR 0039): reading a skill's directory to
// publish it, and installing a published version, showing what it changes first. The
// MCP tools and `switchboard skills` both run this code.
//
// - Publishing reads `<scope>/skills/<name>/` and nothing outside it: no path climbs out,
//   and a symbolic link is refused rather than followed.
// - It refuses a bundle the shared rules refuse (shared/src/skills.ts), secrets first,
//   before anything leaves the machine. The Channel checks again.
// - Installing writes only inside `<scope>/skills/<name>/`, and only the bundle whose
//   digest the Person was shown.

import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type {
  PublishSkillResponse,
  Skill,
  SkillFile,
  SkillResponse,
  SkillSummary,
  SkillsResponse,
} from "../../shared/src/index";
import {
  checkSkill,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  SKILL_NAME_PATTERN,
  SKILLS_PATH,
  skillPath,
  sortedFiles,
} from "../../shared/src/index";
import { type ChannelClient, ChannelError } from "./channel-client";
import { claudeConfigDir } from "./claude-session";

/** Where a skill lives: the Person's own skills, or the repo's. */
export type SkillScope = "user" | "project";

/** A refusal said in words a Person can act on. */
export class SkillError extends Error {}

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
 * With `missing: "empty"`, a skill that is not there has no files.
 */
export async function readSkillDir(
  root: string,
  name: string,
  missing: "refuse" | "empty" = "refuse",
): Promise<SkillFile[]> {
  checkName(name);
  const dir = join(root, name);
  const top = await lstat(dir).catch(() => null);
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
      bytes += size;
      if (bytes > MAX_SKILL_BYTES)
        throw new SkillError(`${name} is over ${MAX_SKILL_BYTES} bytes, the most a skill may be.`);
      if (files.length >= MAX_SKILL_FILES)
        throw new SkillError(`${name} has over ${MAX_SKILL_FILES} files, the most a skill may have.`);
      const raw = await readFile(path);
      const content = raw.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(raw)) {
        throw new SkillError(`${name}/${inside} is not UTF-8 text: a shared skill holds text files only.`);
      }
      files.push({ path: inside, content });
    }
  };
  await walk(dir);
  return sortedFiles(files);
}

/** The skill `name` of `scope`, checked as the Channel will check it, ready to publish. */
export async function localSkill(
  scope: SkillScope,
  name: string,
  ctx: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<SkillFile[]> {
  const files = await readSkillDir(await skillsDir(scope, ctx), name);
  const checked = checkSkill(name, files);
  if (!checked.ok) throw new SkillError(checked.reason);
  return files;
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

export function fetchSkill(client: ChannelClient, name: string, version?: number): Promise<SkillResponse> {
  checkName(name);
  return asked(client.request<SkillResponse>(skillPath(name, version)));
}

export function sendSkill(client: ChannelClient, name: string, files: SkillFile[]): Promise<PublishSkillResponse> {
  return asked(
    client.request<PublishSkillResponse>(skillPath(name), { method: "POST", body: JSON.stringify({ files }) }, 30_000),
  );
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

/** What installing `after` over `before` changes, file by file, as unified diffs; empty when nothing does. */
export function skillDiff(before: readonly SkillFile[], after: readonly SkillFile[]): string {
  const old = new Map(before.map((file) => [file.path, file.content]));
  const now = new Map(after.map((file) => [file.path, file.content]));
  const paths = [...new Set([...old.keys(), ...now.keys()])].sort();
  return paths
    .filter((path) => old.get(path) !== now.get(path))
    .map((path) => fileDiff(path, old.get(path), now.get(path)))
    .join("\n");
}

/** A published version in full: what it is, every file's content, and what installing it at `dir` changes. */
export function describeInstall(skill: Skill, dir: string, installed: readonly SkillFile[]): string {
  const diff = skillDiff(installed, skill.files);
  const by = skill.publishedBy.agent ?? skill.publishedBy.person;
  const head = [
    `${skill.name} version ${skill.version}, published by ${by} at ${skill.publishedAt}. Digest ${skill.digest}.`,
    ...(skill.description === undefined ? [] : [skill.description]),
    "",
    ...skill.files.flatMap((file) => [`===== ${file.path} =====`, file.content.replace(/\n$/, ""), ""]),
  ];
  const change =
    installed.length === 0
      ? `Installing it creates ${dir}.`
      : diff === ""
        ? `${dir} already holds exactly this version: installing it changes nothing.`
        : `Installing it over ${dir} changes:\n${diff}`;
  return `${head.join("\n")}\n${change}`;
}

/**
 * Installs `skill` at `root/name`, replacing what is there: files it does not have are
 * removed, inside that directory only.
 */
export async function writeSkill(root: string, skill: Skill, installed: readonly SkillFile[]): Promise<string> {
  const dir = join(root, skill.name);
  for (const file of skill.files) {
    const path = join(dir, ...file.path.split("/"));
    if (relative(dir, path).startsWith("..")) throw new SkillError(`${file.path} is outside the skill's directory.`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
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
