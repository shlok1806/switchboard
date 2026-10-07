import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Agent } from "@shared/index";
import { AgentBrief, ContextWindow } from "@/components/domain/context";
import { AccountCardView } from "@/components/domain/usage";
import { accountCards } from "@/lib/usage";

const agent: Agent = { id: "ana/codex/abcd", person: "ana", cli: "codex", presence: "live", proxyMode: "digest", secretMasking: true, canReceiveInterrupts: true, startedAt: new Date(Date.now() - 3600000).toISOString(), lastSeenAt: new Date().toISOString() };
describe("Agent context", () => {
  it("shows tokens, percent and compactions with exact warning thresholds", () => {
    const render = (tokens: number) => renderToStaticMarkup(<ContextWindow agent={{ ...agent, context: { readAt: new Date().toISOString(), tokens, window: 200000, autoCompactions: 2 } }} />);
    expect(render(90000)).toContain("bg-green");
    expect(render(100000)).toContain("bg-orange");
    expect(render(160000)).not.toContain("Over 80%");
    const html = render(170000);
    expect(html).toContain("85.0%"); expect(html).toContain("170,000 / 200,000 tokens");
    expect(html).toContain("Over 80%"); expect(html).toContain("bg-red"); expect(html).toContain("2 auto-compactions");
  });
  it("shows unavailable and stale readings honestly, with an expandable brief and working location", () => {
    expect(renderToStaticMarkup(<ContextWindow agent={agent} />)).toContain("Unavailable");
    const a = { ...agent, context: { readAt: new Date(Date.now() - 3600000).toISOString(), tokens: 50000, task: "Fix redirect", brief: "Fix redirect\nDB_PASSWORD=[MASKED]", activity: "Tool: Read", cwd: "/repo", branch: "fix-redirect" } };
    const html = renderToStaticMarkup(<><ContextWindow agent={a} /><AgentBrief agent={a} /></>);
    expect(html).toContain("Stale"); expect(html).toContain("Show brief"); expect(html).toContain("<details>"); expect(html).toContain("DB_PASSWORD=[MASKED]"); expect(html).toContain("Tool: Read"); expect(html).toContain("/repo"); expect(html).toContain("fix-redirect");
  });
  it("groups Codex limits by reported account label and displays both reset windows", () => {
    const limits = { readAt: new Date().toISOString(), session: { percent: 30, resetsAt: new Date(Date.now() + 3600000).toISOString() }, week: { percent: 55, resetsAt: new Date(Date.now() + 86400000).toISOString() }, models: [] };
    const a = { ...agent, usage: { accountId: "Codex · ana · work", limits, reportedAt: limits.readAt } };
    const [card] = accountCards([{ email: a.usage.accountId, limits, history: [] }], [a]);
    expect(card.agents).toHaveLength(1);
    const html = renderToStaticMarkup(<AccountCardView card={card} now={Date.now()} />);
    expect(html).toContain("Codex · ana · work"); expect(html).toContain("5-hour"); expect(html).toContain("Week (all models)"); expect(html).toContain("30%"); expect(html).toContain("55%"); expect(html).toContain("resets");
  });
});
