import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
