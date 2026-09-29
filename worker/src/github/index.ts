// Picks the GitHub a Channel syncs with: the REST API when GITHUB_TOKEN is set,
// or whatever a test installed. Without either, Task sync is off.

import { RestGitHub } from "./rest";
import type { GitHub } from "./types";

export { GitHubApiError, RestGitHub } from "./rest";
export { parseSteps } from "./steps";
export type { GitHub, GitHubIssue, IssueRef, IssueState, NewIssue } from "./types";
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

export function gitHubFor(env: Env): GitHub | null {
  if (installed !== null) return installed;
  return env.GITHUB_TOKEN ? new RestGitHub(env.GITHUB_TOKEN, repoOf(env)) : null;
}
