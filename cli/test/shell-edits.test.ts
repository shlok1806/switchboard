// What a shell command changed, from git snapshots of its worktree before and after it.

import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_HASHED_BYTES, MAX_SHELL_EDITS, ShellEdits, shellDir } from "../src/hooks/shell-edits";

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

/** Every object file in the repo's own object store; in `gitDir` when it is not `<dir>/.git`. */
async function objects(dir: string, gitDir = join(dir, ".git")): Promise<string[]> {
  const root = join(gitDir, "objects");
  const found: string[] = [];
  for (const sub of await readdir(root)) {
    if (sub === "info" || sub === "pack") continue;
    for (const name of await readdir(join(root, sub)).catch(() => [])) found.push(`${sub}/${name}`);
  }
  return found.sort();
}

/** Runs `change` as a shell command in `dir` would, between the two snapshots. */
async function around(edits: ShellEdits, dir: string, change: () => Promise<unknown>) {
  await edits.start("call", dir);
  await change();
  return edits.finish("call");
}

describe("ShellEdits", () => {
  it("reports changed, new and deleted files, but not ignored ones", async () => {
    const dir = await repo();
    const changes = await around(new ShellEdits(() => {}), dir, async () => {
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
    await writeFile(join(dir, "untracked.txt"), "already\n");
    const edits = new ShellEdits(() => {});
    expect(await around(edits, dir, async () => {})).toEqual([]);
    expect(await around(edits, dir, () => appendFile(join(dir, "src", "a.ts"), "during\n"))).toEqual([
      { path: "src/a.ts", additions: 1, deletions: 0 },
    ]);
  });

  it("reports a rename as a delete and an add, and a binary file with no line counts", async () => {
    const dir = await repo();
    const changes = await around(new ShellEdits(() => {}), dir, async () => {
      await rename(join(dir, "src", "b.ts"), join(dir, "src", "c.ts"));
      await writeFile(join(dir, "logo.png"), Buffer.from([0, 1, 2, 0, 255, 0]));
    });
    expect(changes).toEqual([
      { path: "logo.png", additions: 0, deletions: 0 },
      { path: "src/b.ts", additions: 0, deletions: 3 },
      { path: "src/c.ts", additions: 3, deletions: 0 },
    ]);
  });

  it("covers only the worktree the call runs in, not another Agent's Task worktree changing meanwhile", async () => {
    const dir = await repo();
    await appendFile(join(dir, ".git", "info", "exclude"), "/.switchboard/\n");
    const other = join(dir, ".switchboard", "worktrees", "task", "2-other");
    await git(dir, "worktree", "add", "--quiet", "-b", "task/2-other", other);
    const own = join(dir, ".switchboard", "worktrees", "task", "1-own");
    await git(dir, "worktree", "add", "--quiet", "-b", "task/1-own", own);
    const edits = new ShellEdits(() => {});
    // A's call runs in its own worktree (from a subdirectory); B edits its worktree at the same time.
    expect(
      await around(edits, join(own, "src"), async () => {
        await appendFile(join(own, "src", "a.ts"), "mine\n");
        await appendFile(join(other, "src", "a.ts"), "theirs\n");
        await appendFile(join(dir, "src", "b.ts"), "the Person's\n");
      }),
    ).toEqual([{ path: "src/a.ts", additions: 1, deletions: 0 }]);
  });

  it("follows a big file by its size and time, without reading it, and leaves no objects in the repo", async () => {
    const dir = await repo();
    const big = join(dir, "data.bin");
    await writeFile(big, Buffer.alloc(MAX_HASHED_BYTES * 40, 7));
    const logs: string[] = [];
    const edits = new ShellEdits((line) => logs.push(line));
    const stored = await objects(dir);
    const started = Date.now();
    // A big untracked file the command does not touch: nothing, and quickly.
    expect(await around(edits, dir, () => appendFile(join(dir, "src", "a.ts"), "3\n"))).toEqual([
      { path: "src/a.ts", additions: 1, deletions: 0 },
    ]);
    expect(Date.now() - started).toBeLessThan(1500);
    // The command changes it: reported, with no line counts.
    expect(await around(edits, dir, () => appendFile(big, "x"))).toEqual([
      { path: "data.bin", additions: 0, deletions: 0 },
    ]);
    expect(logs).toEqual([]);
    expect(await objects(dir)).toEqual(stored);
  });

  it("gives up on a snapshot that takes too long, killing git, and counts nothing", async () => {
    const dir = await repo();
    // A slow file system monitor stands in for a huge or slow repo: git status waits on it.
    await git(dir, "config", "core.fsmonitor", "sleep 5; :");
    const logs: string[] = [];
    const edits = new ShellEdits((line) => logs.push(line));
    const started = Date.now();
    expect(await around(edits, dir, () => appendFile(join(dir, "src", "a.ts"), "3\n"))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(logs.join("\n")).toContain("took over 1500 ms; not counted");
  });

  it("turns off the repo's clean filters for the snapshot", async () => {
    const dir = await repo();
    // A clean filter that would fail (as git-lfs does without its binary) and is required.
    await git(dir, "config", "filter.broken.clean", "false");
    await git(dir, "config", "filter.broken.required", "true");
    await writeFile(join(dir, ".gitattributes"), "*.dat filter=broken\n");
    const logs: string[] = [];
    const changes = await around(new ShellEdits((line) => logs.push(line)), dir, () =>
      writeFile(join(dir, "x.dat"), "a\nb\n"),
    );
    expect(logs).toEqual([]);
    expect(changes).toEqual([{ path: "x.dat", additions: 2, deletions: 0 }]);
  });

  it("reports nothing for a call it has no snapshot before, and at most MAX_SHELL_EDITS files", async () => {
    const dir = await repo();
    const logs: string[] = [];
    const edits = new ShellEdits((line) => logs.push(line));
    expect(await edits.finish("unknown")).toEqual([]);
    const many = await around(edits, dir, async () => {
      for (let i = 0; i < MAX_SHELL_EDITS + 5; i++) await writeFile(join(dir, `gen-${i}.txt`), "x\n");
    });
    expect(many).toHaveLength(MAX_SHELL_EDITS);
    expect(logs.join("\n")).toContain(`${MAX_SHELL_EDITS + 5} files changed`);
  });

  it("counts each change once when two shell calls run at the same time in one worktree (#91)", async () => {
    for (const firstDone of ["first", "second"] as const) {
      const dir = await repo();
      const edits = new ShellEdits(() => {});
      await edits.start("one", dir);
      await appendFile(join(dir, "src", "a.ts"), "one\n");
      await edits.start("two", dir);
      await appendFile(join(dir, "src", "b.ts"), "two\n");
      const early = await edits.finish(firstDone === "first" ? "one" : "two");
      await writeFile(join(dir, "late.txt"), "late\n");
      const late = await edits.finish(firstDone === "first" ? "two" : "one");
      // Together, every change once: not twice, and none missed.
      expect(
        [...early, ...late].sort((x, y) => x.path.localeCompare(y.path)),
        firstDone,
      ).toEqual([
        { path: "late.txt", additions: 1, deletions: 0 },
        { path: "src/a.ts", additions: 1, deletions: 0 },
        { path: "src/b.ts", additions: 1, deletions: 0 },
      ]);
    }
  });

  it("still counts only a call's own window once the calls that overlapped it are done", async () => {
    const dir = await repo();
    const edits = new ShellEdits(() => {});
    await edits.start("one", dir);
    await edits.start("two", dir);
    await appendFile(join(dir, "src", "a.ts"), "both\n");
    await edits.finish("one");
    await edits.finish("two");
    // An Edit tool's change between calls is its own, not the next shell call's.
    await appendFile(join(dir, "src", "b.ts"), "edit tool\n");
    expect(await around(edits, dir, () => writeFile(join(dir, "next.txt"), "x\n"))).toEqual([
      { path: "next.txt", additions: 1, deletions: 0 },
    ]);
  });

  it("pairs calls of the same key in order, for a CLI whose hooks name no call (Gemini CLI)", async () => {
    const dir = await repo();
    const edits = new ShellEdits(() => {});
    await edits.start("same", dir);
    await appendFile(join(dir, "src", "a.ts"), "first\n");
    await edits.start("same", dir);
    await appendFile(join(dir, "src", "b.ts"), "second\n");
    const changes = [...(await edits.finish("same")), ...(await edits.finish("same"))];
    expect(changes.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "src/a.ts", additions: 1, deletions: 0 },
      { path: "src/b.ts", additions: 1, deletions: 0 },
    ]);
    expect(await edits.finish("same")).toEqual([]);
  });

  it("reports files changed inside a submodule by their path in the worktree (#91)", async () => {
    const lib = await repo();
    const dir = await repo();
    await git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", lib, "vendor/lib");
    await git(dir, "commit", "--quiet", "-m", "Add lib");
    const sub = join(dir, "vendor", "lib");
    const stored = await objects(dir);
    const subGit = join(dir, ".git", "modules", "vendor", "lib");
    const subStored = await objects(sub, subGit);
    const changes = await around(new ShellEdits(() => {}), dir, async () => {
      await appendFile(join(sub, "src", "a.ts"), "3\n");
      await writeFile(join(sub, "new.ts"), "n\n");
      await appendFile(join(dir, "src", "b.ts"), "w\n");
    });
    expect(changes).toEqual([
      { path: "src/b.ts", additions: 1, deletions: 0 },
      { path: "vendor/lib/new.ts", additions: 1, deletions: 0 },
      { path: "vendor/lib/src/a.ts", additions: 1, deletions: 0 },
    ]);
    // Nothing left behind in either repo's objects.
    expect(await objects(dir)).toEqual(stored);
    expect(await objects(sub, subGit)).toEqual(subStored);
  });

  it("reports nothing outside a git repository, and says why", async () => {
    const plain = join(scratch, "plain");
    await mkdir(plain);
    const logs: string[] = [];
    const edits = new ShellEdits((line) => logs.push(line));
    expect(await around(edits, plain, () => writeFile(join(plain, "f.txt"), "x\n"))).toEqual([]);
    expect(logs.join("\n")).toContain("is not in a git worktree");
  });
});

describe("shellDir", () => {
  it("is the shell tool's own workdir when it has one, else the hook's cwd", () => {
    expect(shellDir("/repo/sub", { command: "ls" }, "/root")).toBe("/repo/sub");
    expect(shellDir("/repo", { command: ["ls"], workdir: "/repo/.switchboard/worktrees/x" }, "/root")).toBe(
      "/repo/.switchboard/worktrees/x",
    );
    expect(shellDir("/repo", { workdir: "pkg" }, "/root")).toBe("/repo/pkg");
    expect(shellDir(undefined, {}, "/root")).toBe("/root");
  });
});
