// The wrapper's guess at the Person's input line, and the text it pastes.

import { describe, expect, it } from "vitest";
import { InputLine, pasteText } from "../src/interrupts";

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
