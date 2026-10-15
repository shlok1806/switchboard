/**
 * Pending approvals (ADR 0013): an Agent whose CLI waits on a permission prompt (Codex's
 * approval dialog, Claude Code's permission prompt) says so on the Channel, so People
 * and orchestrators see why it stopped. Read-only: the prompt is answered at its terminal.
 */

import type { AgentId } from "./domain";
import { agentPath } from "./agents";

/** The most characters of what the prompt asks for (a command, a path, a tool's input) the Channel keeps. */
export const MAX_APPROVAL_DETAIL_LENGTH = 2000;
/** The most characters of the CLI's reason for asking the Channel keeps. */
export const MAX_APPROVAL_REASON_LENGTH = 500;
/** The longest approval ID. */
export const MAX_APPROVAL_ID_LENGTH = 64;

/** A permission prompt the Agent's CLI is showing, as its wrapper reports it. Masked on the laptop. */
export interface PendingApproval {
  /** The wrapper's ID for this one prompt. A new prompt gets a new ID. */
  id: string;
  /** The tool it asks to run, as the CLI names it: `Bash`, `Edit`, `apply_patch`, an MCP tool. */
  tool: string;
  /**
   * What it asks for: the command, the file path, or the tool's input in short, with
   * detected secrets masked. Absent when the tool's input says nothing readable.
   */
  detail?: string;
  /**
   * Why it asks, as the CLI words it (Claude Code's tool description, Codex's
   * justification). It comes from the model: the Agent's claim, not a fact.
   */
  reason?: string;
  /** When the prompt opened. */
  openedAt: string;
}

/**
 * `POST /api/agents/:id/approval`: the Agent's wrapper reports the permission prompt its
 * CLI shows, or `null` once it closed. The Agent's own token or its own Person. An
 * opened prompt is an `approval.pending` Event, a closed one `approval.closed`; the
 * Agent carries the open one as `approval` until then.
 */
export interface SetApprovalRequest {
  approval: PendingApproval | null;
}

/** The path that reports an Agent's pending approval. */
export function approvalPath(id: AgentId): string {
  return `${agentPath(id)}/approval`;
}

/** One line of text: control characters out, trimmed, cut to `max`. Empty means none. */
function line(raw: unknown, max: number, keepNewlines = false): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = (
    keepNewlines
      ? // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
        raw.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
      : // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
        raw.replace(/[\u0000-\u001f\u007f]/g, " ")
  ).trim();
  return clean === "" ? undefined : clean.slice(0, max);
}

/**
 * A pending approval as the Channel keeps it, from a request body's `approval`: `null`
 * when the prompt closed, `undefined` when the body holds no valid one.
 */
export function cleanApproval(value: unknown): PendingApproval | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = line(raw.id, MAX_APPROVAL_ID_LENGTH);
  const tool = line(raw.tool, 200);
  if (id === undefined || tool === undefined) return undefined;
  if (typeof raw.openedAt !== "string" || !Number.isFinite(Date.parse(raw.openedAt))) return undefined;
  const detail = line(raw.detail, MAX_APPROVAL_DETAIL_LENGTH, true);
  const reason = line(raw.reason, MAX_APPROVAL_REASON_LENGTH);
  return {
    id,
    tool,
    ...(detail === undefined ? {} : { detail }),
    ...(reason === undefined ? {} : { reason }),
    openedAt: new Date(raw.openedAt).toISOString(),
  };
}
