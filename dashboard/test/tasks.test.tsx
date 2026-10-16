// @vitest-environment happy-dom
// The Tasks board and a Task's page, used as a Person would: a Stale Claim heads the Claimed
// column and fills the inspector first, with Take over as its action; a click on another card
// reads that Task without leaving the board; on a phone a tap opens the Task as a sheet. The
// Task's page lists its Steps and posts an Update on it or a Directive to the Agent holding it.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentId, ChannelEvent, ChannelSnapshot, PersonAction, Task } from "@shared/index";
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
  task(12, "Add the avatar upload", {
    labels: ["web"],
    steps: [
      { index: 0, text: "Pick a storage bucket", done: false },
      { index: 1, text: "Resize on upload", done: false },
    ],
  }),
  task(15, "Add a timeout option to request()", { blockedBy: [12] }),
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

const history = [
  { id: "e1", seq: 1, at: "2026-10-15T09:10:00.000Z", type: "claim", actor: { kind: "agent", agentId: quill.id }, capture: "tool", task: 14, payload: { holder: { kind: "agent", agentId: quill.id } } },
  { id: "e2", seq: 2, at: "2026-10-15T09:20:00.000Z", type: "file.edit", actor: { kind: "agent", agentId: quill.id }, capture: "hook", task: 14, payload: { path: "web/src/users.tsx" } },
] as unknown as ChannelEvent[];

function channel(acted: PersonAction[] = []) {
  const source = {
    me: "ana",
    capabilities: { claims: true, takeover: true, directives: true, agents: true },
    snapshot: async () =>
      ({ channel: { repo: "ana/app" }, persons: [{ name: "ana" }], agents: [quill, moth], tasks, events: [], verdicts: [], relay: { interruptThreshold: 0.6 }, cursor: 0 }) as unknown as ChannelSnapshot,
    hosts: async () => null,
    scopedEvents: async (scope: { task?: number }) => ({ events: scope.task === 14 ? history : [] }),
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

  it("marks no Step in progress on a Task nobody holds", async () => {
    render(<TasksView />, { wrapper: channel() });
    fireEvent.click(await screen.findByText("Add the avatar upload"));
    const inspector = screen.getByRole("complementary", { name: "#12 Add the avatar upload, in the inspector" });
    expect(within(inspector).getByText("Pick a storage bucket")).toBeTruthy();
    expect(within(inspector).queryByText("In progress:")).toBeNull();
    expect(within(inspector).getAllByText("To do:")).toHaveLength(2);
  });

  it("narrows the board to my Tasks and to blocked ones", async () => {
    render(<TasksView />, { wrapper: channel() });
    fireEvent.click(await screen.findByRole("button", { name: /^Mine \d/ }));
    // Ana's Agents hold #14 and #17; nobody holds #12 or #15.
    expect(screen.getByText("Page the Users API by 50")).toBeTruthy();
    expect(screen.queryByText("Add the avatar upload")).toBeNull();
    expect(screen.queryByText("Add a timeout option to request()")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Blocked \d/ }));
    expect(screen.getByText("Add a timeout option to request()")).toBeTruthy();
    expect(screen.queryByText("Page the Users API by 50")).toBeNull();
    expect(screen.queryByText("Add the avatar upload")).toBeNull();
  });

  it("keeps a click on a card's Claim menu from opening the card in the inspector", async () => {
    render(<TasksView />, { wrapper: channel() });
    const card = (await screen.findByText("Add the avatar upload")).closest("[aria-roledescription='Task card']") as HTMLElement;
    expect(card.getAttribute("aria-label")).toBe("#12 Add the avatar upload");
    fireEvent.click(within(card).getByRole("button", { name: "Claim" }));
    expect(screen.getByRole("complementary", { name: /^#17 / })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: /^#12 / })).toBeNull();
  });

  it("offers on a phone only the moves the Channel will make", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    try {
      render(<TasksView />, { wrapper: channel() });
      const card = (await screen.findByText("Page the Users API by 50")).closest("[aria-roledescription='Task card']") as HTMLElement;
      fireEvent.pointerDown(within(card).getByRole("button", { name: "Move" }), { button: 0, pointerType: "mouse" });
      const menu = await screen.findByRole("menu");
      // Ana's Agent holds it, so she can release it to Open; In review and Done come from GitHub.
      expect(within(menu).getByRole("menuitem", { name: "Open" })).toBeTruthy();
      expect(within(menu).queryByRole("menuitem", { name: "In review" })).toBeNull();
      expect(within(menu).queryByRole("menuitem", { name: "Done" })).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    }
  });

  it("shows one column at a time on a phone, the claimed one first, and another when it is picked", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    try {
      render(<TasksView />, { wrapper: channel() });
      const columns = await screen.findByRole("group", { name: "Column" });
      expect(within(columns).getByRole("button", { name: /^Claimed/ }).getAttribute("aria-pressed")).toBe("true");
      expect(await screen.findByText("Page the Users API by 50")).toBeTruthy();
      expect(screen.queryByText("Add the avatar upload")).toBeNull();
      fireEvent.click(within(columns).getByRole("button", { name: /^Open/ }));
      expect(await screen.findByText("Add the avatar upload")).toBeTruthy();
      expect(screen.queryByText("Page the Users API by 50")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    }
  });

  it("opens a Task as a sheet on a phone only when its card is tapped, and Escape closes it", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    try {
      render(<TasksView />, { wrapper: channel() });
      // A phone shows one column at a time; this Task is in Open.
      fireEvent.click(within(await screen.findByRole("group", { name: "Column" })).getByRole("button", { name: /^Open/ }));
      const card = await screen.findByText("Add the avatar upload");
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(card);
      const sheet = await screen.findByRole("dialog", { name: "#12 Add the avatar upload, in the inspector" });
      await waitFor(() => expect(document.activeElement).toBe(sheet));
      fireEvent.keyDown(sheet, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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

  it("shows the Task's work on the Timeline, and everything with All", async () => {
    render(<TaskDetail number={14} />, { wrapper: channel() });
    const timeline = (await screen.findByRole("heading", { name: "Timeline" })).closest("section")!;
    await within(timeline).findByText("Claimed");
    expect(within(timeline).queryByText("Edited web/src/users.tsx")).toBeNull();
    fireEvent.click(within(timeline).getByRole("button", { name: /^All/ }));
    expect(within(timeline).getByText("Edited web/src/users.tsx")).toBeTruthy();
  });

  it("claims an unclaimed Task from its head only", async () => {
    render(<TaskDetail number={12} />, { wrapper: channel() });
    await screen.findByRole("heading", { level: 1, name: /Add the avatar upload/ });
    expect(screen.getAllByRole("button", { name: "Claim" })).toHaveLength(1);
    expect(screen.getByText("Nobody holds it.")).toBeTruthy();
  });

  it("leads with Take over on a Stale Claim and sends no Directive to its Gone Agent", async () => {
    render(<TaskDetail number={17} />, { wrapper: channel() });
    expect(await screen.findByRole("heading", { name: "Stale Claim" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Take over" }).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Directive to moth")).toBeNull();
    expect(screen.getByText("moth is Gone. A Directive waits until it resumes.")).toBeTruthy();
  });
});
