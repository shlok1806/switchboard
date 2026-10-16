// @vitest-environment happy-dom
// Focus order and reduced motion, as a keyboard or motion-sensitive reader meets them (plan
// slice 11): the first Tab reaches Skip to the page; opening another page puts focus at the top
// of it, so the next Tab starts there, but picking a row on the same page leaves focus where it
// was; and with reduced motion asked for, the page jumps where it would glide.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { MockChannelSource } from "@/data/mock/mockSource";
import { ChannelProvider, ChannelStore } from "@/data/store";

let reduce = false;

beforeEach(() => {
  reduce = false;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce") ? reduce : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

async function open(hash: string) {
  window.location.hash = hash;
  render(
    <ChannelProvider store={new ChannelStore(new MockChannelSource({ latencyMs: 0 }))}>
      <App />
    </ChannelProvider>,
  );
  await waitFor(() => expect(document.querySelector("[data-view-state=loading]")).toBeNull());
}

const go = async (hash: string) => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
};

describe("focus order", () => {
  it("starts with Skip to the page, which puts focus on the page", async () => {
    await open("#/agents");
    const focusable = document.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]:not([tabindex='-1'])");
    expect(focusable[0]?.textContent).toBe("Skip to the page");
    fireEvent.click(focusable[0]!);
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("puts focus at the top of a page it opens, but not when a row on the same page is picked", async () => {
    await open("#/agents");
    const key = screen.getByRole("link", { name: /^Tasks/ });
    key.focus();
    await go("#/tasks");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main")));

    const agents = screen.getByRole("link", { name: /^Agents/ });
    await go("#/agents");
    agents.focus();
    await go("#/agents/select/shlok%2Fcodex%2Fc91e");
    expect(document.activeElement).toBe(agents);
  });
});

describe("reduced motion", () => {
  async function directive() {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await open("#/agents/shlok%2Fclaude%2F7f3a");
    fireEvent.click(await screen.findByRole("button", { name: "Directive" }));
    return scroll.mock.calls.at(-1)?.[0] as ScrollIntoViewOptions;
  }

  it("glides to the Directive box by default", async () => {
    expect((await directive()).behavior).toBe("smooth");
  });

  it("jumps there when the reader asked for less motion", async () => {
    reduce = true;
    expect((await directive()).behavior).toBe("auto");
  });
});
