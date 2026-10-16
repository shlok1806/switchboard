// @vitest-environment happy-dom
// The Now view with the demo Channel, as a Person sees it: the Now key, the page head and the
// queue all count the same lines, a review someone else asks of you among them; a note Agents
// left opens in Memory.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, ChannelEvent, ChannelSnapshot, Task } from "@shared/index";
import { TopBar } from "@/components/shell/nav";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { ME, agents, persons, tasks } from "@/data/mock/fixtures";
import { NowView } from "@/views/NowView";

/** A Task maya's Agent finished: its review is shlok's to give. */
const mayasReview: Task = {
  ...tasks[0]!,
  number: 30,
  title: "Retry budget per request",
  status: "review",
  pr: 31,
  branch: "task/30-retry-budget",
  claim: { task: 30, holder: { kind: "agent", agentId: "maya/claude/2b8d" as AgentId }, claimedAt: "2026-10-15T09:00:00.000Z", stale: false },
};

function channel(events: ChannelEvent[] = []) {
  const source = {
    me: ME,
    capabilities: {},
    snapshot: async (): Promise<ChannelSnapshot> =>
      ({ channel: { repo: "shlok1806/app" }, persons, agents, tasks: [...tasks, mayasReview], events, verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
    subscribe: () => () => {},
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => (
    <ChannelProvider store={store}>
      <TooltipProvider>{children}</TooltipProvider>
    </ChannelProvider>
  );
}

afterEach(cleanup);

async function show(events: ChannelEvent[] = []) {
  const Wrapper = channel(events);
  render(
    <Wrapper>
      <TopBar route={{ view: "now" }} repo="shlok1806/app" onSearch={() => {}} />
      <NowView />
    </Wrapper>,
  );
  await act(async () => {});
}

describe("the Now view", () => {
  it("counts the same lines on the Now key, in the head and in the queue", async () => {
    await show();
    const key = screen.getByRole("link", { name: /^Now/ });
    const n = Number(key.textContent!.match(/\d+/)![0]);
    expect(n).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(new RegExp(`^${n} lines need you`));
    const queue = screen.getByRole("region", { name: "Needs a Person" });
    expect(within(queue).getByText(`${n} for you`, { exact: false })).toBeTruthy();

    fireEvent.click(within(queue).getByRole("button", { name: "Mine" }));
    expect(within(queue).getAllByRole("listitem")).toHaveLength(n);
  });

  it("puts a review someone else asks of you in the queue, and counts it", async () => {
    await show();
    const queue = screen.getByRole("region", { name: "Needs a Person" });
    fireEvent.click(within(queue).getByRole("button", { name: "Mine" }));
    expect(within(queue).getByText("PR #31 is ready for your review")).toBeTruthy();
    expect(within(queue).getByRole("link", { name: "Review PR #31" })).toBeTruthy();
  });

  it("opens a note in Memory", async () => {
    const note = {
      id: "n1",
      seq: 1,
      at: new Date().toISOString(),
      type: "memory.note",
      actor: { kind: "agent", agentId: agents[0]!.id },
      capture: null,
      payload: { text: "The users API pages by 50.", tags: ["fact"] },
    } as unknown as ChannelEvent;
    await show([note]);
    window.location.hash = "";
    fireEvent.click(within(screen.getByRole("region", { name: "Memory" })).getByText("The users API pages by 50."));
    expect(window.location.hash).toBe("#/memory/n1");
  });
});
