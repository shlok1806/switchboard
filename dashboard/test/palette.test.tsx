// @vitest-environment happy-dom
// The command palette as a Person uses it (plan, Palette): ⌘K opens it anywhere and `/` on a
// list; a command that needs an argument takes it in a second step, with the steps so far over
// the input; Backspace in an empty input or Escape goes back a step; Agents picked lately come
// first.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/domain/palette";
import { MockChannelSource } from "@/data/mock/mockSource";
import { ChannelProvider, ChannelStore } from "@/data/store";
import type { Route } from "@/lib/router";
import { useState } from "react";

let source: MockChannelSource;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  });
  // cmdk scrolls the picked item into view, which happy-dom does not draw.
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

function Harness({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">On the page</button>
      <CommandPalette open={open} onOpenChange={setOpen} route={route} />
    </>
  );
}

async function show(route: Route = { view: "agents" }) {
  source = new MockChannelSource({ latencyMs: 0 });
  render(
    <ChannelProvider store={new ChannelStore(source)}>
      <Harness route={route} />
    </ChannelProvider>,
  );
  await act(async () => {});
}

const input = () => screen.getByRole("combobox") as HTMLInputElement;
const palette = () => screen.getByRole("dialog");
const typeIn = (text: string) => fireEvent.change(input(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(input(), { key });
const choose = async (name: RegExp | string) => fireEvent.click(await within(palette()).findByRole("option", { name }));
const trail = () => within(palette()).queryByRole("list", { name: "Steps" })?.textContent ?? "";

describe("the command palette", () => {
  it("opens with ⌘K, and with / on a list but not while typing", async () => {
    await show();
    fireEvent.keyDown(document, { key: "/" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    press("Escape");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("does not take / on a page that is not a list", async () => {
    await show({ view: "task", number: 12 });
    fireEvent.keyDown(document, { key: "/" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends a Directive in steps: the command, an Agent, then the text", async () => {
    await show();
    const act = vi.spyOn(source, "act");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await choose(/Directive to/);
    expect(trail()).toMatch(/^Directive to/);
    await choose(/shlok\/claude\/7f3a/);
    expect(trail()).toMatch(/Directive to.*shlok\/api-client/);
    // Nothing to send until there is text.
    expect(within(palette()).getByRole("option", { name: /Type the Directive/ }).getAttribute("aria-disabled")).toBe("true");
    typeIn("Run the tests before pushing");
    await choose(/Send “Run the tests before pushing”/);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(act).toHaveBeenCalledWith({ type: "directive", to: "shlok/claude/7f3a", text: "Run the tests before pushing" });
  });

  it("goes back a step with Backspace in an empty input, and with Escape", async () => {
    await show();
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await choose(/Directive to/);
    await choose(/shlok\/claude\/7f3a/);
    press("Backspace");
    expect(trail()).toMatch(/^Directive to/);
    expect(trail()).not.toMatch(/api-client/);
    expect(input().placeholder).toBe("Pick an Agent");
    fireEvent.keyDown(palette(), { key: "Escape" });
    expect(trail()).toBe("");
    expect(within(palette()).getByRole("option", { name: /Directive to/ })).toBeTruthy();
    // At the top, Escape closes.
    fireEvent.keyDown(palette(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("asks before it stops one of your Agents, and offers only those", async () => {
    await show();
    const stop = vi.spyOn(source, "stopAgent");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await choose(/^Stop/);
    const offered = within(palette()).getAllByRole("option").map((o) => o.textContent);
    expect(offered.every((t) => t?.startsWith("shlok/"))).toBe(true);
    await choose(/shlok\/claude\/7f3a/);
    await choose("Keep it running");
    expect(stop).not.toHaveBeenCalled();
    await choose(/shlok\/claude\/7f3a/);
    await choose(/Stop shlok\/api-client/);
    await waitFor(() => expect(stop).toHaveBeenCalledWith("shlok/claude/7f3a"));
  });

  it("takes over a Stale Task for you", async () => {
    await show();
    const act = vi.spyOn(source, "act");
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await choose(/Take over/);
    await choose(/#17/);
    await waitFor(() => expect(act).toHaveBeenCalledWith({ type: "takeover", task: 17, to: { kind: "person", person: "shlok" } }));
  });

  it("puts the Agents picked lately first", async () => {
    await show();
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await choose(/Watch/);
    await choose(/maya\/claude\/2b8d/);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await choose(/Directive to/);
    const recent = within(palette()).getByRole("group", { name: "Recent" });
    expect(within(recent).getAllByRole("option").map((o) => o.textContent?.split(" ")[0])).toEqual(["maya/claude/2b8dusers-pageLive"]);
  });
});
