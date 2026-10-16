// @vitest-environment happy-dom
// A Hand off (ADR 0024), clicked through as a Person would: an Agent's page names the Agent it
// continues and those that continue it, and Hand off opens the one Start an Agent sheet filled
// in for a successor, which starts with `from` set.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentId, ChannelSnapshot, Host, HostsResponse } from "@shared/index";
import { StartAgentButton, StartAgentSheet } from "@/components/domain/start-agent";
import type { ChannelSource, SpawnResult } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { href } from "@/lib/router";
import { AgentDetail } from "@/views/AgentDetail";

afterEach(cleanup);

const host: Host = {
  id: "ana/studio",
  person: "ana",
  name: "studio",
  roots: ["/Users/ana/code/app"],
  maxPermissionMode: "acceptEdits",
  live: true,
  registeredAt: "2026-10-15T00:00:00.000Z",
  lastSeenAt: "2026-10-15T00:00:00.000Z",
};

const agent = (id: string, nickname: string, extra: Partial<Agent> = {}): Agent =>
  ({
    id: id as AgentId,
    person: "ana",
    nickname,
    cli: "claude-code",
    presence: "live",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: true,
    lastSeenAt: "2026-10-15T10:00:00.000Z",
    startedAt: "2026-10-15T09:00:00.000Z",
    ...extra,
  }) as Agent;

const scout = agent("ana/claude/aaaa", "scout", {
  presence: "gone",
  host: host.id,
  context: { readAt: "2026-10-15T10:00:00.000Z", cwd: "/Users/ana/code/app/web" },
});
const mason = agent("ana/claude/bbbb", "mason", { host: host.id, continues: scout.id });

let channels = 0;
function channel(spawnAgent = vi.fn(async (): Promise<SpawnResult> => ({ ok: false, reason: "not in this test" }))) {
  const repo = ++channels;
  const source = {
    me: "ana",
    capabilities: { directives: true },
    snapshot: async () =>
      ({
        channel: { repo: `ana/app-${repo}` },
        persons: [{ name: "ana" }],
        agents: [scout, mason],
        tasks: [],
        events: [],
        verdicts: [],
        relay: { interruptThreshold: 0.6 },
        cursor: 0,
      }) as unknown as ChannelSnapshot,
    eventsById: async () => [],
    wakesAfter: async () => [],
    scopedEvents: async () => ({ events: [] }),
    hosts: async (): Promise<HostsResponse> => ({ hosts: [host], cap: 4, running: 1 }),
    spawnAgent,
    terminal: () => ({ send: () => false, close: () => {} }),
    subscribe: () => () => {},
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

describe("an Agent's page after a Hand off", () => {
  it("says which Agent it continues, and the predecessor says which continue it, each a link", async () => {
    const wrapper = channel();
    const { unmount } = render(<AgentDetail id={mason.id} />, { wrapper });
    const from = await screen.findByRole("link", { name: "scout" });
    expect(from.parentElement?.textContent).toContain("continued from scout");
    expect(from.getAttribute("href")).toBe(href({ view: "agent", id: scout.id }));
    unmount();

    render(<AgentDetail id={scout.id} />, { wrapper });
    const to = await screen.findByRole("link", { name: "mason" });
    expect(to.parentElement?.textContent).toContain("handed off to mason");
    expect(to.getAttribute("href")).toBe(href({ view: "agent", id: mason.id }));
  });
});

describe("handing off an Agent", () => {
  it("opens the Start an Agent sheet in its folder with a brief to edit, and starts the successor from it", async () => {
    const spawnAgent = vi.fn(async (): Promise<SpawnResult> => ({ ok: false, reason: "studio is Offline." }));
    render(
      <>
        <AgentDetail id={scout.id} />
        <StartAgentSheet />
      </>,
      { wrapper: channel(spawnAgent) },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Hand off" }));
    const sheet = await screen.findByRole("dialog", { name: "Start an Agent" });
    expect(sheet.textContent).toContain("Continues scout.");
    expect((screen.getByRole("textbox", { name: "Folder" }) as HTMLInputElement).value).toBe("/Users/ana/code/app/web");
    const brief = screen.getByRole("textbox", { name: "Brief" }) as HTMLTextAreaElement;
    expect(brief.value).toBe("Carry on scout's work.");
    fireEvent.change(brief, { target: { value: "Finish the users page." } });

    const start = screen.getByRole("button", { name: "Start Agent" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(spawnAgent).toHaveBeenCalledTimes(1));
    expect(spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ host: "studio", cwd: "/Users/ana/code/app/web", brief: "Finish the users page.", from: scout.id }),
    );
  });

  it("leaves the sheet empty the next time it opens for a new Agent", async () => {
    const spawnAgent = vi.fn(async (): Promise<SpawnResult> => ({ ok: false, reason: "studio is Offline." }));
    render(
      <>
        <AgentDetail id={scout.id} />
        <StartAgentButton />
        <StartAgentSheet />
      </>,
      { wrapper: channel(spawnAgent) },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Hand off" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Start an Agent" }));
    const sheet = await screen.findByRole("dialog", { name: "Start an Agent" });
    expect(sheet.textContent).not.toContain("Continues");
    expect((screen.getByRole("textbox", { name: "Brief" }) as HTMLTextAreaElement).value).toBe("");
    const start = screen.getByRole("button", { name: "Start Agent" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(spawnAgent).toHaveBeenCalledTimes(1));
    expect(spawnAgent.mock.calls[0]?.[0]).not.toHaveProperty("from");
  });
});
