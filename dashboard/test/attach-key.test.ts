// What a key press in the terminal panel sends to the Agent's terminal, and the sequence
// numbers its frames carry: the wrapper drops any frame whose number is not higher than
// the last one it took from the key.

import { describe, expect, it } from "vitest";
import { keyInput, nextSeq } from "@/lib/attach-key";

const press = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  keyInput({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("keyInput", () => {
  it("sends printable keys as themselves", () => {
    expect(["a", "Z", "7", " ", "é", "/"].map((k) => press(k))).toEqual(["a", "Z", "7", " ", "é", "/"]);
  });

  it("sends the bytes a terminal expects for Enter, Backspace, Tab, Escape and arrows", () => {
    expect(press("Enter")).toBe("\r");
    expect(press("Backspace")).toBe("\x7f");
    expect(press("Tab")).toBe("\t");
    expect(press("Tab", { shiftKey: true })).toBe("\x1b[Z");
    expect(press("Escape")).toBe("\x1b");
    expect(press("ArrowUp")).toBe("\x1b[A");
    expect(press("ArrowLeft")).toBe("\x1b[D");
  });

  it("sends Ctrl+letter as its control code, so Ctrl+C interrupts", () => {
    expect(press("c", { ctrlKey: true })).toBe("\x03");
    expect(press("D", { ctrlKey: true })).toBe("\x04");
    expect(press("[", { ctrlKey: true })).toBe("\x1b");
    expect(press("1", { ctrlKey: true })).toBeNull();
  });

  it("leaves the browser's own shortcuts and keys that type nothing alone", () => {
    expect(press("v", { metaKey: true })).toBeNull();
    expect(press("Shift")).toBeNull();
    expect(press("F5")).toBeNull();
  });

  it("prefixes Alt with Escape, as terminals read Meta", () => {
    expect(press("b", { altKey: true })).toBe("\x1bb");
  });
});

describe("nextSeq", () => {
  it("counts up within one millisecond and when the clock goes back", () => {
    const a = nextSeq(1_000);
    const b = nextSeq(1_000);
    const c = nextSeq(500);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("follows the clock, so a reloaded page starts above what it sent before", () => {
    const before = nextSeq(2_000);
    expect(nextSeq(Date.now())).toBeGreaterThan(before);
    expect(nextSeq(Date.now() + 1)).toBeGreaterThanOrEqual((Date.now() + 1) * 1000);
  });
});
