// Opt-in: reads this repo's real Issues through the Channel API, read-only.
// Runs only when GITHUB_TOKEN is set, for example `GITHUB_TOKEN=$(gh auth token) npm test`.

import { env, reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskListResponse } from "../../shared/src/index";
import { installGitHub, RestGitHub, repoOf } from "../src/github/index";

afterEach(async () => {
  installGitHub(null);
  await reset();
});

describe.skipIf(!env.GITHUB_TOKEN)("the real GitHub (read-only)", () => {
  it("lists every open Issue in the repo as a Task", async () => {
    const repo = repoOf(env);
    const gitHub = new RestGitHub(env.GITHUB_TOKEN, repo);
    installGitHub(gitHub);

    const response = await exports.default.fetch(
      new Request("https://switchboard.test/api/tasks", {
        headers: { Authorization: "Bearer test-join-secret", "X-Switchboard-Person": "live-test" },
      }),
    );
    expect(response.status).toBe(200);
    const { tasks } = await response.json<TaskListResponse>();

    const open = await gitHub.listOpenIssues();
    expect(tasks.map((t) => t.number)).toEqual(open.map((issue) => issue.number).sort((a, b) => a - b));
    for (const task of tasks) {
      expect(task.status).toBe("open");
      expect(task.url).toBe(`https://github.com/${repo}/issues/${task.number}`);
      expect(task.stepsDone).toBe(task.steps.filter((step) => step.done).length);
      for (const blocker of task.blockedBy) expect(typeof blocker).toBe("number");
    }
  }, 30_000);
});
