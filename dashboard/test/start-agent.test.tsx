// @vitest-environment happy-dom
// Starting and stopping an Agent on a Host (ADR 0015), clicked through as a Person would.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionResult, Agent, Host, HostsResponse } from "@shared/index";
import { CommandPalette } from "@/components/domain/palette";
import { StartAgentButton, StartAgentSheet, StopAgentButton } from "@/components/domain/start-agent";
import type { ChannelSource, SpawnResult } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const host: Host = {
  id: "shlok/studio",
  person: "shlok",
  name: "studio",
  roots: ["/Users/shlok/code/app"],
  maxPermissionMode: "acceptEdits",
  live: true,
  registeredAt: "2026-10-15T00:00:00.000Z",
  lastSeenAt: "2026-10-15T00:00:00.000Z",
};

/** A Channel source with only what these dialogs use; it never finishes loading the Channel. */
function source(overrides: Partial<ChannelSource>): ChannelSource {
  return {
    me: "shlok",
    capabilities: {},
    snapshot: () => new Promise(() => {}),
    hosts: async (): Promise<HostsResponse> => ({ hosts: [host], cap: 4, running: 0 }),
    ...overrides,
  } as unknown as ChannelSource;
}

function withChannel(src: ChannelSource) {
  const store = new ChannelStore(src);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

function pending<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

async function openStartSheet(src: ChannelSource) {
  render(
    <>
      <StartAgentButton />
      <StartAgentSheet />
    </>,
    { wrapper: withChannel(src) },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Start an Agent" }));
  const start = (await screen.findByRole("button", { name: "Start Agent" })) as HTMLButtonElement;
  await waitFor(() => expect(start.disabled).toBe(false));
  return start;
}

describe("starting an Agent", () => {
  it("shows the Channel's refusal in the sheet, with its command as code", async () => {
    const spawnAgent = vi.fn(
      async (): Promise<SpawnResult> => ({
        ok: false,
        reason: "/tmp is not under studio's folders. Run `switchboard host install` again to add it.",
      }),
    );
    const start = await openStartSheet(source({ spawnAgent }));
    fireEvent.click(start);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("is not under studio's folders");
    expect(alert.querySelector("code")?.textContent).toBe("switchboard host install");
    expect(screen.getByRole("button", { name: "Start Agent" })).toBeTruthy();
  });

  it("starts one Agent however often Start is pressed, and cannot be closed while it starts", async () => {
    const answer = pending<SpawnResult>();
    const spawnAgent = vi.fn(() => answer.promise);
    const start = await openStartSheet(source({ spawnAgent }));
    const form = document.getElementById(start.getAttribute("form") ?? "") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(spawnAgent).toHaveBeenCalledTimes(1);

    // Start keeps its label and spins while it waits; nothing closes the sheet meanwhile.
    await waitFor(() => expect(start.getAttribute("aria-busy")).toBe("true"));
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Start an Agent" })).toBeTruthy();

    await act(async () => answer.settle({ ok: false, reason: "studio is Offline." }));
    expect((await screen.findByRole("alert")).textContent).toBe("studio is Offline.");
  });

  it("refuses a folder outside the Host's roots with the Host's reason, before asking", async () => {
    const spawnAgent = vi.fn();
    const start = await openStartSheet(source({ spawnAgent }));
    const folder = screen.getByRole("textbox", { name: "Folder" });
    fireEvent.change(folder, { target: { value: "/Users/shlok/code/other" } });
    expect(folder.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/^\/Users\/shlok\/code\/other is not under studio's folders \(\/Users\/shlok\/code\/app\)/)).toBeTruthy();
    expect(start.disabled).toBe(true);
    fireEvent.submit(document.getElementById("start-agent") as HTMLFormElement);
    expect(spawnAgent).not.toHaveBeenCalled();

    // A folder under a root is fine.
    fireEvent.change(folder, { target: { value: "/Users/shlok/code/app/web" } });
    expect(folder.getAttribute("aria-invalid")).toBeNull();
    expect(start.disabled).toBe(false);
  });

  it("shows the Channel's cap before Start, and will not start past it", async () => {
    render(
      <>
        <StartAgentButton />
        <StartAgentSheet />
      </>,
      { wrapper: withChannel(source({ hosts: async () => ({ hosts: [host], cap: 4, running: 4 }) })) },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Start an Agent" }));
    expect((await screen.findByRole("meter", { name: "Agents running on Hosts" })).getAttribute("aria-valuenow")).toBe("4");
    expect(screen.getByText("4 of 4 Agents running on Hosts")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start Agent" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens from the palette's Start an Agent command", async () => {
    // The palette reads the saved theme; Node 26's own localStorage warns, so a Map stands in.
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) });
    const onOpenChange = vi.fn();
    render(
      <>
        <CommandPalette open onOpenChange={onOpenChange} />
        <StartAgentSheet />
      </>,
      { wrapper: withChannel(source({})) },
    );
    fireEvent.click(await screen.findByRole("option", { name: /Start an Agent/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(await screen.findByRole("dialog", { name: "Start an Agent" })).toBeTruthy();
  });

  it("asks the Channel again after it could not say whether it has Hosts", async () => {
    let calls = 0;
    const hosts = vi.fn(async (): Promise<HostsResponse> => {
      calls += 1;
      if (calls === 1) throw new Error("Failed to fetch");
      return { hosts: [host], cap: 4, running: 0 };
    });
    const wrapper = withChannel(source({ hosts }));
    const first = render(<StartAgentButton />, { wrapper });
    await waitFor(() => expect(hosts).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Start an Agent" })).toBeNull();
    first.unmount();

    render(<StartAgentButton />, { wrapper });
    expect(await screen.findByRole("button", { name: "Start an Agent" })).toBeTruthy();
  });
});

describe("stopping an Agent", () => {
  const agent: Agent = {
    id: "shlok/claude/7f3a",
    person: "shlok",
    cli: "claude-code",
    presence: "live",
    proxyMode: "digest",
    secretMasking: true,
    canReceiveInterrupts: true,
    startedAt: "2026-10-15T00:00:00.000Z",
    lastSeenAt: "2026-10-15T00:00:00.000Z",
    host: "shlok/studio",
  };

  it("asks once, in place, and Escape takes the question back to Stop", async () => {
    const stopAgent = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    render(<StopAgentButton agent={agent} />, { wrapper: withChannel(source({ stopAgent })) });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const question = screen.getByRole("group", { name: "Stop shlok/claude/7f3a?" });
    expect(question.textContent).toContain("a Claim it holds goes Stale");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop" }));
    expect(stopAgent).not.toHaveBeenCalled();
  });

  it("cannot be asked twice: Stop waits, disabled, until the Agent is Gone", async () => {
    const stopAgent = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const wrapper = withChannel(source({ stopAgent }));
    const { rerender } = render(<StopAgentButton agent={agent} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop Agent" }));
    const stopping = (await screen.findByRole("button", { name: "Stopping" })) as HTMLButtonElement;
    expect(stopping.disabled).toBe(true);
    fireEvent.click(stopping);
    expect(screen.queryByRole("group", { name: /^Stop / })).toBeNull();
    expect(stopAgent).toHaveBeenCalledTimes(1);

    // Its session going Idle on the way out is not the answer: Stop stays off.
    rerender(<StopAgentButton agent={{ ...agent, presence: "idle" }} />);
    expect((screen.getByRole("button", { name: "Stopping" }) as HTMLButtonElement).disabled).toBe(true);

    // Its Host answered: the Agent went Gone, and there is nothing left to stop.
    rerender(<StopAgentButton agent={{ ...agent, presence: "gone" }} />);
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });
});
