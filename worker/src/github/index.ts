// Picks the GitHub a Channel syncs with: the REST API when GITHUB_TOKEN is set,
// or whatever a test installed. Without either, Task sync is off.

import { RestGitHub } from "./rest";
import type { GitHub } from "./types";

export type { CodeChange } from "./code-webhook";
export { CODE_WEBHOOK_EVENTS, readCodeWebhook } from "./code-webhook";
export { capFileChanges, parsePatch } from "./diff";
export { GitHubApiError, RestGitHub } from "./rest";
export { parseSteps, tickStep } from "./steps";
export type {
  ComparedFile,
  Comparison,
  GitHub,
  GitHubIssue,
  IssueRef,
  IssueState,
  NewIssue,
  NewPullRequest,
  PullRequestRef,
} from "./types";
export type { WebhookChange } from "./webhook";
export { readWebhook, sign, verifySignature, WEBHOOK_EVENTS } from "./webhook";

/** The repo a Channel mirrors when GITHUB_REPO is not set. */
export const DEFAULT_REPO = "shlok1806/switchboard";

let installed: GitHub | null = null;

/**
 * Replaces the GitHub every Channel uses, for tests. The Workers test runner runs
 * the Channel Durable Object in the test's own isolate, so this reaches it.
 */
export function installGitHub(gitHub: GitHub | null): void {
  installed = gitHub;
}

export function repoOf(env: Env): string {
  return env.GITHUB_REPO || DEFAULT_REPO;
}

declare global {
  interface Env {
    /**
     * Where the GitHub REST API lives. Unset in production (api.github.com); the
     * CLI end-to-end test points it at a local stand-in.
     */
    GITHUB_API_URL?: string;
  }
}

export function gitHubFor(env: Env): GitHub | null {
  if (installed !== null) return installed;
  return env.GITHUB_TOKEN ? new RestGitHub(env.GITHUB_TOKEN, repoOf(env), env.GITHUB_API_URL || undefined) : null;
}
