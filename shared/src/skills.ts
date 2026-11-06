// Skills shared on the Channel (ADR 0039): a Claude Code skill directory, published as a
// versioned bundle of its text files, that every Person on the Channel can read and
// install. The rules here run on the laptop before a bundle leaves it, and again on the
// Channel, which enforces every rule the tools do (ADR 0034).

import type { AgentId, PersonName } from "./domain";
import { maskSecrets } from "./mask";

/** A skill's name: its directory's name under `.claude/skills/`. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The most a skill's files may hold together, in UTF-8 bytes. */
export const MAX_SKILL_BYTES = 256 * 1024;

/** The most files one skill may have. */
export const MAX_SKILL_FILES = 100;

/** The longest path a skill's file may have, inside the skill's directory. */
export const MAX_SKILL_PATH = 200;

/** The file every skill has at its root, as Claude Code reads it. */
export const SKILL_ENTRY = "SKILL.md";

/** One of a skill's files: its path inside the skill's directory, and its text. */
export interface SkillFile {
  path: string;
  content: string;
}

/** Who published a version: always a Person, through one of their Agents or themselves. */
export interface SkillPublisher {
  person: PersonName;
  agent?: AgentId;
}

/** One version of a skill, without its files' contents. */
export interface SkillSummary {
  name: string;
  version: number;
  /** From the `description:` line of its SKILL.md front matter. */
  description?: string;
  publishedBy: SkillPublisher;
  publishedAt: string;
  /** Its files' size together, in UTF-8 bytes. */
  size: number;
  paths: string[];
  /** SHA-256 over its files, hex: what an install names to say which bundle it was shown. */
  digest: string;
}

/** One version of a skill, with its files. */
export interface Skill extends SkillSummary {
  files: SkillFile[];
}

/** `POST /api/skills/:name`: publishes the next version. */
export interface PublishSkillRequest {
  files: SkillFile[];
}

/** `POST /api/skills/:name`: the version published, or the latest one when it holds the same files. */
export interface PublishSkillResponse {
  skill: SkillSummary;
  /** False when the latest version already held these files, so nothing was published. */
  published: boolean;
}

/** `GET /api/skills`: each skill's latest version, by name. */
export interface SkillsResponse {
  skills: SkillSummary[];
}

/** `GET /api/skills/:name[?version=]`: one version with its files, and every version there is. */
export interface SkillResponse {
  skill: Skill;
  versions: number[];
}

export const SKILLS_PATH = "/api/skills";

export function skillPath(name: string, version?: number): string {
  return `${SKILLS_PATH}/${encodeURIComponent(name)}${version === undefined ? "" : `?version=${version}`}`;
}

/** File names that hold credentials, whatever is in them: never published. */
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|.*\.(pem|key|p12|pfx|keystore))$/i;

/** Why `path` cannot be a skill's file, or null. */
function badPath(path: string): string | null {
  if (path.length === 0 || path.length > MAX_SKILL_PATH) return `"${path}" must be 1 to ${MAX_SKILL_PATH} characters.`;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return `"${path}" must be a relative path inside the skill's directory.`;
  }
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return `"${path}" must be a relative path inside the skill's directory.`;
  }
  return null;
}

/** The size of `text` in UTF-8 bytes. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Checks a skill before it is published: its name, its files' paths and sizes, that
 * they are text, and that none looks like it holds a secret. Says what is wrong in
 * words a Person can act on, naming the files.
 */
export function checkSkill(
  name: string,
  files: readonly SkillFile[],
): { ok: true; size: number; description?: string } | { ok: false; reason: string } {
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `"${name}" is not a skill name: lower-case letters, digits, ".", "_" and "-", up to 64.` };
  }
  if (files.length === 0 || files.length > MAX_SKILL_FILES) {
    return { ok: false, reason: `A skill has 1 to ${MAX_SKILL_FILES} files; ${name} has ${files.length}.` };
  }
  const seen = new Set<string>();
  let size = 0;
  const secrets: string[] = [];
  for (const file of files) {
    if (typeof file?.path !== "string" || typeof file.content !== "string") {
      return { ok: false, reason: 'Each file needs a "path" and a text "content".' };
    }
    const bad = badPath(file.path);
    if (bad !== null) return { ok: false, reason: bad };
    if (seen.has(file.path)) return { ok: false, reason: `"${file.path}" is listed twice.` };
    seen.add(file.path);
    if (file.content.includes("\0")) {
      return { ok: false, reason: `${file.path} is not text: a skill shares text files only.` };
    }
    size += utf8Bytes(file.content);
    if (SECRET_FILE.test(file.path) || maskSecrets(file.content).count > 0) secrets.push(file.path);
  }
  if (!seen.has(SKILL_ENTRY)) return { ok: false, reason: `A skill needs ${SKILL_ENTRY} at the root of its directory.` };
  if (size > MAX_SKILL_BYTES) {
    return { ok: false, reason: `${name} is ${size} bytes; a skill may be at most ${MAX_SKILL_BYTES}.` };
  }
  if (secrets.length > 0) {
    return {
      ok: false,
      reason: `${secrets.join(", ")} ${secrets.length === 1 ? "looks" : "look"} like ${secrets.length === 1 ? "it holds" : "they hold"} a secret, so ${name} was not published. Remove it and publish again.`,
    };
  }
  const description = skillDescription(files);
  return { ok: true, size, ...(description === undefined ? {} : { description }) };
}

/** The `description:` of a skill's SKILL.md front matter, if it has one. */
export function skillDescription(files: readonly SkillFile[]): string | undefined {
  const entry = files.find((file) => file.path === SKILL_ENTRY)?.content;
  const front = entry?.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = front?.[1]?.split(/\r?\n/).find((l) => /^description\s*:/.test(l));
  const value = line
    ?.replace(/^description\s*:\s*/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  return value ? value.slice(0, 300) : undefined;
}

/** The files in the order a digest and a listing use: by path. */
export function sortedFiles(files: readonly SkillFile[]): SkillFile[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What a skill's digest is taken over: its files by path, as JSON. */
export function digestInput(files: readonly SkillFile[]): string {
  return JSON.stringify(sortedFiles(files).map((file) => [file.path, file.content]));
}
