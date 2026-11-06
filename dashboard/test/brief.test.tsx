// @vitest-environment happy-dom
// The Brief view, used as a Person would: it lists the Brief's pages with each one's age,
// opens at the overview with who last wrote it and when, reads a page's Markdown with its
// Task references as links, opens another page from the list, and says when there is no
// such page or the read failed. A Channel with no pages is in states.test.tsx.

import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentId, BriefPage, BriefResponse, ChannelSnapshot } from "@shared/index";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { BriefView } from "@/views/BriefView";

const librarian = {
  id: "shlok/claude/7f3a" as AgentId,
  person: "shlok",
  nickname: "librarian",
  cli: "claude-code",
  presence: "live",
  lastSeenAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
} as unknown as Agent;

function channel(brief: () => Promise<BriefResponse | null>) {
  const source = {
    me: "maya",
    capabilities: {},
    snapshot: async () =>
      ({ channel: { repo: "shlok1806/app" }, persons: [], agents: [librarian], tasks: [], events: [], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
    hosts: async () => null,
    subscribe: () => () => {},
    brief,
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const page = (p: Partial<BriefPage> & Pick<BriefPage, "page" | "title" | "text">): BriefPage => ({
  version: 1,
  author: { agent: librarian.id, person: "shlok", nickname: "librarian" },
  updatedAt: hoursAgo(1),
  ...p,
});

const pages: BriefPage[] = [
  page({
    page: "overview",
    title: "Overview",
    version: 4,
    updatedAt: hoursAgo(3),
    text: "# The app\n\nThe API client is being cleaned up in #11.\n\n## Next\n\n1. A timeout for `request()` (#15).\n2. The settings form.",
  }),
  page({ page: "api-client", title: "API client", updatedAt: hoursAgo(26), text: "# API client\n\nRetries GET only (#16)." }),
  page({ page: "stuck", title: "Stuck and not happening", updatedAt: hoursAgo(0.5), text: "- #9 has had no Update for two days." }),
];

const brief = async (): Promise<BriefResponse> => ({ pages });

describe("the Brief view", () => {
  it("lists every page with its age, and opens at the overview with who last wrote it and when", async () => {
    render(<BriefView />, { wrapper: channel(brief) });
    const list = await screen.findByRole("navigation", { name: "Pages" });
    const links = within(list).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Overview3h ago", "API client1d ago", "Stuck and not happening30m ago"]);
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
    expect(links[1]?.getAttribute("href")).toBe("#/brief/api-client");

    const article = screen.getByRole("article", { name: "Overview" });
    expect(within(article).getByText(/Written/).textContent).toBe("Written 3h ago by shlok/librarian · version 4");
    expect(within(article).getByRole("link", { name: "shlok/librarian" }).getAttribute("href")).toBe(`#/agents/${encodeURIComponent(librarian.id)}`);
    // The page's own Markdown: its headings, a numbered list, code, and Tasks as links.
    expect(within(article).getByRole("heading", { name: "Next" })).toBeTruthy();
    expect(within(article).getByText("request()").tagName).toBe("CODE");
    expect(within(article).getByRole("link", { name: "#11" }).getAttribute("href")).toBe("#/tasks/11");
    expect(within(article).getAllByRole("listitem")).toHaveLength(2);
  });

  it("reads the page picked, leaving out a first heading that repeats its title", async () => {
    render(<BriefView page="api-client" />, { wrapper: channel(brief) });
    const article = await screen.findByRole("article", { name: "API client" });
    expect(within(article).getAllByRole("heading").map((h) => h.textContent)).toEqual(["API client"]);
    expect(within(article).getByRole("link", { name: "#16" })).toBeTruthy();
    expect(screen.queryByText(/being cleaned up/)).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", { current: "page" }).textContent).toMatch(/^API client/);
  });

  it("never draws a page's HTML or a link that is not to a web address", async () => {
    const tricky = page({ page: "overview", title: "Overview", text: '<img src=x onerror="alert(1)"> [run](javascript:alert(1)) [docs](https://example.com/docs)' });
    render(<BriefView />, { wrapper: channel(async () => ({ pages: [tricky] })) });
    const article = await screen.findByRole("article", { name: "Overview" });
    expect(article.querySelector("img")).toBeNull();
    expect(within(article).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([`#/agents/${encodeURIComponent(librarian.id)}`, "https://example.com/docs"]);
    expect(within(article).getByText(/<img src=x/)).toBeTruthy();
  });

  it("says when there is no such page, and links back to the overview", async () => {
    render(<BriefView page="billing" />, { wrapper: channel(brief) });
    expect(await screen.findByRole("heading", { name: "No page billing" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Read the overview" }).getAttribute("href")).toBe("#/brief");
  });

  it("says when the Worker has no Brief, and when the read failed", async () => {
    const { unmount } = render(<BriefView />, { wrapper: channel(async () => null) });
    expect(await screen.findByRole("heading", { name: "The Brief is not on this Channel yet" })).toBeTruthy();
    unmount();
    render(<BriefView />, {
      wrapper: channel(async () => {
        throw new Error("The Channel's Worker answered 503.");
      }),
    });
    expect(await screen.findByText("The Channel's Worker answered 503.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
