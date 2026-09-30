// Opt-in: reads this repo's real Issues through the Channel API, read-only.
// Runs only when LIVE_GITHUB_TOKEN is set, for example
// `LIVE_GITHUB_TOKEN=$(gh auth token) npm test`. Any token that can read the repo
// stands in for the GitHub App's installation token here.

import { env, reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskListResponse } from "../../shared/src/index";
import { installGitHub, RestGitHub } from "../src/github/index";
import { bearer, REPO, url } from "./client";

const token = (env as { LIVE_GITHUB_TOKEN?: string }).LIVE_GITHUB_TOKEN;

afterEach(async () => {
  installGitHub(null);
  await reset();
});

describe.skipIf(!token)("the real GitHub (read-only)", () => {
  it("lists every open Issue in the repo as a Task", async () => {
    const gitHub = new RestGitHub({ token: async () => token ?? "", invalidate: () => {} }, REPO);
    installGitHub(gitHub);

    const response = await exports.default.fetch(
      new Request(url("/api/tasks"), { headers: { Authorization: await bearer("shlok1806") } }),
    );
    expect(response.status).toBe(200);
    const { tasks } = await response.json<TaskListResponse>();

    const open = await gitHub.listOpenIssues();
    expect(tasks.map((t) => t.number)).toEqual(open.map((issue) => issue.number).sort((a, b) => a - b));
    for (const task of tasks) {
      expect(task.status).toBe("open");
      expect(task.url).toBe(`https://github.com/${REPO}/issues/${task.number}`);
      expect(task.stepsDone).toBe(task.steps.filter((step) => step.done).length);
      for (const blocker of task.blockedBy) expect(typeof blocker).toBe("number");
    }
  }, 30_000);
});
