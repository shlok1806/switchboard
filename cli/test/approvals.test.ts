// Pending approvals (ADR 0013): what the wrapper tells the Channel about the permission
// prompt its CLI shows, and when.

import { describe, expect, it } from "vitest";
import type { PendingApproval } from "../../shared/src/index";
import { ApprovalReporter, pendingApproval } from "../src/approvals";
import type { ClaudeHookInput } from "../src/hooks/summarize";
import { InterruptTyper } from "../src/interrupts";

const AT = new Date("2026-10-15T03:08:00Z");

function request(tool: string, toolInput: Record<string, unknown>): ClaudeHookInput {
  return { hook_event_name: "PermissionRequest", tool_name: tool, tool_input: toolInput };
}

describe("pendingApproval", () => {
  it("shows a shell command and the CLI's reason for asking", () => {
    expect(
      pendingApproval(request("Bash", { command: "tart run base", description: "Start the VM" }), AT, "p1"),
    ).toEqual({ id: "p1", tool: "Bash", detail: "tart run base", reason: "Start the VM", openedAt: AT.toISOString() });
  });

  it("shows the path an edit asks for, and an MCP tool's input in short", () => {
    expect(pendingApproval(request("Write", { file_path: "/etc/hosts", content: "x" }), AT).detail).toBe("/etc/hosts");
    expect(pendingApproval(request("mcp__fs__move", { from: "a", to: "b" }), AT).detail).toBe('{"from":"a","to":"b"}');
    expect(pendingApproval(request("ExitWorktree", {}), AT).detail).toBeUndefined();
  });

  it("masks secrets before anything leaves the laptop, and cuts long input short", () => {
    const shown = pendingApproval(
      request("Bash", {
        command: `curl -H "Authorization: Bearer ${"sk-ant-api03-".padEnd(100, "A")}" ${"x".repeat(3000)}`,
      }),
      AT,
    );
    expect(shown.detail).not.toContain("sk-ant-api03-AAAA");
    expect(shown.detail).toHaveLength(2000);
  });
});

describe("ApprovalReporter", () => {
  /** A Channel that answers as `up` says, recording what reached it. */
  function channel() {
    const state = { up: true, told: [] as (string | null)[] };
    const reporter = new ApprovalReporter({
      send: async (approval: PendingApproval | null) => {
        if (!state.up) return false;
        state.told.push(approval?.tool ?? null);
        return true;
      },
      log: () => {},
      retryMs: 10,
    });
    return { state, reporter };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  it("tells the Channel when a prompt opens and closes", async () => {
    const { state, reporter } = channel();
    reporter.changed(request("Bash", { command: "make vm" }));
    await settle();
    reporter.changed(null);
    await settle();
    expect(state.told).toEqual(["Bash", null]);
    reporter.close();
  });

  it("sends only the latest state once the Channel is back, never a prompt that already closed", async () => {
    const { state, reporter } = channel();
    state.up = false;
    reporter.changed(request("Bash", { command: "make vm" }));
    reporter.changed(null);
    reporter.changed(request("Edit", { file_path: "a.ts" }));
    await settle();
    expect(state.told).toEqual([]);
    state.up = true;
    await settle();
    expect(state.told).toEqual(["Edit"]);
    reporter.close();
  });

  it("says an open prompt again when the Agent registers again, which drops it on the Channel", async () => {
    const { state, reporter } = channel();
    reporter.changed(request("Bash", { command: "make vm" }));
    await settle();
    reporter.registered();
    await settle();
    expect(state.told).toEqual(["Bash", "Bash"]);
    reporter.changed(null);
    reporter.registered();
    await settle();
    expect(state.told).toEqual(["Bash", "Bash", null]);
    reporter.close();
  });
});

describe("InterruptTyper, the permission prompt it reports", () => {
  function typer() {
    const seen: (string | null)[] = [];
    const t = new InterruptTyper({
      write: () => {},
      log: () => {},
      idleClears: true,
      onApproval: (input) => seen.push(input === null ? null : (input.tool_input?.command as string)),
    });
    t.hook({ hook_event_name: "SessionStart", source: "startup" });
    return { typer: t, seen };
  }
  const asks = (command: string): ClaudeHookInput => ({
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command },
  });
  const ran = (command: string): ClaudeHookInput => ({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });

  it("opens with the PermissionRequest and closes once that call has run", () => {
    const { typer: t, seen } = typer();
    t.hook(asks("make vm"));
    // Another call, running alongside it, finishing first.
    t.hook(ran("ls"));
    expect(seen).toEqual(["make vm"]);
    t.hook(ran("make vm"));
    expect(seen).toEqual(["make vm", null]);
  });

  for (const [name, close] of [
    ["the Person answers with Enter", (t: InterruptTyper) => t.personTyped("\r")],
    ["the Person denies with Escape", (t: InterruptTyper) => t.personTyped("\x1b")],
    ["the turn ends", (t: InterruptTyper) => t.hook({ hook_event_name: "Stop" })],
    ["the session ends", (t: InterruptTyper) => t.hook({ hook_event_name: "SessionEnd" })],
  ] as const) {
    it(`closes when ${name}`, () => {
      const { typer: t, seen } = typer();
      t.hook(asks("make vm"));
      close(t);
      expect(seen).toEqual(["make vm", null]);
    });
  }

  it("reports no prompt for a question, which is not an approval", () => {
    const { typer: t, seen } = typer();
    t.hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" });
    t.personTyped("\r");
    expect(seen).toEqual([]);
  });
});
