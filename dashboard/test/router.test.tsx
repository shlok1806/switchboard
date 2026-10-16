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
  it("opens on Now for an empty hash", () => {
    expect(parse("")).toEqual({ view: "now" });
    expect(parse("#/")).toEqual({ view: "now" });
  });

  it("keeps an address it does not know, so the page can say there is no such page", () => {
    expect(parse("#/somewhere-else")).toEqual({ view: "missing", path: "/somewhere-else" });
    expect(parse("#/tasks/abc")).toEqual({ view: "missing", path: "/tasks/abc" });
    expect(href({ view: "missing", path: "/somewhere-else" })).toBe("#/somewhere-else");
  });

  it("still reaches Activity, and a link to Now comes back as Now", () => {
    expect(parse("#/feed")).toEqual({ view: "feed", event: undefined });
    expect(parse(href({ view: "now" }))).toEqual({ view: "now" });
  });

  it("reads the log by model turn, and an old Compare link lands there", () => {
    expect(parse(href({ view: "feed", by: "turn", turn: "t1" }))).toEqual({ view: "feed", by: "turn", turn: "t1" });
    expect(parse(href({ view: "feed", by: "turn" }))).toEqual({ view: "feed", by: "turn", turn: undefined });
    expect(parse("#/compare")).toEqual({ view: "feed", by: "turn", turn: undefined });
    expect(parse("#/compare/t1")).toEqual({ view: "feed", by: "turn", turn: "t1" });
    // An Event picked inside an open turn keeps the turn.
    expect(parse(href({ view: "feed", by: "turn", turn: "t1", event: "e2" }))).toEqual({ view: "feed", by: "turn", turn: "t1", event: "e2" });
  });

  it("reaches Memory, and a Host by its ID, which has a slash in it", () => {
    expect(parse(href({ view: "memory" }))).toEqual({ view: "memory" });
    expect(parse(href({ view: "hosts" }))).toEqual({ view: "hosts", host: undefined });
    expect(parse(href({ view: "hosts", host: "maya/maya-mbp" }))).toEqual({ view: "hosts", host: "maya/maya-mbp" });
  });

  it("selects an Agent in the table, or opens its page ready for a Directive", () => {
    const id = "maya/claude/2b8d";
    expect(parse(href({ view: "agents", selected: id }))).toEqual({ view: "agents", selected: id });
    expect(parse(href({ view: "agent", id }))).toEqual({ view: "agent", id });
    expect(parse(href({ view: "agent", id, focus: "directive" }))).toEqual({ view: "agent", id, focus: "directive" });
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
