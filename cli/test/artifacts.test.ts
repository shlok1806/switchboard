// Artifacts on the laptop (ADR 0053): what a publish reads and refuses before anything
// leaves the machine, the folder pages are saved into, and when a page opens in a browser.

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactsDir, openInBrowser, preparePublish, savePage } from "../src/artifacts";
import { prepareSessionTools } from "../src/mcp-config";

const git = (cwd: string, ...args: string[]) =>
  promisify(execFile)("git", args, { cwd }).then(({ stdout }) => stdout.trim());

let scratch = "";
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "switchboard-artifacts-")));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("publishing a page", () => {
  it("reads a file relative to the session's directory, named after the file, byte for byte", async () => {
    const dir = join(scratch, "publish");
    await mkdir(join(dir, "reports"), { recursive: true });
    // A byte order mark and multi-byte text survive as they are.
    const html = "﻿<!doctype html><title>Receipt splitter</title><p>Split €12 three ways.</p>\n";
    await writeFile(join(dir, "reports", "Receipt Splitter.html"), html);
    expect(await preparePublish({ path: "reports/Receipt Splitter.html" }, dir)).toEqual({
      name: "receipt-splitter",
      html,
      from: join(dir, "reports", "Receipt Splitter.html"),
    });
    // A name given wins over the file's.
    expect((await preparePublish({ path: "reports/Receipt Splitter.html", name: "split" }, dir)).name).toBe("split");
  });

  it("takes the page itself only with a name, and never both a page and a file", async () => {
    const page = "<p>Hello</p>";
    expect(await preparePublish({ html: page, name: "hello", title: "  Hi\nthere " }, scratch)).toEqual({
      name: "hello",
      html: page,
      title: "Hi there",
    });
    await expect(preparePublish({ html: page }, scratch)).rejects.toThrow("A page given as html needs a name");
    await expect(preparePublish({ html: page, path: "a.html", name: "a" }, scratch)).rejects.toThrow(
      "Give exactly one of path",
    );
    await expect(preparePublish({ name: "a" }, scratch)).rejects.toThrow("Give exactly one of path");
  });

  it("refuses what is not an HTML file of UTF-8 text, and a page holding a secret, saying why but not the secret", async () => {
    const dir = join(scratch, "refused");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "notes.md"), "# Notes\n");
    await expect(preparePublish({ path: "notes.md" }, dir)).rejects.toThrow(
      `${join(dir, "notes.md")} is not an .html or .htm file.`,
    );
    await expect(preparePublish({ path: "missing.html" }, dir)).rejects.toThrow("There is no file");
    await writeFile(join(dir, "latin.html"), Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c]));
    await expect(preparePublish({ path: "latin.html" }, dir)).rejects.toThrow("is not UTF-8 text.");
    const token = "ghp_R8f2kLq9Zt3Xw7Vn1Bc6Hd4Jm0Ps5Yg2Ue8A";
    await writeFile(join(dir, "deploy.html"), `<title>Deploy</title>\n<script>const t = "${token}";</script>\n`);
    const refused = await preparePublish({ path: "deploy.html" }, dir).catch((error: Error) => error.message);
    expect(refused).toBe(
      "The page looks like it holds a secret (a GitHub token, line 2), so deploy was not published. Remove it and publish again.",
    );
  });
});

describe("the artifacts folder", () => {
  it("is .switchboard/artifacts at the clone's top, from anywhere inside it, and stays out of git status", async () => {
    const repo = join(scratch, "clone");
    await mkdir(join(repo, "src", "deep"), { recursive: true });
    await git(repo, "init", "--quiet");
    const dir = await artifactsDir(join(repo, "src", "deep"));
    expect(dir).toBe(join(repo, ".switchboard", "artifacts"));
    await savePage(join(dir as string, "report.html"), "<p>Report</p>");
    expect(await git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
    // Asked again, the exclude is not added twice.
    await artifactsDir(repo);
    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === "/.switchboard/")).toHaveLength(1);
  });

  it("is none outside a git repo", async () => {
    const plain = join(scratch, "plain");
    await mkdir(plain, { recursive: true });
    expect(await artifactsDir(plain)).toBeNull();
  });

  it("says when a save replaced a different copy", async () => {
    const path = join(scratch, "saved", "page.html");
    expect((await savePage(path, "<p>1</p>")).replaced).toBe(false);
    expect((await savePage(path, "<p>1</p>")).replaced).toBe(false);
    expect((await savePage(path, "<p>2</p>")).replaced).toBe(true);
    expect(await readFile(path, "utf8")).toBe("<p>2</p>");
  });
});

describe("opening a page in the browser", () => {
  /** A $BROWSER that writes the URL it was given to `opened`. */
  async function fakeBrowser(name: string): Promise<{ env: NodeJS.ProcessEnv; opened: string }> {
    const opened = join(scratch, `${name}.opened`);
    const script = join(scratch, `${name}.sh`);
    await writeFile(script, `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`);
    await chmod(script, 0o755);
    const { SWITCHBOARD_HOST: _, ...rest } = process.env;
    return { env: { ...rest, BROWSER: script }, opened };
  }

  async function openedUrl(path: string): Promise<string> {
    for (let i = 0; i < 100; i++) {
      const text = await readFile(path, "utf8").catch(() => "");
      if (text !== "") return text;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`nothing was opened (${path})`);
  }

  const link = "https://sb.example/octo/app#/artifacts/report/2";

  it("opens an Agent's page at its Person's terminal", async () => {
    const { env, opened } = await fakeBrowser("terminal");
    const tools = prepareSessionTools(scratch, "octo/app", env, { skillWrites: false });
    try {
      // The server runs with Claude Code's environment and its own on top, as Claude Code starts it.
      expect(await openInBrowser(link, { ...env, ...tools.server.env })).toEqual({ opened: true });
      expect(await openedUrl(opened)).toBe(link);
    } finally {
      tools.dispose();
    }
  });

  it("never opens one for an Agent on a Host, though its CLI never sees SWITCHBOARD_HOST", async () => {
    const { env, opened } = await fakeBrowser("host");
    // The wrapper on a Host has SWITCHBOARD_HOST; the CLI it starts, and so the server, does not.
    const tools = prepareSessionTools(
      scratch,
      "octo/app",
      { ...env, SWITCHBOARD_HOST: "studio" },
      { skillWrites: false },
    );
    try {
      const answer = await openInBrowser(link, { ...env, ...tools.server.env });
      expect(answer).toEqual({ opened: false, reason: "this Agent runs on a Host, with no screen anyone sees" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(stat(opened)).rejects.toThrow();
    } finally {
      tools.dispose();
    }
  });

  it("says so when the browser cannot start", async () => {
    const answer = await openInBrowser(link, { ...process.env, BROWSER: join(scratch, "no-such-browser") });
    expect(answer.opened).toBe(false);
  });
});
