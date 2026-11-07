// Skills shared on the Channel (ADR 0039, 0050): a Claude Code skill directory, published
// as numbered versions that every Person on the Channel can read and install. A version is
// a manifest of its files (path, size, SHA-256, encoding); the files' bytes are stored once
// each, by SHA-256, and move in chunks so that no request comes near a platform limit.
// The rules here run on the laptop before a skill leaves it, and again on the Channel,
// which enforces every rule the tools do (ADR 0034).

import type { AgentId, PersonName } from "./domain";
import { findSecret, type SecretFound } from "./secrets";
import { fromBase64, toBase64 } from "./terminal";

/** A skill's name: its directory's name under `.claude/skills/`. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const MiB = 1024 * 1024;

/** The most a skill's files may hold together, in bytes. */
export const MAX_SKILL_BYTES = 64 * MiB;

/** The most files one skill may have. */
export const MAX_SKILL_FILES = 2000;

/** The most one file may hold: the Channel holds a file whole while it checks it. */
export const MAX_SKILL_FILE_BYTES = 8 * MiB;

/** A stored file's chunk: one SQLite row, under the Durable Object's 2 MB value limit. */
export const SKILL_CHUNK_BYTES = MiB;

/** The most file bytes one upload or read request carries, before base64. */
export const SKILL_TRANSFER_BYTES = 4 * MiB;

/** The most skill files a Channel stores, counting each distinct file once. */
export const MAX_CHANNEL_SKILL_BYTES = 2048 * MiB;

/** The longest path a skill's file may have, inside the skill's directory. */
export const MAX_SKILL_PATH = 200;

/** The file every skill has at its root, as Claude Code reads it. */
export const SKILL_ENTRY = "SKILL.md";

/** How a file's content travels: as text, or as base64 when it is not UTF-8 text. */
export type SkillEncoding = "utf8" | "base64";

/** One of a skill's files in a version's manifest: no content, just what pins it. */
export interface SkillEntry {
  /** Inside the skill's directory, `/`-separated. */
  path: string;
  /** In bytes. */
  size: number;
  /** SHA-256 of its bytes, hex. */
  digest: string;
  encoding: SkillEncoding;
}

/** One of a skill's files with its bytes, as the laptop or the Dashboard holds it. */
export interface SkillFile {
  path: string;
  bytes: Uint8Array;
}

/** Who published a version: always a Person, through one of their Agents or themselves. */
export interface SkillPublisher {
  person: PersonName;
  agent?: AgentId;
}

/** One version of a skill, without its manifest. */
export interface SkillSummary {
  name: string;
  version: number;
  /** From the `description:` line of its SKILL.md front matter. */
  description?: string;
  publishedBy: SkillPublisher;
  publishedAt: string;
  /** Its files' size together, in bytes. */
  size: number;
  paths: string[];
  /** SHA-256 of its manifest, hex: what an install names to say which version it was shown. */
  digest: string;
}

/** One version of a skill, with its manifest. */
export interface Skill extends SkillSummary {
  files: SkillEntry[];
}

/** `POST /api/skills/:name`: publishes the next version, once the Channel holds every file. */
export interface PublishSkillRequest {
  files: SkillEntry[];
}

/** `POST /api/skills/:name`: the version published, or the latest one when it holds the same files. */
export interface PublishSkillResponse {
  skill: SkillSummary;
  /** False when the latest version already held these files, so nothing was published. */
  published: boolean;
}

/** `POST /api/skills/:name` answers 409 with this when the Channel lacks some files: upload them, then publish again. */
export interface SkillFilesMissing {
  ok: false;
  reason: string;
  missing: string[];
}

/** A chunk of one stored file: chunk `index` of the file whose SHA-256 is `digest`, in base64. */
export interface SkillChunk {
  digest: string;
  index: number;
  data: string;
}

/** `POST /api/skill-files`: chunks of files to store, each with its whole file's size. */
export interface UploadSkillFilesRequest {
  chunks: (SkillChunk & { size: number })[];
}

/** `POST /api/skill-files`: the files whose last chunk arrived and whose bytes matched their digest. */
export interface UploadSkillFilesResponse {
  complete: string[];
}

/** `POST /api/skill-files/read`: chunks of files some version holds. */
export interface ReadSkillFilesRequest {
  chunks: { digest: string; index: number }[];
}

export interface ReadSkillFilesResponse {
  chunks: SkillChunk[];
}

/** `GET /api/skills`: each skill's latest version, by name. */
export interface SkillsResponse {
  skills: SkillSummary[];
}

/** `GET /api/skills/:name[?version=]`: one version with its manifest, and every version there is. */
export interface SkillResponse {
  skill: Skill;
  versions: number[];
}

export const SKILLS_PATH = "/api/skills";
export const SKILL_FILES_PATH = "/api/skill-files";
export const SKILL_FILES_READ_PATH = "/api/skill-files/read";

export function skillPath(name: string, version?: number): string {
  return `${SKILLS_PATH}/${encodeURIComponent(name)}${version === undefined ? "" : `?version=${version}`}`;
}

/** File names that hold credentials, whatever is in them: never published. */
const SECRET_FILE =
  /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|.*\.(pem|key|p12|pfx|keystore))$/i;

const DIGEST = /^[0-9a-f]{64}$/;

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

/** The number of chunks a file of `size` bytes is stored in: an empty file has one, empty. */
export function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / SKILL_CHUNK_BYTES));
}

/** The length of chunk `index` of a file of `size` bytes. */
export function chunkLength(size: number, index: number): number {
  return Math.max(0, Math.min(SKILL_CHUNK_BYTES, size - index * SKILL_CHUNK_BYTES));
}

/** "1.2 MB", "12,040 bytes": a size as a Person reads it. */
export function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < MiB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MiB).toFixed(1)} MB`;
}

const fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text of `bytes` when they are UTF-8 with no NUL, which makes a file text; otherwise null. */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return fatal.decode(bytes);
  } catch {
    return null;
  }
}

/** How a file with these bytes travels. */
export function encodingOf(bytes: Uint8Array): SkillEncoding {
  return textOf(bytes) === null ? "base64" : "utf8";
}

/** `bytes` as Latin-1 text: one character per byte, for reading a binary file for token formats. */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

/** The SHA-256 of `bytes`, hex. */
export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const hash = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The first credential in a file's bytes (ADR 0050): the token formats in a binary, everything in text. */
export function secretIn(bytes: Uint8Array): SecretFound | null {
  const text = textOf(bytes);
  return text === null ? findSecret(latin1(bytes), { formatsOnly: true }) : findSecret(text);
}

/** "scripts/deploy.sh (a GitHub token, line 3)": a file refused for a secret, never the secret. */
export function describeSecret(path: string, found: SecretFound | null): string {
  return found === null ? path : `${path} (${found.kind}, line ${found.line})`;
}

/** Whether a file's name alone says it holds credentials: `.env`, `*.pem`, `id_rsa`. */
export function credentialFile(path: string): boolean {
  return SECRET_FILE.test(path);
}

/** The refusal of a skill whose files hold secrets, each named as `describeSecret` does. */
export function secretsRefusal(name: string, files: readonly string[]): string {
  return `${files.join(", ")} ${files.length === 1 ? "looks" : "look"} like ${files.length === 1 ? "it holds" : "they hold"} a secret, so ${name} was not published. Remove it and publish again.`;
}

/**
 * Checks a skill's manifest before it is published: its name, its files' paths, sizes,
 * digests and encodings, that it has a SKILL.md, and that no file's name says it holds
 * credentials. Says what is wrong in words a Person can act on, naming the files.
 * What the files hold is checked where their bytes are (`checkSkillFiles`, and the
 * Channel as each upload completes).
 */
export function checkManifest(
  name: string,
  files: readonly SkillEntry[],
): { ok: true; size: number } | { ok: false; reason: string } {
  if (!SKILL_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: `"${name}" is not a skill name: lower-case letters, digits, ".", "_" and "-", up to 64.`,
    };
  }
  if (files.length === 0 || files.length > MAX_SKILL_FILES) {
    return { ok: false, reason: `A skill has 1 to ${MAX_SKILL_FILES} files; ${name} has ${files.length}.` };
  }
  const seen = new Set<string>();
  let size = 0;
  const named: string[] = [];
  for (const file of files) {
    if (
      typeof file?.path !== "string" ||
      !Number.isInteger(file.size) ||
      file.size < 0 ||
      typeof file.digest !== "string" ||
      !DIGEST.test(file.digest) ||
      (file.encoding !== "utf8" && file.encoding !== "base64")
    ) {
      return {
        ok: false,
        reason:
          'Each file is { "path", "size", "digest", "encoding" }: the SHA-256 of its bytes, and "utf8" or "base64". ' +
          "A Switchboard from before skills of any size sends their content instead: update Switchboard and publish again.",
      };
    }
    const bad = badPath(file.path);
    if (bad !== null) return { ok: false, reason: bad };
    if (seen.has(file.path)) return { ok: false, reason: `"${file.path}" is listed twice.` };
    seen.add(file.path);
    if (file.size > MAX_SKILL_FILE_BYTES) {
      return {
        ok: false,
        reason: `${file.path} is ${describeSize(file.size)}; a skill's file may be at most ${describeSize(MAX_SKILL_FILE_BYTES)}.`,
      };
    }
    size += file.size;
    if (credentialFile(file.path)) named.push(file.path);
  }
  const entry = files.find((file) => file.path === SKILL_ENTRY);
  if (entry === undefined) return { ok: false, reason: `A skill needs ${SKILL_ENTRY} at the root of its directory.` };
  if (entry.encoding !== "utf8") return { ok: false, reason: `${SKILL_ENTRY} must be UTF-8 text.` };
  if (size > MAX_SKILL_BYTES) {
    return {
      ok: false,
      reason: `${name} is ${describeSize(size)} (${size} bytes); a skill may be at most ${describeSize(MAX_SKILL_BYTES)}.`,
    };
  }
  if (named.length > 0) return { ok: false, reason: secretsRefusal(name, named) };
  return { ok: true, size };
}

/** A skill's files' manifest: each one's path, size, SHA-256 and encoding, by path. */
export async function manifestOf(files: readonly SkillFile[]): Promise<SkillEntry[]> {
  const entries = await Promise.all(
    files.map(async (file) => ({
      path: file.path,
      size: file.bytes.length,
      digest: await sha256Hex(file.bytes),
      encoding: encodingOf(file.bytes),
    })),
  );
  return sortedByPath(entries);
}

/**
 * Checks a skill with its files' bytes, as the laptop does before anything leaves it: the
 * manifest's rules, then that no file holds a secret. Answers the manifest to publish.
 */
export async function checkSkillFiles(
  name: string,
  files: readonly SkillFile[],
): Promise<{ ok: true; manifest: SkillEntry[]; size: number } | { ok: false; reason: string }> {
  const manifest = await manifestOf(files);
  const checked = checkManifest(name, manifest);
  if (!checked.ok) return checked;
  const secrets = sortedByPath(files).flatMap((file) => {
    const found = secretIn(file.bytes);
    return found === null ? [] : [describeSecret(file.path, found)];
  });
  if (secrets.length > 0) return { ok: false, reason: secretsRefusal(name, secrets) };
  return { ok: true, manifest, size: checked.size };
}

/** The `description:` of a SKILL.md's front matter, if it has one. */
export function skillDescription(entry: string | undefined): string | undefined {
  const front = entry?.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = front?.[1]?.split(/\r?\n/).find((l) => /^description\s*:/.test(l));
  const value = line
    ?.replace(/^description\s*:\s*/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  return value ? value.slice(0, 300) : undefined;
}

/** Files or entries in the order a digest and a listing use: by path. */
export function sortedByPath<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A version's digest: the SHA-256 of its manifest by path, each file's path, encoding and SHA-256, as JSON. */
export function manifestDigest(files: readonly SkillEntry[]): Promise<string> {
  return sha256Hex(JSON.stringify(sortedByPath(files).map((file) => [file.path, file.encoding, file.digest])));
}

/**
 * Batches of chunk reads, each at most `SKILL_TRANSFER_BYTES` of file bytes, that fetch
 * every chunk of `files`.
 */
export function readBatches(files: readonly SkillEntry[]): ReadSkillFilesRequest[] {
  const batches: ReadSkillFilesRequest[] = [];
  let batch: ReadSkillFilesRequest["chunks"] = [];
  let bytes = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.digest)) continue;
    seen.add(file.digest);
    for (let index = 0; index < chunkCount(file.size); index++) {
      const length = chunkLength(file.size, index);
      if (batch.length > 0 && bytes + length > SKILL_TRANSFER_BYTES) {
        batches.push({ chunks: batch });
        batch = [];
        bytes = 0;
      }
      batch.push({ digest: file.digest, index });
      bytes += length;
    }
  }
  if (batch.length > 0) batches.push({ chunks: batch });
  return batches;
}

/**
 * Fetches the bytes of `files` through `read` (one `POST /api/skill-files/read` each), and
 * checks every file's SHA-256 against its entry. Answers the bytes by path.
 */
export async function downloadSkillFiles(
  files: readonly SkillEntry[],
  read: (request: ReadSkillFilesRequest) => Promise<ReadSkillFilesResponse>,
): Promise<Map<string, Uint8Array>> {
  const chunks = new Map<string, Uint8Array>();
  for (const batch of readBatches(files)) {
    for (const chunk of (await read(batch)).chunks) {
      const bytes = fromBase64(chunk.data);
      if (bytes !== null) chunks.set(`${chunk.digest}/${chunk.index}`, bytes);
    }
  }
  const byDigest = new Map<string, Uint8Array>();
  const out = new Map<string, Uint8Array>();
  for (const file of files) {
    let bytes = byDigest.get(file.digest);
    if (bytes === undefined) {
      bytes = new Uint8Array(file.size);
      for (let index = 0; index < chunkCount(file.size); index++) {
        const chunk = chunks.get(`${file.digest}/${index}`);
        if (chunk === undefined || chunk.length !== chunkLength(file.size, index)) {
          throw new Error(`The Channel did not send all of ${file.path}.`);
        }
        bytes.set(chunk, index * SKILL_CHUNK_BYTES);
      }
      if ((await sha256Hex(bytes)) !== file.digest) {
        throw new Error(`${file.path} as the Channel sent it does not match its SHA-256 ${file.digest}.`);
      }
      byDigest.set(file.digest, bytes);
    }
    out.set(file.path, bytes);
  }
  return out;
}

/**
 * Uploads the files of `files` whose digests are in `missing`, through `upload` (one
 * `POST /api/skill-files` each), in batches of at most `SKILL_TRANSFER_BYTES` of file bytes.
 */
export async function uploadSkillFiles(
  files: readonly SkillFile[],
  missing: readonly string[],
  upload: (request: UploadSkillFilesRequest) => Promise<UploadSkillFilesResponse>,
): Promise<void> {
  const wanted = new Set(missing);
  let batch: UploadSkillFilesRequest["chunks"] = [];
  let bytes = 0;
  const send = async () => {
    if (batch.length > 0) await upload({ chunks: batch });
    batch = [];
    bytes = 0;
  };
  for (const file of files) {
    const digest = await sha256Hex(file.bytes);
    if (!wanted.delete(digest)) continue;
    for (let index = 0; index < chunkCount(file.bytes.length); index++) {
      const data = file.bytes.subarray(index * SKILL_CHUNK_BYTES, (index + 1) * SKILL_CHUNK_BYTES);
      if (bytes + data.length > SKILL_TRANSFER_BYTES) await send();
      batch.push({ digest, index, size: file.bytes.length, data: toBase64(data) });
      bytes += data.length;
    }
  }
  await send();
}
