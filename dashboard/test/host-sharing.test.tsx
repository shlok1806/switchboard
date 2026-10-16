// @vitest-environment happy-dom
// Sharing a Host from the Hosts page (ADR 0028): a toggle sends the new list, signed by
// this browser's attach key, and a refusal from the Host is shown with what to run there.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelSnapshot, Host, SetHostAllowRequest, StreamMessage } from "@shared/index";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { HostsView } from "@/views/HostsView";

vi.mock("@/lib/attach-key", () => ({
  attachKey: async () => ({
    spki: "a2V5",
    fingerprint: "AAAA-BBBB-CCCC-DDDD-EEEE",
    signAllow: async (repo: string, host: string, _at: number, _seq: number, allow: string[], channel: boolean) =>
      `signed:${repo}:${host}:${channel ? "channel" : allow.join(",")}`,
  }),
  nextSeq: () => 7,
}));

afterEach(cleanup);

const studio = {
  id: "shlok/studio",
  person: "shlok",
  name: "studio",
  roots: ["/Users/shlok/code"],
  maxPermissionMode: "default",
  allow: [],
  allowChannel: false,
  live: true,
  registeredAt: "2026-10-01T09:00:00.000Z",
  lastSeenAt: "2026-10-13T09:00:00.000Z",
} as Host;

function channel(setHostAllow: (name: string, request: SetHostAllowRequest) => Promise<{ ok: true } | { ok: false; reason: string }>) {
  const source = {
    me: "shlok",
    capabilities: {},
    snapshot: async () =>
      ({
        channel: { repo: "shlok1806/app" },
        persons: [
          { name: "shlok", timeZone: "UTC", joinedAt: "" },
          { name: "pranay", timeZone: "UTC", joinedAt: "" },
        ],
        agents: [],
        tasks: [],
        events: [],
        verdicts: [],
        cursor: 0,
      }) as unknown as ChannelSnapshot,
    hosts: async () => ({ hosts: [studio], cap: 8, running: 0 }),
    subscribe: (_c: number, _m: (m: StreamMessage) => void) => () => {},
    setHostAllow,
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

describe("sharing a Host from the Hosts page", () => {
  it("sends the list signed by this browser's key when a Person is toggled", async () => {
    const sent: SetHostAllowRequest[] = [];
    render(<HostsView selected="shlok/studio" />, {
      wrapper: channel(async (_name, request) => {
        sent.push(request);
        return { ok: true };
      }),
    });
    const inspector = await screen.findByRole("complementary", { name: "studio, in the inspector" });
    await act(inspector);
    fireEvent.click(within(inspector).getByRole("checkbox", { name: "pranay" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ allow: ["pranay"], allowChannel: false, key: "a2V5", seq: 7, sig: "signed:shlok1806/app:studio:pranay" });
    await waitFor(() => expect((within(inspector).getByRole("checkbox", { name: "pranay" }) as HTMLInputElement).checked).toBe(true));
  });

  it("shows the Host's refusal with the command that trusts this browser, and leaves the toggle off", async () => {
    render(<HostsView selected="shlok/studio" />, {
      wrapper: channel(async () => ({
        ok: false,
        reason: "studio refused: this browser's key AAAA-BBBB-CCCC-DDDD-EEEE is not trusted on this machine. Run `switchboard attach allow AAAA-BBBB-CCCC-DDDD-EEEE` here, then try again",
      })),
    });
    const inspector = await screen.findByRole("complementary", { name: "studio, in the inspector" });
    fireEvent.click(within(inspector).getByRole("checkbox", { name: "Everyone on this Channel" }));
    const alert = await within(inspector).findByRole("alert");
    expect(alert.textContent).toContain("switchboard attach allow AAAA-BBBB-CCCC-DDDD-EEEE");
    expect((within(inspector).getByRole("checkbox", { name: "Everyone on this Channel" }) as HTMLInputElement).checked).toBe(false);
  });
});

/** Lets the Hosts read settle before a click. */
async function act(_: HTMLElement) {
  await new Promise((r) => setTimeout(r, 20));
}
