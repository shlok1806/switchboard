// @vitest-environment happy-dom
// The canvas (ADR 0020), used as a Person would: it draws the Channel's Agents, their
// Tasks and who started whom; a click opens an Agent; a dragged node stays where it
// was put, across a reload and when another Agent joins.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, AgentId, ChannelSnapshot, StreamMessage, Task } from "@shared/index";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { CanvasView } from "@/views/CanvasView";

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return {
    id: id as AgentId,
    person: id.split("/")[0]!,
    cli: "claude-code",
    presence: "live",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: true,
    lastSeenAt: "2026-10-15T10:00:00.000Z",
    startedAt: "2026-10-15T09:00:00.000Z",
    ...extra,
  } as Agent;
}

const lead = agent("shlok/claude/aaaa", { nickname: "planner", role: "lead" });
const child = agent("shlok/codex/bbbb", { cli: "codex", parent: lead.id, startedAt: "2026-10-15T09:05:00.000Z" });
const maya = agent("maya/claude/cccc", { presence: "gone" });
const login: Task = {
  number: 12,
  title: "Fix the login redirect",
  claim: { task: 12, holder: { kind: "agent", agentId: lead.id }, claimedAt: "2026-10-15T09:01:00.000Z", stale: false },
} as Task;

let push: (m: StreamMessage) => void = () => {};

function channel(agents: Agent[]) {
  const source = {
    me: "shlok",
    capabilities: {},
    snapshot: async (): Promise<ChannelSnapshot> =>
      ({ channel: { repo: "shlok1806/app" }, persons: [], agents, tasks: [login], events: [], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
    subscribe: (_cursor: number, onMessage: (m: StreamMessage) => void) => {
      push = onMessage;
      return () => {};
    },
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => (
    <ChannelProvider store={store}>
      <TooltipProvider>{children}</TooltipProvider>
    </ChannelProvider>
  );
}

const node = (name: RegExp) => screen.findByRole("button", { name });
const place = (el: HTMLElement) => ({ x: Number.parseFloat(el.style.left), y: Number.parseFloat(el.style.top) });

/** A browser's storage for this origin: happy-dom under this Node has none of its own. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  window.location.hash = "#/canvas";
});
afterEach(cleanup);

describe("the canvas", () => {
  it("draws every Agent with its state, a frame for the Task it holds, and an edge from a lead", async () => {
    const { container } = render(<CanvasView />, { wrapper: channel([lead, child, maya]) });
    expect(await node(/^planner, shlok's Claude Code Agent, Running$/)).toBeTruthy();
    expect(await node(/^shlok\/codex\/bbbb, shlok's Codex Agent, Running$/)).toBeTruthy();
    expect(await node(/^maya\/claude\/cccc, maya's Claude Code Agent, Gone$/)).toBeTruthy();
    expect(screen.getByText("Fix the login redirect")).toBeTruthy();
    expect([...container.querySelectorAll("path[data-edge]")].map((p) => p.getAttribute("data-edge"))).toEqual([`${lead.id} ${child.id}`]);
    // shlok, the signed-in Person, comes first.
    expect([...container.querySelectorAll("[data-lane] > span:first-child")].map((e) => e.textContent)).toEqual(["shlok (you)", "maya"]);
  });

  it("opens an Agent on a click, and shows where it came from", async () => {
    render(<CanvasView />, { wrapper: channel([lead, child]) });
    fireEvent.click(await node(/^shlok\/codex\/bbbb/));
    expect(window.location.hash).toBe(`#/canvas/${encodeURIComponent(child.id)}`);
    cleanup();
    render(<CanvasView selected={child.id} />, { wrapper: channel([lead, child]) });
    const panel = await screen.findByRole("complementary", { name: /shlok\/codex\/bbbb/ });
    expect(panel.textContent).toContain("Started by planner");
    expect(screen.getByRole("link", { name: "Open Agent page" }).getAttribute("href")).toBe(`#/agents/${encodeURIComponent(child.id)}`);
  });

  it("keeps a dragged node where it was put, after a reload and when another Agent joins", async () => {
    render(<CanvasView />, { wrapper: channel([lead, child]) });
    const dragged = await node(/^planner/);
    const start = place(dragged);
    const other = place(await node(/^shlok\/codex/));
    act(() => {
      fireEvent.pointerDown(dragged, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(dragged, { pointerId: 1, clientX: 210, clientY: 410 });
      fireEvent.pointerUp(dragged, { pointerId: 1, clientX: 210, clientY: 410 });
    });
    const moved = place(dragged);
    expect(moved.x - start.x).toBeCloseTo(200 / currentZoom());
    expect(moved.y - start.y).toBeCloseTo(400 / currentZoom());
    // The drag was not a click: nothing was selected.
    fireEvent.click(dragged);
    expect(window.location.hash).toBe("#/canvas");

    cleanup();
    render(<CanvasView />, { wrapper: channel([lead, child]) });
    expect(place(await node(/^planner/))).toEqual(moved);
    act(() => push({ type: "agent", agent: agent("shlok/gemini/dddd", { cli: "gemini" }) }));
    await node(/^shlok\/gemini\/dddd/);
    expect(place(await node(/^planner/))).toEqual(moved);
    expect(place(await node(/^shlok\/codex/))).toEqual(other);
  });
});

function currentZoom(): number {
  return Number.parseInt(screen.getByText(/^\d+%$/).textContent ?? "100", 10) / 100;
}
