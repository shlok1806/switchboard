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
    ["https://github.com/octo/repo.git/", "octo/repo"],
    ["https://www.github.com/octo/repo", "octo/repo"],
    ["https://GitHub.com:443/octo/repo.git", "octo/repo"],
    ["https://user:token@github.com/octo/repo.git", "octo/repo"],
    ["https://github.com/octo/repo?q=1#frag", "octo/repo"],
    ["  https://github.com/octo/repo  ", "octo/repo"],
    ["git@github.com:Octo/Repo.git", "octo/repo"],
    ["git@github.com:octo/repo", "octo/repo"],
    ["git@github.com:/octo/repo.git", "octo/repo"],
    ["org-123@github.com:octo/repo.git", "octo/repo"],
    ["ssh://git@github.com/octo/repo.git", "octo/repo"],
    ["ssh://git@github.com:22/octo/repo", "octo/repo"],
    ["ssh://git@ssh.github.com:443/octo/repo.git", "octo/repo"],
    ["git+ssh://git@github.com/octo/repo", "octo/repo"],
    ["git://github.com/octo/my.repo.git", "octo/my.repo"],
    // SSH host aliases from ~/.ssh/config, and insteadOf shorthands, have no dots.
    ["github-work:octo/repo.git", "octo/repo"],
    ["gh:octo/repo", "octo/repo"],
    ["ssh://git@github-work/octo/repo.git", "octo/repo"],
    ["https://github.com/octo/octo.github.io", "octo/octo.github.io"],
  ])("%s names %s", (url, repo) => {
    expect(remoteRepo(url)).toBe(repo);
  });

  it.each([
    // Not exactly owner/repo.
    "https://github.com/someone/owner/repo",
    "https://gitlab.com/group/sub/owner/repo.git",
    "host:/srv/git/owner/repo.git",
    "C:/Users/me/owner/repo",
    "https://github.com/octo",
    // Not GitHub.
    "https://gitlab.com/owner/repo",
    "https://evil.example/owner/repo",
    "git@gitlab.com:owner/repo.git",
    "ssh://git@bitbucket.org/owner/repo.git",
    "https://gitserver/owner/repo",
    // Local.
    "/srv/git/origin.git",
    "../origin.git",
    "file:///srv/git/octo/repo.git",
    "C:\\repos\\octo\\repo",
    "octo/repo",
    "",
  ])("%s names no repo", (url) => {
    expect(remoteRepo(url)).toBeNull();
  });
});

describe("channelCheckout", () => {
  const run = promisify(execFile);
  let scratch = "";
  let env: NodeJS.ProcessEnv = {};
  const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, env })).stdout.trim();
  const guide = "git clone https://github.com/octo/repo.git, then run switchboard from inside it.";

  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "switchboard-checkout-")));
    env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
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
    await git(root, "commit", "--quiet", "--allow-empty", "-m", "x");
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
    const none = await repoWithOrigin("no-origin");
    await expect(channelCheckout(plain, "octo/repo")).rejects.toThrow(`${plain} is not inside a git repository.`);
    await expect(channelCheckout(plain, "octo/repo")).rejects.toThrow(guide);
    await expect(channelCheckout(other, "octo/repo")).rejects.toThrow(
      `${other} is a clone of someone/else, not of octo/repo.`,
    );
    await expect(channelCheckout(none, "octo/repo")).rejects.toThrow(`${none} has no origin remote. `);
  });

  it("never prints the credentials in an origin URL", async () => {
    const dir = await repoWithOrigin("token", "https://me:s3cret-token@gitlab.com/group/sub/repo.git");
    const refusal = channelCheckout(dir, "octo/repo");
    await expect(refusal).rejects.toThrow(
      `${dir} is a clone of https://gitlab.com/group/sub/repo.git, not of octo/repo.`,
    );
    await expect(refusal).rejects.not.toThrow("s3cret");
  });

  it("refuses an origin with several URLs, or a push URL, that are not all the Channel's repo", async () => {
    const several = await repoWithOrigin("several", "https://github.com/octo/repo.git");
    await git(several, "config", "--add", "remote.origin.url", "https://github.com/someone/else.git");
    await expect(channelCheckout(several, "octo/repo")).rejects.toThrow(
      `${several} is a clone of someone/else, not of octo/repo.`,
    );
    const pushes = await repoWithOrigin("pushes", "https://github.com/octo/repo.git");
    await git(pushes, "config", "remote.origin.pushurl", "git@github.com:someone/else.git");
    await expect(channelCheckout(pushes, "octo/repo")).rejects.toThrow(
      `${pushes} is a clone of someone/else, not of octo/repo.`,
    );
    // Several URLs that all name the repo are fine.
    const same = await repoWithOrigin("same", "https://github.com/octo/repo.git");
    await git(same, "config", "--add", "remote.origin.url", "git@github.com:octo/repo.git");
    await git(same, "config", "remote.origin.pushurl", "git@github.com:Octo/Repo");
    expect(await channelCheckout(same, "octo/repo")).toMatchObject({ root: same });
  });

  it("says what a checkout with its git directory elsewhere is, and that it is not supported", async () => {
    const bare = join(scratch, "bare.git");
    await run("git", ["init", "--quiet", "--bare", "-b", "main", bare], { env });
    await git(bare, "remote", "add", "origin", "https://github.com/octo/repo.git");
    await expect(channelCheckout(bare, "octo/repo")).rejects.toThrow(
      `${bare} is a bare repository, with no checkout to work in.`,
    );
    const seed = await repoWithOrigin("seed", bare);
    await git(seed, "commit", "--quiet", "--allow-empty", "-m", "x");
    await git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    const bareTree = join(scratch, "bare-tree");
    await git(bare, "worktree", "add", "--quiet", bareTree, "main");
    const separate = join(scratch, "separate");
    await run("git", ["clone", "--quiet", "--separate-git-dir", join(scratch, "separate.git"), bare, separate], {
      env,
    });
    for (const dir of [bareTree, separate]) {
      const refusal = channelCheckout(dir, "octo/repo");
      await expect(refusal).rejects.toThrow(`${dir} is a checkout whose git directory is not inside it`);
      await expect(refusal).rejects.toThrow("Switchboard works only in a plain clone");
      await expect(refusal).rejects.not.toThrow("is a bare repository");
    }
  });
});
