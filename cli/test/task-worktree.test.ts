// Which directories are a clone of the Channel's repo, read from origin's URL.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { channelCheckout, remoteRepo } from "../src/task-worktree";

describe("remoteRepo", () => {
  it.each([
    ["https://github.com/Octo/Repo.git", "octo/repo"],
    ["https://github.com/octo/repo", "octo/repo"],
    ["https://github.com/octo/repo/", "octo/repo"],
    ["https://user@github.com/octo/repo.git", "octo/repo"],
    ["git@github.com:Octo/Repo.git", "octo/repo"],
    ["git@github.com:octo/repo", "octo/repo"],
    ["github-work:octo/repo.git", "octo/repo"],
    ["ssh://git@github.com/octo/repo.git", "octo/repo"],
    ["ssh://git@github.com:22/octo/repo", "octo/repo"],
    ["git://github.com/octo/my.repo.git", "octo/my.repo"],
  ])("%s names %s", (url, repo) => {
    expect(remoteRepo(url)).toBe(repo);
  });

  it.each([
    "/srv/git/origin.git",
    "../origin.git",
    "file:///srv/git/octo/repo.git",
    "https://github.com/octo",
    "C:\\repos\\octo\\repo",
    "",
  ])("%s names no repo", (url) => {
    expect(remoteRepo(url)).toBeNull();
  });
});

describe("channelCheckout", () => {
  const run = promisify(execFile);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, env })).stdout.trim();
  let scratch = "";

  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "switchboard-checkout-")));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function repoWithOrigin(name: string, url?: string): Promise<string> {
    const dir = join(scratch, name);
    await mkdir(dir);
    await git(dir, "init", "--quiet", "-b", "main");
    if (url !== undefined) await git(dir, "remote", "add", "origin", url);
    return dir;
  }

  it("finds the clone from its root, a subdirectory, or one of its worktrees", async () => {
    const root = await repoWithOrigin("clone", "git@github.com:Octo/Repo.git");
    await git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "x");
    await mkdir(join(root, "src"));
    const tree = join(scratch, "tree");
    await git(root, "worktree", "add", "--quiet", "-b", "side", tree);
    for (const dir of [root, join(root, "src"), tree]) {
      expect(await channelCheckout(dir, "octo/repo")).toMatchObject({ repo: "octo/repo", root });
    }
  });

  it("says which repo to clone when the directory is not a clone of it", async () => {
    const plain = join(scratch, "home");
    await mkdir(plain);
    const other = await repoWithOrigin("other", "https://github.com/someone/else.git");
    const bare = await repoWithOrigin("no-origin");
    const guide = "git clone https://github.com/octo/repo.git, then run switchboard from inside it.";
    await expect(channelCheckout(plain, "octo/repo")).rejects.toThrow(`${plain} is not inside a git repository.`);
    await expect(channelCheckout(plain, "octo/repo")).rejects.toThrow(guide);
    await expect(channelCheckout(other, "octo/repo")).rejects.toThrow(
      `${other} is a clone of someone/else, not of octo/repo.`,
    );
    await expect(channelCheckout(bare, "octo/repo")).rejects.toThrow(`${bare} has no origin remote. `);
  });
});
