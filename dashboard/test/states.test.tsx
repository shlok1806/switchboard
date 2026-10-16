// @vitest-environment happy-dom
// Every view's loading, empty and error states, as a Person meets them (plan slice 11): while
// the Channel is joined each view draws rows shaped like its own, a Channel with nothing on it
// says so in each view with the one thing to do next, a Channel that cannot be reached says why
// with Try again, and an address the Dashboard has no page for says that instead of showing Now.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Task } from "@shared/index";
import { ViewErrorBoundary } from "@/components/shell/states";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { MockChannelSource, type MockState } from "@/data/mock/mockSource";
import { ChannelProvider, ChannelStore } from "@/data/store";

const VIEWS = ["now", "agents", "tasks", "canvas", "feed", "memory", "hosts"] as const;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

async function open(state: MockState | undefined, hash: string, change?: (s: MockChannelSource) => void) {
  window.location.hash = hash;
  const source = new MockChannelSource({ latencyMs: 0, state });
  change?.(source);
  const store = new ChannelStore(source);
  render(
    <ChannelProvider store={store}>
      <App />
    </ChannelProvider>,
  );
  await act(async () => {});
  return source;
}

const viewState = () => document.querySelector("[data-view-state]")?.getAttribute("data-view-state");

describe("while the Channel is joined", () => {
  it.each(VIEWS)("%s draws rows shaped like its own, and says it is loading", async (view) => {
    await open("loading", `#/${view}`);
    expect(viewState()).toBe("loading");
    // One status region stays on the page and changes its words, so a screen reader hears them.
    await waitFor(() => expect(screen.getAllByRole("status").some((s) => /^Loading [A-Z]/.test(s.textContent ?? ""))).toBe(true));
    expect(document.querySelector("main")?.getAttribute("aria-busy")).not.toBe("true");
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
  });
});

describe("a Channel with nothing on it", () => {
  const cases: [string, RegExp, RegExp][] = [
    ["now", /Nothing on this Channel yet/, /Copy switchboard run claude/],
    ["agents", /No Agents yet/, /Copy switchboard run claude/],
    ["canvas", /No Agents on the canvas yet/, /Copy switchboard run claude/],
    ["tasks", /No Tasks yet/, /New Task/],
    ["feed", /No Events yet/, /Post an Update/],
    ["memory", /No notes yet/, /How notes work/],
    ["hosts", /No Hosts yet/, /Copy switchboard host install/],
  ];
  it.each(cases)("%s says so, with one thing to do next", async (view, title, action) => {
    await open("empty", `#/${view}`);
    await waitFor(() => expect(viewState()).toBe("empty"));
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    // The action waits for the Channel to say whether you have a Host, so it never changes under you.
    const actions = () => document.querySelector("[data-view-state=empty]")!.querySelectorAll("button, a");
    await waitFor(() => expect(actions()).toHaveLength(1));
    expect(actions()[0]!.getAttribute("aria-label") ?? actions()[0]!.textContent).toMatch(action);
  });

  it("puts Post an Update's cursor in the composer", async () => {
    await open("empty", "#/feed");
    await waitFor(() => screen.getByRole("button", { name: "Post an Update" }));
    fireEvent.click(screen.getByRole("button", { name: "Post an Update" }));
    expect(document.activeElement?.getAttribute("placeholder")).toMatch(/Paging lands/);
  });
});

describe("a Channel that cannot be reached", () => {
  it.each(VIEWS)("%s says why, with Try again", async (view) => {
    await open("error", `#/${view}`);
    await waitFor(() => expect(viewState()).toBe("error"));
    expect(screen.getByRole("alert").textContent).toMatch(/Could not reach the Channel/);
    expect(screen.getByText(/answered 503/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    // The top bar does not claim a connection it does not have.
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
  });
});

describe("an address the Dashboard has no page for", () => {
  it.each([
    ["#/somewhere-else", /No such page/, "Go to Now"],
    ["#/tasks/9999", /No Task #9999/, "Back to the Tasks"],
    ["#/agents/nobody%2Fclaude%2Fx", /No such Agent/, "Back to Agents"],
  ])("%s says there is nothing there, and links back", async (hash, title, back) => {
    await open(undefined, hash);
    await waitFor(() => expect(viewState()).toBe("error"));
    // Nothing failed: it is said plainly, not as an alert, with focus on the title.
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: title })));
    expect(screen.getByRole("link", { name: back })).toBeTruthy();
  });

  it.each([
    ["#/memory/nope", "No such note"],
    ["#/feed/nope", "No such Event"],
  ])("%s says the inspector has nothing to show, and Close goes back to the list", async (hash, title) => {
    await open(undefined, hash);
    await waitFor(() => screen.getByRole("heading", { name: title }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: title })).toBeNull());
    expect(window.location.hash).toBe(hash.replace("/nope", ""));
  });
});

describe("a list whose filter or search matches nothing", () => {
  const empty = () => document.querySelector("[data-view-state=empty]") as HTMLElement;

  it("Agents says so, and Clear the search brings the rows back", async () => {
    await open(undefined, "#/agents");
    fireEvent.change(await screen.findByPlaceholderText("name, Task or Host"), { target: { value: "zzzz" } });
    await waitFor(() => expect(within(empty()).getByRole("heading", { name: "No Agent matches" })).toBeTruthy());
    fireEvent.click(within(empty()).getByRole("button", { name: "Clear the search" }));
    await waitFor(() => expect(empty()).toBeNull());
    expect((screen.getByPlaceholderText("name, Task or Host") as HTMLInputElement).value).toBe("");
  });

  it("Hosts says so, and Clear the filter brings the rows back", async () => {
    await open(undefined, "#/hosts", (source) => {
      const read = source.hosts.bind(source);
      source.hosts = async () => {
        const r = await read();
        return { ...r, hosts: r.hosts.filter((h) => h.live) };
      };
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Offline/ }));
    await waitFor(() => expect(within(empty()).getByRole("heading", { name: "No Host matches" })).toBeTruthy());
    fireEvent.click(within(empty()).getByRole("button", { name: "Clear the filter" }));
    await waitFor(() => expect(empty()).toBeNull());
  });

  it("Tasks says so once over the board, and Clear the filters brings the cards back", async () => {
    await open(undefined, "#/tasks", (source) => {
      const own = source as unknown as { tasks: Task[] };
      own.tasks = own.tasks.filter((t) => !t.claim);
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Stale/ }));
    await waitFor(() => expect(within(empty()).getByRole("heading", { name: "No Task matches these filters" })).toBeTruthy());
    expect(document.querySelectorAll("[data-view-state=empty]")).toHaveLength(1);
    // The board's columns do not say it again under it.
    expect(screen.queryByText("None match.")).toBeNull();
    fireEvent.click(within(empty()).getByRole("button", { name: "Clear the filters" }));
    await waitFor(() => expect(empty()).toBeNull());
  });
});

describe("a read that fails while the Channel is up", () => {
  it.each([
    ["#/hosts", "Could not read the Hosts", "hosts"],
    ["#/memory", "Could not read the notes", "memory"],
  ] as const)("%s says why, and Try again reads again", async (hash, title, read) => {
    const source = await open("read-error", hash);
    const reads = vi.spyOn(source, read);
    await waitFor(() => expect(screen.getByRole("heading", { name: title })).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/answered 500/);
    const before = reads.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(before));
  });

  it("an Event the inspector cannot read says so, with Close", async () => {
    await open("read-error", "#/feed/nope");
    await waitFor(() => screen.getByRole("heading", { name: "Could not read the Event" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.hash).toBe("#/feed"));
  });
});

describe("a page that stops working", () => {
  it("says so in place of the page, and Try again draws it again", async () => {
    let broken = true;
    function Page() {
      if (broken) throw new Error("users.map is not a function");
      return <p>The page</p>;
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ViewErrorBoundary>
        <Page />
      </ViewErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/This page stopped working/);
    expect(screen.getByText(/users.map is not a function/)).toBeTruthy();
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("The page")).toBeTruthy();
  });
});
