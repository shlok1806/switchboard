// File changes made through the shell (#57). Edit tools report the files they
// change; a shell command (a heredoc, sed, a script) does not. So the Hook Capture
// takes a snapshot of the call's worktree just before each shell call (its
// PreToolUse hook, which the CLI waits for) and another just after (PostToolUse,
// which it also waits for), and reports each file that differs as one `file.edit`,
// with the lines added and removed.
//
// The worktree is the one the call runs in (the hook's `cwd`, or the shell tool's
// own `workdir`). Other worktrees are left alone: another Agent's Task worktree in
// the same clone (ADR 0006) changes while this command runs, and those changes are
// that Agent's.
//
// A snapshot is a git tree of the worktree as it is on disk, made the way
// `git stash` makes one: `git add` into a temporary copy of the worktree's index,
// then `git write-tree`. So:
// - Tracked and untracked files count; ignored files do not.
// - Only the files `git status` lists (changed or untracked) are read, and only
//   those up to MAX_HASHED_BYTES. A bigger file is followed by its size and time
//   alone, and reported with no line counts when they change.
// - Everything git writes goes to a scratch object directory (the repo's own is
//   read through it as an alternate), deleted after the call: nothing is left in
//   the Person's .git.
// - The repo's clean filters (git-lfs, git-crypt) are turned off for the snapshot.
// - A rename shows as a delete and an add, a binary file as 0 lines each way.
// - A submodule checked out in the worktree is snapshotted the same way, as part of
//   it: its files are reported by their path in the worktree (`vendor/lib/a.ts`).
// A snapshot that takes longer than SNAPSHOT_TIMEOUT_MS is abandoned and its git
// processes killed; that call is not counted.
//
// Only the time the command runs is compared, so Edit-tool changes (their own
// calls) are never counted twice. Shell calls of the session that run at the same
// time in one worktree share their snapshots: a call reports what changed since
// the last report of one of them, so each change is reported once (#91). Not told
// apart: the Person's changes in the same worktree while a command runs.

import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * How long a snapshot may take: inside the 2 s the hook waits for the wrapper's
 * answer (hook-command.ts), after which the CLI goes on anyway.
 */
const SNAPSHOT_TIMEOUT_MS = 1_500;
/** The largest file hashed to count its lines. Bigger ones are followed by size and time. */
export const MAX_HASHED_BYTES = 1024 * 1024;
/** The most files one shell call reports. A build or an install into unignored files can touch thousands. */
export const MAX_SHELL_EDITS = 200;
/** How deep submodules inside submodules are followed. */
const MAX_SUBMODULE_DEPTH = 3;
/** Scratch directories this old are left over from a wrapper that was killed mid-call. */
const STALE_SCRATCH_MS = 60 * 60 * 1000;
const SCRATCH_PREFIX = "switchboard-shell-";
/** The most shell calls waiting for their PostToolUse; past it the oldest are dropped (their hook never came). */
const MAX_OPEN_CALLS = 50;

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

/** One worktree as it was: its tree, the big files' sizes and times, and its checked-out submodules'. */
interface Snapshot {
  tree: string;
  big: Map<string, string>;
  submodules: Map<string, Snapshot>;
}

/** The shell calls under way in one worktree, which share a scratch directory and what they reported. */
interface Worktree {
  path: string;
  scratch: string;
  open: Set<Call>;
  /** Calls whose snapshot before is still being taken. */
  starting: number;
  /** The snapshot the last call to finish reported up to, and when (in call order). */
  reported: { snapshot: Snapshot; at: number } | null;
  /** Finishes one at a time, so each reports from where the one before stopped. */
  finishing: Promise<unknown>;
}

/** One shell call: its worktree, when it started (in call order), and the snapshot before it. */
interface Call {
  at: number;
  worktree: Worktree;
  before: Snapshot;
}

export class ShellEdits {
  /** Shell calls waiting for their PostToolUse, by key, oldest first: a key can come twice. */
  private readonly calls = new Map<string, Promise<Call | null>[]>();
  private readonly worktrees = new Map<string, Worktree>();
  private clock = 0;

  constructor(private readonly log: (line: string) => void) {
    void sweepStaleScratch();
  }

  /**
   * A shell call is about to run in `dir`: takes the snapshot it is compared against.
   * The CLI waits for this, so a snapshot that takes too long is not used: the
   * command may have started before it was done. `key` names the call: its ID, or
   * for a CLI whose hooks name none, its command and directory (calls with the same
   * key are paired in order).
   */
  async start(key: string, dir: string): Promise<void> {
    const call = this.begin(dir);
    this.calls.set(key, [...(this.calls.get(key) ?? []), call]);
    if (this.waiting() > MAX_OPEN_CALLS) this.dropOldest();
    await call;
  }

  /**
   * The shell call finished: the files changed since the last report of a shell call
   * overlapping it (else since it started), at most MAX_SHELL_EDITS of them. The CLI
   * waits for the snapshot after it too, so the next tool's changes, an Edit tool's
   * say, are not counted with this command's.
   */
  async finish(key: string): Promise<FileChange[]> {
    const queue = this.calls.get(key) ?? [];
    const pending = queue.shift();
    if (queue.length === 0) this.calls.delete(key);
    const call = await pending;
    if (!call) return [];
    const { worktree } = call;
    const done = worktree.finishing.then(() => this.report(call));
    worktree.finishing = done.catch(() => {});
    try {
      return await done;
    } finally {
      await this.close(call);
    }
  }

  private async report(call: Call): Promise<FileChange[]> {
    const { worktree } = call;
    const after = await this.timely("after", (signal) => snapshot(worktree.path, worktree.scratch, signal));
    if (!after) return [];
    const from = this.from(call);
    worktree.reported = { snapshot: after, at: ++this.clock };
    const changes = await changesBetween(worktree.path, worktree.scratch, from, after);
    if (changes.length > MAX_SHELL_EDITS) {
      this.log(`shell edits: ${changes.length} files changed; reporting the first ${MAX_SHELL_EDITS}`);
      return changes.slice(0, MAX_SHELL_EDITS);
    }
    return changes;
  }

  /**
   * What `call` reports from: the earliest start among it and the calls still open
   * that started before it, or, when a call reported after that, where it stopped.
   */
  private from(call: Call): Snapshot {
    let earliest = call;
    for (const other of call.worktree.open) if (other.at < earliest.at) earliest = other;
    const { reported } = call.worktree;
    return reported !== null && reported.at > earliest.at ? reported.snapshot : earliest.before;
  }

  private async begin(dir: string): Promise<Call | null> {
    let path: string;
    try {
      path = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    } catch (error) {
      this.log(`shell edits: ${dir} is not in a git worktree: ${(error as Error).message}`);
      return null;
    }
    let worktree = this.worktrees.get(path);
    if (!worktree) {
      worktree = { path, scratch: "", open: new Set(), starting: 0, reported: null, finishing: Promise.resolve() };
      this.worktrees.set(path, worktree);
    }
    const at = ++this.clock;
    // Counted while its snapshot is taken, so the scratch directory is not removed from under it.
    worktree.starting += 1;
    let call: Call | null = null;
    try {
      if (worktree.scratch === "") worktree.scratch = await mkdtemp(join(tmpdir(), SCRATCH_PREFIX));
      const scratch = worktree.scratch;
      const before = await this.timely("before", (signal) => snapshot(path, scratch, signal));
      if (before) {
        call = { at, worktree, before };
        worktree.open.add(call);
      }
      return call;
    } finally {
      worktree.starting -= 1;
      if (call === null) await this.release(worktree);
    }
  }

  /** The call is done: its worktree's scratch goes once no call there is open. */
  private async close(call: Call): Promise<void> {
    call.worktree.open.delete(call);
    await this.release(call.worktree);
  }

  private async release(worktree: Worktree): Promise<void> {
    if (worktree.open.size > 0 || worktree.starting > 0 || this.worktrees.get(worktree.path) !== worktree) return;
    this.worktrees.delete(worktree.path);
    if (worktree.scratch !== "") await rm(worktree.scratch, { recursive: true, force: true });
  }

  private waiting(): number {
    let count = 0;
    for (const queue of this.calls.values()) count += queue.length;
    return count;
  }

  /** Drops the oldest call waiting for its PostToolUse: it never came. */
  private dropOldest(): void {
    const oldest = this.calls.entries().next().value;
    if (oldest === undefined) return;
    const [key, queue] = oldest;
    const dropped = queue.shift();
    if (queue.length === 0) this.calls.delete(key);
    void dropped?.then((call) => call && this.close(call));
  }

  /** A snapshot taken within SNAPSHOT_TIMEOUT_MS, or null; a late one's git processes are killed. */
  private async timely(when: "before" | "after", take: (signal: AbortSignal) => Promise<Snapshot>) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SNAPSHOT_TIMEOUT_MS);
    try {
      return await take(abort.signal);
    } catch (error) {
      this.log(
        abort.signal.aborted
          ? `shell edits: the snapshot ${when} the command took over ${SNAPSHOT_TIMEOUT_MS} ms; not counted`
          : `shell edits: no snapshot ${when} the command: ${(error as Error).message}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Runs git, killed when `signal` aborts. `input` goes to its stdin. */
function git(
  cwd: string,
  args: string[],
  { env = {}, input, signal }: { env?: Record<string, string>; input?: string; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      ...(signal ? { signal } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`git ${args[0]} exited ${code}: ${Buffer.concat(err).toString("utf8").trim()}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

/** `-c` overrides that turn off every clean filter the repo configures (git-lfs, git-crypt). */
async function withoutFilters(worktree: string, signal: AbortSignal): Promise<string[]> {
  const names = await git(worktree, ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process)$"], {
    signal,
  }).catch(() => "");
  const filters = new Set(names.split("\n").flatMap((key) => /^filter\.(.+)\.(?:clean|process)$/.exec(key)?.[1] ?? []));
  return [...filters].flatMap((name) => [
    "-c",
    `filter.${name}.clean=cat`,
    "-c",
    `filter.${name}.process=`,
    "-c",
    `filter.${name}.required=false`,
  ]);
}

/** The repo's objects directory, which a snapshot reads through as an alternate. */
async function objectsOf(worktree: string, signal?: AbortSignal): Promise<string> {
  const args = ["rev-parse", "--path-format=absolute", "--git-path", "objects"];
  return (await git(worktree, args, signal ? { signal } : {})).trim();
}

/** The submodules checked out in `worktree`: the paths `.gitmodules` names that have their own `.git`. */
async function submodulesOf(worktree: string, signal: AbortSignal): Promise<string[]> {
  const listed = await readFile(join(worktree, ".gitmodules"), "utf8").catch(() => null);
  if (listed === null) return [];
  const out = await git(worktree, ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], {
    signal,
  }).catch(() => "");
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    const path = line.slice(line.indexOf(" ") + 1).trim();
    if (line.includes(" ") && path !== "" && !path.split("/").includes("..")) {
      if (await lstat(join(worktree, path, ".git")).catch(() => null)) paths.push(path);
    }
  }
  return paths;
}

/**
 * The worktree as a tree, its changed and untracked files up to MAX_HASHED_BYTES
 * read into it, through a copy of its index and into the scratch objects; and the
 * same for each submodule checked out in it.
 */
async function snapshot(worktree: string, scratch: string, signal: AbortSignal, depth = 0): Promise<Snapshot> {
  const index = (
    await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"], { signal })
  ).trim();
  const objects = await objectsOf(worktree, signal);
  const own = join(scratch, "objects");
  await mkdir(own, { recursive: true });
  const copy = join(scratch, `index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await copyFile(index, copy).catch(() => {});
  const env = { GIT_INDEX_FILE: copy, GIT_OBJECT_DIRECTORY: own, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
  const filters = await withoutFilters(worktree, signal);

  // What git sees changed or untracked, from the index's stat cache (nothing is written).
  const status = await git(
    worktree,
    [...filters, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules"],
    { env, signal },
  );
  const small: string[] = [];
  const big = new Map<string, string>();
  for (const entry of status.split("\0")) {
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    const info = await lstat(join(worktree, path)).catch(() => null);
    if (info?.isFile() && info.size > MAX_HASHED_BYTES) big.set(path, `${info.size}:${info.mtimeMs}`);
    else small.push(path);
  }
  if (small.length > 0) {
    await git(worktree, [...filters, "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      env: { ...env, GIT_LITERAL_PATHSPECS: "1" },
      signal,
      input: `${small.join("\0")}\0`,
    });
  }
  const tree = (await git(worktree, [...filters, "write-tree"], { env, signal })).trim();
  await rm(copy, { force: true });
  const submodules = new Map<string, Snapshot>();
  if (depth < MAX_SUBMODULE_DEPTH) {
    for (const path of await submodulesOf(worktree, signal)) {
      submodules.set(path, await snapshot(join(worktree, path), scratch, signal, depth + 1));
    }
  }
  return { tree, big, submodules };
}

/** One change per file that differs between two snapshots of a worktree, `prefix` before each path. */
async function changesBetween(
  worktree: string,
  scratch: string,
  before: Snapshot,
  after: Snapshot,
  prefix = "",
): Promise<FileChange[]> {
  const bigPaths = new Set([...before.big.keys(), ...after.big.keys()]);
  const changes: FileChange[] = [];
  if (before.tree !== after.tree) {
    const env = {
      GIT_OBJECT_DIRECTORY: join(scratch, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: await objectsOf(worktree),
    };
    const out = await git(worktree, ["diff-tree", "-r", "-z", "--numstat", "--no-renames", before.tree, after.tree], {
      env,
    });
    // `<added>\t<deleted>\t<path>\0` per file; `-` for a binary file.
    for (const record of out.split("\0")) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
      if (!match) continue;
      const [, added = "-", deleted = "-", path = ""] = match;
      // A big file is in the tree as git last indexed it, so its lines are not compared.
      if (bigPaths.has(path)) continue;
      changes.push({
        path: `${prefix}${path}`,
        additions: added === "-" ? 0 : Number(added),
        deletions: deleted === "-" ? 0 : Number(deleted),
      });
    }
  }
  // A big file changed when its size or time did, or it came or went (from the list, or as git has it).
  for (const path of bigPaths) {
    if (before.big.get(path) !== after.big.get(path))
      changes.push({ path: `${prefix}${path}`, additions: 0, deletions: 0 });
  }
  // A submodule checked out both times: its own changes, by their path in the worktree.
  for (const [path, then] of before.submodules) {
    const now = after.submodules.get(path);
    if (now) changes.push(...(await changesBetween(join(worktree, path), scratch, then, now, `${prefix}${path}/`)));
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Removes scratch directories left by a wrapper that was killed in the middle of a call. */
async function sweepStaleScratch(): Promise<void> {
  const dir = tmpdir();
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > STALE_SCRATCH_MS) await rm(path, { recursive: true, force: true });
  }
}

/** The directory a shell call runs in: the shell tool's own `workdir`, else the hook's `cwd`. */
export function shellDir(cwd: string | undefined, toolInput: Record<string, unknown> | undefined, fallback: string) {
  const base = cwd && isAbsolute(cwd) ? cwd : fallback;
  const workdir = toolInput?.workdir;
  return typeof workdir === "string" && workdir !== "" ? resolve(base, workdir) : base;
}

/**
 * What names a shell call between its PreToolUse and PostToolUse: its ID, or for a CLI
 * whose hooks name no call (Gemini CLI), its directory and command.
 */
export function shellCallKey(callId: string | undefined, dir: string, toolInput: Record<string, unknown> | undefined) {
  return callId !== undefined && callId !== "" ? callId : `${dir}\0${JSON.stringify(toolInput?.command ?? null)}`;
}
