import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentId, TerminalScreenFrame } from "@shared/index";
import { Screen } from "@/components/domain/terminal";

const frame = (lines: string[], prompt: boolean): TerminalScreenFrame => ({
  type: "terminal.screen",
  agent: "ana/claude/abcd" as AgentId,
  nonce: "n",
  cols: 72,
  rows: lines.length,
  lines,
  cursor: { x: 2, y: lines.length - 1 },
  attached: [],
  prompt,
  paste: true,
  holder: null,
});

/** Each screen row's tone, in order: dim, signal or plain. */
function tones(f: TerminalScreenFrame) {
  const html = renderToStaticMarkup(<Screen frame={f} />);
  return [...html.matchAll(/<span class="block min-h-\[1\.55em\]([^"]*)">/g)].map(([, c]) => (c!.includes("term-signal") ? "signal" : c!.includes("term-dim") ? "dim" : "plain"));
}

describe("the terminal screen", () => {
  it("dims tool calls, keeps their results and prose plain, and paints only the open dialog", () => {
    const lines = [
      "● Read(web/src/users.tsx)",
      "  ⎿  Read 182 lines",
      "● The list now pages by 50.",
      "? Run npm ci (answered earlier)",
      "  done",
      "",
      "? Run rm -rf web/node_modules && npm ci",
      "  1. Yes   2. Yes, and don't ask again this session   3. No",
      "  ",
    ];
    expect(tones(frame(lines, true))).toEqual(["dim", "plain", "plain", "plain", "plain", "plain", "signal", "signal", "signal"]);
  });

  it("paints nothing in the signal when no dialog is open, even over an old question", () => {
    const lines = ["? Run npm ci", "  1. Yes   2. No", "", "> "];
    expect(tones(frame(lines, false))).toEqual(["plain", "plain", "plain", "plain"]);
    // The wrapper says a prompt is open but the bottom is ordinary output: not a dialog.
    expect(tones(frame(lines, true))).toEqual(["plain", "plain", "plain", "plain"]);
  });

  it("reads a boxed dialog, as Claude Code draws one", () => {
    const lines = ["● Bash(npm test)", "╭────────╮", "│ Do you want to proceed?", "│ ❯ 1. Yes", "│   2. No", "╰────────╯"];
    expect(tones(frame(lines, true))).toEqual(["dim", "plain", "signal", "signal", "signal", "signal"]);
  });
});
