// @vitest-environment happy-dom
// The phone breakpoint is known on the first render, so a page that measures itself on mount
// measures the layout the Person sees.

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useIsMobile } from "@/hooks/use-mobile";

const width = window.innerWidth;
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
});

function firstRender(innerWidth: number): boolean {
  Object.defineProperty(window, "innerWidth", { value: innerWidth, configurable: true });
  const seen: boolean[] = [];
  function Probe() {
    seen.push(useIsMobile());
    return null;
  }
  render(<Probe />);
  return seen[0]!;
}

it("is a phone on the first render at 390px", () => {
  expect(firstRender(390)).toBe(true);
});

it("is not a phone on the first render at 1440px", () => {
  expect(firstRender(1440)).toBe(false);
});
