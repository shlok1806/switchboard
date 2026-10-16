// @vitest-environment happy-dom
// Activity, used as a Person would: an Interrupt the Relay types into a session arrives as a
// row and a count on the Activity key, never a toast, and reading its row clears the count;
// the log reads by model turn, where a turn opens on its Proxy, Hook and Tool Captures side by
// side (what Compare was), and an old Compare link lands there and stays there while its
// Events are read; or by Agent, a section each; new Events wait under a button while the log
// is being read; on a phone a row opens its Event as a sheet; an Agent's History uses the same rows.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentId, ChannelEvent, ChannelSnapshot, StreamMessage, Verdict } from "@shared/index";
import { TopBar } from "@/components/shell/nav";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore, useChannel } from "@/data/store";
import { parse } from "@/lib/router";
import { ActivityView } from "@/views/ActivityView";
import { AgentDetail } from "@/views/AgentDetail";

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

const turnHistory = () => [
  ev("proxy.digest", quill, { model: "claude-opus", inputTokens: 900, outputTokens: 40, reply: "Paging the users table by 50.", toolCalls: [], maskedSecrets: 0 }, { capture: "proxy", turn: "t1" }),
  ev("file.edit", quill, { path: "web/src/users.tsx", additions: 4, deletions: 1 }, { turn: "t1" }),
  ev("update", quill, { text: "Users page loads 50 at a time." }, { capture: "tool", turn: "t1" }),
  ev("command", moth, { command: "npm test" }),
];

let push: (m: StreamMessage) => void = () => {};
// Each test is its own Channel, so what one test saw never counts as seen in the next.
let channels = 0;

function channel(events: ChannelEvent[] = turnHistory(), verdicts: Verdict[] = []) {
  const repo = ++channels;
  const source = {
    me: "ana",
    capabilities: { verdicts: true, directives: true, captures: true },
    snapshot: async () =>
      ({
        channel: { repo: `ana/app-${repo}` },
        persons: [{ name: "ana" }, { name: "bo" }],
        agents: [quill, moth],
        tasks: [],
        events,
        verdicts,
        relay: { interruptThreshold: 0.6 },
        cursor: 0,
      }) as unknown as ChannelSnapshot,
    eventsById: async () => [],
    wakesAfter: async () => [],
    scopedEvents: async (scope: { agent?: string }) => ({
      events: events.filter((e) => e.actor.kind === "agent" && e.actor.agentId === scope.agent),
    }),
    terminal: () => ({ send: () => false, close: () => {} }),
    subscribe: (_c: number, onMessage: (m: StreamMessage) => void) => {
      push = onMessage;
      return () => {};
    },
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

// A Verdict made after the page opened, so it counts as new on the Activity key.
const verdict = (event: ChannelEvent, to: Agent, extra: Partial<Verdict> = {}): Verdict =>
  ({
    event: event.id,
    agent: to.id,
    at: new Date(Date.now() + 60_000).toISOString(),
    option: "interrupt",
    delivered: "interrupt",
    source: "jev",
    probabilities: { interrupt: 0.81, queue: 0.17, drop: 0.02 },
    overlap: { files: ["web/src/users.tsx"], symbols: [] },
    ...extra,
  }) as unknown as Verdict;

/** The log row that shows this text. */
const rowWith = (text: string | RegExp) => {
  const row = screen.getByText(text).closest("[role=button]");
  if (!(row instanceof HTMLElement)) throw new Error(`no row shows ${text}`);
  return row;
};

beforeEach(() => {
  seq = 0;
  // Under Node 26 the global localStorage is Node's own experimental one; a Map stands in.
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("an Interrupt", () => {
  it("arrives as a row and a count on the Activity key, and seeing its row clears the count", async () => {
    const Wrapper = channel();
    const { unmount } = render(
      <Wrapper>
        <TopBar route={{ view: "now" }} repo="ana/app" onSearch={() => {}} />
      </Wrapper>,
    );
    const key = await screen.findByRole("link", { name: /^Activity/ });
    const pushed = ev("push", moth, { branch: "task/12", commit: "7c2d0f1", message: "Rename getJson", commits: [], files: [] }, { capture: null });
    act(() => {
      push({ type: "event", event: pushed });
      push({ type: "verdict", verdict: verdict(pushed, quill) });
    });
    expect(key.textContent).toContain("1 new Interrupt");
    unmount();

    render(
      <Wrapper>
        <TopBar route={{ view: "feed" }} repo="ana/app" onSearch={() => {}} />
        <ActivityView />
      </Wrapper>,
    );
    const row = rowWith("Typed bo's push into its running session.");
    expect(row.textContent).toContain("Interrupt");
    expect(row.textContent).toContain("Jev 0.81");
    await waitFor(() => expect(screen.getByRole("link", { name: /^Activity/ }).textContent).not.toContain("Interrupt"));
  });

  it("still counts while a filter hides its row", async () => {
    const Wrapper = channel();
    render(
      <Wrapper>
        <TopBar route={{ view: "feed" }} repo="ana/app" onSearch={() => {}} />
        <ActivityView />
      </Wrapper>,
    );
    await screen.findByText("$ npm test");
    // Only Tool Capture Events: the push below has no Capture, so neither it nor its Interrupt shows.
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by Capture" }), { target: { value: "tool" } });
    const pushed = ev("push", moth, { branch: "task/12", commit: "7c2d0f1", message: "Rename getJson", commits: [], files: [] }, { capture: null });
    act(() => {
      push({ type: "event", event: pushed });
      push({ type: "verdict", verdict: verdict(pushed, quill) });
    });
    expect(screen.queryByText("Typed bo's push into its running session.")).toBeNull();
    expect(screen.getByRole("link", { name: /^Activity/ }).textContent).toContain("1 new Interrupt");
  });

  it("reads as Queued instead, with the reason, when the Relay could not type it in", async () => {
    const events = turnHistory();
    const pushed = ev("push", moth, { branch: "task/12", commit: "7c2d0f1", message: "Rename getJson", commits: [], files: [] }, { capture: null });
    render(<ActivityView />, {
      wrapper: channel([...events, pushed], [verdict(pushed, quill, { delivered: "queue", downgraded: { reason: "below-threshold" } } as Partial<Verdict>)]),
    });
    await screen.findByText(/^Queued bo's push instead of typing it in: interrupt was below the threshold\.$/);
    const row = rowWith(/^Queued bo's push instead of typing it in: /);
    expect(row.textContent).toContain("Queued instead");
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
    expect(rowWith("$ npm test")).toBeTruthy();

    fireEvent.click(within(turn).getByRole("button", { name: "Compare" }));
    const proxy = within(turn).getByRole("region", { name: "Proxy Capture" });
    expect(within(proxy).getByText("Paging the users table by 50.")).toBeTruthy();
    expect(within(within(turn).getByRole("region", { name: "Hook Capture" })).getByText("Edited web/src/users.tsx")).toBeTruthy();
    expect(within(turn).getByRole("region", { name: "Tool Capture" })).toBeTruthy();
  });

  it("opens an old Compare link on that turn, and picking one of its Events keeps the turn", async () => {
    expect(parse("#/compare/t1")).toEqual({ view: "feed", by: "turn", turn: "t1" });
    const Wrapper = channel();
    const { rerender } = render(
      <Wrapper>
        <ActivityView byTurn turn="t1" />
      </Wrapper>,
    );
    await screen.findAllByText("Users page loads 50 at a time.");
    const turn = document.getElementById("turn-t1")!;
    expect(within(turn).getByRole("button", { name: "Close" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "By turn" }).getAttribute("aria-pressed")).toBe("true");

    const hook = screen.getByRole("region", { name: "Hook Capture" });
    fireEvent.click(within(hook).getByText("Edited web/src/users.tsx"));
    expect(window.location.hash).toBe("#/feed/turn/t1/e2");
    const route = parse(window.location.hash);
    expect(route).toEqual({ view: "feed", by: "turn", turn: "t1", event: "e2" });
    rerender(
      <Wrapper>
        <ActivityView byTurn turn="t1" selected="e2" />
      </Wrapper>,
    );
    expect(within(document.getElementById("turn-t1")!).getByRole("button", { name: "Close" }).getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("complementary", { name: "File edit, in the inspector" })).toBeTruthy();
  });

  it("opens #/feed/turn with no turn named as the log by turn, all turns closed", async () => {
    expect(parse("#/feed/turn")).toEqual({ view: "feed", by: "turn", turn: undefined });
    render(<ActivityView byTurn />, { wrapper: channel() });
    expect(await screen.findByRole("button", { name: "Compare" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says so when no model turn is among the loaded Events", async () => {
    render(<ActivityView byTurn />, { wrapper: channel([ev("command", moth, { command: "npm test" })]) });
    expect((await screen.findByRole("status")).textContent).toMatch(/^No model turn among the 1 newest Events/);
    expect(screen.queryByText(/model turns?$/)).toBeNull();
  });
});

describe("the log by Agent", () => {
  it("holds a section per Agent, each with its own rows", async () => {
    render(<ActivityView />, { wrapper: channel() });
    fireEvent.click(await screen.findByRole("button", { name: "By Agent" }));
    const ana = screen.getByRole("region", { name: /ana\/claude\/aaaa$/ });
    const bo = screen.getByRole("region", { name: /bo\/claude\/bbbb$/ });
    expect(within(ana).getByText("3 rows")).toBeTruthy();
    expect(within(ana).getByText("Users page loads 50 at a time.")).toBeTruthy();
    expect(within(bo).getByText("$ npm test")).toBeTruthy();
    expect(within(bo).queryByText("Users page loads 50 at a time.")).toBeNull();
  });
});

describe("new Events", () => {
  it("wait under a button while the log is being read, and the button goes to them", async () => {
    render(<ActivityView />, { wrapper: channel() });
    const log = await screen.findByRole("region", { name: "Events" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
    // Scrolled up, away from the newest.
    log.scrollTop = 100;
    fireEvent.scroll(log);
    act(() => push({ type: "event", event: ev("update", moth, { text: "Tests pass." }, { capture: "tool" }) }));
    const button = screen.getByRole("button", { name: "1 new Event" });
    expect(log.scrollTop).toBe(100);
    fireEvent.click(button);
    expect(log.scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: /new Event/ })).toBeNull();
  });

  it("stop counting once the log is scrolled back to the newest by hand", async () => {
    render(<ActivityView />, { wrapper: channel() });
    const log = await screen.findByRole("region", { name: "Events" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    act(() => push({ type: "event", event: ev("update", moth, { text: "Tests pass." }, { capture: "tool" }) }));
    expect(screen.getByRole("button", { name: "1 new Event" })).toBeTruthy();
    log.scrollTop = 1600;
    fireEvent.scroll(log);
    expect(screen.queryByRole("button", { name: /new Event/ })).toBeNull();
  });
});

describe("new Events, on a turn link", () => {
  it("count nothing on landing, and only what arrives after", async () => {
    render(<ActivityView byTurn turn="t1" />, { wrapper: channel() });
    await screen.findAllByText("Users page loads 50 at a time.");
    expect(screen.queryByRole("button", { name: /new Event/ })).toBeNull();
    act(() => push({ type: "event", event: ev("update", moth, { text: "Tests pass." }, { capture: "tool" }) }));
    expect(screen.getByRole("button", { name: "1 new Event" })).toBeTruthy();
  });

  it("stay counted when the log's own scroll to the turn ends near the bottom", async () => {
    // As a browser does: the turn's scrollIntoView scrolls the log, landing 40px from the
    // bottom, and the scroll event follows before the next frame.
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      const log = this.closest("[role=region]") as HTMLElement;
      Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
      log.scrollTop = 1560;
      queueMicrotask(() => fireEvent.scroll(log));
    });
    render(<ActivityView byTurn turn="t1" />, { wrapper: channel() });
    const log = await screen.findByRole("region", { name: "Events" });
    await screen.findAllByText("Users page loads 50 at a time.");
    await act(async () => {});
    expect(scrollIntoView).toHaveBeenCalled();
    act(() => push({ type: "event", event: ev("update", moth, { text: "Tests pass." }, { capture: "tool" }) }));
    expect(screen.getByRole("button", { name: "1 new Event" })).toBeTruthy();
    expect(log.scrollTop).toBe(1560);
    scrollIntoView.mockRestore();
  });
});

describe("a turn link, under StrictMode", () => {
  function Loaded() {
    return useChannel().events.length > 0 ? <p>loaded</p> : null;
  }

  // React runs every effect twice in development. The log's effects that keep its place
  // (older Events loaded above, a new filter or grouping) must act only on a real change, or
  // the second run drops the log from the turn to its bottom.
  it("stays on the turn when React runs its effects again", async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      const log = this.closest("[role=region]") as HTMLElement;
      Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
      log.scrollTop = 600;
    });
    // The Channel is loaded before Activity mounts, as when the Person follows a link from
    // another view, so React's second run of the mount effects meets the rows already there.
    const Wrapper = channel();
    const { rerender } = render(
      <StrictMode>
        <Wrapper>
          <Loaded />
        </Wrapper>
      </StrictMode>,
    );
    await screen.findByText("loaded");
    rerender(
      <StrictMode>
        <Wrapper>
          <Loaded />
          <ActivityView byTurn turn="t1" />
        </Wrapper>
      </StrictMode>,
    );
    const log = screen.getByRole("region", { name: "Events" });
    await act(async () => {});
    expect(scrollIntoView).toHaveBeenCalled();
    expect(log.scrollTop).toBe(600);
    expect(screen.queryByRole("button", { name: /new Event/ })).toBeNull();
    scrollIntoView.mockRestore();
  });
});

describe("new Events, regrouped", () => {
  it("are cleared when a new grouping starts the log at the newest again", async () => {
    render(<ActivityView />, { wrapper: channel() });
    const log = await screen.findByRole("region", { name: "Events" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    act(() => push({ type: "event", event: ev("update", moth, { text: "Tests pass." }, { capture: "tool" }) }));
    expect(screen.getByRole("button", { name: "1 new Event" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "By Agent" }));
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
      fireEvent.click(rowWithAsync(await screen.findByText("$ npm test")));
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

describe("an Agent's History", () => {
  it("lists what it did as log rows that open in Activity", async () => {
    render(<AgentDetail id={quill.id} />, { wrapper: channel() });
    fireEvent.click(await screen.findByRole("button", { name: /^History/ }));
    const history = screen.getByRole("region", { name: "History" });
    const row = within(history).getByText("Paging the users table by 50.").closest("[role=button]") as HTMLElement;
    expect(within(history).queryByText("$ npm test")).toBeNull();
    fireEvent.click(row);
    expect(window.location.hash).toBe("#/feed/e1");
  });
});

describe("an Agent's page opened for a Directive", () => {
  it("puts focus in the Directive field, ready to type", async () => {
    render(<AgentDetail id={quill.id} focus="directive" />, { wrapper: channel() });
    const field = await screen.findByRole("textbox", { name: /Directive/ });
    await waitFor(() => expect(document.activeElement).toBe(field));
  });
});

function rowWithAsync(el: HTMLElement): HTMLElement {
  return el.closest("[role=button]") as HTMLElement;
}
