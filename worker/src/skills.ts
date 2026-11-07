// Skills shared on the Channel (ADR 0039, 0050). A version is a row naming who published it
// and when, with its manifest as one row per file (path, size, SHA-256, encoding). The
// files' bytes are stored once each, by SHA-256, in chunks of at most 1 MiB, one per row:
// a file the same in two skills or two versions is stored once. A file is kept only once
// its bytes match its digest, and is checked for secrets then. A name belongs to the
// Person who first published it: only that Person, or one of their Agents, publishes its
// next versions. Versions are never removed, so an install names exactly what it was shown.

import type { PersonName, Skill, SkillEntry, SkillPublisher, SkillSummary } from "../../shared/src/index";
import {
  checkManifest,
  chunkCount,
  chunkLength,
  credentialFile,
  describeSecret,
  describeSize,
  MAX_CHANNEL_SKILL_BYTES,
  MAX_SKILL_FILE_BYTES,
  manifestDigest,
  SKILL_CHUNK_BYTES,
  SKILL_ENTRY,
  SKILL_TRANSFER_BYTES,
  secretIn,
  secretsRefusal,
  sha256Hex,
  skillDescription,
  sortedByPath,
  textOf,
} from "../../shared/src/index";
import type { Caller } from "./claims";

export const SKILLS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS skill_versions (
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    person TEXT NOT NULL,
    agent TEXT,
    published_at TEXT NOT NULL,
    digest TEXT NOT NULL,
    size INTEGER NOT NULL,
    description TEXT,
    PRIMARY KEY (name, version)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS skill_entries (
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    path TEXT NOT NULL,
    digest TEXT NOT NULL,
    size INTEGER NOT NULL,
    encoding TEXT NOT NULL,
    PRIMARY KEY (name, version, path)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS skill_entries_digest ON skill_entries (digest);
  CREATE TABLE IF NOT EXISTS skill_blobs (
    digest TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0,
    text INTEGER,
    secret TEXT,
    uploaded_at TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS skill_chunks (
    digest TEXT NOT NULL,
    idx INTEGER NOT NULL,
    data BLOB NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS skill_chunks_key ON skill_chunks (digest, idx);
`;

/** An upload no version holds is removed this long after it was uploaded. */
const UNPUBLISHED_TTL_MS = 24 * 60 * 60 * 1000;

type VersionRow = {
  name: string;
  version: number;
  person: string;
  agent: string | null;
  published_at: string;
  digest: string;
  size: number;
  description: string | null;
};

type BlobRow = { digest: string; size: number; complete: number; text: number | null; secret: string | null };

export type SkillResult<T> = { ok: true; value: T } | { ok: false; status: number; reason: string; missing?: string[] };

/** One chunk of an upload, its bytes decoded. */
export interface UploadedChunk {
  digest: string;
  size: number;
  index: number;
  data: Uint8Array;
}

function summary(row: VersionRow, paths: string[]): SkillSummary {
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
    paths,
    digest: row.digest,
  };
}

/**
 * Moves the versions ADR 0039 stored, each one row with its files as JSON, into the
 * tables above: each file stored by its SHA-256, each version's digest taken again over
 * its manifest. Run once, when a Channel first starts with ADR 0050's tables.
 */
export async function migrateSkills(storage: DurableObjectStorage): Promise<void> {
  const sql = storage.sql;
  // Asking for the old table, rather than scanning sqlite_master for it, reads no row once it is gone.
  let rows: (VersionRow & { files: string })[];
  try {
    rows = sql.exec<VersionRow & { files: string }>("SELECT * FROM skills ORDER BY name, version").toArray();
  } catch {
    return;
  }
  const now = new Date().toISOString();
  const moved = await Promise.all(
    rows.map(async (row) => {
      const files = await Promise.all(
        (JSON.parse(row.files) as { path: string; content: string }[]).map(async (file) => {
          const bytes = new TextEncoder().encode(file.content);
          return {
            path: file.path,
            bytes,
            entry: { path: file.path, size: bytes.length, digest: await sha256Hex(bytes), encoding: "utf8" as const },
          };
        }),
      );
      return { row, files, digest: await manifestDigest(files.map((file) => file.entry)) };
    }),
  );
  storage.transactionSync(() => {
    for (const { row, files, digest } of moved) {
      sql.exec(
        `INSERT OR IGNORE INTO skill_versions (name, version, person, agent, published_at, digest, size, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        row.name,
        row.version,
        row.person,
        row.agent,
        row.published_at,
        digest,
        row.size,
        row.description,
      );
      for (const { bytes, entry } of files) {
        sql.exec(
          "INSERT OR IGNORE INTO skill_entries (name, version, path, digest, size, encoding) VALUES (?, ?, ?, ?, ?, ?)",
          row.name,
          row.version,
          entry.path,
          entry.digest,
          entry.size,
          entry.encoding,
        );
        if (sql.exec("SELECT 1 FROM skill_blobs WHERE digest = ?", entry.digest).toArray().length > 0) continue;
        sql.exec(
          "INSERT INTO skill_blobs (digest, size, complete, text, secret, uploaded_at) VALUES (?, ?, 1, 1, NULL, ?)",
          entry.digest,
          entry.size,
          now,
        );
        for (let index = 0; index < chunkCount(bytes.length); index++) {
          sql.exec(
            "INSERT INTO skill_chunks (digest, idx, data) VALUES (?, ?, ?)",
            entry.digest,
            index,
            bytes.subarray(index * SKILL_CHUNK_BYTES, (index + 1) * SKILL_CHUNK_BYTES),
          );
        }
      }
    }
    sql.exec("DROP TABLE skills");
  });
}

export class Skills {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  private entries(name: string, version: number): SkillEntry[] {
    return this.sql
      .exec<{ path: string; size: number; digest: string; encoding: SkillEntry["encoding"] }>(
        "SELECT path, size, digest, encoding FROM skill_entries WHERE name = ? AND version = ? ORDER BY path",
        name,
        version,
      )
      .toArray()
      .map((row) => ({ path: row.path, size: row.size, digest: row.digest, encoding: row.encoding }));
  }

  /** Each skill's latest version, by name. */
  list(): SkillSummary[] {
    const latest = this.sql
      .exec<VersionRow>(
        `SELECT s.* FROM skill_versions s
         JOIN (SELECT name, MAX(version) AS version FROM skill_versions GROUP BY name) latest
           ON latest.name = s.name AND latest.version = s.version
         ORDER BY s.name`,
      )
      .toArray();
    return latest.map((row) =>
      summary(
        row,
        this.entries(row.name, row.version).map((entry) => entry.path),
      ),
    );
  }

  /** One version of `name` with its manifest (the latest when `version` is left out), and every version there is. */
  read(name: string, version?: number): SkillResult<{ skill: Skill; versions: number[] }> {
    const versions = this.sql
      .exec<{ version: number }>("SELECT version FROM skill_versions WHERE name = ? ORDER BY version", name)
      .toArray()
      .map((row) => row.version);
    if (versions.length === 0) return { ok: false, status: 404, reason: `No skill is named ${name} on this Channel.` };
    const wanted = version ?? (versions.at(-1) as number);
    const row = this.sql
      .exec<VersionRow>("SELECT * FROM skill_versions WHERE name = ? AND version = ?", name, wanted)
      .toArray()[0];
    if (!row) {
      return { ok: false, status: 404, reason: `${name} has no version ${wanted}; it has ${versions.join(", ")}.` };
    }
    const files = this.entries(name, wanted);
    return {
      ok: true,
      value: {
        skill: {
          ...summary(
            row,
            files.map((f) => f.path),
          ),
          files,
        },
        versions,
      },
    };
  }

  private blob(digest: string): BlobRow | undefined {
    return this.sql
      .exec<BlobRow>("SELECT digest, size, complete, text, secret FROM skill_blobs WHERE digest = ?", digest)
      .toArray()[0];
  }

  /** The whole of a stored file. */
  private bytesOf(digest: string, size: number): Uint8Array {
    const bytes = new Uint8Array(size);
    for (const row of this.sql.exec<{ idx: number; data: ArrayBuffer }>(
      "SELECT idx, data FROM skill_chunks WHERE digest = ? ORDER BY idx",
      digest,
    )) {
      bytes.set(new Uint8Array(row.data), row.idx * SKILL_CHUNK_BYTES);
    }
    return bytes;
  }

  private forget(digest: string): void {
    this.sql.exec("DELETE FROM skill_chunks WHERE digest = ?", digest);
    this.sql.exec("DELETE FROM skill_blobs WHERE digest = ?", digest);
  }

  /** Removes uploads no version holds, a day after they were uploaded. */
  private sweep(): void {
    const before = new Date(Date.now() - UNPUBLISHED_TTL_MS).toISOString();
    const stale = this.sql
      .exec<{ digest: string }>(
        `SELECT digest FROM skill_blobs b WHERE uploaded_at < ?
         AND NOT EXISTS (SELECT 1 FROM skill_entries e WHERE e.digest = b.digest)`,
        before,
      )
      .toArray();
    for (const { digest } of stale) this.forget(digest);
  }

  /**
   * Stores chunks of files. A file is kept once its last chunk arrives and its bytes match
   * its digest; it is then checked for a secret. Answers the files completed so far.
   */
  async upload(chunks: readonly UploadedChunk[]): Promise<SkillResult<{ complete: string[] }>> {
    let bytes = 0;
    for (const chunk of chunks) {
      if (
        !/^[0-9a-f]{64}$/.test(chunk.digest) ||
        !Number.isInteger(chunk.size) ||
        chunk.size < 0 ||
        !Number.isInteger(chunk.index) ||
        chunk.index < 0 ||
        chunk.index >= chunkCount(chunk.size)
      ) {
        return {
          ok: false,
          status: 400,
          reason: "Each chunk is { digest, size, index, data } for a file's SHA-256, its size and the chunk's number.",
        };
      }
      if (chunk.size > MAX_SKILL_FILE_BYTES) {
        return {
          ok: false,
          status: 400,
          reason: `A skill's file may be at most ${describeSize(MAX_SKILL_FILE_BYTES)}.`,
        };
      }
      if (chunk.data.length !== chunkLength(chunk.size, chunk.index)) {
        return {
          ok: false,
          status: 400,
          reason: `Chunk ${chunk.index} of a file of ${chunk.size} bytes is ${chunkLength(chunk.size, chunk.index)} bytes, not ${chunk.data.length}.`,
        };
      }
      bytes += chunk.data.length;
    }
    if (bytes > SKILL_TRANSFER_BYTES) {
      return {
        ok: false,
        status: 413,
        reason: `One upload carries at most ${describeSize(SKILL_TRANSFER_BYTES)} of files.`,
      };
    }
    this.sweep();
    const touched = new Set<string>();
    for (const chunk of chunks) {
      const blob = this.blob(chunk.digest);
      if (blob?.complete === 1) continue;
      if (blob !== undefined && blob.size !== chunk.size) {
        return {
          ok: false,
          status: 400,
          reason: `${chunk.digest} is being uploaded as ${blob.size} bytes, not ${chunk.size}.`,
        };
      }
      if (blob === undefined) {
        const stored =
          this.sql.exec<{ total: number | null }>("SELECT SUM(size) AS total FROM skill_blobs").one().total ?? 0;
        if (stored + chunk.size > MAX_CHANNEL_SKILL_BYTES) {
          return {
            ok: false,
            status: 507,
            reason: `This Channel already stores ${describeSize(stored)} of skill files, and holds at most ${describeSize(MAX_CHANNEL_SKILL_BYTES)}.`,
          };
        }
        this.sql.exec(
          "INSERT INTO skill_blobs (digest, size, complete, uploaded_at) VALUES (?, ?, 0, ?)",
          chunk.digest,
          chunk.size,
          new Date().toISOString(),
        );
      }
      this.sql.exec(
        "INSERT OR REPLACE INTO skill_chunks (digest, idx, data) VALUES (?, ?, ?)",
        chunk.digest,
        chunk.index,
        chunk.data,
      );
      touched.add(chunk.digest);
    }
    const complete: string[] = [];
    for (const digest of touched) {
      const blob = this.blob(digest);
      if (blob === undefined) continue;
      const have = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM skill_chunks WHERE digest = ?", digest)
        .one().n;
      if (have < chunkCount(blob.size)) continue;
      const bytes = this.bytesOf(digest, blob.size);
      if ((await sha256Hex(bytes)) !== digest) {
        this.forget(digest);
        return {
          ok: false,
          status: 400,
          reason: `A file uploaded as ${digest} does not match that SHA-256, so it was not kept.`,
        };
      }
      const found = secretIn(bytes);
      this.sql.exec(
        "UPDATE skill_blobs SET complete = 1, text = ?, secret = ? WHERE digest = ?",
        textOf(bytes) === null ? 0 : 1,
        found === null ? null : JSON.stringify(found),
        digest,
      );
      complete.push(digest);
    }
    for (const chunk of chunks)
      if (this.blob(chunk.digest)?.complete === 1 && !complete.includes(chunk.digest)) complete.push(chunk.digest);
    return { ok: true, value: { complete } };
  }

  /** Chunks of files some version holds, at most `SKILL_TRANSFER_BYTES` of them. */
  readChunks(
    wanted: readonly { digest: string; index: number }[],
  ): SkillResult<{ digest: string; index: number; data: Uint8Array }[]> {
    let bytes = 0;
    const out: { digest: string; index: number; data: Uint8Array }[] = [];
    for (const { digest, index } of wanted) {
      const blob = typeof digest === "string" ? this.blob(digest) : undefined;
      const held =
        blob?.complete === 1 &&
        this.sql.exec("SELECT 1 FROM skill_entries WHERE digest = ? LIMIT 1", digest).toArray().length > 0;
      if (!blob || !held || !Number.isInteger(index) || index < 0 || index >= chunkCount(blob.size)) {
        return { ok: false, status: 404, reason: `No published skill holds chunk ${index} of ${digest}.` };
      }
      bytes += chunkLength(blob.size, index);
      if (bytes > SKILL_TRANSFER_BYTES) {
        return {
          ok: false,
          status: 413,
          reason: `One read carries at most ${describeSize(SKILL_TRANSFER_BYTES)} of files.`,
        };
      }
      const row = this.sql
        .exec<{ data: ArrayBuffer }>("SELECT data FROM skill_chunks WHERE digest = ? AND idx = ?", digest, index)
        .toArray()[0];
      out.push({ digest, index, data: new Uint8Array(row?.data ?? new ArrayBuffer(0)) });
    }
    return { ok: true, value: out };
  }

  /**
   * Publishes the next version of `name` for `caller`, or says why not. The Channel must
   * hold every file first: a refusal with `missing` names those to upload. Files the latest
   * version already holds publish nothing and answer with it.
   */
  async publish(
    caller: Caller,
    name: string,
    files: SkillEntry[],
  ): Promise<SkillResult<{ skill: SkillSummary; published: boolean }>> {
    const checked = checkManifest(name, files);
    if (!checked.ok) return { ok: false, status: 400, reason: checked.reason };
    const latest = this.sql
      .exec<VersionRow>("SELECT * FROM skill_versions WHERE name = ? ORDER BY version DESC LIMIT 1", name)
      .toArray()[0];
    if (latest !== undefined && latest.person !== caller.person) {
      return {
        ok: false,
        status: 403,
        reason: `${name} belongs to ${latest.person}: only they and their Agents publish its versions. Publish yours under another name.`,
      };
    }
    const sorted = sortedByPath(files).map(({ path, size, digest, encoding }) => ({ path, size, digest, encoding }));
    const blobs = new Map(sorted.map((file) => [file.digest, this.blob(file.digest)]));
    const missing = [...blobs].filter(([, blob]) => blob?.complete !== 1).map(([digest]) => digest);
    if (missing.length > 0) {
      return {
        ok: false,
        status: 409,
        reason: `The Channel does not hold ${missing.length} of ${name}'s files yet: upload them, then publish again.`,
        missing,
      };
    }
    const secrets: string[] = [];
    for (const file of sorted) {
      const blob = blobs.get(file.digest) as BlobRow;
      if (blob.size !== file.size) {
        return { ok: false, status: 400, reason: `${file.path} is ${blob.size} bytes, not ${file.size}.` };
      }
      if ((blob.text === 1) !== (file.encoding === "utf8")) {
        return {
          ok: false,
          status: 400,
          reason: `${file.path} is ${blob.text === 1 ? "UTF-8 text" : "not UTF-8 text"}, so its encoding is ${blob.text === 1 ? "utf8" : "base64"}.`,
        };
      }
      if (blob.secret !== null) secrets.push(describeSecret(file.path, JSON.parse(blob.secret)));
      else if (credentialFile(file.path)) secrets.push(file.path);
    }
    if (secrets.length > 0) return { ok: false, status: 400, reason: secretsRefusal(name, secrets) };
    const digest = await manifestDigest(sorted);
    if (latest !== undefined && latest.digest === digest) {
      return {
        ok: true,
        value: {
          skill: summary(
            latest,
            sorted.map((f) => f.path),
          ),
          published: false,
        },
      };
    }
    const entry = sorted.find((file) => file.path === SKILL_ENTRY) as SkillEntry;
    const description = skillDescription(textOf(this.bytesOf(entry.digest, entry.size)) ?? undefined) ?? null;
    const row: VersionRow = {
      name,
      version: (latest?.version ?? 0) + 1,
      person: caller.person,
      agent: caller.agent ?? null,
      published_at: new Date().toISOString(),
      digest,
      size: checked.size,
      description,
    };
    this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO skill_versions (name, version, person, agent, published_at, digest, size, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        row.name,
        row.version,
        row.person,
        row.agent,
        row.published_at,
        row.digest,
        row.size,
        row.description,
      );
      for (const file of sorted) {
        this.sql.exec(
          "INSERT INTO skill_entries (name, version, path, digest, size, encoding) VALUES (?, ?, ?, ?, ?, ?)",
          row.name,
          row.version,
          file.path,
          file.digest,
          file.size,
          file.encoding,
        );
      }
    });
    return {
      ok: true,
      value: {
        skill: summary(
          row,
          sorted.map((f) => f.path),
        ),
        published: true,
      },
    };
  }
}

/** Who may publish under a name: kept here so the rule reads in one place. */
export type SkillOwner = PersonName;
