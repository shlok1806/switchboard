import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Agent } from "@shared/index";
import { AgentBrief, ContextWindow } from "@/components/domain/context";

const agent: Agent = { id: "ana/codex/abcd", person: "ana", cli: "codex", presence: "live", proxyMode: "digest", secretMasking: true, canReceiveInterrupts: true, startedAt: new Date(Date.now() - 3600000).toISOString(), lastSeenAt: new Date().toISOString() };
describe("Agent context", () => {
  it("shows tokens, percent and compactions with exact warning thresholds", () => {
    const render = (tokens: number) => renderToStaticMarkup(<ContextWindow agent={{ ...agent, context: { readAt: new Date().toISOString(), tokens, window: 200000, autoCompactions: 2 } }} />);
    expect(render(160000)).not.toContain("Over 80%");
    const html = render(170000);
    expect(html).toContain("85%"); expect(html).toContain("170k of 200k tokens");
    expect(html).toContain("Over 80%"); expect(html).toContain("2 auto-compactions");
  });
  it("shows unavailable and stale readings honestly, with an expandable brief and working location", () => {
    expect(renderToStaticMarkup(<ContextWindow agent={agent} />)).toContain("Unavailable");
    const a = { ...agent, context: { readAt: new Date(Date.now() - 3600000).toISOString(), tokens: 50000, task: "Fix redirect", brief: "Fix redirect\nDB_PASSWORD=[MASKED]", activity: "Tool: Read", cwd: "/repo", branch: "fix-redirect" } };
    const html = renderToStaticMarkup(<><ContextWindow agent={a} /><AgentBrief agent={a} /></>);
    expect(html).toContain("Stale"); expect(html).toContain("Show brief"); expect(html).toContain("<details>"); expect(html).toContain("DB_PASSWORD=[MASKED]"); expect(html).toContain("Tool: Read"); expect(html).toContain("/repo"); expect(html).toContain("fix-redirect");
  });
});
