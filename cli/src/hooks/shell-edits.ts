// File changes made through the shell (#57). Edit tools report the files they
// change; a shell command (a heredoc, sed, a script) does not. So the Hook Capture
// takes a snapshot of the working trees just before each shell call (its
// PreToolUse hook, which the CLI waits for) and another just after (PostToolUse),
// and reports each file that differs as one `file.edit`, with the lines added and
// removed.
//
// A snapshot is a git tree of each worktree of the repo as it is on disk, made the
// way `git stash` makes one: `git add -A` into a temporary copy of the worktree's
// index, then `git write-tree`. So:
// - Tracked and untracked files count; ignored files do not (.gitignore, and
//   `.switchboard/` through .git/info/exclude, so a Task worktree is not seen twice).
// - Only files whose size or time changed are read, thanks to the index's stat
//   cache, so a snapshot of a big repo with a few changes stays cheap.
// - Every worktree is covered, the Task worktrees included, wherever the command
//   ran. Paths are relative to the worktree, as git and the Relay name them.
// - A rename shows as a delete and an add, a binary file as 0 lines each way.
// The blobs `git add` writes go to the repo's object store, unreferenced, as with
// `git stash create`; git's own gc clears them.
//
// Only the time the command runs is compared, so Edit-tool changes (their own
// calls) are never counted twice. A change the Person makes in the same worktree
// while the command runs is counted with it: nothing on disk tells them apart.

import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * How long the snapshot before a command may take: inside the 2 s the hook waits
 * for the wrapper's answer (hook-command.ts), after which the CLI runs the command
 * anyway. Past it, the call is left uncounted.
 */
const SNAPSHOT_TIMEOUT_MS = 1_500;
/** How long one git command may take. */
const GIT_TIMEOUT_MS = 30_000;
/** The most files one shell call reports. A build or an install into unignored files can touch thousands. */
export const MAX_SHELL_EDITS = 200;

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

/** Each worktree's tree as it was on disk, by worktree path. */
type Snapshot = Map<string, string>;

export class ShellEdits {
  /** Snapshots taken before shell calls that have not finished, by tool call ID. */
  private readonly before = new Map<string, Promise<Snapshot | null>>();

  /** `cwd` is anywhere inside the repo the session works in. */
  constructor(
    private readonly cwd: string,
    private readonly log: (line: string) => void,
  ) {}

  /**
   * A shell call is about to run: takes the snapshot it is compared against. The CLI
   * waits for this (and gives up on its hook after a while), so a snapshot that takes
   * too long is not used: the command may have started before it was done.
   */
  async start(callId: string): Promise<void> {
    const snapshot = this.timely("before");
    this.before.set(callId, snapshot);
    // Too many unfinished calls means their PostToolUse hooks never came: drop the oldest.
    if (this.before.size > 50) this.before.delete(this.before.keys().next().value ?? "");
    await snapshot;
  }

  /**
   * The shell call finished: the files it changed, at most MAX_SHELL_EDITS of them.
   * The CLI waits for the snapshot after it too (the PostToolUse hook), so the next
   * tool's changes, an Edit tool's say, are not counted with this command's.
   */
  async finish(callId: string): Promise<FileChange[]> {
    const before = await this.before.get(callId);
    this.before.delete(callId);
    if (!before) return [];
    const after = await this.timely("after");
    if (!after) return [];
    const changes: FileChange[] = [];
    for (const [worktree, tree] of after) {
      const old = before.get(worktree);
      if (old === undefined || old === tree) continue;
      changes.push(...(await this.diff(worktree, old, tree)));
    }
    if (changes.length > MAX_SHELL_EDITS) {
      this.log(`shell edits: ${changes.length} files changed; reporting the first ${MAX_SHELL_EDITS}`);
      return changes.slice(0, MAX_SHELL_EDITS);
    }
    return changes;
  }

  /**
   * A snapshot taken within SNAPSHOT_TIMEOUT_MS, or null. A late one is not used:
   * the CLI may have moved on (run the command, or the next tool) before it was done.
   */
  private async timely(when: "before" | "after"): Promise<Snapshot | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        this.log(`shell edits: the snapshot ${when} the command took over ${SNAPSHOT_TIMEOUT_MS} ms; not counted`);
        resolve(null);
      }, SNAPSHOT_TIMEOUT_MS);
    });
    const taken = this.snapshot().catch((error: Error) => {
      this.log(`shell edits: no snapshot ${when} the command: ${error.message}`);
      return null;
    });
    return Promise.race([taken, late]).finally(() => clearTimeout(timer));
  }

  private async git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
    const { stdout } = await run("git", args, {
      cwd,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  /** Every worktree of the repo that has a checkout. */
  private async worktrees(): Promise<string[]> {
    const list = await this.git(this.cwd, ["worktree", "list", "--porcelain", "-z"]);
    const paths: string[] = [];
    let path: string | null = null;
    for (const field of [...list.split("\0"), ""]) {
      if (field.startsWith("worktree ")) path = field.slice("worktree ".length);
      else if (field === "bare") path = null;
      else if (field === "" && path !== null) {
        paths.push(path);
        path = null;
      }
    }
    return paths;
  }

  private async snapshot(): Promise<Snapshot> {
    const snapshot: Snapshot = new Map();
    const scratch = await mkdtemp(join(tmpdir(), "switchboard-shell-"));
    try {
      for (const [n, worktree] of (await this.worktrees()).entries()) {
        const tree = await this.treeOf(worktree, join(scratch, `index-${n}`)).catch(() => null);
        if (tree !== null) snapshot.set(worktree, tree);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    return snapshot;
  }

  /** The worktree's files as a tree, through a copy of its index (whose stat cache spares unchanged files). */
  private async treeOf(worktree: string, index: string): Promise<string> {
    const own = (await this.git(worktree, ["rev-parse", "--git-path", "index"])).trim();
    await copyFile(isAbsolute(own) ? own : join(worktree, own), index).catch(() => {});
    const env = { GIT_INDEX_FILE: index };
    await this.git(worktree, ["add", "-A", "--", "."], env);
    return (await this.git(worktree, ["write-tree"], env)).trim();
  }

  private async diff(worktree: string, from: string, to: string): Promise<FileChange[]> {
    const out = await this.git(worktree, ["diff-tree", "-r", "-z", "--numstat", "--no-renames", from, to]);
    const changes: FileChange[] = [];
    // `<added>\t<deleted>\t<path>\0` per file; `-` for a binary file.
    for (const record of out.split("\0")) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
      if (!match) continue;
      const [, added = "-", deleted = "-", path = ""] = match;
      changes.push({
        path,
        additions: added === "-" ? 0 : Number(added),
        deletions: deleted === "-" ? 0 : Number(deleted),
      });
    }
    return changes;
  }
}
