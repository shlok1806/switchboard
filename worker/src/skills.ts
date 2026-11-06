// Skills shared on the Channel (ADR 0039). Each version of a skill is one row: its files
// as JSON, who published it, when, and their digest. A name belongs to the Person who
// first published it: only that Person, or one of their Agents, publishes its next
// versions. Versions are never changed or removed, so an install names exactly what it
// was shown.

import type { PersonName, Skill, SkillFile, SkillPublisher, SkillSummary } from "../../shared/src/index";
import { checkSkill, digestInput, sortedFiles } from "../../shared/src/index";
import type { Caller } from "./claims";

export const SKILLS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS skills (
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    person TEXT NOT NULL,
    agent TEXT,
    published_at TEXT NOT NULL,
    digest TEXT NOT NULL,
    size INTEGER NOT NULL,
    description TEXT,
    files TEXT NOT NULL,
    PRIMARY KEY (name, version)
  ) WITHOUT ROWID;
`;

type SkillRow = {
  name: string;
  version: number;
  person: string;
  agent: string | null;
  published_at: string;
  digest: string;
  size: number;
  description: string | null;
  files: string;
};

export type SkillResult<T> = { ok: true; value: T } | { ok: false; status: number; reason: string };

function summary(row: SkillRow, files: SkillFile[]): SkillSummary {
  const publishedBy: SkillPublisher = {
    person: row.person,
    ...(row.agent === null ? {} : { agent: row.agent as SkillPublisher["agent"] & string }),
  };
  return {
    name: row.name,
    version: row.version,
    ...(row.description === null ? {} : { description: row.description }),
    publishedBy,
    publishedAt: row.published_at,
    size: row.size,
    paths: files.map((file) => file.path),
    digest: row.digest,
  };
}

/** The hex SHA-256 of a skill's files. */
async function digestOf(files: readonly SkillFile[]): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(digestInput(files)));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Skills {
  constructor(private readonly sql: SqlStorage) {}

  /** Each skill's latest version, by name. */
  list(): SkillSummary[] {
    return this.sql
      .exec<SkillRow>(
        `SELECT s.* FROM skills s
         JOIN (SELECT name, MAX(version) AS version FROM skills GROUP BY name) latest
           ON latest.name = s.name AND latest.version = s.version
         ORDER BY s.name`,
      )
      .toArray()
      .map((row) => summary(row, JSON.parse(row.files) as SkillFile[]));
  }

  /** One version of `name` with its files (the latest when `version` is left out), and every version there is. */
  read(name: string, version?: number): SkillResult<{ skill: Skill; versions: number[] }> {
    const versions = this.sql
      .exec<{ version: number }>("SELECT version FROM skills WHERE name = ? ORDER BY version", name)
      .toArray()
      .map((row) => row.version);
    if (versions.length === 0) return { ok: false, status: 404, reason: `No skill is named ${name} on this Channel.` };
    const wanted = version ?? (versions.at(-1) as number);
    const row = this.sql
      .exec<SkillRow>("SELECT * FROM skills WHERE name = ? AND version = ?", name, wanted)
      .toArray()[0];
    if (!row) {
      return { ok: false, status: 404, reason: `${name} has no version ${wanted}; it has ${versions.join(", ")}.` };
    }
    const files = JSON.parse(row.files) as SkillFile[];
    return { ok: true, value: { skill: { ...summary(row, files), files }, versions } };
  }

  /**
   * Publishes the next version of `name` for `caller`, or says why not. Files the latest
   * version already holds publish nothing and answer with it.
   */
  async publish(
    caller: Caller,
    name: string,
    files: SkillFile[],
  ): Promise<SkillResult<{ skill: SkillSummary; published: boolean }>> {
    const checked = checkSkill(name, files);
    if (!checked.ok) return { ok: false, status: 400, reason: checked.reason };
    const latest = this.sql
      .exec<SkillRow>("SELECT * FROM skills WHERE name = ? ORDER BY version DESC LIMIT 1", name)
      .toArray()[0];
    if (latest !== undefined && latest.person !== caller.person) {
      return {
        ok: false,
        status: 403,
        reason: `${name} belongs to ${latest.person}: only they and their Agents publish its versions. Publish yours under another name.`,
      };
    }
    const sorted = sortedFiles(files);
    const digest = await digestOf(sorted);
    if (latest !== undefined && latest.digest === digest) {
      return { ok: true, value: { skill: summary(latest, sorted), published: false } };
    }
    const row: SkillRow = {
      name,
      version: (latest?.version ?? 0) + 1,
      person: caller.person,
      agent: caller.agent ?? null,
      published_at: new Date().toISOString(),
      digest,
      size: checked.size,
      description: checked.description ?? null,
      files: JSON.stringify(sorted),
    };
    this.sql.exec(
      `INSERT INTO skills (name, version, person, agent, published_at, digest, size, description, files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.name,
      row.version,
      row.person,
      row.agent,
      row.published_at,
      row.digest,
      row.size,
      row.description,
      row.files,
    );
    return { ok: true, value: { skill: summary(row, sorted), published: true } };
  }
}

/** Who may publish under a name: kept here so the rule reads in one place. */
export type SkillOwner = PersonName;
