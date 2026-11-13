// The Dataset's collector (ADR 0054): copies the owner's sessions, new or changed since
// the last sync, from the agent CLIs' own files into the Dataset, redacted, with their
// outcomes linked. A session is redone whole when any of its files changed, and written
// by replacing its files, so a sync is idempotent; `state.json` is saved after every
// session, so a sync that stopped resumes where it was. One sync runs at a time.

import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type LinkDeps, linkOutcome, unsettled } from "./outcomes";
import { claudeSessionFiles, codexSessionId, type ParsedSession, parseClaudeSession, parseCodexSession } from "./parse";
import {
  DATASET_SCHEMA,
  type DatasetCli,
  type DatasetOutcome,
  type DatasetSession,
  type RedactionManifest,
} from "./schema";
import { type DatasetSources, discoverSources, keeps, readSources, sourcesPath } from "./sources";

/** How long a session whose outcome can still change waits before it is linked again. */
const RELINK_MS = 6 * 60 * 60_000;

/** A session's files as last read: their paths, sizes and modification times. */
type Fingerprint = string;

interface SessionState {
  cli: DatasetCli;
  fingerprint: Fingerprint;
  /** Kept, or skipped because its account is not the owner's. */
  kept: boolean;
  account: string | null;
  linkedAt?: string;
  unsettled?: boolean;
  /** The Codex session that started it, once one is known. */
  parent?: string;
}

interface SyncState {
  schema: typeof DATASET_SCHEMA;
  /** The sources the sessions were judged against; a change judges skipped ones again. */
  sources: string;
  sessions: Record<string, SessionState>;
}

export interface SyncOptions {
  dir: string;
  env?: NodeJS.ProcessEnv;
  /** What linking reaches; built by the command from the machine's config. */
  link: LinkDeps;
  /** Links every kept session again, changed or not. */
  relink?: boolean;
  now?: () => Date;
  say?: (line: string) => void;
}

export interface SyncReport {
  /** False when another sync holds the lock: nothing was done. */
  ran: boolean;
  scanned: number;
  written: number;
  relinked: number;
  unchanged: number;
  /** Sessions under accounts `sources.json` does not list, by account. */
  skipped: Record<string, number>;
  removed: number;
  failed: { session: string; error: string }[];
  /** Whether this sync wrote `sources.json` for the first time. */
  firstSync: boolean;
}

/** A session file found in a source. */
interface Found {
  cli: DatasetCli;
  id: string;
  file: string;
  /** Every file it is made of. */
  files: string[];
}

async function list(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** Every session file in the sources: Claude Code's `projects/*\/*.jsonl`, Codex's rollouts. */
async function findSessions(sources: DatasetSources): Promise<Found[]> {
  const found: Found[] = [];
  for (const source of sources.sources) {
    if (source.cli === "claude-code") {
      const projects = join(source.dir, "projects");
      for (const project of await list(projects)) {
        for (const name of await list(join(projects, project))) {
          if (!name.endsWith(".jsonl")) continue;
          const file = join(projects, project, name);
          found.push({
            cli: "claude-code",
            id: name.slice(0, -".jsonl".length),
            file,
            files: await claudeSessionFiles(file),
          });
        }
      }
    } else {
      const walk = async (dir: string): Promise<void> => {
        for (const name of await list(dir)) {
          const path = join(dir, name);
          if (name.endsWith(".jsonl"))
            found.push({ cli: "codex", id: codexSessionId(path), file: path, files: [path] });
          else if (!name.includes(".")) await walk(path);
        }
      };
      await walk(join(source.dir, "sessions"));
      await walk(join(source.dir, "archived_sessions"));
    }
  }
  return found;
}

async function fingerprint(files: readonly string[]): Promise<Fingerprint> {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const { size, mtimeMs } = await stat(file);
      parts.push(`${file}:${size}:${Math.floor(mtimeMs)}`);
    } catch {
      parts.push(`${file}:gone`);
    }
  }
  return parts.join("\n");
}

/** Writes `text` to `path` by replacing it whole, so a reader never sees half a file. */
async function replaceFile(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

/** Where a session's records live: `sessions/<cli>/<id>/`. */
export function sessionDir(dir: string, cli: DatasetCli, id: string): string {
  return join(dir, "sessions", cli, id);
}

function sessionRecord(
  cli: DatasetCli,
  parsed: ParsedSession,
  source: string,
  parent: string | undefined,
): DatasetSession {
  const counts = {
    turns: parsed.turns.length,
    prompts: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    corrections: 0,
  };
  for (const turn of parsed.turns) {
    if (turn.kind === "prompt") counts.prompts++;
    if (turn.role === "assistant") counts.assistantMessages++;
    for (const part of turn.parts) {
      if (part.type === "tool_use") counts.toolCalls++;
      if (part.type === "tool_result") counts.toolResults++;
    }
    if (turn.correction) counts.corrections++;
  }
  return {
    schema: DATASET_SCHEMA,
    id: parsed.id,
    cli,
    account: { id: parsed.account, source },
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    ...(parsed.startedAt === undefined ? {} : { startedAt: parsed.startedAt }),
    ...(parsed.endedAt === undefined ? {} : { endedAt: parsed.endedAt }),
    ...(parsed.cwds[0] === undefined ? {} : { cwd: parsed.cwds[0] }),
    cwds: parsed.cwds,
    gitBranches: parsed.gitBranches,
    models: parsed.models,
    ...(parent === undefined ? {} : { parent }),
    threads: parsed.threads,
    workflows: parsed.workflows,
    counts,
    correctionKinds: parsed.correctionKinds,
    tokens: parsed.tokens,
    redactions: parsed.redactions,
  };
}

/** Takes the sync lock, or says another sync holds it. A lock whose process is gone is taken over. */
async function lock(path: string): Promise<(() => Promise<void>) | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        await unlink(path).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
      let alive = false;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      if (alive) return null;
      await unlink(path).catch(() => {});
    }
  }
  return null;
}

async function readState(path: string, sources: string): Promise<SyncState> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as SyncState;
    if (state.schema === DATASET_SCHEMA && typeof state.sessions === "object") return state;
  } catch {
    // None yet, or from another schema: every session is written again.
  }
  return { schema: DATASET_SCHEMA, sources, sessions: {} };
}

/** Runs one sync. */
export async function syncDataset(options: SyncOptions): Promise<SyncReport> {
  const { dir, link } = options;
  const now = options.now ?? (() => new Date());
  const say = options.say ?? (() => {});
  const report: SyncReport = {
    ran: false,
    scanned: 0,
    written: 0,
    relinked: 0,
    unchanged: 0,
    skipped: {},
    removed: 0,
    failed: [],
    firstSync: false,
  };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const release = await lock(join(dir, "sync.lock"));
  if (release === null) return report;
  report.ran = true;
  try {
    let sources = await readSources(dir);
    if (sources === null) {
      sources = await discoverSources(options.env);
      await replaceFile(sourcesPath(dir), `${JSON.stringify(sources, null, 2)}\n`);
      report.firstSync = true;
      say(`Wrote ${sourcesPath(dir)}: the accounts whose sessions are kept. Edit it to change them.`);
    }
    const sourcesKey = JSON.stringify(sources);
    const statePath = join(dir, "state.json");
    const state = await readState(statePath, sourcesKey);
    const sourcesChanged = state.sources !== sourcesKey;
    state.sources = sourcesKey;
    const saveState = () => replaceFile(statePath, JSON.stringify(state));

    const found = await findSessions(sources);
    // Codex subagent threads name their parent in the parent's file: a child's parent is
    // known once the parent is read, so the parent's children are noted as found.
    for (const session of found) {
      report.scanned++;
      const key = `${session.cli}:${session.id}`;
      const known = state.sessions[key];
      const print = await fingerprint(session.files);
      const changed = known === undefined || known.fingerprint !== print || (sourcesChanged && !known.kept);
      const due =
        known?.kept === true &&
        (options.relink === true ||
          (known.unsettled === true && now().getTime() - Date.parse(known.linkedAt ?? "") > RELINK_MS));
      if (!changed && !due && !(sourcesChanged && known.kept)) {
        report.unchanged++;
        continue;
      }
      try {
        const parsed =
          session.cli === "claude-code"
            ? await parseClaudeSession(session.file)
            : await parseCodexSession(session.file);
        const out = sessionDir(dir, session.cli, session.id);
        if (!keeps(sources, session.cli, parsed.account)) {
          const label = parsed.account ?? "no account recorded";
          report.skipped[label] = (report.skipped[label] ?? 0) + 1;
          if (known?.kept) {
            await rm(out, { recursive: true, force: true });
            report.removed++;
          }
          state.sessions[key] = { cli: session.cli, fingerprint: print, kept: false, account: parsed.account };
          await saveState();
          continue;
        }
        for (const child of parsed.refs.children) {
          const childKey = `codex:${child}`;
          const childState = state.sessions[childKey];
          if (childState && childState.parent !== session.id) {
            childState.parent = session.id;
            childState.fingerprint = ""; // Written again with its parent.
          } else if (!childState) {
            state.sessions[childKey] = {
              cli: "codex",
              fingerprint: "",
              kept: false,
              account: null,
              parent: session.id,
            };
          }
        }
        await mkdir(out, { recursive: true, mode: 0o700 });
        const source = sources.sources.find((s) => session.file.startsWith(`${s.dir}/`))?.dir ?? "";
        if (changed || known?.kept !== true) {
          const turns = parsed.turns.map((turn) => JSON.stringify(turn)).join("\n");
          await replaceFile(join(out, "turns.jsonl"), turns === "" ? "" : `${turns}\n`);
          const record = sessionRecord(session.cli, parsed, source, known?.parent ?? state.sessions[key]?.parent);
          await replaceFile(join(out, "session.json"), `${JSON.stringify(record, null, 2)}\n`);
          report.written++;
        } else report.relinked++;
        const outcome = await linkOutcome(session.cli, parsed, link, now());
        await replaceFile(join(out, "outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);
        state.sessions[key] = {
          cli: session.cli,
          fingerprint: print,
          kept: true,
          account: parsed.account,
          linkedAt: outcome.linkedAt,
          unsettled: unsettled(outcome),
          ...(state.sessions[key]?.parent === undefined ? {} : { parent: state.sessions[key]?.parent as string }),
        };
        await saveState();
        if ((report.written + report.relinked) % 50 === 0)
          say(`${report.written + report.relinked} sessions done, ${report.scanned} of ${found.length} read`);
      } catch (error) {
        report.failed.push({ session: key, error: (error as Error).message });
      }
    }
    await writeIndexes(dir);
    return report;
  } finally {
    await release();
  }
}

/** Every kept session's records, read back. */
export async function* keptSessions(
  dir: string,
): AsyncGenerator<{ session: DatasetSession; outcome: DatasetOutcome | null }> {
  for (const cli of await list(join(dir, "sessions"))) {
    for (const id of await list(join(dir, "sessions", cli))) {
      const base = join(dir, "sessions", cli, id);
      let session: DatasetSession;
      try {
        session = JSON.parse(await readFile(join(base, "session.json"), "utf8")) as DatasetSession;
      } catch {
        continue;
      }
      let outcome: DatasetOutcome | null = null;
      try {
        outcome = JSON.parse(await readFile(join(base, "outcome.json"), "utf8")) as DatasetOutcome;
      } catch {
        // Not linked yet.
      }
      yield { session, outcome };
    }
  }
}

/** Rewrites `outcomes.jsonl` and `redactions.json` from every kept session. */
async function writeIndexes(dir: string): Promise<void> {
  const outcomes: string[] = [];
  const manifest: RedactionManifest = {
    schema: DATASET_SCHEMA,
    sessions: 0,
    sessionsWithRedactions: 0,
    total: 0,
    kinds: {},
  };
  for await (const { session, outcome } of keptSessions(dir)) {
    manifest.sessions++;
    const kinds = Object.entries(session.redactions);
    if (kinds.length > 0) manifest.sessionsWithRedactions++;
    for (const [kind, n] of kinds) {
      manifest.kinds[kind] = (manifest.kinds[kind] ?? 0) + n;
      manifest.total += n;
    }
    if (outcome !== null) outcomes.push(JSON.stringify(outcome));
  }
  manifest.kinds = Object.fromEntries(Object.entries(manifest.kinds).sort(([a], [b]) => a.localeCompare(b)));
  await replaceFile(join(dir, "outcomes.jsonl"), outcomes.length === 0 ? "" : `${outcomes.join("\n")}\n`);
  await replaceFile(join(dir, "redactions.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await replaceFile(
    join(dir, "schema.json"),
    `${JSON.stringify({ schema: DATASET_SCHEMA, docs: "https://github.com/shlok1806/switchboard/blob/main/docs/dataset.md" }, null, 2)}\n`,
  );
}
