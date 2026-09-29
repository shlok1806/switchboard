// GitHub webhook deliveries: the signature check, and the Issue numbers each one touches.

import type { TaskNumber } from "../../../shared/src/index";

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** Checks `X-Hub-Signature-256` (`sha256=<hex HMAC of the raw body>`) in constant time. */
export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (header === null || !header.startsWith("sha256=")) return false;
  const signature = hexToBytes(header.slice("sha256=".length));
  if (signature === null) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, encoder.encode(body));
}

/** The `X-Hub-Signature-256` header GitHub sends for this body. */
export async function sign(secret: string, body: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The webhook events the Channel subscribes to. Anything else is acknowledged and ignored. */
export const WEBHOOK_EVENTS: ReadonlySet<string> = new Set(["issues", "sub_issues", "issue_dependencies"]);

/** What one delivery asks the Channel to refresh. */
export interface WebhookChange {
  /** Issues in the Channel's repo whose Tasks may have changed. */
  issues: TaskNumber[];
  /** Set when the delivery is an Issue being closed: which one, and the GitHub login that closed it. */
  closed?: { issue: TaskNumber; by: string };
}

type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null ? (value as Json) : undefined;
}

function fullName(value: unknown): string | undefined {
  const name = object(value)?.full_name;
  return typeof name === "string" ? name : undefined;
}

// Each payload field holding an Issue, with the field naming that Issue's repo when it may differ.
const ISSUE_FIELDS: [field: string, repoField: string | null][] = [
  ["issue", null],
  ["parent_issue", "parent_issue_repo"],
  ["sub_issue", "sub_issue_repo"],
  ["blocked_issue", "blocked_issue_repo"],
  ["blocking_issue", "blocking_issue_repo"],
];

/**
 * Reads the Issue numbers out of an `issues`, `sub_issues` or `issue_dependencies`
 * delivery. Returns null when the delivery is some other event or for another repo.
 * Issues that live in another repo (a cross-repo sub-issue or blocker) are left out.
 */
export function readWebhook(event: string, payload: unknown, repo: string): WebhookChange | null {
  const body = object(payload);
  if (!WEBHOOK_EVENTS.has(event) || body === undefined) return null;
  const home = fullName(body.repository);
  if (home === undefined || home.toLowerCase() !== repo.toLowerCase()) return null;

  const issues: TaskNumber[] = [];
  for (const [field, repoField] of ISSUE_FIELDS) {
    const issue = object(body[field]);
    if (issue === undefined || typeof issue.number !== "number" || issue.pull_request !== undefined) continue;
    const issueRepo = (repoField === null ? undefined : fullName(body[repoField])) ?? home;
    if (issueRepo.toLowerCase() === repo.toLowerCase() && !issues.includes(issue.number)) issues.push(issue.number);
  }
  const login = object(body.sender)?.login;
  const closedIssue = object(body.issue)?.number;
  if (event === "issues" && body.action === "closed" && typeof login === "string" && typeof closedIssue === "number") {
    return { issues, closed: { issue: closedIssue, by: login } };
  }
  return { issues };
}
