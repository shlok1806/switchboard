import { describe, expect, it } from "vitest";
import type { Task } from "../../shared/src/domain";
import type { MemoryNote } from "../../shared/src/memory";
import { safeMemoryNote, safeTask } from "../src/managed-projection";

const task: Task = {
  number: 1,
  title: "Task",
  description: "Public description",
  labels: [],
  blockedBy: [],
  subtasks: [],
  subtasksDone: 0,
  steps: [],
  stepsDone: 0,
  url: "https://example.test/issues/1",
  status: "claimed",
  updatedAt: "now",
  claim: { task: 1, holder: { kind: "person", person: "legacy-login" }, claimedAt: "now", stale: false },
};
const note: MemoryNote = {
  seq: 1,
  id: "note",
  at: "now",
  author: "legacy-login/codex/session",
  person: "legacy-login",
  nickname: "private-marker",
  tags: ["decision"],
  text: "Public note",
};
describe("managed native content projection allowlists (QL-4)", () => {
  it("requires independently admitted holder attribution rather than copying legacy Person logins", () => {
    expect(safeTask(task)).toBeNull();
    expect(safeTask(task, { kind: "person", personId: "native-person" })).toMatchObject({
      claim: { holder: { kind: "person", personId: "native-person" } },
    });
    expect(JSON.stringify(safeTask(task, { kind: "person", personId: "native-person" }))).not.toMatch(
      /legacy-login|nickname/,
    );
  });
  it("constructs Task and note fields by allowlist without spreading extension fields", () => {
    const projectedTask = safeTask({ ...task, secret: "private-marker" } as Task, {
      kind: "agent",
      agentId: "admitted/codex/id",
    });
    expect(projectedTask?.claim?.holder).toEqual({ kind: "agent", agentId: "admitted/codex/id" });
    const projectedNote = safeMemoryNote({ ...note, secret: "private-marker" } as MemoryNote, {
      kind: "person",
      personId: "native-person",
    });
    expect(projectedNote).toEqual({
      seq: 1,
      id: "note",
      at: "now",
      author: { kind: "person", personId: "native-person" },
      tags: ["decision"],
      text: "Public note",
    });
    expect(JSON.stringify([projectedTask, projectedNote])).not.toMatch(/legacy-login|private-marker|nickname|secret/);
  });
  it("copies mutable public arrays and constructs attribution independently", () => {
    const source = { ...note, tags: ["decision"] as MemoryNote["tags"], files: ["public.ts"] };
    const projected = safeMemoryNote(source, { kind: "agent", agentId: "enrolled/codex/id" });
    source.tags.push("question");
    source.files.push("other.ts");
    expect(projected.tags).toEqual(["decision"]);
    expect(projected.files).toEqual(["public.ts"]);
    expect(projected.author).toEqual({ kind: "agent", agentId: "enrolled/codex/id" });
  });
});
