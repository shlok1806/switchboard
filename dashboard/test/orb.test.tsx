// @vitest-environment happy-dom
// The thinking orb (ADR 0047), as a Person sees it in the Agents table: each Agent's row shows
// the orb of its state beside the state's word, the orb follows the Agent as the Channel
// reports it, and an Agent that runs nothing (Stale, Paused) shows none.

import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentId, ChannelSnapshot, StreamMessage, Task } from "@shared/index";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { AgentsView } from "@/views/AgentsView";

const agent = (id: string, nickname: string, extra: Partial<Agent> = {}) =>
  ({
    id: id as AgentId,
    person: id.split("/")[0],
    nickname,
    cli: "claude-code",
    presence: "live",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: true,
    lastSeenAt: "2026-10-15T10:00:00.000Z",
    startedAt: "2026-10-15T09:00:00.000Z",
    ...extra,
  }) as unknown as Agent;

const approval = { id: "prompt-1", tool: "Bash", detail: "npm ci", openedAt: "2026-10-15T10:00:00.000Z" };

const scout = agent("shlok/claude/aaaa", "scout");
const quill = agent("shlok/claude/bbbb", "quill", { presence: "idle" });
const asker = agent("maya/claude/cccc", "asker", { approval } as Partial<Agent>);
const parked = agent("shlok/claude/dddd", "parked", { presence: "paused" });
const lost = agent("maya/gemini/eeee", "lost", { presence: "gone" });
// The Task its Gone holder still claims, which makes that holder Stale.
const held = {
  number: 17,
  title: "Validate the settings form",
  status: "claimed",
  steps: [],
  stepsDone: 0,
  claim: { holder: { kind: "agent", agentId: lost.id }, stale: true },
} as unknown as Task;

let push: (m: StreamMessage) => void = () => {};

function channel(agents: Agent[]) {
  const source = {
    me: "shlok",
    capabilities: { agents: true, directives: true },
    snapshot: async () =>
      ({ channel: { repo: "shlok1806/app" }, persons: [], agents, tasks: [held], events: [], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
    hosts: async () => null,
    subscribe: (_c: number, onMessage: (m: StreamMessage) => void, onState: (c: "live") => void) => {
      push = onMessage;
      onState("live");
      return () => {};
    },
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

/** The orb in the named Agent's row, or null when it shows none. */
const orbOf = (name: string) => screen.getByText(name, { selector: "a" }).closest("tr")?.querySelector("[data-orb]")?.getAttribute("data-orb") ?? null;

beforeEach(() => {
  window.location.hash = "#/agents";
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the thinking orb", () => {
  it("shows each Agent's state beside its word, and none for an Agent that runs nothing", async () => {
    render(<AgentsView />, { wrapper: channel([scout, quill, asker, parked, lost]) });
    await screen.findByText("scout", { selector: "a" });
    expect(orbOf("scout")).toBe("working");
    expect(orbOf("quill")).toBe("breathing");
    expect(orbOf("asker")).toBe("listening");
    expect(orbOf("parked")).toBeNull();
    expect(orbOf("lost")).toBeNull();
    // The word is still there: the orb never carries the state alone.
    const row = screen.getByText("asker", { selector: "a" }).closest("tr");
    expect(row?.textContent).toContain("Needs maya");
  });

  it("follows the Agent live: a prompt opens, closes, and the session goes idle", async () => {
    render(<AgentsView />, { wrapper: channel([scout]) });
    await screen.findByText("scout", { selector: "a" });
    expect(orbOf("scout")).toBe("working");
    act(() => push({ type: "agent", agent: { ...scout, approval } as unknown as Agent }));
    expect(orbOf("scout")).toBe("listening");
    act(() => push({ type: "agent", agent: scout }));
    expect(orbOf("scout")).toBe("working");
    act(() => push({ type: "agent", agent: { ...scout, presence: "idle" } }));
    expect(orbOf("scout")).toBe("breathing");
  });
});
