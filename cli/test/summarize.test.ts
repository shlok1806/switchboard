import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HookSummarizer, repoPath } from "../src/hooks/summarize";

const root = realpathSync(mkdtempSync(join(tmpdir(), "switchboard-summarize-")));
const tree = join(root, ".switchboard", "worktrees", "task", "2-add-a-farewell");
mkdirSync(join(root, ".git"));
mkdirSync(join(tree, "src"), { recursive: true });
// A git worktree has a `.git` file pointing at the main checkout's git directory.
writeFileSync(join(tree, ".git"), `gitdir: ${join(root, ".git", "worktrees", "2-add-a-farewell")}\n`);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("repoPath", () => {
  it("names a file in the repo relative to it", () => {
    expect(repoPath(root, join(root, "src", "greet.ts"))).toBe("src/greet.ts");
    expect(repoPath(root, "src/greet.ts")).toBe("src/greet.ts");
  });

  it("names a file in a Task worktree as git does, relative to that worktree", () => {
    expect(repoPath(root, join(tree, "src", "greet.ts"))).toBe("src/greet.ts");
    expect(repoPath(root, ".switchboard/worktrees/task/2-add-a-farewell/src/greet.ts")).toBe("src/greet.ts");
  });

  it("leaves a path outside the repo as given", () => {
    expect(repoPath(root, "/etc/hosts")).toBe("/etc/hosts");
  });

  it("names a file reached through a symlink, as macOS's /var is to /private/var", () => {
    const link = join(realpathSync(tmpdir()), `switchboard-summarize-link-${process.pid}`);
    symlinkSync(root, link);
    try {
      // The file through the link, the repo by its real path; and the other way round.
      expect(repoPath(root, join(link, "src", "greet.ts"))).toBe("src/greet.ts");
      expect(repoPath(link, join(root, "src", "greet.ts"))).toBe("src/greet.ts");
      expect(repoPath(root, join(link, ".switchboard", "worktrees", "task", "2-add-a-farewell", "src", "new.ts"))).toBe(
        "src/new.ts",
      );
      // A file the tool is about to create, in a directory that does not exist yet.
      expect(repoPath(root, join(link, "docs", "guide", "new.md"))).toBe("docs/guide/new.md");
    } finally {
      rmSync(link, { force: true });
    }
  });
});

describe("HookSummarizer", () => {
  it("reports an edit in a Task worktree with the path pushes use", () => {
    const events = new HookSummarizer(root).summarize({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(tree, "src", "greet.ts"), old_string: "a", new_string: "b" },
    });
    expect(events).toContainEqual({ type: "file.edit", payload: { path: "src/greet.ts", additions: 1, deletions: 1 } });
  });
});
