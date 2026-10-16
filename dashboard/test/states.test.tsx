// @vitest-environment happy-dom
// Every view's loading, empty and error states, as a Person meets them (plan slice 11): while
// the Channel is joined each view draws rows shaped like its own, a Channel with nothing on it
// says so in each view with the one thing to do next, a Channel that cannot be reached says why
// with Try again, and an address the Dashboard has no page for says that instead of showing Now.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

async function open(state: MockState | undefined, hash: string) {
  window.location.hash = hash;
  const store = new ChannelStore(new MockChannelSource({ latencyMs: 0, state }));
  render(
    <ChannelProvider store={store}>
      <App />
    </ChannelProvider>,
  );
  await act(async () => {});
}

const viewState = () => document.querySelector("[data-view-state]")?.getAttribute("data-view-state");

describe("while the Channel is joined", () => {
  it.each(VIEWS)("%s draws rows shaped like its own, and says it is loading", async (view) => {
    await open("loading", `#/${view}`);
    expect(viewState()).toBe("loading");
    expect(document.querySelector("[data-view-state=loading] [role=status]")?.textContent).toMatch(/^Loading /);
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
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
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
