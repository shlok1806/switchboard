// Usage on the Dashboard (ADR 0011): meter colours, stale readings, reset countdowns,
// and one card per account with the Agents running on it and their share.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AccountUsage, Agent, AgentUsage, SessionUsage } from "@shared/index";
import { AccountCardView, Meter } from "@/components/domain/usage";
import { accountCards, meterTone, resetText } from "@/lib/usage";

const NOW = Date.parse("2026-10-07T06:17:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const inMinutes = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function session(requests: number, costUsd?: number): SessionUsage {
  return { requests, inputTokens: requests * 100, outputTokens: requests * 10, cacheReadTokens: 0, cacheWriteTokens: 0, ...(costUsd === undefined ? {} : { costUsd }) };
}

function agent(id: string, usage: Omit<AgentUsage, "reportedAt"> | undefined, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    person: "shlok1806",
    cli: "claude-code",
    presence: "live",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: true,
    lastSeenAt: ago(0),
    startedAt: ago(30),
    ...(usage === undefined ? {} : { usage: { ...usage, reportedAt: ago(0) } }),
    ...extra,
  };
}

const account: AccountUsage = {
  email: "shlokat2@illinois.edu",
  plan: "max",
  limits: {
    readAt: ago(2),
    session: { percent: 74, resetsAt: inMinutes(42) },
    week: { percent: 44, resetsAt: inMinutes(60 * 40) },
    models: [{ model: "Fable", percent: 95, resetsAt: inMinutes(60 * 40) }],
  },
  history: [{ at: ago(30), session: 60 }, { at: ago(2), session: 74 }],
};

describe("a meter", () => {
  it("is green under 70%, amber from 70% to 90%, red over 90%", () => {
    expect([0, 69.9, 70, 90, 90.5, 100].map(meterTone)).toEqual(["green", "green", "amber", "amber", "red", "red"]);
    const html = (percent: number) => renderToStaticMarkup(<Meter label="Session" limit={{ percent }} now={NOW} />);
    expect(html(40)).toContain('data-tone="green"');
    expect(html(40)).toContain("bg-green");
    expect(html(80)).toContain("bg-orange");
    expect(html(97)).toContain("bg-red");
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
});

describe("an account card", () => {
  it("shows the full email, the plan, every limit and the Agents running on it with their share", () => {
    const agents = [
      agent("shlok1806/claude/aaaa", { email: account.email, session: session(30, 3) }, { nickname: "api", model: "claude-opus-5-5" }),
      agent("shlok1806/claude/bbbb", { email: account.email, session: session(10, 1) }, { startedAt: ago(10) }),
      agent("shlok1806/claude/cccc", { email: account.email, session: session(99, 9) }, { presence: "gone" }),
      agent("shlok1806/claude/dddd", { email: "other@gmail.com" }),
    ];
    const [card] = accountCards([account], agents);
    expect(card.agents.map((a) => [a.agent.id, a.share])).toEqual([
      ["shlok1806/claude/aaaa", 0.75],
      ["shlok1806/claude/bbbb", 0.25],
    ]);
    expect(card.total.requests).toBe(40);

    const html = renderToStaticMarkup(<AccountCardView card={card} now={NOW} />);
    expect(html).toContain("shlokat2@illinois.edu");
    expect(html).toContain("Max plan");
    expect(html).toContain("Week (all models)");
    expect(html).toContain("Week (Fable)");
    expect(html).toContain('data-tone="red"');
    expect(html).toContain("2 Agents running");
    expect(html).toContain("Opus 5.5 · 30 min · 75%");
    expect(html).toContain("30 requests · 3K in · 300 out · $3.00");
    expect(html).not.toContain("Stale");
  });

  it("dims a reading older than 15 minutes and says how old it is", () => {
    const old = { ...account, limits: { ...account.limits, readAt: ago(22) } };
    const [card] = accountCards([old], []);
    const html = renderToStaticMarkup(<AccountCardView card={card} now={NOW} />);
    expect(html).toContain("Stale · read 22m ago");
    expect(html).toContain('data-stale="true"');
    expect(html).toContain("opacity-55");
  });

  it("is there for an account an Agent reported without limits, and takes an Agent's newer reading", () => {
    const newer = { ...account.limits, readAt: ago(0), session: { percent: 91 } };
    const cards = accountCards([account], [
      agent("x/claude/1", { email: account.email, limits: newer }),
      agent("x/claude/2", { email: "key@example.com", session: session(1) }),
    ]);
    expect(cards.map((c) => c.email)).toEqual(["shlokat2@illinois.edu", "key@example.com"]);
    expect(cards[0].limits?.session?.percent).toBe(91);
    expect(renderToStaticMarkup(<AccountCardView card={cards[1]} now={NOW} />)).toContain("No limits");
  });
});
