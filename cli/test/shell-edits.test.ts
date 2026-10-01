// What a shell command changed, from git snapshots of every worktree before and after it.

import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_SHELL_EDITS, ShellEdits } from "../src/hooks/shell-edits";

const run = promisify(execFile);
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, env })).stdout.trim();

let scratch = "";
let repoCount = 0;
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "switchboard-shell-edits-")));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A repo with src/a.ts (2 lines), src/b.ts (3 lines) and build/ ignored. */
async function repo(): Promise<string> {
  repoCount += 1;
  const dir = join(scratch, `repo-${repoCount}`);
  await mkdir(join(dir, "src"), { recursive: true });
  await git(dir, "init", "--quiet", "-b", "main");
  await writeFile(join(dir, "src", "a.ts"), "1\n2\n");
  await writeFile(join(dir, "src", "b.ts"), "x\ny\nz\n");
  await writeFile(join(dir, ".gitignore"), "build/\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "--quiet", "-m", "start");
  return dir;
}

/** Runs `change` as a shell command would, between the two snapshots. */
async function around(edits: ShellEdits, change: () => Promise<unknown>) {
  await edits.start("call");
  await change();
  return edits.finish("call");
}

describe("ShellEdits", () => {
  it("reports changed, new and deleted files, but not ignored ones", async () => {
    const dir = await repo();
    const edits = new ShellEdits(dir, () => {});
    const changes = await around(edits, async () => {
      await appendFile(join(dir, "src", "a.ts"), "3\n4\n");
      await rm(join(dir, "src", "b.ts"));
      await writeFile(join(dir, "notes.txt"), "n\n");
      await mkdir(join(dir, "build"));
      await writeFile(join(dir, "build", "out.js"), "ignored\n");
    });
    expect(changes).toEqual([
      { path: "notes.txt", additions: 1, deletions: 0 },
      { path: "src/a.ts", additions: 2, deletions: 0 },
      { path: "src/b.ts", additions: 0, deletions: 3 },
    ]);
  });

  it("counts only what changed during the command, not what was already changed before it", async () => {
    const dir = await repo();
    // Uncommitted before the command (an Edit tool, the Person): not the command's.
    await appendFile(join(dir, "src", "a.ts"), "before\n");
    const edits = new ShellEdits(dir, () => {});
    expect(await around(edits, async () => {})).toEqual([]);
    expect(await around(edits, () => appendFile(join(dir, "src", "a.ts"), "during\n"))).toEqual([
      { path: "src/a.ts", additions: 1, deletions: 0 },
    ]);
  });

  it("reports a rename as a delete and an add, and a binary file with no line counts", async () => {
    const dir = await repo();
    const edits = new ShellEdits(dir, () => {});
    const changes = await around(edits, async () => {
      await rename(join(dir, "src", "b.ts"), join(dir, "src", "c.ts"));
      await writeFile(join(dir, "logo.png"), Buffer.from([0, 1, 2, 0, 255, 0]));
    });
    expect(changes).toEqual([
      { path: "logo.png", additions: 0, deletions: 0 },
      { path: "src/b.ts", additions: 0, deletions: 3 },
      { path: "src/c.ts", additions: 3, deletions: 0 },
    ]);
  });

  it("covers every worktree, a Task worktree's paths relative to it, without counting it twice", async () => {
    const dir = await repo();
    await appendFile(join(dir, ".git", "info", "exclude"), "/.switchboard/\n");
    const tree = join(dir, ".switchboard", "worktrees", "task", "1-x");
    await git(dir, "worktree", "add", "--quiet", "-b", "task/1-x", tree);
    // Started in the main checkout; the command changes the Task worktree.
    const edits = new ShellEdits(dir, () => {});
    expect(await around(edits, () => appendFile(join(tree, "src", "a.ts"), "3\n"))).toEqual([
      { path: "src/a.ts", additions: 1, deletions: 0 },
    ]);
  });

  it("reports nothing for a call it has no snapshot before, and at most MAX_SHELL_EDITS files", async () => {
    const dir = await repo();
    const logs: string[] = [];
    const edits = new ShellEdits(dir, (line) => logs.push(line));
    expect(await edits.finish("unknown")).toEqual([]);
    const many = await around(edits, async () => {
      for (let i = 0; i < MAX_SHELL_EDITS + 5; i++) await writeFile(join(dir, `gen-${i}.txt`), "x\n");
    });
    expect(many).toHaveLength(MAX_SHELL_EDITS);
    expect(logs.join("\n")).toContain(`${MAX_SHELL_EDITS + 5} files changed`);
  });

  it("reports nothing outside a git repository, and says why", async () => {
    const plain = join(scratch, "plain");
    await mkdir(plain);
    const logs: string[] = [];
    const edits = new ShellEdits(plain, (line) => logs.push(line));
    expect(await around(edits, () => writeFile(join(plain, "f.txt"), "x\n"))).toEqual([]);
    expect(logs.join("\n")).toContain("no snapshot before the command");
  });
});
