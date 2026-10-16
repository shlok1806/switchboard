// @vitest-environment happy-dom
// The Tasks board and a Task's page, used as a Person would: a Stale Claim heads the Claimed
// column and fills the inspector first, with Take over as its action; a click on another card
// reads that Task without leaving the board; on a phone a tap opens the Task as a sheet. The
// Task's page lists its Steps and posts an Update on it or a Directive to the Agent holding it.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentId, ChannelSnapshot, PersonAction, Task } from "@shared/index";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { TaskDetail } from "@/views/TaskDetail";
import { TasksView } from "@/views/TasksView";

const agent = (id: string, nickname: string, presence: Agent["presence"]) =>
  ({
    id: id as AgentId,
    person: "ana",
    nickname,
    cli: "claude-code",
    presence,
    lastSeenAt: "2026-10-15T10:00:00.000Z",
    startedAt: "2026-10-15T09:00:00.000Z",
  }) as unknown as Agent;
const quill = agent("ana/claude/aaaa", "quill", "live");
const moth = agent("ana/claude/bbbb", "moth", "gone");

const task = (number: number, title: string, extra: Partial<Task> = {}): Task => ({
  number,
  title,
  description: "",
  labels: [],
  blockedBy: [],
  subtasks: [],
  subtasksDone: 0,
  steps: [],
  stepsDone: 0,
  url: `https://github.com/ana/app/issues/${number}`,
  status: "open",
  updatedAt: "2026-10-15T09:00:00.000Z",
  ...extra,
});

const tasks = [
  task(12, "Add the avatar upload", { labels: ["web"] }),
  task(14, "Page the Users API by 50", {
    status: "claimed",
    claim: { task: 14, holder: { kind: "agent", agentId: quill.id }, claimedAt: "2026-10-15T09:10:00.000Z", stale: false },
    steps: [
      { index: 0, text: "Read the API", done: true },
      { index: 1, text: "Change the page size", done: false },
    ],
    stepsDone: 1,
    branch: "task/14-users-paging",
  }),
  task(17, "Fix the Safari login crash", {
    status: "claimed",
    claim: { task: 17, holder: { kind: "agent", agentId: moth.id }, claimedAt: "2026-10-15T08:00:00.000Z", stale: true },
  }),
];

function channel(acted: PersonAction[] = []) {
  const source = {
    me: "ana",
    capabilities: { claims: true, takeover: true, directives: true, agents: true },
    snapshot: async () =>
      ({ channel: { repo: "ana/app" }, persons: [{ name: "ana" }], agents: [quill, moth], tasks, events: [], verdicts: [], relay: { interruptThreshold: 0.6 }, cursor: 0 }) as unknown as ChannelSnapshot,
    hosts: async () => null,
    scopedEvents: async () => ({ events: [] }),
    act: async (a: PersonAction) => {
      acted.push(a);
      return { ok: true };
    },
    subscribe: () => () => {},
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

afterEach(cleanup);

describe("the Tasks board", () => {
  it("heads the Claimed column with the Stale Claim and opens it in the inspector first", async () => {
    render(<TasksView />, { wrapper: channel() });
    const stale = await screen.findByRole("region", { name: "Stale Claims" });
    expect(within(stale).getByText("Fix the Safari login crash")).toBeTruthy();
    // Listed once: not also among the Claims that are moving.
    expect(screen.getAllByText("Fix the Safari login crash")).toHaveLength(1);

    const inspector = screen.getByRole("complementary", { name: "#17 Fix the Safari login crash, in the inspector" });
    expect(within(inspector).getByRole("button", { name: "Take over" })).toBeTruthy();
  });

  it("reads another Task in the inspector on a click, with its Steps, branch and a way to its page", async () => {
    render(<TasksView />, { wrapper: channel() });
    fireEvent.click(await screen.findByText("Page the Users API by 50"));
    const inspector = screen.getByRole("complementary", { name: "#14 Page the Users API by 50, in the inspector" });
    expect(within(inspector).getByText("Change the page size")).toBeTruthy();
    expect(within(inspector).getByText("git switch task/14-users-paging")).toBeTruthy();
    expect(within(inspector).getByRole("link", { name: "Open" }).getAttribute("href")).toBe("#/tasks/14");
  });

  it("narrows the board to the Stale Claims", async () => {
    render(<TasksView />, { wrapper: channel() });
    fireEvent.click(await screen.findByRole("button", { name: /^Stale \d/ }));
    expect(screen.queryByText("Add the avatar upload")).toBeNull();
    expect(screen.queryByText("Page the Users API by 50")).toBeNull();
    expect(screen.getAllByText("Fix the Safari login crash").length).toBeGreaterThan(0);
  });

  it("opens a Task as a sheet on a phone only when its card is tapped, and Escape closes it", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    try {
      render(<TasksView />, { wrapper: channel() });
      const card = await screen.findByText("Add the avatar upload");
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(card);
      const sheet = await screen.findByRole("dialog", { name: "#12 Add the avatar upload, in the inspector" });
      expect(document.activeElement).toBe(sheet);
      fireEvent.keyDown(sheet, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    }
  });
});

describe("a Task's page", () => {
  it("lists the Steps with the one its Agent is on, and posts an Update and a Directive", async () => {
    const acted: PersonAction[] = [];
    render(<TaskDetail number={14} />, { wrapper: channel(acted) });
    expect(await screen.findByRole("heading", { level: 1, name: /Page the Users API by 50/ })).toBeTruthy();
    const steps = screen.getByRole("heading", { name: /Steps/ }).closest("section")!;
    expect(within(steps).getByText("In progress:").parentElement?.textContent).toContain("Change the page size");

    fireEvent.change(screen.getByLabelText("Update on #14"), { target: { value: "Page size is 50 now." } });
    fireEvent.click(within(screen.getByLabelText("Update on #14").closest("form")!).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(acted).toContainEqual({ type: "update", text: "Page size is 50 now.", task: 14 }));

    fireEvent.change(screen.getByLabelText("Directive to quill"), { target: { value: "Run the API tests." } });
    fireEvent.click(within(screen.getByLabelText("Directive to quill").closest("form")!).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(acted).toContainEqual({ type: "directive", to: quill.id, text: "Run the API tests." }));
  });

  it("leads with Take over on a Stale Claim and sends no Directive to its Gone Agent", async () => {
    render(<TaskDetail number={17} />, { wrapper: channel() });
    expect(await screen.findByRole("heading", { name: "Stale Claim" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Take over" }).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Directive to moth")).toBeNull();
    expect(screen.getByText("moth is Gone. A Directive waits until it resumes.")).toBeTruthy();
  });
});
