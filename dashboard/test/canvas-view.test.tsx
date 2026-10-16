// @vitest-environment happy-dom
// The canvas (ADR 0020), used as a Person would: it draws the Channel's Agents, their
// Tasks and who started whom; a click opens an Agent; a dragged node stays where it
// was put, across a reload and when another Agent joins.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentId, ChannelSnapshot, StreamMessage, Task } from "@shared/index";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { CanvasView, shortTitle } from "@/views/CanvasView";

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
const mayaIdle = agent("maya/claude/dddd", { presence: "idle" });
const login: Task = {
  number: 12,
  title: "Fix the login redirect",
  branch: "task/12-fix-the-login-redirect",
  claim: { task: 12, holder: { kind: "agent", agentId: lead.id }, claimedAt: "2026-10-15T09:01:00.000Z", stale: false },
} as Task;

let push: (m: StreamMessage) => void = () => {};

function channel(agents: Agent[]) {
  const source = {
    me: "shlok",
    capabilities: {},
    snapshot: async (): Promise<ChannelSnapshot> =>
      ({ channel: { repo: "shlok1806/app" }, persons: [], agents, tasks: [login], events: [], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
    // A Worker with no Hosts: the canvas offers no Start an Agent.
    hosts: async () => null,
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
const place = (el: HTMLElement) => {
  const box = el.closest<HTMLElement>("[data-node]")!;
  return { x: Number.parseFloat(box.style.left), y: Number.parseFloat(box.style.top) };
};

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
  it("draws current Agents with their state and Task, a frame for where they run, and an edge from a lead", async () => {
    const { container } = render(<CanvasView />, { wrapper: channel([lead, child, maya]) });
    expect(await node(/^planner, shlok's Claude Code Agent, Running, #12 Fix the login redirect$/)).toBeTruthy();
    expect(await node(/^shlok\/codex\/bbbb, shlok's Codex Agent, Running$/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^maya\/claude\/cccc/ })).toBeNull();
    expect(screen.getByText("#12 Fix the login redirect")).toBeTruthy();
    expect([...container.querySelectorAll("[data-edge]")].map((p) => p.getAttribute("data-edge"))).toEqual([`${lead.id} ${child.id}`]);
    // One frame for each Person's hand-started Agents, the signed-in Person's first.
    const frames = [...container.querySelectorAll("[data-frame]")];
    expect(frames.map((f) => f.querySelector("span > span:first-child")?.textContent)).toEqual(["terminals"]);
    expect(frames[0]!.textContent).toContain("shlok (you)");
    expect(frames[0]!.textContent).toContain("2 Agents");
  });

  it("puts an Agent a Host started in that Host's frame", async () => {
    const onStudio = agent("shlok/claude/eeee", { host: "shlok/studio" as Agent["host"] });
    const { container } = render(<CanvasView />, { wrapper: channel([onStudio, maya]) });
    await node(/^shlok\/claude\/eeee/);
    const studio = container.querySelector(`[data-frame="shlok/studio"]`)!;
    expect(studio.querySelector("span > span:first-child")?.textContent).toBe("studio");
    expect(studio.textContent).toContain("1 Agent");
    expect(studio.textContent).not.toContain("by hand");
  });

  it("opens an Agent on a phone as a sheet that takes focus and closes on Escape", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    try {
      window.location.hash = `#/canvas/${encodeURIComponent(child.id)}`;
      render(<CanvasView selected={child.id} />, { wrapper: channel([lead, child]) });
      const sheet = await screen.findByRole("dialog", { name: /shlok\/codex\/bbbb/ });
      expect(document.activeElement).toBe(sheet);
      fireEvent.keyDown(within(sheet).getByRole("link", { name: "Open the terminal" }), { key: "Escape" });
      expect(window.location.hash).toBe("#/canvas");
    } finally {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    }
  });

  it("lists the frames as lanes on a phone, a lead's Agent under it, and a tap opens the Agent", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    try {
      const { container } = render(<CanvasView />, { wrapper: channel([mayaIdle, child, lead]) });
      await screen.findByText("planner");
      // No canvas to pan on a phone: the frames are lanes, yours first.
      expect(container.querySelector("[role=application]")).toBeNull();
      const lanes = screen.getAllByRole("region");
      expect(lanes.map((l) => l.querySelector("h2")?.textContent)).toEqual(["terminalsshlok (you) · 2 Agents", "terminalsmaya · 1 Agent"]);
      const rows = within(lanes[0]!).getAllByRole("link");
      expect(rows.map((r) => r.textContent)).toEqual([expect.stringMatching(/^planner/), expect.stringMatching(/^codex\/bbbb.*started by planner$/)]);
      expect(rows[1]!.getAttribute("href")).toBe(`#/canvas/${encodeURIComponent(child.id)}`);
    } finally {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    }
  });

  it("puts the nodes in frame order, so Tab moves through the canvas the way it reads", async () => {
    // maya's Agent joined first, but the signed-in Person's frame comes first.
    const { container } = render(<CanvasView />, { wrapper: channel([maya, child, lead]) });
    await node(/^planner/);
    expect([...container.querySelectorAll("[data-node]")].map((e) => e.getAttribute("data-node"))).toEqual([lead.id, child.id]);
  });

  it("opens an Agent on a click, and shows where it came from", async () => {
    render(<CanvasView />, { wrapper: channel([lead, child]) });
    fireEvent.click(await node(/^shlok\/codex\/bbbb/));
    expect(window.location.hash).toBe(`#/canvas/${encodeURIComponent(child.id)}`);
    cleanup();
    render(<CanvasView selected={child.id} />, { wrapper: channel([lead, child]) });
    const panel = await screen.findByRole("complementary", { name: /shlok\/codex\/bbbb/ });
    expect(panel.textContent).toContain("Started byplanner");
    expect(within(panel).getByRole("link", { name: "Open the terminal" }).getAttribute("href")).toBe(`#/agents/${encodeURIComponent(child.id)}`);
  });

  it("closes the open Agent on Escape, from a node as well as from the canvas", async () => {
    window.location.hash = `#/canvas/${encodeURIComponent(child.id)}`;
    render(<CanvasView selected={child.id} />, { wrapper: channel([lead, child]) });
    fireEvent.keyDown(await node(/^planner/), { key: "Escape" });
    expect(window.location.hash).toBe("#/canvas");
  });

  it("zooms in as two fingers spread and out as they pinch, about the point between them", async () => {
    render(<CanvasView />, { wrapper: channel([lead, child]) });
    await node(/^planner/);
    const ground = screen.getByRole("application");
    const start = currentZoom();
    act(() => {
      fireEvent.pointerDown(ground, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
      fireEvent.pointerDown(ground, { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
      fireEvent.pointerMove(ground, { pointerId: 2, pointerType: "touch", clientX: 220, clientY: 100 });
    });
    expect(currentZoom()).toBeCloseTo(start * 1.2);
    act(() => {
      fireEvent.pointerMove(ground, { pointerId: 2, pointerType: "touch", clientX: 160, clientY: 100 });
    });
    expect(currentZoom()).toBeCloseTo(start * 0.6);
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

describe("a node's Task line", () => {
  it("cuts a long title at a word, and a first word too long for the line where the line ends", () => {
    expect(shortTitle("Fix the login redirect")).toBe("Fix the login redirect");
    expect(shortTitle("Move the settings form onto the new validation")).toBe("Move the settings form");
    const word = "Internationalizationoftheapp";
    expect(shortTitle(`${word} strings`)).toBe(word.slice(0, 26));
  });
});
