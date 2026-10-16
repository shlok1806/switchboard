// @vitest-environment happy-dom
// Activity, used as a Person would: an Interrupt the Relay types into a session arrives as a
// row and a count on the Activity key, never a toast, and reading Activity clears the count;
// the log reads by model turn, where a turn opens on its Proxy, Hook and Tool Captures side by
// side (what Compare was), and an old Compare link lands there; new Events wait under a button
// while the log is being read; on a phone a row opens its Event as a sheet.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentId, ChannelEvent, ChannelSnapshot, StreamMessage, Verdict } from "@shared/index";
import { TopBar } from "@/components/shell/nav";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { parse } from "@/lib/router";
import { ActivityView } from "@/views/ActivityView";

const agent = (id: string, nickname: string) =>
  ({
    id: id as AgentId,
    person: id.split("/")[0],
    nickname,
    cli: "claude-code",
    presence: "live",
    lastSeenAt: "2026-10-15T10:00:00.000Z",
    startedAt: "2026-10-15T09:00:00.000Z",
  }) as unknown as Agent;
const quill = agent("ana/claude/aaaa", "quill");
const moth = agent("bo/claude/bbbb", "moth");

let seq = 0;
const ev = (type: string, actor: Agent, payload: object, extra: Partial<ChannelEvent> = {}) =>
  ({
    id: `e${++seq}`,
    seq,
    at: `2026-10-15T10:${String(seq).padStart(2, "0")}:00.000Z`,
    type,
    actor: { kind: "agent", agentId: actor.id },
    capture: "hook",
    payload,
    ...extra,
  }) as unknown as ChannelEvent;

const history = [
  ev("proxy.digest", quill, { model: "claude-opus", inputTokens: 900, outputTokens: 40, reply: "Paging the users table by 50.", toolCalls: [], maskedSecrets: 0 }, { capture: "proxy", turn: "t1" }),
  ev("file.edit", quill, { path: "web/src/users.tsx", additions: 4, deletions: 1 }, { turn: "t1" }),
  ev("update", quill, { text: "Users page loads 50 at a time." }, { capture: "tool", turn: "t1" }),
  ev("command", moth, { command: "npm test" }),
];

let push: (m: StreamMessage) => void = () => {};

function channel() {
  const source = {
    me: "ana",
    capabilities: { verdicts: true, directives: true, captures: true },
    snapshot: async () =>
      ({
        channel: { repo: "ana/app" },
        persons: [{ name: "ana" }, { name: "bo" }],
        agents: [quill, moth],
        tasks: [],
        events: history,
        verdicts: [],
        relay: { interruptThreshold: 0.6 },
        cursor: 0,
      }) as unknown as ChannelSnapshot,
    eventsById: async () => [],
    wakesAfter: async () => [],
    subscribe: (_c: number, onMessage: (m: StreamMessage) => void) => {
      push = onMessage;
      return () => {};
    },
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

const interrupt = (event: ChannelEvent, to: Agent): Verdict =>
  ({
    event: event.id,
    agent: to.id,
    at: event.at,
    option: "interrupt",
    delivered: "interrupt",
    source: "jev",
    probabilities: { interrupt: 0.81, queue: 0.17, drop: 0.02 },
    overlap: { files: ["web/src/users.tsx"], symbols: [] },
  }) as unknown as Verdict;

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("an Interrupt", () => {
  it("arrives as a row and a count on the Activity key, and reading Activity clears the count", async () => {
    const Wrapper = channel();
    const { unmount } = render(
      <Wrapper>
        <TopBar route={{ view: "now" }} repo="ana/app" onSearch={() => {}} />
      </Wrapper>,
    );
    const key = await screen.findByRole("link", { name: /^Activity/ });
    const push1 = ev("push", moth, { branch: "task/12", commit: "7c2d0f1", message: "Rename getJson", commits: [], files: [] }, { capture: null });
    act(() => {
      push({ type: "event", event: push1 });
      push({ type: "verdict", verdict: interrupt(push1, quill) });
    });
    expect(key.textContent).toContain("1 new Interrupt");
    unmount();

    render(
      <Wrapper>
        <TopBar route={{ view: "feed" }} repo="ana/app" onSearch={() => {}} />
        <ActivityView />
      </Wrapper>,
    );
    const row = await screen.findByRole("button", { name: /^Interrupt for ana\/claude\/aaaa/ });
    expect(row.textContent).toContain("Typed bo's push into its running session.");
    expect(row.textContent).toContain("Jev 0.81");
    expect(screen.getByRole("link", { name: /^Activity/ }).textContent).not.toContain("Interrupt");
  });
});

describe("the log by model turn", () => {
  it("folds a turn into one row that opens on its three Captures side by side", async () => {
    render(<ActivityView />, { wrapper: channel() });
    fireEvent.click(await screen.findByRole("button", { name: "By turn" }));
    const turn = document.getElementById("turn-t1")!;
    expect(within(turn).getByText("Users page loads 50 at a time.")).toBeTruthy();
    expect(within(turn).getByText(/3 Events: 1 Proxy, 1 Hook, 1 Tool/)).toBeTruthy();
    // An Event outside any turn stays a row of its own.
    expect(screen.getByRole("button", { name: /^Command at/ })).toBeTruthy();

    fireEvent.click(within(turn).getByRole("button", { name: "Compare" }));
    const proxy = within(turn).getByRole("region", { name: "Proxy Capture" });
    expect(within(proxy).getByText("Paging the users table by 50.")).toBeTruthy();
    expect(within(within(turn).getByRole("region", { name: "Hook Capture" })).getByText("Edited web/src/users.tsx")).toBeTruthy();
    expect(within(turn).getByRole("region", { name: "Tool Capture" })).toBeTruthy();
  });

  it("opens an old Compare link as the log by turn with that turn open", async () => {
    const route = parse("#/compare/t1");
    expect(route).toEqual({ view: "feed", by: "turn", turn: "t1" });
    render(<ActivityView byTurn turn="t1" />, { wrapper: channel() });
    const turn = await screen.findByRole("button", { name: "Close" });
    expect(turn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "By turn" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("new Events", () => {
  it("wait under a button while the log is being read, and the button goes to them", async () => {
    render(<ActivityView />, { wrapper: channel() });
    const log = await screen.findByRole("region", { name: "Events" });
    // Scrolled up, away from the newest.
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    act(() => push({ type: "event", event: ev("update", moth, { text: "Tests pass." }, { capture: "tool" }) }));
    const button = screen.getByRole("button", { name: "1 new Event" });
    expect(log.scrollTop).toBe(100);
    fireEvent.click(button);
    expect(log.scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: /new Event/ })).toBeNull();
  });
});

describe("on a phone", () => {
  it("opens a row's Event as a sheet that Escape closes", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    try {
      const Wrapper = channel();
      const { rerender } = render(
        <Wrapper>
          <ActivityView />
        </Wrapper>,
      );
      fireEvent.click(await screen.findByRole("button", { name: /^Command at/ }));
      expect(window.location.hash).toBe("#/feed/e4");
      rerender(
        <Wrapper>
          <ActivityView selected="e4" />
        </Wrapper>,
      );
      const sheet = await screen.findByRole("dialog", { name: "Command, in the inspector" });
      expect(within(sheet).getByText("$ npm test")).toBeTruthy();
      fireEvent.keyDown(sheet, { key: "Escape" });
      expect(window.location.hash).toBe("#/feed");
    } finally {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    }
  });
});
