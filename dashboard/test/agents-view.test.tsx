// @vitest-environment happy-dom
// The Agents table, used as a Person would: the selected Agent is in the address, so a dropped
// connection or a reload comes back to it; each row has a menu (Open, Directive, Rename,
// Stop) that never selects the row; Compact rows drop their second line and stay that way;
// a long fleet renders only the rows near the screen.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentId, ChannelSnapshot, StreamMessage } from "@shared/index";
import type { ChannelSource, ConnectionState } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { setDensity } from "@/lib/density";
import { parse } from "@/lib/router";
import { AgentsView } from "@/views/AgentsView";

const agent = (id: string, nickname: string, extra: Partial<Agent> = {}) =>
  ({
    id: id as AgentId,
    person: id.split("/")[0],
    nickname,
    cli: "claude-code",
    model: "claude-opus-5-5",
    presence: "live",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: true,
    lastSeenAt: "2026-10-15T10:00:00.000Z",
    startedAt: "2026-10-15T09:00:00.000Z",
    ...extra,
  }) as unknown as Agent;

const scout = agent("shlok/claude/aaaa", "scout", { host: "shlok/studio" as Agent["host"] });
const quill = agent("maya/claude/bbbb", "quill");

let push: (m: StreamMessage) => void = () => {};
let connection: (c: ConnectionState) => void = () => {};

function channel(agents: Agent[] = [scout, quill], extra: Partial<ChannelSource> = {}) {
  const source = {
    me: "shlok",
    capabilities: { agents: true, directives: true },
    snapshot: async () =>
      ({ channel: { repo: "shlok1806/app" }, persons: [], agents, tasks: [], events: [], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
    hosts: async () => null,
    subscribe: (_c: number, onMessage: (m: StreamMessage) => void, onState: (c: ConnectionState) => void) => {
      push = onMessage;
      connection = onState;
      onState("live");
      return () => {};
    },
    ...extra,
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

/** Opens a Radix menu the way a pointer does. */
const openMenu = (trigger: HTMLElement) => fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });

beforeEach(() => {
  window.location.hash = "#/agents";
  // Node 26's own localStorage warns; a Map stands in.
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) });
});

afterEach(() => {
  cleanup();
  setDensity("comfortable");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the selected Agent", () => {
  it("is in the address, and the inspector reads it even when a chip hides its row", async () => {
    const Wrapper = channel();
    const { rerender } = render(
      <Wrapper>
        <AgentsView />
      </Wrapper>,
    );
    // The row, not its name: the name is a link to the Agent's page.
    fireEvent.click((await screen.findByText("quill", { selector: "a" })).closest("tr")!);
    expect(window.location.hash).toBe(`#/agents/select/${encodeURIComponent(quill.id)}`);
    rerender(
      <Wrapper>
        <AgentsView selected={quill.id} />
      </Wrapper>,
    );
    expect(screen.getByRole("complementary", { name: "quill, in the inspector" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Mine/ }));
    expect(screen.queryByText("quill", { selector: "a" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "quill, in the inspector" })).toBeTruthy();
  });

  it("survives a dropped connection, and a reload after one", async () => {
    window.location.hash = `#/agents/select/${encodeURIComponent(quill.id)}`;
    const route = parse(window.location.hash);
    if (route.view !== "agents") throw new Error("not the Agents table");
    render(<AgentsView selected={route.selected} />, { wrapper: channel() });
    await screen.findByRole("complementary", { name: "quill, in the inspector" });

    // The stream drops and comes back: the Worker sends every Agent again, as new objects.
    act(() => connection("reconnecting"));
    act(() => {
      connection("live");
      push({ type: "agent", agent: { ...scout } });
      push({ type: "agent", agent: { ...quill, lastSeenAt: "2026-10-15T10:05:00.000Z" } });
    });
    expect(screen.getByRole("complementary", { name: "quill, in the inspector" })).toBeTruthy();
    expect(screen.getByText("quill", { selector: "a" }).closest("tr")?.getAttribute("aria-selected")).toBe("true");

    // The page is reloaded on a fresh Channel connection: the address still names quill.
    cleanup();
    const again = parse(window.location.hash);
    render(<AgentsView selected={again.view === "agents" ? again.selected : undefined} />, { wrapper: channel() });
    expect(await screen.findByRole("complementary", { name: "quill, in the inspector" })).toBeTruthy();
  });
});

describe("an address naming an Agent the Channel does not have", () => {
  it("becomes the plain view once the Channel has loaded", async () => {
    window.location.hash = "#/agents/select/maya%2Fclaude%2Fgone";
    render(<AgentsView selected="maya/claude/gone" />, { wrapper: channel() });
    await waitFor(() => expect(window.location.hash).toBe("#/agents"));
  });
});

describe("the row menu", () => {
  it("opens an Agent, or its page ready for a Directive, without selecting the row", async () => {
    render(<AgentsView />, { wrapper: channel() });
    openMenu(await screen.findByRole("button", { name: "Actions for quill" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open", "Directive", "Rename"]);
    // Opening the menu selected nothing.
    expect(window.location.hash).toBe("#/agents");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Directive" }));
    expect(window.location.hash).toBe(`#/agents/${encodeURIComponent(quill.id)}/directive`);
  });

  it("renames an Agent in a dialog", async () => {
    const act_ = vi.fn(async () => ({ ok: true as const }));
    render(<AgentsView />, { wrapper: channel(undefined, { act: act_ }) });
    openMenu(await screen.findByRole("button", { name: "Actions for quill" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename quill" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Nickname" }), { target: { value: "quill-2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(act_).toHaveBeenCalledWith({ type: "rename", agent: quill.id, nickname: "quill-2" }));
  });

  it("gives focus back to the menu's button when the rename dialog is shut with Escape", async () => {
    render(<AgentsView />, { wrapper: channel() });
    const trigger = await screen.findByRole("button", { name: "Actions for quill" });
    openMenu(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const field = await screen.findByRole("textbox", { name: "Nickname" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("asks Stop's question in the inspector, for an Agent your Host runs", async () => {
    const Wrapper = channel();
    const { rerender } = render(
      <Wrapper>
        <AgentsView />
      </Wrapper>,
    );
    openMenu(await screen.findByRole("button", { name: "Actions for scout" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop" }));
    // The item acts once the menu has closed, so focus can land on the question.
    await waitFor(() => expect(window.location.hash).toBe(`#/agents/select/${encodeURIComponent(scout.id)}`));
    rerender(
      <Wrapper>
        <AgentsView selected={scout.id} />
      </Wrapper>,
    );
    const inspector = screen.getByRole("complementary", { name: "scout, in the inspector" });
    const question = within(inspector).getByRole("group", { name: "Stop scout?" });
    await waitFor(() => expect(document.activeElement).toBe(within(question).getByRole("button", { name: "Cancel" })));
    // The question holds the inspector's one primary.
    expect(within(inspector).queryByRole("link", { name: "Open the terminal" })).toBeNull();
    // Taken back, focus goes to the menu that asked, not to the inspector's Stop.
    fireEvent.keyDown(within(question).getByRole("button", { name: "Cancel" }), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions for scout" })));
  });
});

describe("compact rows", () => {
  it("drop the second line, and stay compact in this browser", async () => {
    render(<AgentsView />, { wrapper: channel() });
    await screen.findByText("quill", { selector: "a" });
    const table = screen.getByRole("table");
    expect(within(table).getAllByText(/Opus 5\.5/).length).toBeGreaterThan(0);
    const toggle = screen.getByRole("button", { name: "Compact rows" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(localStorage.getItem("switchboard.density")).toBe("compact");
    expect(within(table).queryByText(/Opus 5\.5/)).toBeNull();
  });
});

/** 200 Agents in a table happy-dom pretends to lay out. */
function longFleet() {
  // happy-dom lays nothing out: every box is 900px tall here, so the scroller shows about 30 rows.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  // Its ResizeObserver reports empty boxes; one that reports nothing leaves those sizes standing.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(20_000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
  // Nor does it scroll for scrollTo: this one moves the box and says so, as a browser does.
  vi.spyOn(Element.prototype, "scrollTo").mockImplementation(function (this: Element, options?: ScrollToOptions | number) {
    if (typeof options === "object" && options.top !== undefined) this.scrollTop = options.top;
    this.dispatchEvent(new Event("scroll"));
  });
  return Array.from({ length: 200 }, (_, i) => agent(`${["shlok", "maya", "dev"][i % 3]}/claude/${(0x1000 + i).toString(16)}`, `agent-${i}`));
}

const rendered = () => document.querySelectorAll("tbody tr[data-index]").length;
const scrollerOf = () => document.querySelector("table")!.closest(".overflow-y-auto") as HTMLElement;

describe("a long fleet", () => {
  it("renders only the rows near the screen, and others as it scrolls", async () => {
    render(<AgentsView />, { wrapper: channel(longFleet()) });
    await waitFor(() => expect(rendered()).toBeGreaterThan(0));
    expect(screen.getByText("agent-0", { selector: "a" })).toBeTruthy();
    expect(rendered()).toBeLessThan(60);
    expect(screen.queryByText("agent-199", { selector: "a" })).toBeNull();

    const scroller = scrollerOf();
    await act(async () => {
      scroller.scrollTop = 100_000;
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(screen.queryByText("agent-0", { selector: "a" })).toBeNull());
    expect(rendered()).toBeLessThan(60);
  });

  it("opens on an Agent far down the list with its row on the page", async () => {
    const fleet = longFleet();
    const late = fleet.find((a) => a.nickname === "agent-197")!;
    render(<AgentsView selected={late.id} />, { wrapper: channel(fleet) });
    expect(await screen.findByText("agent-197", { selector: "a" })).toBeTruthy();
    expect(scrollerOf().scrollTop).toBeGreaterThan(0);
  });

  it("numbers every row for a screen reader, rendered or not", async () => {
    render(<AgentsView />, { wrapper: channel(longFleet()) });
    await waitFor(() => expect(rendered()).toBeGreaterThan(0));
    const table = screen.getByRole("table");
    // 200 Agents, 3 Person lines and the head row.
    expect(table.getAttribute("aria-rowcount")).toBe("204");
    expect(table.querySelector("thead tr")?.getAttribute("aria-rowindex")).toBe("1");
    const first = table.querySelectorAll("tbody tr[data-index]");
    expect([...first].slice(0, 2).map((r) => r.getAttribute("aria-rowindex"))).toEqual(["2", "3"]);
  });

  it("keeps the row holding focus when it scrolls out of view", async () => {
    render(<AgentsView />, { wrapper: channel(longFleet()) });
    const row = (await screen.findByText("agent-0", { selector: "a" })).closest("tr")!;
    act(() => row.focus());
    const scroller = scrollerOf();
    await act(async () => {
      scroller.scrollTop = 100_000;
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(screen.queryByText("agent-3", { selector: "a" })).toBeNull());
    expect(document.activeElement).toBe(row);
    expect(row.isConnected).toBe(true);
  });
});
