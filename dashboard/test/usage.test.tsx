// Usage on the Dashboard (ADR 0011): meter tones, stale readings and reset countdowns.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Meter } from "@/components/domain/usage";
import { isStale, meterTone, resetText } from "@/lib/usage";

const NOW = Date.parse("2026-10-07T06:17:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe("a meter", () => {
  it("is green under 70%, amber from 70% to 90%, red over 90%, said as a number and not a colour", () => {
    expect([0, 69.9, 70, 90, 90.5, 100].map(meterTone)).toEqual(["green", "green", "amber", "amber", "red", "red"]);
    const html = (percent: number) => renderToStaticMarkup(<Meter label="Session" limit={{ percent }} now={NOW} />);
    expect(html(40)).toContain('data-tone="green"');
    expect(html(97)).toContain('data-tone="red"');
    expect(html(97)).toContain("97%");
  });

  it("says when its window resets and how long until then", () => {
    const html = renderToStaticMarkup(
      <Meter label="Session" limit={{ percent: 80, resetsAt: "2026-10-07T06:59:00Z" }} now={NOW} timeZone="America/Chicago" />,
    );
    expect(html).toContain("resets 1:59am, in 42 min");
    expect(resetText({ resetsAt: "2026-10-08T21:59:00Z" }, NOW, "America/Chicago")).toBe("resets Thu 4:59pm, in 1 d 15 h");
    expect(resetText({ resets: "Oct 9 at noon" }, NOW)).toBe("resets Oct 9 at noon");
  });

  it("dims a reading older than 15 minutes", () => {
    expect(isStale(ago(14), NOW)).toBe(false);
    expect(isStale(ago(22), NOW)).toBe(true);
    const html = renderToStaticMarkup(<Meter label="Session" limit={{ percent: 50 }} now={NOW} stale />);
    expect(html).toContain('data-stale="true"');
  });
});
