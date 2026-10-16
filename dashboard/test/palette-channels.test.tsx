// @vitest-environment happy-dom
// On a live deployment the palette lists the deployment's other Channels to switch to, read
// once a session from /auth/config; the simulated Channel lists none.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/domain/palette";
import { MockChannelSource } from "@/data/mock/mockSource";
import { ChannelProvider, ChannelStore } from "@/data/store";

vi.mock("@/lib/session", async (actual) => ({
  ...(await actual<typeof import("@/lib/session")>()),
  wantsMock: () => false,
  channelRepo: () => "shlok1806/app",
}));

const fetched = vi.fn(async () => new Response(JSON.stringify({ configured: true, repos: ["shlok1806/app", "shlok1806/site"], devSignIn: false })));
const assign = vi.fn();

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", fetched);
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign, hash: "", search: "", pathname: "/shlok1806/app" } });
});
afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(true);
  return <CommandPalette open={open} onOpenChange={setOpen} route={{ view: "now" }} />;
}

describe("switching Channel", () => {
  it("lists the other Channels, read once, and opens the one picked", async () => {
    const store = new ChannelStore(new MockChannelSource({ latencyMs: 0 }));
    const { unmount } = render(
      <ChannelProvider store={store}>
        <Harness />
      </ChannelProvider>,
    );
    await act(async () => {});
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("option", { name: /Switch to shlok1806\/app/ })).toBeNull();
    fireEvent.click(await within(dialog).findByRole("option", { name: /Switch to shlok1806\/site/ }));
    expect(assign).toHaveBeenCalledWith("/shlok1806/site");

    unmount();
    render(
      <ChannelProvider store={store}>
        <Harness />
      </ChannelProvider>,
    );
    await within(screen.getByRole("dialog")).findByRole("option", { name: /Switch to shlok1806\/site/ });
    expect(fetched).toHaveBeenCalledTimes(1);
  });
});
