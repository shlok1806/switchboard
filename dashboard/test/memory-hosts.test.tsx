// @vitest-environment happy-dom
// The Memory and Hosts views, used as a Person would: Memory reads the notes Agents left,
// narrows them by tag and pages back through older ones; Hosts lists each machine that
// starts Agents, yours first, says which are Live and what runs on each.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentId, ChannelSnapshot, Host, HostsResponse, MemoryNote, MemoryQuery, MemoryResponse } from "@shared/index";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
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

function channel(extra: Partial<ChannelSource>) {
  const source = {
    me: "shlok",
    capabilities: {},
    snapshot: async () =>
      ({ channel: { repo: "shlok1806/app" }, persons: [], agents: [scout], tasks: [], events: [], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
    hosts: async () => null,
    subscribe: () => () => {},
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

  it("says so when the Channel's Worker has no Hosts", async () => {
    render(<HostsView />, { wrapper: channel({}) });
    expect(await screen.findByText("Hosts are not on this Channel yet")).toBeTruthy();
  });
});
