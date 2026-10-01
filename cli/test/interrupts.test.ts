// The wrapper's guess at the Person's input line, and the text it pastes.
//
// The guess may wrongly say "not empty" (an Interrupt then waits, or becomes a
// Queue), but must never wrongly say "empty": the Interrupt would be pasted and
// Enter pressed on top of the Person's half-written prompt, submitting it.

import { describe, expect, it } from "vitest";
import type { ClaudeHookInput } from "../src/hooks/summarize";
import { DOUBLE_ESCAPE_MS, InputLine, InterruptTyper, pasteText } from "../src/interrupts";

describe("pasteText", () => {
  it("keeps line breaks as a terminal pastes them and drops anything that could end the paste", () => {
    expect(pasteText("one\ntwo\r\nthree")).toBe("one\rtwo\rthree");
    expect(pasteText("a\x1b[201~b\x07c\td")).toBe("a[201~bc\td");
  });
});

/** A line in Claude Code's prompt, with a clock the test moves, at its idle prompt unless `idle` is false. */
function lineAt({ idle = true } = {}) {
  const clock = { now: 0 };
  const line = new InputLine({ now: () => clock.now, idleClears: true });
  line.setIdle(idle);
  return { line, clock };
}

/** Keys, each in its legacy and kitty keyboard protocol forms. */
const KEYS = {
  escape: { legacy: "\x1b", kitty: "\x1b[27u", "kitty with event types": "\x1b[27;1:1u" },
  ctrlW: { legacy: "\x17", kitty: "\x1b[119;5u", "kitty with event types": "\x1b[119;5:1u" },
  altBackspace: { legacy: "\x1b\x7f", kitty: "\x1b[127;3u", "kitty with event types": "\x1b[127;3:1u" },
  ctrlY: { legacy: "\x19", kitty: "\x1b[121;5u" },
  altY: { legacy: "\x1by", kitty: "\x1b[121;3u" },
  ctrlU: { legacy: "\x15", kitty: "\x1b[117;5u" },
  left: { legacy: "\x1b[D", "application mode": "\x1bOD", "with Ctrl": "\x1b[1;5D" },
  home: { legacy: "\x1b[H", "vt220 form": "\x1b[1~", "Ctrl+A": "\x01", "Ctrl+A (kitty)": "\x1b[97;5u" },
  wordLeft: { "Alt+B": "\x1bb", "Alt+B (kitty)": "\x1b[98;3u", "Ctrl+B": "\x02" },
  up: { legacy: "\x1b[A", "application mode": "\x1bOA", "Ctrl+P": "\x10" },
  down: { legacy: "\x1b[B", "Ctrl+N": "\x0e" },
} as const;

describe("InputLine", () => {
  it("is empty until the Person types, and again after Enter, Ctrl+C at the prompt, or Ctrl+U", () => {
    const { line } = lineAt();
    expect(line.empty).toBe(true);
    line.keys("ab");
    expect(line.empty).toBe(false);
    expect(line.keys("\r")).toEqual({ enter: true, cancel: false });
    expect(line.empty).toBe(true);
    line.setIdle(true);
    line.keys("x");
    line.keys("\x03");
    expect(line.empty).toBe(true);
    line.keys("xy\x15");
    expect(line.empty).toBe(true);
  });

  it("counts Backspace, and ignores Left, Right and focus reports on an empty line", () => {
    const { line } = lineAt();
    line.keys("ab\x7f");
    expect(line.empty).toBe(false);
    line.keys("\x7f\x1b[D\x1b[I\x1bOC\x1b[O");
    expect(line.empty).toBe(true);
  });

  it("reads keys sent with the kitty keyboard protocol, even split across reads", () => {
    const { line } = lineAt();
    line.keys("\x1b[97");
    expect(line.empty).toBe(true);
    line.keys("u");
    expect(line.empty).toBe(false);
    expect(line.keys("\x1b[13u")).toEqual({ enter: true, cancel: false });
    expect(line.empty).toBe(true);
    line.setIdle(true);
    expect(line.keys("\x1b[27u").cancel).toBe(true);
    line.keys("\x1b[104u\x1b[99;5u");
    expect(line.empty).toBe(true);
  });

  it("counts a paste the Person makes as text on the line", () => {
    const { line } = lineAt();
    line.keys("\x1b[200~pasted\rtext");
    expect(line.empty).toBe(false);
    line.keys("\x1b[201~");
    expect(line.empty).toBe(false);
    line.keys("\r");
    expect(line.empty).toBe(true);
  });

  it("ignores kitty key release events", () => {
    const { line } = lineAt();
    line.keys("\x1b[97;1:1u\x1b[97;1:3u");
    line.keys("\x1b[127;1:1u");
    expect(line.empty).toBe(true);
  });
});

describe("InputLine, double Escape", () => {
  for (const [form, key] of Object.entries(KEYS.escape)) {
    it(`clears the line at the idle prompt (${form})`, () => {
      const { line, clock } = lineAt();
      line.keys("half a thought");
      line.keys(key);
      expect(line.empty).toBe(false);
      clock.now += DOUBLE_ESCAPE_MS - 1;
      expect(line.keys(key).cancel).toBe(true);
      expect(line.empty).toBe(true);
    });
  }

  it("clears on two Escapes in one read", () => {
    const { line } = lineAt();
    line.keys("half a thought\x1b\x1b");
    expect(line.empty).toBe(true);
  });

  it("keeps the line while a turn runs, where Escape cancels the turn", () => {
    const { line } = lineAt({ idle: false });
    line.keys("half a thought\x1b\x1b");
    expect(line.empty).toBe(false);
    // Submitting starts a turn too.
    line.setIdle(true);
    line.keys("first\rhalf a thought\x1b\x1b");
    expect(line.empty).toBe(false);
  });

  it("keeps the line when autocomplete may be showing, where the first Escape closes it", () => {
    for (const text of ["/hel", "fix @src/inter", "@"]) {
      const { line } = lineAt();
      line.keys(`${text}\x1b\x1b`);
      expect(line.empty, text).toBe(false);
    }
  });

  it("keeps the line on Escapes at or past the window, or with another key between them", () => {
    const { line, clock } = lineAt();
    line.keys("half a thought\x1b");
    clock.now += DOUBLE_ESCAPE_MS;
    line.keys("\x1b");
    expect(line.empty).toBe(false);
    clock.now += 5000;
    line.keys("\x1b[D\x1b");
    expect(line.empty).toBe(false);
    expect(DOUBLE_ESCAPE_MS).toBeLessThan(800);
  });
});

describe("InputLine, word deletes", () => {
  for (const [name, forms] of [
    ["Ctrl+W", KEYS.ctrlW],
    ["Alt+Backspace", KEYS.altBackspace],
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
    // A word delete does not cross a line break.
    const other = lineAt().line;
    other.keys("first\n\x17");
    expect(other.empty).toBe(false);
  });
});

describe("InputLine, yanking deleted text back", () => {
  for (const [yank, forms] of [
    ["Ctrl+Y", KEYS.ctrlY],
    ["Alt+Y", KEYS.altY],
  ] as const) {
    for (const [form, key] of Object.entries(forms)) {
      for (const [deleted, keys] of [
        ["Ctrl+W", KEYS.ctrlW.legacy],
        ["Alt+Backspace", KEYS.altBackspace.legacy],
        ["Ctrl+U", KEYS.ctrlU.legacy],
      ] as const) {
        it(`is not empty after ${deleted} then ${yank} (${form})`, () => {
          const { line } = lineAt();
          line.keys(`hello${keys}`);
          expect(line.empty).toBe(true);
          line.keys(key);
          expect(line.empty).toBe(false);
        });
      }
    }
  }
});

describe("InputLine, after the cursor moves", () => {
  const moves = { ...KEYS.left, ...KEYS.home, ...KEYS.wordLeft };
  for (const [form, move] of Object.entries(moves)) {
    it(`no delete can take the line to empty (${JSON.stringify(form)})`, () => {
      for (const del of [KEYS.ctrlW.legacy, KEYS.altBackspace.kitty, "\x7f", KEYS.ctrlU.legacy]) {
        const { line } = lineAt();
        line.keys(`abcdefgh${move.repeat(7)}`);
        line.keys(del.repeat(9));
        expect(line.empty, JSON.stringify(del)).toBe(false);
      }
    });
  }

  it("is known empty again once the line is submitted", () => {
    const { line } = lineAt();
    line.keys("abc\x1b[Dd\r");
    expect(line.empty).toBe(true);
  });
});

describe("InputLine, history", () => {
  for (const [form, key] of Object.entries({ ...KEYS.up, ...KEYS.down })) {
    it(`is not empty after recalling a prompt (${JSON.stringify(form)})`, () => {
      const { line } = lineAt();
      line.keys(key);
      expect(line.empty).toBe(false);
      // Deleting what it cannot see does not make it empty.
      line.keys("\x17\x7f");
      expect(line.empty).toBe(false);
    });
  }
});

describe("InputLine, kitty modifiers", () => {
  it("counts text typed with Caps Lock or Num Lock on", () => {
    for (const keys of ["\x1b[97;65u\x1b[98;65u", "\x1b[97;129u", "\x1b[65;66u"]) {
      const { line } = lineAt();
      line.keys(keys);
      expect(line.empty, JSON.stringify(keys)).toBe(false);
    }
  });

  it("reads Ctrl+W with Caps Lock on as Ctrl+W", () => {
    const { line } = lineAt();
    line.keys("abc\x1b[119;69u");
    expect(line.empty).toBe(true);
  });
});

describe("InputLine, bracketed paste", () => {
  it("reads everything but the paste-end marker as text", () => {
    for (const pasted of ["abc\x1b\x1b", "abc\x15", "abc\x03", "abc\x17\x17", "\r", "abc\x1b[27u\x1b[27u"]) {
      const { line } = lineAt();
      line.keys(`\x1b[200~${pasted}\x1b[201~`);
      expect(line.empty, JSON.stringify(pasted)).toBe(false);
    }
  });

  it("finds the paste-end marker split across reads", () => {
    const { line } = lineAt();
    line.keys("\x1b[200~abc\x1b[20");
    line.keys("1~\x17");
    expect(line.empty).toBe(true);
  });
});

describe("InputLine, keys that start a new line instead of submitting", () => {
  for (const [name, keys] of [
    ["Shift+Enter (kitty)", "\x1b[13;2u"],
    ["Alt+Enter", "\x1b\r"],
    ["Alt+Enter (kitty)", "\x1b[13;3u"],
    ["Ctrl+J", "\n"],
    ["\\ then Enter", "\\\r"],
  ] as const) {
    it(`keeps the line on ${name}`, () => {
      const { line } = lineAt();
      line.keys(`first${keys}`);
      expect(line.empty).toBe(false);
    });
  }

  it("Ctrl+U clears only the line the cursor is on", () => {
    const { line } = lineAt();
    line.keys("first\x1b[13;2usecond\x15");
    expect(line.empty).toBe(false);
  });

  it("keeps the line when Enter may accept an @ mention suggestion", () => {
    const { line } = lineAt();
    line.keys("look at @src/inter\r");
    expect(line.empty).toBe(false);
  });
});

describe("InputLine, Ctrl+C", () => {
  it("keeps the line while a turn runs, where Ctrl+C cancels the turn", () => {
    const { line } = lineAt({ idle: false });
    line.keys("half a thought\x03");
    expect(line.empty).toBe(false);
  });
});

describe("InterruptTyper after the Person clears their line", () => {
  /** A typer for Claude Code (or, with `idleClears` false, a CLI whose prompt keeps its text), at its prompt. */
  function typer({ idleClears = true } = {}) {
    const written: string[] = [];
    const t = new InterruptTyper({
      write: (d) => written.push(d),
      quietMs: 0,
      waitMs: 300,
      log: () => {},
      idleClears,
    });
    t.hook({ hook_event_name: "SessionStart", source: "startup" });
    t.output("\x1b[?2004h");
    return { typer: t, written };
  }
  const DIRECTIVE = "[Switchboard] Directive from octocat";
  const personTyping = { typed: false, reason: "person-typing" };

  for (const [name, keys] of [
    ["double Escape", "\x1b\x1b"],
    ["double Escape (kitty)", "\x1b[27u\x1b[27u"],
    ["Ctrl+W", "\x17"],
    ["Ctrl+W (kitty)", "\x1b[119;5u"],
    ["Alt+Backspace", "\x1b\x7f"],
    ["Alt+Backspace (kitty)", "\x1b[127;3u"],
  ] as const) {
    it(`types a Directive after ${name}, not downgraded to Queue`, async () => {
      const { typer: t, written } = typer();
      t.personTyped("fixit");
      t.personTyped(keys);
      expect(await t.type("[Switchboard] Directive from octocat")).toEqual({ typed: true });
      expect(written.slice(-2)).toEqual(["\x1b[200~[Switchboard] Directive from octocat\x1b[201~", "\r"]);
    });
  }

  it("does not type after a double Escape while a turn runs", async () => {
    const { typer: t, written } = typer();
    t.hook({ hook_event_name: "UserPromptSubmit" } as ClaudeHookInput);
    t.personTyped("fixit\x1b\x1b");
    expect(await t.type("[Switchboard] Directive from octocat")).toEqual({ typed: false, reason: "person-typing" });
    expect(written).toEqual(["fixit\x1b\x1b"]);
    // The turn ends: Claude Code is at its prompt again, and now a double Escape clears.
    t.hook({ hook_event_name: "Stop" } as ClaudeHookInput);
    t.personTyped("\x1b\x1b");
    expect(await t.type("[Switchboard] Directive from octocat")).toEqual({ typed: true });
  });

  it("is idle again after a SessionStart for a new, resumed or cleared session, but not after a compaction", async () => {
    for (const source of ["startup", "resume", "clear"]) {
      const { typer: t } = typer();
      t.hook({ hook_event_name: "UserPromptSubmit" });
      t.hook({ hook_event_name: "SessionStart", source });
      t.personTyped("fixit\x1b\x1b");
      expect(await t.type(DIRECTIVE), source).toEqual({ typed: true });
    }
    // Claude Code compacts mid-turn, and the turn carries on.
    const { typer: t } = typer();
    t.hook({ hook_event_name: "UserPromptSubmit" });
    t.hook({ hook_event_name: "SessionStart", source: "compact" });
    t.personTyped("fixit\x1b\x1b");
    expect(await t.type(DIRECTIVE)).toEqual(personTyping);
  });

  it("is not idle after any hook but Stop, such as a turn Claude Code starts by itself", async () => {
    for (const hook of ["Notification", "SubagentStop", "PreCompact", "PostToolUse"]) {
      const { typer: t } = typer();
      t.hook({ hook_event_name: "Stop" });
      t.hook({ hook_event_name: hook });
      t.personTyped("fixit\x1b\x1b");
      expect(await t.type(DIRECTIVE), hook).toEqual(personTyping);
      t.personTyped("\x03");
      expect(await t.type(DIRECTIVE), hook).toEqual(personTyping);
    }
  });

  it("does not take double Escape or Ctrl+C as clearing in a CLI whose prompt keeps its text (Codex)", async () => {
    for (const keys of ["\x1b\x1b", "\x1b[27u\x1b[27u", "\x03", "\x1b[99;5u"]) {
      const { typer: t } = typer({ idleClears: false });
      t.personTyped(`fixit${keys}`);
      expect(await t.type(DIRECTIVE), JSON.stringify(keys)).toEqual(personTyping);
    }
    // The keys every prompt reads the same way still clear.
    const { typer: t } = typer({ idleClears: false });
    t.personTyped("fixit\x17");
    expect(await t.type(DIRECTIVE)).toEqual({ typed: true });
  });
});

describe("InputLine, the rewind picker", () => {
  it("is not empty after a double Escape on an empty line opens it and Enter puts an old prompt back", () => {
    for (const idle of [true, false]) {
      const { line } = lineAt({ idle });
      line.keys("\x1b\x1b");
      expect(line.empty).toBe(false);
      line.keys("\r");
      expect(line.empty).toBe(false);
    }
    // After a double Escape cleared the line, a second one opens the picker.
    const { line, clock } = lineAt();
    line.keys("half a thought\x1b\x1b");
    expect(line.empty).toBe(true);
    clock.now += 1000;
    line.keys("\x1b\x1b\r");
    expect(line.empty).toBe(false);
  });
});
