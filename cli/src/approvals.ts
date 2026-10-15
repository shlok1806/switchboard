// Pending approvals, the wrapper's side (ADR 0013). When the CLI opens a permission
// prompt (its PermissionRequest hook, which the Interrupt typer watches), the wrapper
// tells the Channel what the prompt asks, so People and orchestrators see why the
// Agent stopped; when it closes, the wrapper says so. Read-only: the prompt is still
// answered at the terminal.
//
// What leaves the laptop is masked first, with the Proxy's secret masking. The
// reporter sends the latest state only: a prompt that opened and closed while the
// Channel could not be reached is never sent, and a failed report is tried again.

import { randomUUID } from "node:crypto";
import { MAX_APPROVAL_DETAIL_LENGTH, MAX_APPROVAL_REASON_LENGTH, type PendingApproval } from "../../shared/src/index";
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
export function pendingApproval(request: ClaudeHookInput, openedAt: Date, id: string = randomUUID()): PendingApproval {
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
  };
}

export interface ApprovalReporterOptions {
  /** Sends the Agent's pending approval, or null; false when it did not reach the Channel (or there is no Agent yet). */
  send: (approval: PendingApproval | null) => Promise<boolean>;
  log: (line: string) => void;
  now?: () => Date;
  retryMs?: number;
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

  /** The CLI opened a permission prompt (`request`), or closed it (null). */
  changed(request: ClaudeHookInput | null): void {
    this.wanted = request === null ? null : pendingApproval(request, this.now());
    if (this.wanted) this.options.log(`waiting for approval: ${this.wanted.tool}`);
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
