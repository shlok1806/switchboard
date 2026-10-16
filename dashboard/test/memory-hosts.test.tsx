// @vitest-environment happy-dom
// The Memory and Hosts views, used as a Person would: Memory reads the notes Agents left,
// searches and narrows them by tag, and pages back through older ones; Hosts lists each
// machine that starts Agents, yours first, says which are Live and what runs on each; on a
// phone, the Hosts and Agents inspectors open as a sheet from the row.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentId, ChannelEvent, ChannelSnapshot, Host, HostsResponse, MemoryNote, MemoryQuery, MemoryResponse, StreamMessage } from "@shared/index";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { AgentsView } from "@/views/AgentsView";
import { HostsView } from "@/views/HostsView";
import { MemoryView } from "@/views/MemoryView";

const scout = {
  id: "shlok/claude/aaaa" as AgentId,
  person: "shlok",
  nickname: "scout",
  cli: "claude-code",
  presence: "live",
  host: "shlok/studio",
  lastSeenAt: "2026-10-15T10:00:00.000Z",
  startedAt: "2026-10-15T09:00:00.000Z",
} as unknown as Agent;

let push: (m: StreamMessage) => void = () => {};
const event = (e: Partial<ChannelEvent>) => ({ type: "event", event: { at: "2026-10-15T10:00:00.000Z", ...e } }) as unknown as StreamMessage;

function channel(extra: Partial<ChannelSource>) {
  const source = {
    me: "shlok",
    capabilities: {},
    snapshot: async () =>
      ({ channel: { repo: "shlok1806/app" }, persons: [], agents: [scout], tasks: [], events: [], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
    hosts: async () => null,
    subscribe: (_cursor: number, onMessage: (m: StreamMessage) => void) => {
      push = onMessage;
      return () => {};
    },
    ...extra,
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

afterEach(cleanup);

const note = (seq: number, text: string, extra: Partial<MemoryNote> = {}): MemoryNote => ({
  seq,
  id: `e${seq}`,
  at: "2026-10-15T09:30:00.000Z",
  author: scout.id,
  person: "shlok",
  tags: ["fact"],
  text,
  ...extra,
});

describe("the Memory view", () => {
  it("shows each note with who left it, narrows by tag, and pages back from the oldest shown", async () => {
    const asked: MemoryQuery[] = [];
    const memory = async (q: MemoryQuery): Promise<MemoryResponse> => {
      asked.push(q);
      if (q.before !== undefined) return { notes: [note(3, "The old API returned 25 a page.")] };
      if (q.tag === "decision") return { notes: [note(9, "Retries stay at three.", { tags: ["decision"] })] };
      return { notes: [note(12, "Users API pages by 50.", { task: 14, files: ["web/src/users.tsx"] })], more: true };
    };
    render(<MemoryView />, { wrapper: channel({ memory }) });

    const first = await screen.findByText("Users API pages by 50.");
    const row = first.closest("li")!;
    expect(within(row).getByRole("link", { name: "shlok/scout" }).getAttribute("href")).toBe(`#/agents/${encodeURIComponent(scout.id)}`);
    expect(within(row).getByRole("link", { name: "#14" }).getAttribute("href")).toBe("#/tasks/14");
    expect(within(row).getByText("web/src/users.tsx")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show older notes" }));
    expect(await screen.findByText("The old API returned 25 a page.")).toBeTruthy();
    expect(asked.at(-1)).toMatchObject({ before: 12 });
    expect(screen.queryByRole("button", { name: "Show older notes" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Decision" }));
    expect(await screen.findByText("Retries stay at three.")).toBeTruthy();
    expect(screen.queryByText("Users API pages by 50.")).toBeNull();
  });

  it("opens a note in the inspector with its author's Events around it", async () => {
    const at = (m: number) => `2026-10-15T09:${String(m).padStart(2, "0")}:00.000Z`;
    const other = "bo/claude/bbbb" as AgentId;
    const events = [
      { id: "e1", seq: 1, at: at(1), type: "command", actor: { kind: "agent", agentId: scout.id }, capture: "hook", payload: { command: "npm test" } },
      { id: "e2", seq: 2, at: at(2), type: "command", actor: { kind: "agent", agentId: other }, capture: "hook", payload: { command: "make lint" } },
      { id: "e3", seq: 3, at: at(3), type: "memory.note", actor: { kind: "agent", agentId: scout.id }, capture: null, payload: { text: "Users API pages by 50.", tags: ["fact"] } },
      { id: "e4", seq: 4, at: at(4), type: "file.edit", actor: { kind: "agent", agentId: scout.id }, capture: "hook", payload: { path: "web/src/users.tsx", additions: 3, deletions: 0 } },
    ] as unknown as ChannelEvent[];
    const memory = async (): Promise<MemoryResponse> => ({ notes: [note(3, "Users API pages by 50.")] });
    const snapshot = async () =>
      ({ channel: { repo: "shlok1806/app" }, persons: [], agents: [scout], tasks: [], events, verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot;
    const Wrapper = channel({ memory, snapshot });
    const { rerender } = render(
      <Wrapper>
        <MemoryView />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByText("Users API pages by 50."));
    expect(window.location.hash).toBe("#/memory/e3");

    rerender(
      <Wrapper>
        <MemoryView selected="e3" />
      </Wrapper>,
    );
    const inspector = await screen.findByRole("complementary", { name: "Note, in the inspector" });
    const around = within(inspector).getByRole("region", { name: "Around it" });
    const rows = within(around).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("npm test");
    expect(rows[1]).toMatch(/^This note/);
    expect(rows[2]).toContain("web/src/users.tsx");
    // Another Agent's Event, not on the note's Task, is not around it.
    expect(within(around).queryByText(/make lint/)).toBeNull();
  });

  it("reads what came before a note older than the Events loaded", async () => {
    const at = (m: number) => `2026-10-15T09:${String(m).padStart(2, "0")}:00.000Z`;
    const old = { id: "e3", seq: 3, at: at(3), type: "memory.note", actor: { kind: "agent", agentId: scout.id }, capture: null, payload: { text: "Users API pages by 50.", tags: ["fact"] } };
    const before = { id: "e1", seq: 1, at: at(1), type: "command", actor: { kind: "agent", agentId: scout.id }, capture: "hook", payload: { command: "npm test" } };
    // Only a much later Event is loaded.
    const loaded = { id: "e90", seq: 90, at: at(50), type: "command", actor: { kind: "agent", agentId: scout.id }, capture: "hook", payload: { command: "git push" } };
    const asked: { scope: unknown; before?: number }[] = [];
    const src = {
      memory: async (): Promise<MemoryResponse> => ({ notes: [note(3, "Users API pages by 50.")] }),
      snapshot: async () =>
        ({ channel: { repo: "shlok1806/app" }, persons: [], agents: [scout], tasks: [], events: [loaded], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
      eventsById: async () => [old as unknown as ChannelEvent],
      wakesAfter: async () => [],
      scopedEvents: async (scope: unknown, until?: number) => {
        asked.push({ scope, before: until });
        return { events: [before as unknown as ChannelEvent] };
      },
    };
    render(<MemoryView selected="e3" />, { wrapper: channel(src as unknown as Partial<ChannelSource>) });
    const inspector = await screen.findByRole("complementary", { name: "Note, in the inspector" });
    const around = within(inspector).getByRole("region", { name: "Around it" });
    await within(around).findByText(/npm test/);
    expect(asked).toEqual([{ scope: { agent: scout.id }, before: 3 }]);
    const rows = within(around).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(rows[0]).toContain("npm test");
    expect(rows[1]).toMatch(/^This note/);
    // What came after it is not loaded, and the later Event that is loaded is not shown as if it were.
    expect(rows[2]).toMatch(/What came after it is not loaded/);
    expect(within(around).queryByText(/git push/)).toBeNull();
  });

  it("asks once a search settles, ranks it as the Worker does, and offers no older page of it", async () => {
    const asked: MemoryQuery[] = [];
    const memory = async (q: MemoryQuery): Promise<MemoryResponse> => {
      asked.push(q);
      // The Worker's rank, not seq: the older note is the better match.
      if (q.q) return { notes: [note(4, "Retries retry GETs only."), note(11, "Retries live in client.ts.")], more: true };
      return { notes: [note(12, "Users API pages by 50.")], more: true };
    };
    render(<MemoryView />, { wrapper: channel({ memory }) });
    await screen.findByText("Users API pages by 50.");

    const find = screen.getByRole("searchbox", { name: "Find" });
    for (const typed of ["r", "re", "retries"]) fireEvent.change(find, { target: { value: typed } });
    const best = await screen.findByText("Retries retry GETs only.");
    expect(asked.filter((q) => q.q !== undefined).map((q) => q.q)).toEqual(["retries"]);
    const list = best.closest("ol")!;
    expect(within(list).getAllByRole("listitem")[0]!.textContent).toContain("Retries retry GETs only.");
    expect(screen.getByText(/best 2 matches/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show older notes" })).toBeNull();

    // Punctuation alone is no search: the Worker would refuse it, so the latest notes come back.
    fireEvent.change(find, { target: { value: "--" } });
    expect(await screen.findByText("Users API pages by 50.")).toBeTruthy();
    expect(asked.at(-1)?.q).toBeUndefined();
  });

  it("reads the first page again when an Agent leaves a new note", async () => {
    let notes = [note(12, "Users API pages by 50.")];
    render(<MemoryView />, { wrapper: channel({ memory: async () => ({ notes }) }) });
    await screen.findByText("Users API pages by 50.");
    notes = [note(13, "Settings validate on submit."), ...notes];
    act(() => push(event({ id: "e13", seq: 13, type: "memory.note", actor: { kind: "agent", agentId: scout.id } } as Partial<ChannelEvent>)));
    expect(await screen.findByText("Settings validate on submit.")).toBeTruthy();
  });

  it("says so when the Channel's Worker has no memory", async () => {
    render(<MemoryView />, { wrapper: channel({ memory: async () => null }) });
    expect(await screen.findByText("Memory is not on this Channel yet")).toBeTruthy();
  });
});

const host = (person: string, name: string, live: boolean, extra: Partial<Host> = {}): Host =>
  ({
    id: `${person}/${name}`,
    person,
    name,
    roots: [`/Users/${person}/code`],
    maxPermissionMode: "default",
    live,
    registeredAt: "2026-10-01T09:00:00.000Z",
    lastSeenAt: "2026-10-13T09:00:00.000Z",
    ...extra,
  }) as Host;

describe("the Hosts view", () => {
  const response: HostsResponse = {
    hosts: [host("maya", "maya-mbp", true), host("shlok", "laptop", false), host("shlok", "studio", true)],
    cap: 8,
    running: 1,
  };

  it("lists your Hosts first, Live before Offline, with what runs on each", async () => {
    const { container } = render(<HostsView />, { wrapper: channel({ hosts: async () => response }) });
    await screen.findByRole("heading", { name: "Hosts" });
    const rows = [...container.querySelectorAll("table tbody tr[tabindex]")];
    expect(rows.map((r) => r.querySelectorAll("td")[1]!.querySelector("span")!.textContent)).toEqual(["studio", "laptop", "maya-mbp"]);
    expect(within(rows[0] as HTMLElement).getByText("Live")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "scout" })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Offline")).toBeTruthy();
    expect(screen.getByText(/1 of 8 Agents running on Hosts/)).toBeTruthy();
  });

  it("reads the Host the link names in the inspector, and narrows to the Offline ones", async () => {
    render(<HostsView selected="shlok/laptop" />, { wrapper: channel({ hosts: async () => response }) });
    const inspector = await screen.findByRole("complementary", { name: "laptop, in the inspector" });
    expect(within(inspector).getByText(/switchboard host run/)).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Offline/ })));
    expect(screen.queryByText("maya-mbp")).toBeNull();
  });

  it("shows the Host a link names even when the chips hide it", async () => {
    render(<HostsView selected="maya/maya-mbp" />, { wrapper: channel({ hosts: async () => response }) });
    await screen.findByRole("complementary", { name: "maya-mbp, in the inspector" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Mine/ })));
    expect(screen.getByRole("complementary", { name: "maya-mbp, in the inspector" })).toBeTruthy();
  });

  it("reads the Hosts again when one comes online", async () => {
    let online = false;
    const hosts = async () => ({ ...response, hosts: response.hosts.map((h) => (online && h.name === "laptop" ? { ...h, live: true } : h)) });
    render(<HostsView />, { wrapper: channel({ hosts }) });
    const liveChip = () => screen.getByRole("button", { name: /^Live/ }).textContent;
    await screen.findByRole("heading", { name: "Hosts" });
    await waitFor(() => expect(liveChip()).toBe("Live2"));
    online = true;
    act(() => push(event({ id: "h1", seq: 20, type: "host.online", payload: { host: "shlok/laptop" } } as Partial<ChannelEvent>)));
    await waitFor(() => expect(liveChip()).toBe("Live3"));
  });

  it("stacks the Hosts on a phone, and a tap opens the Host as a sheet that Escape closes", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    try {
      window.location.hash = "#/hosts";
      const { container } = render(<HostsView />, { wrapper: channel({ hosts: async () => response }) });
      const studio = await screen.findByRole("button", { name: /studio/ });
      expect(container.querySelector("table")).toBeNull();
      // Nothing is open until a row is tapped.
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(studio);
      expect(window.location.hash).toBe(`#/hosts/${encodeURIComponent("shlok/studio")}`);
      cleanup();

      render(<HostsView selected="shlok/studio" />, { wrapper: channel({ hosts: async () => response }) });
      const sheet = await screen.findByRole("dialog", { name: "studio, in the inspector" });
      expect(document.activeElement).toBe(sheet);
      fireEvent.keyDown(sheet, { key: "Escape" });
      expect(window.location.hash).toBe("#/hosts");
    } finally {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    }
  });

  it("says so when the Channel's Worker has no Hosts", async () => {
    render(<HostsView />, { wrapper: channel({}) });
    expect(await screen.findByText("Hosts are not on this Channel yet")).toBeTruthy();
  });
});

describe("the Agents view on a phone", () => {
  it("opens a tapped Agent as a sheet over the list, and gives focus back to its row on Escape", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    try {
      // The sheet follows the address, as the Hosts view's does.
      window.location.hash = "#/agents";
      const Wrapper = channel({});
      const { rerender } = render(
        <Wrapper>
          <AgentsView />
        </Wrapper>,
      );
      const row = await screen.findByRole("button", { name: /scout/ });
      expect(screen.queryByRole("dialog")).toBeNull();
      row.focus();
      fireEvent.click(row);
      expect(window.location.hash).toBe(`#/agents/select/${encodeURIComponent(scout.id)}`);
      rerender(
        <Wrapper>
          <AgentsView selected={scout.id} />
        </Wrapper>,
      );
      const sheet = screen.getByRole("dialog", { name: "scout, in the inspector" });
      expect(document.activeElement).toBe(sheet);
      fireEvent.keyDown(sheet, { key: "Escape" });
      expect(window.location.hash).toBe("#/agents");
      rerender(
        <Wrapper>
          <AgentsView />
        </Wrapper>,
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /scout/ }));
    } finally {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    }
  });
});
