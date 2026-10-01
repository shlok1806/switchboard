// The wrapper's guess at the Person's input line, and the text it pastes.

import { describe, expect, it } from "vitest";
import type { ClaudeHookInput } from "../src/hooks/summarize";
import { InputLine, InterruptTyper, pasteText } from "../src/interrupts";

describe("pasteText", () => {
  it("keeps line breaks as a terminal pastes them and drops anything that could end the paste", () => {
    expect(pasteText("one\ntwo\r\nthree")).toBe("one\rtwo\rthree");
    expect(pasteText("a\x1b[201~b\x07c\td")).toBe("a[201~bc\td");
  });
});

describe("InputLine", () => {
  it("is empty until the Person types, and again after Enter, Ctrl+C or Ctrl+U", () => {
    const line = new InputLine();
    expect(line.empty).toBe(true);
    line.keys("ab");
    expect(line.empty).toBe(false);
    expect(line.keys("\r")).toEqual({ enter: true, cancel: false });
    expect(line.empty).toBe(true);
    line.keys("x");
    line.keys("\x03");
    expect(line.empty).toBe(true);
    line.keys("xy\x15");
    expect(line.empty).toBe(true);
  });

  it("counts Backspace, and ignores arrow keys and focus reports", () => {
    const line = new InputLine();
    line.keys("ab\x7f");
    expect(line.empty).toBe(false);
    line.keys("\x7f\x1b[D\x1b[I\x1bOA");
    expect(line.empty).toBe(true);
  });

  it("reads keys sent with the kitty keyboard protocol, even split across reads", () => {
    const line = new InputLine();
    line.keys("\x1b[97");
    expect(line.empty).toBe(true);
    line.keys("u");
    expect(line.empty).toBe(false);
    expect(line.keys("\x1b[13u")).toEqual({ enter: true, cancel: false });
    expect(line.empty).toBe(true);
    expect(line.keys("\x1b[27u").cancel).toBe(true);
    line.keys("\x1b[104u\x1b[99;5u");
    expect(line.empty).toBe(true);
  });

  it("counts a paste the Person makes as text on the line", () => {
    const line = new InputLine();
    line.keys("\x1b[200~pasted\rtext");
    expect(line.empty).toBe(false);
    line.keys("\x1b[201~");
    expect(line.empty).toBe(false);
    line.keys("\r");
    expect(line.empty).toBe(true);
  });
});

describe("InputLine, keys that clear or shorten the line", () => {
  /** A line with a clock the test moves. */
  function lineAt(start = 0) {
    const clock = { now: start };
    return { line: new InputLine(() => clock.now), clock };
  }

  // Each key in its legacy and kitty keyboard protocol forms.
  const ESCAPE = { legacy: "\x1b", kitty: "\x1b[27u", "kitty with event types": "\x1b[27;1:1u" };
  const CTRL_W = { legacy: "\x17", kitty: "\x1b[119;5u", "kitty with event types": "\x1b[119;5:1u" };
  const ALT_BACKSPACE = { legacy: "\x1b\x7f", kitty: "\x1b[127;3u", "kitty with event types": "\x1b[127;3:1u" };

  for (const [form, key] of Object.entries(ESCAPE)) {
    it(`clears the line on a double Escape (${form})`, () => {
      const { line, clock } = lineAt();
      line.keys("half a thought");
      line.keys(key);
      expect(line.empty).toBe(false);
      clock.now += 300;
      expect(line.keys(key).cancel).toBe(true);
      expect(line.empty).toBe(true);
    });
  }

  it("clears the line on a double Escape that arrives in one read", () => {
    const { line } = lineAt();
    line.keys("half a thought");
    line.keys("\x1b\x1b");
    expect(line.empty).toBe(true);
  });

  it("keeps the line on two Escapes too far apart, or with another key between them", () => {
    const { line, clock } = lineAt();
    line.keys("half a thought\x1b");
    clock.now += 5000;
    line.keys("\x1b");
    expect(line.empty).toBe(false);
    line.keys("\x1b[D\x1b");
    expect(line.empty).toBe(false);
  });

  for (const [name, forms] of [
    ["Ctrl+W", CTRL_W],
    ["Alt+Backspace", ALT_BACKSPACE],
  ] as const) {
    for (const [form, key] of Object.entries(forms)) {
      it(`deletes a word at a time on ${name} (${form})`, () => {
        const { line } = lineAt();
        line.keys("fix the bug  ");
        line.keys(key);
        expect(line.empty).toBe(false);
        line.keys(key + key);
        expect(line.empty).toBe(true);
        // Never below empty.
        line.keys(`${key}x`);
        expect(line.empty).toBe(false);
      });
    }
  }

  it("deletes no more than the shortest word a key could delete", () => {
    const { line } = lineAt();
    // Alt+Backspace stops at the dot; Ctrl+W may take the whole path.
    line.keys("src/app.ts\x17");
    expect(line.empty).toBe(false);
  });

  it("ignores kitty key release events", () => {
    const { line } = lineAt();
    line.keys("\x1b[97;1:1u\x1b[97;1:3u");
    line.keys("\x1b[127;1:1u");
    expect(line.empty).toBe(true);
    line.keys("ab\x1b[27;1:1u\x1b[27;1:3u");
    expect(line.empty).toBe(false);
  });
});

describe("InterruptTyper after the Person clears their line", () => {
  for (const [name, keys] of [
    ["double Escape", "\x1b\x1b"],
    ["double Escape (kitty)", "\x1b[27u\x1b[27u"],
    ["Ctrl+W", "\x17"],
    ["Ctrl+W (kitty)", "\x1b[119;5u"],
    ["Alt+Backspace", "\x1b\x7f"],
    ["Alt+Backspace (kitty)", "\x1b[127;3u"],
  ] as const) {
    it(`types a Directive after ${name}, not downgraded to Queue`, async () => {
      const written: string[] = [];
      const typer = new InterruptTyper({ write: (d) => written.push(d), quietMs: 0, waitMs: 300, log: () => {} });
      typer.hook({ hook_event_name: "SessionStart" } as ClaudeHookInput);
      typer.output("\x1b[?2004h");
      typer.personTyped("fixit");
      typer.personTyped(keys);
      expect(await typer.type("[Switchboard] Directive from octocat")).toEqual({ typed: true });
      expect(written.slice(-2)).toEqual(["\x1b[200~[Switchboard] Directive from octocat\x1b[201~", "\r"]);
    });
  }
});
