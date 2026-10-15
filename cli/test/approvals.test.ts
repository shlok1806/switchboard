// Pending approvals (ADR 0013): what the wrapper tells the Channel about the permission
// prompt its CLI shows, and when.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "../../shared/src/index";
import { ApprovalReporter, DenyGate, pendingApproval } from "../src/approvals";
import { type HeldHook, HookCapture } from "../src/hooks/capture";
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

describe("DenyGate", () => {
  const denied = (message: string) =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } },
    });

  /** A held hook: `printed` is whether it says it printed its answer. */
  function heldHook(printed = true) {
    const lapse = new AbortController();
    const answers: string[] = [];
    const hook: HeldHook = {
      gone: lapse.signal,
      answer: async (text) => {
        answers.push(text);
        return printed && !lapse.signal.aborted;
      },
    };
    return { hook, answers, end: () => lapse.abort() };
  }

  it("answers the held hook with a deny for its own prompt only", async () => {
    const gate = new DenyGate();
    const { hook, answers } = heldHook();
    gate.hold("p1", hook);
    expect(await gate.deny("p0", "no")).toBe(false);
    expect(await gate.deny("p1", "Not now.")).toBe(true);
    expect(answers).toEqual([denied("Not now.")]);
    // Once: the prompt is no longer held.
    expect(await gate.deny("p1", "Not now.")).toBe(false);
  });

  it("ends a hook with no decision when its prompt closes or another takes its place", async () => {
    const gate = new DenyGate();
    const first = heldHook();
    const second = heldHook();
    gate.hold("p1", first.hook);
    gate.hold("p2", second.hook);
    expect(first.answers).toEqual([""]);
    gate.release();
    expect(second.answers).toEqual([""]);
    expect(await gate.deny("p2", "late")).toBe(false);
  });

  it("refuses a deny once the held hook ended on its own, and says the prompt lapsed", async () => {
    const lapsed: string[] = [];
    const gate = new DenyGate((id) => lapsed.push(id));
    const { hook, answers, end } = heldHook();
    gate.hold("p1", hook);
    // The hook gave up, or Claude Code killed it at its timeout.
    end();
    expect(lapsed).toEqual(["p1"]);
    expect(await gate.deny("p1", "Too late.")).toBe(false);
    expect(answers).toEqual([]);
  });

  it("does not count a deny the hook never printed", async () => {
    const lapsed: string[] = [];
    const gate = new DenyGate((id) => lapsed.push(id));
    gate.hold("p1", heldHook(false).hook);
    expect(await gate.deny("p1", "Not now.")).toBe(false);
    expect(lapsed).toEqual(["p1"]);
  });
});

describe("ApprovalReporter, a prompt whose hold lapsed", () => {
  it("shows the prompt afresh, under a new ID, as one only the terminal answers", async () => {
    const sent: (PendingApproval | null)[] = [];
    const reporter = new ApprovalReporter({
      deniable: true,
      log: () => {},
      send: async (approval) => {
        sent.push(approval);
        return true;
      },
    });
    reporter.changed({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "make" } });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const first = sent[0] as PendingApproval;
    expect(first.deniable).toBe(true);
    reporter.lapsed("someone-else");
    reporter.lapsed(first.id);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const again = sent[1] as PendingApproval;
    expect(again.id).not.toBe(first.id);
    expect(again.deniable).toBeUndefined();
    expect({ ...again, id: first.id }).toEqual((({ deniable: _, ...rest }) => rest)(first));
    reporter.close();
  });
});

describe("a held PermissionRequest hook, over the wrapper's socket", () => {
  // The built hook script, as Claude Code runs it (`npm test` builds it first).
  const script = fileURLToPath(new URL("../dist/switchboard-hook.js", import.meta.url));
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** A Hook Capture that holds every PermissionRequest, and the hook it holds, once it does. */
  async function holding() {
    const dir = await mkdtemp(join(tmpdir(), "sb-hold-"));
    let resolveHeld: (hook: HeldHook) => void = () => {};
    const held = new Promise<HeldHook>((resolve) => {
      resolveHeld = resolve;
    });
    const capture = await HookCapture.start({
      dir,
      root: dir,
      send: () => true,
      log: () => {},
      hold: (input, hook) => {
        if (input.hook_event_name !== "PermissionRequest") return false;
        resolveHeld(hook);
        return true;
      },
    });
    let child: ChildProcess | undefined;
    cleanups.push(async () => {
      child?.kill();
      await capture.close();
      await rm(dir, { recursive: true, force: true });
    });
    // Claude Code runs the hook with the prompt's input on stdin.
    child = spawn(process.execPath, [script, join(dir, "hook.sock"), "--hold"]);
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    const exited = new Promise<string>((resolve) => child?.on("close", () => resolve(out)));
    child.stdin?.end(
      JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "make" } }),
    );
    return { hook: await held, child, exited };
  }

  it("counts a deny once the hook printed it for Claude Code", async () => {
    const { hook, exited } = await holding();
    const deny = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}';
    expect(await hook.answer(deny)).toBe(true);
    expect(await exited).toBe(deny);
    expect(hook.gone.aborted).toBe(false);
  });

  it("hears that a hook killed before an answer is gone, and a later deny does not count", async () => {
    const { hook, child, exited } = await holding();
    // Claude Code kills the hook at its timeout; its dialog stays open.
    child.kill("SIGKILL");
    await exited;
    await vi.waitFor(() => expect(hook.gone.aborted).toBe(true));
    expect(await hook.answer("{}")).toBe(false);
  });

  it("ends the hook with no decision when it is answered with nothing", async () => {
    const { hook, exited } = await holding();
    expect(await hook.answer("")).toBe(false);
    expect(await exited).toBe("");
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
