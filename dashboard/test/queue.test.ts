// The Now view's queue: what waits on a Person, in the order a Person answers it, and
// which of it is yours.
import { describe, expect, it } from "vitest";
import type { Agent, AgentId, Task } from "@shared/index";
import { isMine, needsQueue } from "@/lib/queue";

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return { id: id as AgentId, person: id.split("/")[0]!, cli: "claude-code", presence: "live", startedAt: "2026-10-15T09:00:00.000Z", ...extra } as Agent;
}
const ask = (openedAt: string) => ({ id: "p1", tool: "Bash", openedAt }) as Agent["approval"];
function task(number: number, extra: Partial<Task>): Task {
  return { number, title: `Task ${number}`, status: "claimed", steps: [], stepsDone: 0, updatedAt: "2026-10-15T09:30:00.000Z", ...extra } as Task;
}

const mineLate = agent("shlok/claude/a", { approval: ask("2026-10-15T10:01:00.000Z") });
const mineEarly = agent("shlok/claude/b", { approval: ask("2026-10-15T10:00:00.000Z") });
const devs = agent("dev/claude/c", { approval: ask("2026-10-15T09:00:00.000Z") });
const goneWithPrompt = agent("shlok/claude/d", { presence: "gone", approval: ask("2026-10-15T09:00:00.000Z") });
const myCodex = agent("shlok/codex/e");

const stale = task(17, { claim: { task: 17, holder: { kind: "agent", agentId: "maya/gemini/x" as AgentId }, claimedAt: "", stale: true } });
const myReview = task(19, { status: "review", pr: 22, updatedAt: "2026-10-15T09:10:00.000Z", claim: { task: 19, holder: { kind: "agent", agentId: myCodex.id }, claimedAt: "", stale: false } });
const theirReview = task(21, { status: "review", pr: 23, claim: { task: 21, holder: { kind: "person", person: "maya" }, claimedAt: "", stale: false } });
const plain = task(12, { claim: { task: 12, holder: { kind: "agent", agentId: mineLate.id }, claimedAt: "", stale: false } });

describe("needsQueue", () => {
  const queue = needsQueue([mineLate, devs, goneWithPrompt, mineEarly, myCodex], [plain, theirReview, stale, myReview], "shlok");
  const keys = queue.map((i) => (i.kind === "ask" ? `ask ${i.agent.id}` : `${i.kind} #${i.task.number}`));

  it("puts your Asks first, oldest first, then Stale Claims, reviews, and others' Asks last", () => {
    expect(keys).toEqual(["ask shlok/claude/b", "ask shlok/claude/a", "stale #17", "review #19", "review #21", "ask dev/claude/c"]);
  });

  it("leaves out a Gone Agent's prompt and a Task that waits on nobody", () => {
    expect(keys).not.toContain("ask shlok/claude/d");
    expect(keys).not.toContain("claimed #12");
  });

  it("gives you a review only when someone else finished the Task", () => {
    const reviews = queue.filter((i) => i.kind === "review");
    expect(reviews.map((i) => [i.task.number, isMine(i)])).toEqual([
      [19, false],
      [21, true],
    ]);
  });

  it("counts a Stale Claim as yours, since anyone may take it over, and another Person's Ask as theirs", () => {
    expect(queue.filter(isMine).map((i) => i.kind)).toEqual(["ask", "ask", "stale", "review"]);
  });
});
