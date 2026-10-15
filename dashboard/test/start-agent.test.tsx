// @vitest-environment happy-dom
// Starting and stopping an Agent on a Host (ADR 0015), clicked through as a Person would.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionResult, Agent, Host, HostsResponse } from "@shared/index";
import { StartAgentButton, StopAgentButton } from "@/components/domain/start-agent";
import type { ChannelSource, SpawnResult } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";

afterEach(cleanup);

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

async function openStartDialog(src: ChannelSource) {
  render(<StartAgentButton />, { wrapper: withChannel(src) });
  fireEvent.click(await screen.findByRole("button", { name: "Start an Agent" }));
  return screen.findByRole("button", { name: "Start Agent" });
}

describe("starting an Agent", () => {
  it("shows the Channel's refusal in the dialog, with its command as code", async () => {
    const spawnAgent = vi.fn(
      async (): Promise<SpawnResult> => ({
        ok: false,
        reason: "/tmp is not under studio's folders. Run `switchboard host install` again to add it.",
      }),
    );
    const start = await openStartDialog(source({ spawnAgent }));
    fireEvent.click(start);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("is not under studio's folders");
    expect(alert.querySelector("code")?.textContent).toBe("switchboard host install");
    expect(screen.getByRole("button", { name: "Start Agent" })).toBeTruthy();
  });

  it("starts one Agent however often Start is pressed, and cannot be closed while it starts", async () => {
    const answer = pending<SpawnResult>();
    const spawnAgent = vi.fn(() => answer.promise);
    const start = await openStartDialog(source({ spawnAgent }));
    const form = start.closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(spawnAgent).toHaveBeenCalledTimes(1);

    await screen.findByRole("button", { name: "Starting" });
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Starting" })).toBeTruthy();

    await act(async () => answer.settle({ ok: false, reason: "studio is Offline." }));
    expect((await screen.findByRole("alert")).textContent).toBe("studio is Offline.");
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

  it("cannot be asked twice: Stop waits, disabled, until the Agent is Gone", async () => {
    const stopAgent = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const wrapper = withChannel(source({ stopAgent }));
    const { rerender } = render(<StopAgentButton agent={agent} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop Agent" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const stopping = screen.getByRole("button", { name: "Stopping" }) as HTMLButtonElement;
    expect(stopping.disabled).toBe(true);
    fireEvent.click(stopping);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stopAgent).toHaveBeenCalledTimes(1);

    // Its session going Idle on the way out is not the answer: Stop stays off.
    rerender(<StopAgentButton agent={{ ...agent, presence: "idle" }} />);
    expect((screen.getByRole("button", { name: "Stopping" }) as HTMLButtonElement).disabled).toBe(true);

    // Its Host answered: the Agent went Gone, and there is nothing left to stop.
    rerender(<StopAgentButton agent={{ ...agent, presence: "gone" }} />);
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });
});
