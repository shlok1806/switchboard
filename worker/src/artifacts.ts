// Artifacts shared on the Channel (ADR 0053): single HTML pages, each a name and its
// numbered versions. A version is one row naming its title, size, SHA-256 and who
// published it; its page is stored in chunks of at most ARTIFACT_CHUNK_BYTES, one per
// row, under SQLite's 2 MB value limit. Only the last ARTIFACT_VERSIONS_KEPT versions of
// a name are kept: a publish removes the one that falls off. A name belongs to the
// Person who first published it, kept on every version as `owner`, so pruning never
// loses it; only the owner, as a Person, deletes a name with every version. A Channel takes at most ARTIFACT_PUBLISHES_PER_DAY publishes a UTC day.

import type { ArtifactPublisher, ArtifactSummary } from "../../shared/src/index";
import {
  ARTIFACT_CHUNK_BYTES,
  ARTIFACT_VERSIONS_KEPT,
  describeSize,
  MAX_ARTIFACTS,
  MAX_CHANNEL_ARTIFACT_BYTES,
  sha256Hex,
} from "../../shared/src/index";
import { utcDay } from "./channel";

export const ARTIFACTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS artifact_versions (
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    owner TEXT NOT NULL,
    title TEXT NOT NULL,
    size INTEGER NOT NULL,
    digest TEXT NOT NULL,
    publisher TEXT NOT NULL,
    published_at TEXT NOT NULL,
    PRIMARY KEY (name, version)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS artifact_chunks (
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (name, version, idx)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS artifact_budget (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    day TEXT NOT NULL,
    publishes INTEGER NOT NULL
  );
`;

type VersionRow = {
  name: string;
  version: number;
  owner: string;
  title: string;
  size: number;
  digest: string;
  publisher: string;
  published_at: string;
};

export type ArtifactResult<T> = { ok: true; value: T } | { ok: false; status: number; reason: string };

function summaryOf(row: VersionRow): ArtifactSummary {
  return {
    name: row.name,
    title: row.title,
    owner: row.owner,
    version: row.version,
    size: row.size,
    digest: row.digest,
    publishedBy: JSON.parse(row.publisher) as ArtifactPublisher,
    publishedAt: row.published_at,
  };
}

export class Artifacts {
  constructor(
    private readonly storage: DurableObjectStorage,
    /** A Channel's publishes per UTC day. */
    private readonly perDay: number,
  ) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /** Each artifact's latest version, the latest published first. One row read per kept version. */
  list(): ArtifactSummary[] {
    return this.sql
      .exec<VersionRow>(
        `SELECT a.* FROM artifact_versions a
         JOIN (SELECT name, MAX(version) AS version FROM artifact_versions GROUP BY name) latest
           ON latest.name = a.name AND latest.version = a.version
         ORDER BY a.published_at DESC, a.name`,
      )
      .toArray()
      .map(summaryOf);
  }

  private versionsOf(name: string): number[] {
    return this.sql
      .exec<{ version: number }>("SELECT version FROM artifact_versions WHERE name = ? ORDER BY version", name)
      .toArray()
      .map((row) => row.version);
  }

  private row(name: string, version?: number): ArtifactResult<{ row: VersionRow; versions: number[] }> {
    const versions = this.versionsOf(name);
    if (versions.length === 0)
      return { ok: false, status: 404, reason: `No artifact is named ${name} on this Channel.` };
    const wanted = version ?? (versions.at(-1) as number);
    const row = this.sql
      .exec<VersionRow>("SELECT * FROM artifact_versions WHERE name = ? AND version = ?", name, wanted)
      .toArray()[0];
    if (row === undefined) {
      return {
        ok: false,
        status: 404,
        reason: `${name} keeps versions ${versions.join(", ")} only; it has no version ${wanted}.`,
      };
    }
    return { ok: true, value: { row, versions } };
  }

  /** One version of `name` (the latest when `version` is left out), and every version kept. */
  read(name: string, version?: number): ArtifactResult<{ artifact: ArtifactSummary; versions: number[] }> {
    const found = this.row(name, version);
    if (!found.ok) return found;
    return { ok: true, value: { artifact: summaryOf(found.value.row), versions: found.value.versions } };
  }

  /** One version's page, whole. */
  page(name: string, version?: number): ArtifactResult<{ artifact: ArtifactSummary; html: string }> {
    const found = this.row(name, version);
    if (!found.ok) return found;
    const { row } = found.value;
    const chunks = this.sql
      .exec<{ data: ArrayBuffer }>(
        "SELECT data FROM artifact_chunks WHERE name = ? AND version = ? ORDER BY idx",
        row.name,
        row.version,
      )
      .toArray();
    const bytes = new Uint8Array(row.size);
    let at = 0;
    for (const chunk of chunks) {
      const part = new Uint8Array(chunk.data);
      bytes.set(part, at);
      at += part.length;
    }
    return { ok: true, value: { artifact: summaryOf(row), html: new TextDecoder().decode(bytes) } };
  }

  /**
   * Publishes the next version of `name` for `publisher`, or says why not. The page and
   * title were checked already (`checkArtifact`). Publishing exactly what the latest
   * version holds writes nothing and is not counted.
   */
  async publish(
    publisher: ArtifactPublisher,
    name: string,
    page: { html: string; title: string },
  ): Promise<ArtifactResult<{ artifact: ArtifactSummary; published: boolean }>> {
    const bytes = new TextEncoder().encode(page.html);
    const digest = await sha256Hex(bytes);
    const latest = this.sql
      .exec<VersionRow>("SELECT * FROM artifact_versions WHERE name = ? ORDER BY version DESC LIMIT 1", name)
      .toArray()[0];
    if (latest !== undefined && latest.owner !== publisher.person) {
      return {
        ok: false,
        status: 403,
        reason: `${name} belongs to ${latest.owner}, who published it first. Publish yours under another name.`,
      };
    }
    if (latest !== undefined && latest.digest === digest && latest.title === page.title) {
      return { ok: true, value: { artifact: summaryOf(latest), published: false } };
    }
    if (latest === undefined) {
      const names = this.sql.exec<{ n: number }>("SELECT COUNT(DISTINCT name) AS n FROM artifact_versions").one().n;
      if (names >= MAX_ARTIFACTS) {
        return {
          ok: false,
          status: 409,
          reason: `This Channel holds its ${MAX_ARTIFACTS} artifacts. Publish a new version of one of them instead.`,
        };
      }
    }
    const version = (latest?.version ?? 0) + 1;
    const pruned = this.sql
      .exec<{ version: number; size: number }>(
        "SELECT version, size FROM artifact_versions WHERE name = ? AND version <= ?",
        name,
        version - ARTIFACT_VERSIONS_KEPT,
      )
      .toArray();
    const held =
      this.sql.exec<{ total: number | null }>("SELECT SUM(size) AS total FROM artifact_versions").one().total ?? 0;
    const after = held + bytes.length - pruned.reduce((sum, row) => sum + row.size, 0);
    if (after > MAX_CHANNEL_ARTIFACT_BYTES) {
      return {
        ok: false,
        status: 413,
        reason: `This Channel's artifacts would hold ${describeSize(after)}, over its ${describeSize(MAX_CHANNEL_ARTIFACT_BYTES)}. Publish a smaller page.`,
      };
    }
    const admitted = this.admit();
    if (!admitted.ok) return admitted;
    const row: VersionRow = {
      name,
      version,
      owner: latest?.owner ?? publisher.person,
      title: page.title,
      size: bytes.length,
      digest,
      publisher: JSON.stringify(publisher),
      published_at: new Date().toISOString(),
    };
    this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO artifact_versions (name, version, owner, title, size, digest, publisher, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        row.name,
        row.version,
        row.owner,
        row.title,
        row.size,
        row.digest,
        row.publisher,
        row.published_at,
      );
      for (let index = 0; index * ARTIFACT_CHUNK_BYTES < bytes.length; index++) {
        this.sql.exec(
          "INSERT INTO artifact_chunks (name, version, idx, data) VALUES (?, ?, ?, ?)",
          name,
          version,
          index,
          bytes.subarray(index * ARTIFACT_CHUNK_BYTES, (index + 1) * ARTIFACT_CHUNK_BYTES),
        );
      }
      for (const old of pruned) {
        this.sql.exec("DELETE FROM artifact_versions WHERE name = ? AND version = ?", name, old.version);
        this.sql.exec("DELETE FROM artifact_chunks WHERE name = ? AND version = ?", name, old.version);
      }
    });
    return { ok: true, value: { artifact: summaryOf(row), published: true } };
  }

  /**
   * Removes every kept version of `name` and its chunks, for its owner only. Afterwards
   * the name is free: whoever publishes it next owns it, from version 1.
   */
  delete(person: string, name: string): ArtifactResult<{ deleted: string; versions: number }> {
    const latest = this.sql
      .exec<{ owner: string }>("SELECT owner FROM artifact_versions WHERE name = ? ORDER BY version DESC LIMIT 1", name)
      .toArray()[0];
    if (latest === undefined)
      return { ok: false, status: 404, reason: `No artifact is named ${name} on this Channel.` };
    if (latest.owner !== person) {
      return {
        ok: false,
        status: 403,
        reason: `${name} belongs to ${latest.owner}, who published it first. Only they delete it.`,
      };
    }
    const versions = this.versionsOf(name).length;
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM artifact_versions WHERE name = ?", name);
      this.sql.exec("DELETE FROM artifact_chunks WHERE name = ?", name);
    });
    return { ok: true, value: { deleted: name, versions } };
  }

  /** Whether the Channel takes another publish today, counting it if so. */
  private admit(): { ok: true } | { ok: false; status: 429; reason: string } {
    const day = utcDay();
    const used = this.sql
      .exec<{ day: string; publishes: number }>("SELECT day, publishes FROM artifact_budget WHERE id = 1")
      .toArray()[0];
    if (used?.day === day && used.publishes >= this.perDay) {
      return {
        ok: false,
        status: 429,
        reason: `This Channel has taken its ${this.perDay} artifact publishes for today (UTC). Publish again tomorrow.`,
      };
    }
    this.sql.exec(
      `INSERT INTO artifact_budget (id, day, publishes) VALUES (1, ?, 1)
       ON CONFLICT (id) DO UPDATE SET
         publishes = CASE WHEN day = excluded.day THEN publishes + 1 ELSE 1 END,
         day = excluded.day`,
      day,
    );
    return { ok: true };
  }
}
