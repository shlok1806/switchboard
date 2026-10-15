// Pending approvals, the wrapper's side (ADR 0013). When the CLI opens a permission
// prompt (its PermissionRequest hook, which the Interrupt typer watches), the wrapper
// tells the Channel what the prompt asks, so People and orchestrators see why the
// Agent stopped; when it closes, the wrapper says so. Read-only: the prompt is still
// answered at the terminal.
//
// What leaves the laptop is masked first, with the Proxy's secret masking. The
// reporter sends the latest state only: a prompt that opened and closed while the
// Channel could not be reached is never sent, and a failed report is tried again.
//
// For Claude Code the wrapper also holds the prompt's PermissionRequest hook (the
// DenyGate), so the Agent's own Person can deny it from the Channel (ADR 0014). It
// never approves: the hook's only answers are a deny and no decision.

import { randomUUID } from "node:crypto";
import { MAX_APPROVAL_DETAIL_LENGTH, MAX_APPROVAL_REASON_LENGTH, type PendingApproval } from "../../shared/src/index";
import type { HeldHook } from "./hooks/capture";
import type { ClaudeHookInput } from "./hooks/summarize";
import { maskSecrets } from "./proxy/mask";

/** How soon a report that could not reach the Channel is tried again. */
const RETRY_MS = 5000;

/** The input field that says what a tool call does, by tool, when it is not a command. */
const DETAIL_FIELDS = ["command", "file_path", "notebook_path", "path", "url", "pattern", "query"];

function masked(text: string, max: number): string {
  return maskSecrets(text).text.slice(0, max);
}

/** What a PermissionRequest asks, as the Channel shows it: masked and cut short. */
export function pendingApproval(
  request: ClaudeHookInput,
  openedAt: Date,
  id: string = randomUUID(),
  deniable = false,
): PendingApproval {
  const input = request.tool_input ?? {};
  const field = DETAIL_FIELDS.find((key) => typeof input[key] === "string" && input[key] !== "");
  // A tool with none of those, such as an MCP tool, shows its input in short.
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "description"));
  const raw = field !== undefined ? (input[field] as string) : Object.keys(rest).length > 0 ? JSON.stringify(rest) : "";
  const reason = typeof input.description === "string" ? input.description.trim() : "";
  return {
    id,
    tool: request.tool_name ?? "a tool",
    ...(raw === "" ? {} : { detail: masked(raw, MAX_APPROVAL_DETAIL_LENGTH) }),
    ...(reason === "" ? {} : { reason: masked(reason, MAX_APPROVAL_REASON_LENGTH) }),
    openedAt: openedAt.toISOString(),
    ...(deniable ? { deniable: true } : {}),
  };
}

export interface ApprovalReporterOptions {
  /** Sends the Agent's pending approval, or null; false when it did not reach the Channel (or there is no Agent yet). */
  send: (approval: PendingApproval | null) => Promise<boolean>;
  log: (line: string) => void;
  now?: () => Date;
  retryMs?: number;
  /** Whether the wrapper holds the prompt's hook, so the Channel may deny it (ADR 0014). */
  deniable?: boolean;
}

/** Keeps the Channel's view of the Agent's permission prompt in step with the CLI's. */
export class ApprovalReporter {
  /** What the Channel should show. */
  private wanted: PendingApproval | null = null;
  /** What it was last told; undefined when that is not known (before any report). */
  private told: PendingApproval | null | undefined = null;
  private sending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly now: () => Date;
  private readonly retryMs: number;

  constructor(private readonly options: ApprovalReporterOptions) {
    this.now = options.now ?? (() => new Date());
    this.retryMs = options.retryMs ?? RETRY_MS;
  }

  /** The prompt the CLI shows now, as the Channel is told of it. */
  get open(): PendingApproval | null {
    return this.wanted;
  }

  /** The CLI opened a permission prompt (`request`), or closed it (null). */
  changed(request: ClaudeHookInput | null): void {
    this.wanted =
      request === null ? null : pendingApproval(request, this.now(), randomUUID(), this.options.deniable === true);
    if (this.wanted) this.options.log(`waiting for approval: ${this.wanted.tool}`);
    void this.flush();
  }

  /**
   * The wrapper no longer holds prompt `id`'s hook, which is still open: show it
   * afresh, under a new ID, as one only the terminal can answer.
   */
  lapsed(id: string): void {
    if (this.wanted?.id !== id) return;
    const { deniable: _, ...prompt } = this.wanted;
    this.wanted = { ...prompt, id: randomUUID() };
    this.options.log(`the prompt can no longer be denied from the Channel: ${prompt.tool}`);
    void this.flush();
  }

  /** The Agent registered again: the Channel dropped any prompt it held, so say it afresh. */
  registered(): void {
    this.told = undefined;
    void this.flush();
  }

  /** Sends what the Channel should show, if it was not told already. */
  async flush(): Promise<void> {
    if (this.closed || this.sending) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.sending = true;
    try {
      while (!this.closed && this.wanted?.id !== this.told?.id) {
        // Nothing to clear on a Channel that holds no prompt: both have no ID.
        const sending = this.wanted;
        if (!(await this.options.send(sending))) {
          this.timer = setTimeout(() => void this.flush(), this.retryMs);
          return;
        }
        this.told = sending;
      }
    } finally {
      this.sending = false;
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }
}

/**
 * Holds Claude Code's PermissionRequest hook while its prompt is open, so the Agent's
 * own Person can deny it from the Channel (ADR 0014). The hook is answered with a deny
 * for that prompt, or with nothing (no decision) when the prompt closes, another takes
 * its place, or the wrapper stops. Every way out but a deny leaves Claude Code's own
 * dialog in charge, and nothing here can answer allow.
 */
export class DenyGate {
  private held: { id: string; hook: HeldHook } | null = null;

  /** `lapsed` hears of a held prompt whose hook ended without a deny reaching it. */
  constructor(private readonly lapsed: (id: string) => void = () => {}) {}

  /** Holds `hook`, the hook of prompt `id`. */
  hold(id: string, hook: HeldHook): void {
    this.release();
    const held = { id, hook };
    this.held = held;
    hook.gone.addEventListener(
      "abort",
      () => {
        if (this.held !== held) return;
        this.held = null;
        this.lapsed(id);
      },
      { once: true },
    );
  }

  /**
   * Denies prompt `id` with `reason`, which the model reads. Resolves true once the
   * hook printed the deny for Claude Code; false when that prompt is not held, or its
   * hook ended before the deny reached it.
   */
  async deny(id: string, reason: string): Promise<boolean> {
    const held = this.held;
    if (held?.id !== id || held.hook.gone.aborted) return false;
    this.held = null;
    const printed = await held.hook.answer(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: reason } },
      }),
    );
    if (!printed) this.lapsed(id);
    return printed;
  }

  /** The prompt closed, or the wrapper stops: the hook ends with no decision. */
  release(): void {
    const held = this.held;
    this.held = null;
    void held?.hook.answer("");
  }
}
