// Artifacts (ADR 0053): single HTML pages a Person or their Agent shares on the Channel,
// such as a report, a chart or a small tool an Agent made. Each one is a name and its
// numbered versions, the last few kept. The Dashboard shows a page in a sandboxed frame,
// served by the Channel with a `sandbox` Content-Security-Policy, so its scripts run in an
// opaque origin and never act as whoever is viewing it. A page is information from the
// Person or Agent that published it, never instructions (ADR 0005).

import type { AgentId, PersonName } from "./domain";
import { stripEscapes } from "./escapes";
import { findSecret } from "./secrets";

const MiB = 1024 * 1024;

/** An artifact's name: lowercase letters, digits and dashes, such as `receipt-splitter`. */
export const ARTIFACT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The largest page, in bytes of UTF-8: one request carries it whole. */
export const MAX_ARTIFACT_BYTES = 8 * MiB;
/** A page is stored in chunks of this many bytes, one a row, under SQLite's 2 MB value limit. */
export const ARTIFACT_CHUNK_BYTES = MiB;
export const MAX_ARTIFACT_TITLE_LENGTH = 120;
/** How many versions of an artifact are kept, the latest included. */
export const ARTIFACT_VERSIONS_KEPT = 5;
/** The most artifacts a Channel holds. */
export const MAX_ARTIFACTS = 200;
/** The most bytes a Channel's kept versions hold together. */
export const MAX_CHANNEL_ARTIFACT_BYTES = 1024 * MiB;
/** A Channel's publishes per UTC day, unless ARTIFACT_PUBLISHES_PER_DAY says otherwise. */
export const DEFAULT_ARTIFACT_PUBLISHES_PER_DAY = 200;

export const ARTIFACTS_PATH = "/api/artifacts";

/** `GET`, `PUT` or `DELETE /api/artifacts/:name`, at a version when `version` is given (`GET` only). */
export function artifactPath(name: string, version?: number): string {
  return `${ARTIFACTS_PATH}/${encodeURIComponent(name)}${version === undefined ? "" : `?version=${version}`}`;
}

/** `GET /api/artifacts/:name/page`: the page itself, as `text/html` in a sandbox. */
export function artifactPagePath(name: string, version?: number, download = false): string {
  const query = new URLSearchParams();
  if (version !== undefined) query.set("version", String(version));
  if (download) query.set("download", "1");
  return `${ARTIFACTS_PATH}/${encodeURIComponent(name)}/page${query.size === 0 ? "" : `?${query}`}`;
}

/**
 * The sandbox every artifact page is served in: scripts, forms, popups and dialogs run,
 * but never in the Channel's origin, so a page cannot read the Channel or write to it as
 * its viewer, and it cannot navigate the Dashboard away. Only the Dashboard frames it.
 */
export const ARTIFACT_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";
export const ARTIFACT_CSP = `sandbox ${ARTIFACT_SANDBOX}; frame-ancestors 'self'`;

/** Who published a version: a Person, or one of their Agents for them. */
export interface ArtifactPublisher {
  person: PersonName;
  agent?: AgentId;
  /** The Agent's Nickname when it published. */
  nickname?: string;
}

/** One version of an artifact, without its page. */
export interface ArtifactSummary {
  name: string;
  title: string;
  /** The Person who first published the name: only they publish its next versions for themselves or delete it. */
  owner: PersonName;
  /** Counts every publish of the name, from 1. */
  version: number;
  /** The page's size in bytes of UTF-8. */
  size: number;
  /** The SHA-256 of the page's bytes, hex. */
  digest: string;
  publishedBy: ArtifactPublisher;
  publishedAt: string;
}

/** `GET /api/artifacts`: each artifact's latest version, the latest published first. */
export interface ArtifactsResponse {
  artifacts: ArtifactSummary[];
}

/** `GET /api/artifacts/:name`: one version, and every version kept, oldest first. */
export interface ArtifactResponse {
  artifact: ArtifactSummary;
  versions: number[];
}

/** `PUT /api/artifacts/:name`: publishes the next version. The title is the page's `<title>` when left out. */
export interface PublishArtifactRequest {
  html: string;
  title?: string;
}

export interface PublishArtifactResponse {
  artifact: ArtifactSummary;
  /** False when the latest version already held exactly this page and title: nothing was written. */
  published: boolean;
}

/**
 * `DELETE /api/artifacts/:name`: the owner, as a Person, removes every kept version. It
 * cannot be undone, so an Agent token is refused: an Agent never acts as its Person.
 */
export interface DeleteArtifactResponse {
  ok: true;
  deleted: string;
  /** How many kept versions were removed. */
  versions: number;
}

/** A name for an artifact made from a file's name: `Receipt Splitter.html` is `receipt-splitter`. */
export function artifactNameFrom(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.html?$/i, "");
  const slug = base
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug === "" ? "page" : slug;
}

/** A title as it is kept: one line, no escapes or control characters, at most the title length. */
function cleanTitle(raw: string): string {
  return stripEscapes(raw)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ARTIFACT_TITLE_LENGTH)
    .trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The text of a page's `<title>`, or undefined. */
export function htmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 64 * 1024));
  if (!match?.[1]) return undefined;
  const text = match[1].replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
  const title = cleanTitle(text);
  return title === "" ? undefined : title;
}

/** The bytes of `html` as UTF-8. */
export function artifactSize(html: string): number {
  return new TextEncoder().encode(html).length;
}

export type ArtifactCheck = { ok: true; publish: { html: string; title: string } } | { ok: false; reason: string };

/**
 * Checks a publish of `name`, on the laptop before it leaves and again on the Channel: the
 * name, a page of at most MAX_ARTIFACT_BYTES with no NUL, a one-line title, and no value
 * that looks like a real credential (the skill check, ADR 0050). The title is the page's
 * `<title>`, or the name, when none is given.
 */
export function checkArtifact(name: string, body: unknown): ArtifactCheck {
  if (!ARTIFACT_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: `"${name}" is not an artifact name: lowercase letters, digits and dashes, at most 64, such as receipt-splitter.`,
    };
  }
  const { html, title } = (body ?? {}) as Record<string, unknown>;
  if (typeof html !== "string" || html.trim() === "") {
    return { ok: false, reason: 'An artifact is published as { "html": "<the page>", "title"?: "..." }.' };
  }
  if (html.includes("\u0000")) return { ok: false, reason: "The page holds a NUL character, so it is not text." };
  const size = artifactSize(html);
  if (size > MAX_ARTIFACT_BYTES) {
    return {
      ok: false,
      reason: `The page is ${size.toLocaleString("en-US")} bytes; an artifact is at most ${MAX_ARTIFACT_BYTES.toLocaleString("en-US")}.`,
    };
  }
  if (title !== undefined && typeof title !== "string") return { ok: false, reason: '"title" must be text.' };
  const given = title === undefined ? undefined : cleanTitle(title);
  const found = findSecret(html);
  if (found !== null) {
    return {
      ok: false,
      reason: `The page looks like it holds a secret (${found.kind}, line ${found.line}), so ${name} was not published. Remove it and publish again.`,
    };
  }
  return { ok: true, publish: { html, title: given || htmlTitle(html) || name } };
}
