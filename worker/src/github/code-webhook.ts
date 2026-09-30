// GitHub `push` and `pull_request` webhook deliveries (ADR 0006): a push to a Task
// branch, a Task pull request opened into the default branch, or a merged PR.
// Other branches, tags, deleted branches and PRs closed without merging are ignored.

import type { TaskNumber } from "../../../shared/src/index";
import { isTaskBranch, taskOfBranch } from "../../../shared/src/index";

/** The code events the Channel subscribes to, besides the Issue events in webhook.ts. */
export const CODE_WEBHOOK_EVENTS: ReadonlySet<string> = new Set(["push", "pull_request"]);

/** The SHA git uses for "no commit": `before` of a new branch, `after` of a deleted one. */
const NO_COMMIT = /^0{40}$/;

export type CodeChange =
  | { kind: "pull_request"; pr: number; branch: string; task: TaskNumber; url: string }
  | {
      kind: "push";
      branch: string;
      task: TaskNumber | null;
      /** What to compare from: the commit before the push, or the default branch for a new branch. */
      base: string;
      /** The newest commit pushed. */
      head: string;
    }
  | {
      kind: "merge";
      pr: number;
      /** The pull request's branch. */
      branch: string;
      /** The default branch it merged into. */
      into: string;
      task: TaskNumber | null;
      /** The pull request's base and head commits: comparing them gives what it merged. */
      base: string;
      head: string;
      /** The commit on the default branch, or the head when GitHub does not say. */
      commit: string;
    };

type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null ? (value as Json) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Reads a `push` or `pull_request` delivery for the Channel's repo. Returns null for
 * anything that does not become an Event.
 */
export function readCodeWebhook(event: string, payload: unknown, repo: string): CodeChange | null {
  const body = object(payload);
  if (!CODE_WEBHOOK_EVENTS.has(event) || body === undefined) return null;
  const repository = object(body.repository);
  if (text(repository?.full_name)?.toLowerCase() !== repo.toLowerCase()) return null;
  const defaultBranch = text(repository?.default_branch) ?? "main";

  if (event === "push") {
    const ref = text(body.ref);
    if (ref === undefined || !ref.startsWith("refs/heads/") || body.deleted === true) return null;
    const branch = ref.slice("refs/heads/".length);
    const before = text(body.before);
    const after = text(body.after);
    if (!isTaskBranch(branch) || after === undefined || NO_COMMIT.test(after)) return null;
    const created = body.created === true || before === undefined || NO_COMMIT.test(before);
    return { kind: "push", branch, task: taskOfBranch(branch), base: created ? defaultBranch : before, head: after };
  }

  const pr = object(body.pull_request);
  if (pr === undefined) return null;
  const number = typeof pr.number === "number" ? pr.number : body.number;
  const base = object(pr.base);
  const head = object(pr.head);
  const into = text(base?.ref);
  const branch = text(head?.ref);
  const baseSha = text(base?.sha);
  const headSha = text(head?.sha);
  if (typeof number !== "number" || into !== defaultBranch || branch === undefined) return null;
  if (body.action === "opened" || body.action === "reopened") {
    const task = taskOfBranch(branch);
    const url = text(pr.html_url);
    // Fork branches can share a name with a Task branch in this repo.
    if (text(object(head?.repo)?.full_name)?.toLowerCase() !== repo.toLowerCase()) return null;
    if (!Number.isSafeInteger(number) || number <= 0 || task === null || url === undefined) return null;
    return { kind: "pull_request", pr: number, branch, task, url };
  }
  if (body.action !== "closed" || pr.merged !== true) return null;
  if (baseSha === undefined || headSha === undefined) return null;
  return {
    kind: "merge",
    pr: number,
    branch,
    into,
    task: taskOfBranch(branch),
    base: baseSha,
    head: headSha,
    commit: text(pr.merge_commit_sha) ?? headSha,
  };
}
