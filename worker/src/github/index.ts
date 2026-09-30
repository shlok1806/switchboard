// Picks the GitHub a Channel syncs with: the GitHub App's client for the Channel's
// repo when the App is configured, or whatever a test installed. Without either,
// Task sync and sign-in are off, and say so.

import { appFor, type GitHubSignIn } from "./app";
import type { GitHub } from "./types";

export type { DevicePoll, GitHubAppCredentials, GitHubSignIn } from "./app";
export { appFor, GitHubApp, missingAppSecrets, readPrivateKey } from "./app";
export type { CodeChange } from "./code-webhook";
export { CODE_WEBHOOK_EVENTS, readCodeWebhook } from "./code-webhook";
export { capFileChanges, parsePatch } from "./diff";
export { GitHubApiError, RestGitHub, type TokenSource } from "./rest";
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
  Permission,
  PullRequestRef,
} from "./types";
export { canWrite } from "./types";
export type { WebhookChange } from "./webhook";
export { readWebhook, sign, verifySignature, WEBHOOK_EVENTS } from "./webhook";

/** Said wherever GitHub is needed and the App has not been set up (docs/github-app-setup.md). */
export const APP_NOT_CONFIGURED = "GitHub App not configured. See docs/github-app-setup.md.";

let installed: GitHub | null = null;
let installedSignIn: GitHubSignIn | null = null;

/**
 * Replaces the GitHub the Channel for `gitHub.repo` uses, for tests. The Workers test
 * runner runs the Channel Durable Object in the test's own isolate, so this reaches it.
 */
export function installGitHub(gitHub: GitHub | null): void {
  installed = gitHub;
}

/** Replaces GitHub sign-in (the web and device flows), for tests. */
export function installGitHubSignIn(signIn: GitHubSignIn | null): void {
  installedSignIn = signIn;
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

/** The GitHub for the Channel of `repo`, or null when there is none. */
export function gitHubFor(env: Env, repo: string): GitHub | null {
  if (installed !== null) return installed.repo.toLowerCase() === repo.toLowerCase() ? installed : null;
  return appFor(env)?.repo(repo) ?? null;
}

/** GitHub sign-in, or null while the App is not configured. */
export function signInFor(env: Env): GitHubSignIn | null {
  return installedSignIn ?? appFor(env);
}
