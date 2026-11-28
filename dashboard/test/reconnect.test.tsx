// @vitest-environment happy-dom
// A Dashboard whose stream fell far behind, as after a laptop slept for a day: the Channel
// will not replay the gap (it says `reload`), so the Dashboard loads its snapshot again. It
// keeps what it drew until the new snapshot is in, saying it is reconnecting rather than
// flashing a loading page, then shows every recent Event with the log at the newest, and an
// Agent's History reads its latest page again, so the gap's Events are there too.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentId, ChannelEvent, ChannelSnapshot, StreamMessage } from "@shared/index";
import { TopBar } from "@/components/shell/nav";
import type { ChannelSource, ConnectionState } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { ActivityView } from "@/views/ActivityView";
import { AgentDetail } from "@/views/AgentDetail";

const quill = {
  id: "ana/claude/aaaa" as AgentId,
  person: "ana",
  nickname: "quill",
  cli: "claude-code",
  presence: "live",
  lastSeenAt: "2026-10-15T10:00:00.000Z",
  startedAt: "2026-10-15T09:00:00.000Z",
} as unknown as Agent;

const update = (seq: number, text: string) =>
  ({
    id: `e${seq}`,
    seq,
    at: new Date(Date.parse("2026-10-15T10:00:00.000Z") + seq * 1000).toISOString(),
    type: "update",
    actor: { kind: "agent", agentId: quill.id },
    capture: "tool",
    payload: { text },
  }) as unknown as ChannelEvent;

/** What the Dashboard loaded before the laptop slept, and what the Channel has a day later. */
const BEFORE = [update(1, "Paging the users table."), update(2, "Users page loads 50 at a time.")];
const LATER = [update(5001, "Rebased on main."), update(5002, "Tests pass on the rebased branch.")];
/** One of the Agent's Events from the day the Dashboard slept through. */
const SLEPT_THROUGH = update(3000, "Fixed the flaky login test.");

interface Stream {
  cursor: number;
  push: (m: StreamMessage) => void;
  state: (s: ConnectionState) => void;
  closed: boolean;
}

let streams: Stream[];
let snapshots: { resolve: (snap: ChannelSnapshot) => void; reject: (error: Error) => void }[];
let scopedReads: number;

function snapshotOf(events: ChannelEvent[]): ChannelSnapshot {
  return {
    channel: { id: "ana/app", repo: "ana/app", mainBranch: "main" },
    persons: [{ name: "ana", timeZone: "UTC", joinedAt: "2026-10-15T09:00:00.000Z" }],
    agents: [quill],
    tasks: [],
    events,
    verdicts: [],
    relay: { interruptThreshold: 0.6, interruptIntervalSeconds: 20, model: "jev" },
    cursor: events.at(-1)?.seq ?? 0,
  } as ChannelSnapshot;
}

/** A Channel whose snapshots and stream the test answers by hand. */
function channel(): ({ children }: { children: ReactNode }) => ReactNode {
  const source = {
    me: "ana",
    capabilities: { verdicts: true, directives: true, captures: true },
    snapshot: () => new Promise<ChannelSnapshot>((resolve, reject) => snapshots.push({ resolve, reject })),
    eventsById: async () => [],
    wakesAfter: async () => [],
    scopedEvents: async () => {
      scopedReads += 1;
      // Its latest page: before the reload what was loaded, after it what the Channel has now.
      return { events: scopedReads === 1 ? BEFORE : [SLEPT_THROUGH, ...LATER] };
    },
    agent: async () => quill,
    terminal: () => ({ send: () => false, close: () => {} }),
    hosts: async () => null,
    subscribe: (cursor: number, push: (m: StreamMessage) => void, state: (s: ConnectionState) => void) => {
      const stream: Stream = { cursor, push, state, closed: false };
      streams.push(stream);
      state("live");
      return () => {
        stream.closed = true;
      };
    },
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

beforeEach(() => {
  streams = [];
  snapshots = [];
  scopedReads = 0;
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

/** Answers the snapshot the Dashboard is waiting for. */
async function answer(events: ChannelEvent[] | Error): Promise<void> {
  const asked = snapshots.shift();
  if (!asked) throw new Error("The Dashboard asked for no snapshot");
  await act(async () => (events instanceof Error ? asked.reject(events) : asked.resolve(snapshotOf(events))));
}

describe("a Dashboard far behind the Channel", () => {
  it("keeps what it drew while it reloads, then shows every recent Event at the newest", async () => {
    render(
      <>
        <TopBar route={{ view: "feed" }} repo="ana/app" onSearch={() => {}} />
        <ActivityView />
      </>,
      { wrapper: channel() },
    );
    await answer(BEFORE);
    const log = await screen.findByRole("region", { name: "Events" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 400 });
    // The Person scrolled up to read, then the laptop slept.
    log.scrollTop = 100;
    fireEvent.scroll(log);

    // It wakes; the stream reconnects from its cursor and is told to reload.
    act(() => streams[0]?.push({ type: "reload" }));
    expect(streams[0]?.closed).toBe(true);
    expect(snapshots).toHaveLength(1);
    // Nothing flashes: the same rows, and the bar says it is reconnecting.
    expect(screen.getByText("Users page loads 50 at a time.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Reconnecting");
    expect(document.querySelector("[data-view-state]")).toBeNull();

    await answer(LATER);
    // Every recent Event, the log at the newest, and nothing waiting under a button.
    expect(screen.getByText("Rebased on main.")).toBeTruthy();
    expect(screen.getByText("Tests pass on the rebased branch.")).toBeTruthy();
    expect(screen.queryByText("Users page loads 50 at a time.")).toBeNull();
    expect(log.scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: /new Event/ })).toBeNull();
    // The stream is followed again, from the new snapshot's cursor.
    expect(streams.map((s) => [s.cursor, s.closed])).toEqual([
      [2, true],
      [5002, false],
    ]);
    act(() => streams[1]?.state("live"));
    expect(screen.queryByText("Reconnecting")).toBeNull();
  });

  it("reads an Agent's latest History again, so what it did while the Dashboard slept is there", async () => {
    render(<AgentDetail id={quill.id} />, { wrapper: channel() });
    await answer(BEFORE);
    fireEvent.click(await screen.findByRole("button", { name: /^History/ }));
    const history = screen.getByRole("region", { name: "History" });
    await within(history).findByText("Users page loads 50 at a time.");

    act(() => streams[0]?.push({ type: "reload" }));
    await answer(LATER);
    await waitFor(() => expect(within(history).getByText("Fixed the flaky login test.")).toBeTruthy());
    expect(within(history).getByText("Tests pass on the rebased branch.")).toBeTruthy();
    expect(scopedReads).toBe(2);
  });

  it("tries a reload that failed again, showing what it drew until one works", async () => {
    render(
      <>
        <TopBar route={{ view: "feed" }} repo="ana/app" onSearch={() => {}} />
        <ActivityView />
      </>,
      { wrapper: channel() },
    );
    await answer(BEFORE);
    await screen.findByText("Users page loads 50 at a time.");
    act(() => streams[0]?.push({ type: "reload" }));
    // The Channel is restarting after a deploy: no error page, the rows stay.
    await answer(new Error("The Channel's Worker answered 503."));
    expect(screen.getByText("Users page loads 50 at a time.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Reconnecting");
    await waitFor(() => expect(snapshots).toHaveLength(1), { timeout: 3000 });
    await answer(LATER);
    expect(screen.getByText("Tests pass on the rebased branch.")).toBeTruthy();
    expect(streams.at(-1)?.cursor).toBe(5002);
  });
});
