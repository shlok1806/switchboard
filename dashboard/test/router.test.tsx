// @vitest-environment happy-dom
// Where the Dashboard opens and how a phone reaches every view: Now is the first screen,
// for an empty hash and for one the Dashboard does not know; the phone's tab bar holds
// four views and More holds the rest.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelSnapshot } from "@shared/index";
import { TabBar, VIEWS } from "@/components/shell/nav";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { href, parse } from "@/lib/router";

describe("the route", () => {
  it("opens on Now for an empty hash and for one it does not know", () => {
    expect(parse("")).toEqual({ view: "now" });
    expect(parse("#/")).toEqual({ view: "now" });
    expect(parse("#/somewhere-else")).toEqual({ view: "now" });
  });

  it("still reaches Activity, and a link to Now comes back as Now", () => {
    expect(parse("#/feed")).toEqual({ view: "feed", event: undefined });
    expect(parse(href({ view: "now" }))).toEqual({ view: "now" });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the phone's tab bar", () => {
  it("shows Now, Agents, Tasks and Activity, and every other view under More", async () => {
    // The More menu reads the saved theme. Under Node 26 the global localStorage is Node's own
    // experimental one, which warns on every read, so the menu gets an empty storage instead.
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) });
    const source = {
      me: "shlok",
      capabilities: {},
      snapshot: async () => ({ channel: { repo: "r" }, persons: [], agents: [], tasks: [], events: [], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
      subscribe: () => () => {},
      isMock: true,
    } as unknown as ChannelSource;
    render(
      <ChannelProvider store={new ChannelStore(source)}>
        <TabBar route={{ view: "now" }} />
      </ChannelProvider>,
    );
    await act(async () => {});
    const bar = screen.getByRole("navigation", { name: "Views" });
    expect(within(bar).getAllByRole("link").map((a) => a.textContent)).toEqual(["Now", "Agents", "Tasks", "Activity"]);

    const more = within(bar).getByRole("button", { name: "More" });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    const inMore = within(menu).getAllByRole("menuitem").map((i) => i.textContent);
    const tabs = ["Now", "Agents", "Tasks", "Activity"];
    for (const v of VIEWS) expect(tabs.includes(v.title) !== inMore.includes(v.title)).toBe(true);
  });
});
