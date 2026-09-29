// Turns what a Claude Code hook reports into small Hook Events for the Channel.
// This is where payloads are kept small: arguments and commands are cut to the
// shared limits, heredoc bodies are dropped from commands, and file contents are
// never copied, only counted.

import { isAbsolute, relative } from "node:path";
import type { EventPayloads, HookEventType } from "../../../shared/src/index";
import {
  MAX_HOOK_ARG_LENGTH,
  MAX_HOOK_COMMAND_LENGTH,
  MAX_HOOK_TEXT_LENGTH,
  truncate,
} from "../../../shared/src/index";

/** A Hook Event before the wrapper gives it an ID. */
export type HookEventDraft = { [K in HookEventType]: { type: K; payload: EventPayloads[K] } }[HookEventType];

/** The fields of Claude Code's hook input that Switchboard reads. */
export interface ClaudeHookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  source?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

/** The hooks the wrapper installs, and the Claude Code hook names they listen on. */
export const CAPTURED_HOOKS = ["SessionStart", "PostToolUse", "Stop", "SessionEnd"] as const;

/** Tools that edit files, and the input field that holds the file's path. */
const FILE_EDIT_TOOLS: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** The input field that best sums up each built-in tool's call. */
const ARG_FIELDS: Record<string, string> = {
  ...FILE_EDIT_TOOLS,
  Read: "file_path",
  Bash: "command",
  Glob: "pattern",
  Grep: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Task: "description",
  Agent: "description",
  Skill: "skill",
};

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function lineCount(text: unknown): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/**
 * A short summary of a tool call's input, such as a path or a command. Never the
 * content a tool writes. `path` shortens file paths. The Proxy Capture uses it too.
 */
export function toolArg(tool: string, toolInput: Record<string, unknown>, path: (path: string) => string): string {
  const field = ARG_FIELDS[tool];
  const value = field ? str(toolInput[field]) : undefined;
  if (value !== undefined) {
    const text = field?.endsWith("path") ? path(value) : value;
    return truncate(text.replace(/\s+/g, " ").trim(), MAX_HOOK_ARG_LENGTH);
  }
  // Other tools (MCP tools and the like): their short fields, each cut short.
  const brief = Object.entries(toolInput)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${k}=${truncate(String(v).replace(/\s+/g, " "), 60)}`)
    .join(" ");
  return truncate(brief, MAX_HOOK_ARG_LENGTH);
}

/** Keeps a command readable and small: one line per heredoc, with its body dropped. */
export function shortCommand(command: string): string {
  const lines = command.split("\n");
  const heredoc = lines.findIndex((line) => /<<-?\s*['"]?\w+/.test(line));
  const kept =
    heredoc === -1 || heredoc === lines.length - 1 ? command : `${lines.slice(0, heredoc + 1).join("\n")}\n…`;
  return truncate(kept, MAX_HOOK_COMMAND_LENGTH);
}

export class HookSummarizer {
  private turns = 0;

  /**
   * @param root file paths under this directory (the repo) are sent relative to it.
   */
  constructor(private readonly root: string) {}

  /** The Hook Events for one hook call. Unknown hooks give none. */
  summarize(input: ClaudeHookInput): HookEventDraft[] {
    switch (input.hook_event_name) {
      case "SessionStart": {
        const source = str(input.source) ?? "startup";
        return [
          {
            type: "session.start",
            payload: { cwd: truncate(input.cwd ?? "", MAX_HOOK_TEXT_LENGTH), resumed: source === "resume", source },
          },
        ];
      }
      case "SessionEnd":
        return [
          { type: "session.end", payload: { reason: "exit", detail: truncate(str(input.reason) ?? "other", 40) } },
        ];
      case "Stop":
        this.turns += 1;
        return [{ type: "turn.end", payload: { turn: this.turns } }];
      case "PostToolUse":
        return this.toolUse(input);
      default:
        return [];
    }
  }

  private toolUse(input: ClaudeHookInput): HookEventDraft[] {
    const tool = str(input.tool_name);
    if (!tool) return [];
    const toolInput = input.tool_input ?? {};
    const events: HookEventDraft[] = [
      { type: "tool.call", payload: { tool: truncate(tool, 100), arg: this.arg(tool, toolInput), ok: true } },
    ];
    const pathField = FILE_EDIT_TOOLS[tool];
    const path = pathField ? str(toolInput[pathField]) : undefined;
    if (path) {
      const { additions, deletions } = changedLines(tool, toolInput, input.tool_response);
      events.push({ type: "file.edit", payload: { path: this.path(path), additions, deletions } });
    }
    const command = tool === "Bash" ? str(toolInput.command) : undefined;
    if (command) {
      const exitCode = exitCodeOf(input.tool_response);
      events.push({
        type: "command",
        payload: { command: shortCommand(command), ...(exitCode === undefined ? {} : { exitCode }) },
      });
    }
    return events;
  }

  /** A short summary of a tool call's input. Never the content a tool writes. */
  private arg(tool: string, toolInput: Record<string, unknown>): string {
    return toolArg(tool, toolInput, (path) => this.path(path));
  }

  /** A path relative to the repo when it is inside it, else as given. */
  private path(path: string): string {
    const inside = isAbsolute(path) ? relative(this.root, path) : path;
    const shown = inside === "" || inside.startsWith("..") || isAbsolute(inside) ? path : inside;
    return truncate(shown, MAX_HOOK_TEXT_LENGTH);
  }
}

/** Lines added and removed by a file edit, from Claude Code's patch when it gives one. */
function changedLines(
  tool: string,
  input: Record<string, unknown>,
  response: unknown,
): { additions: number; deletions: number } {
  const patch = (response as { structuredPatch?: unknown } | null)?.structuredPatch;
  if (Array.isArray(patch)) {
    let additions = 0;
    let deletions = 0;
    for (const hunk of patch) {
      const lines = (hunk as { lines?: unknown } | null)?.lines;
      for (const line of Array.isArray(lines) ? lines : []) {
        if (typeof line !== "string") continue;
        if (line.startsWith("+")) additions += 1;
        else if (line.startsWith("-")) deletions += 1;
      }
    }
    // A new file has an empty patch; count its lines instead.
    if (additions + deletions > 0 || tool !== "Write") return { additions, deletions };
  }
  switch (tool) {
    case "Write":
      return { additions: lineCount(input.content), deletions: 0 };
    case "Edit":
      return { additions: lineCount(input.new_string), deletions: lineCount(input.old_string) };
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      return {
        additions: edits.reduce((n, e) => n + lineCount(e?.new_string), 0),
        deletions: edits.reduce((n, e) => n + lineCount(e?.old_string), 0),
      };
    }
    default:
      return { additions: lineCount(input.new_source), deletions: 0 };
  }
}

/** A Bash call's exit code, when Claude Code reports one. */
function exitCodeOf(response: unknown): number | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  for (const key of ["exitCode", "exit_code", "returnCode", "code"]) {
    const value = (response as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}
