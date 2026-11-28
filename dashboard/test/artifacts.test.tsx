// @vitest-environment happy-dom
// Artifacts, used as a Person would (ADR 0053): the folder lists each shared page at its latest
// version with who published it and when; a page opens in the Dashboard's small browser, framed
// in the sandbox it is served in, at the version picked; Open HTML file publishes a page from
// this machine and opens it, unless it holds a secret; an Agent's publish streaming in reads the
// folder again; its owner deletes it after saying so in place; and a Channel with none, a failed read and a Worker without artifacts say so.

import nodeConsole from "node:console";
import type {
  ActionResult,
  Agent,
  AgentId,
  ArtifactResponse,
  ArtifactSummary,
  ArtifactsResponse,
  ChannelEvent,
  ChannelSnapshot,
  PublishArtifactRequest,
  StreamMessage,
} from "@shared/index";
import { ARTIFACT_SANDBOX, artifactPagePath } from "@shared/index";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSource, PublishArtifactResult } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { ago } from "@/lib/format";
import { ArtifactsView, ArtifactViewer } from "@/views/ArtifactsView";

const scout = {
  id: "maya/claude/2b8d" as AgentId,
  person: "maya",
  nickname: "scout",
  cli: "claude-code",
  presence: "live",
  lastSeenAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
} as unknown as Agent;

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const summary = (name: string, version: number, extra: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  name,
  title: "Bundle size by route",
  owner: "maya",
  version,
  size: 4_300,
  digest: `${version}`.repeat(64),
  publishedBy: { person: "maya", agent: scout.id, nickname: "scout" },
  publishedAt: minutesAgo(10),
  ...extra,
});

const BASE = "https://channel.example/r/shlok1806/app";
const pageUrl = (name: string, version?: number, download?: boolean) => `${BASE}${artifactPagePath(name, version, download)}`;

let stream: ((m: StreamMessage) => void) | undefined;

function channel(extra: Partial<ChannelSource>) {
  const source = {
    me: "shlok",
    capabilities: {},
    snapshot: async () =>
      ({ channel: { repo: "shlok1806/app" }, persons: [], agents: [scout], tasks: [], events: [], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
    subscribe: (_cursor: number, onMessage: (m: StreamMessage) => void) => {
      stream = onMessage;
      return () => {};
    },
    artifactPageUrl: pageUrl,
    ...extra,
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

// happy-dom loads no page into a frame and says so on Node's console each time; anything else still shows.
const consoleError = nodeConsole.error.bind(nodeConsole);
beforeEach(() => {
  vi.spyOn(nodeConsole, "error").mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes("Iframe page loading is disabled")) return;
    consoleError(...args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  stream = undefined;
  window.location.hash = "";
});

const folder = (): ArtifactsResponse => ({
  artifacts: [
    summary("bundle-size", 3),
    summary("receipt-splitter", 1, { title: "Receipt splitter", publishedBy: { person: "shlok" }, publishedAt: minutesAgo(180) }),
  ],
});

const bundleSize = async (_name: string, version?: number): Promise<ArtifactResponse> => ({
  artifact: summary("bundle-size", version ?? 3),
  versions: [1, 2, 3],
});

function toolCall(tool: string, arg: string): StreamMessage {
  const event = {
    id: `e-${tool}-${arg}`,
    seq: 99,
    type: "tool.call",
    actor: { kind: "agent", agentId: scout.id },
    capture: "tool",
    at: new Date().toISOString(),
    payload: { tool, arg, ok: true },
  } as unknown as ChannelEvent;
  return { type: "event", event } as StreamMessage;
}

/** The paragraph whose whole text matches: facts are set in several elements. */
const line = (pattern: RegExp) => (_: string, el: Element | null) => el?.tagName === "P" && pattern.test(el.textContent ?? "");

/** Picks `file` in Open HTML file's file chooser. */
function pick(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  expect(input.accept).toContain(".html");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

describe("the folder of artifacts", () => {
  it("lists each artifact at its latest version, with its size, the Agent that published it and its age", async () => {
    render(<ArtifactsView />, { wrapper: channel({ artifacts: async () => folder() }) });
    const row = (await screen.findByText("Bundle size by route")).closest("li");
    if (!row) throw new Error("no row");
    expect(within(row).getByText("v3")).toBeTruthy();
    expect(within(row).getByText(line(/^bundle-size · 4\.2 KB · maya\/scout · /))).toBeTruthy();
    expect(within(row).getByRole("link", { name: "maya/scout" }).getAttribute("href")).toBe(`#/agents/${encodeURIComponent(scout.id)}`);
    expect(within(row).getByText(ago(minutesAgo(10)))).toBeTruthy();
    // A Person's own publish names the Person.
    const own = screen.getByText("Receipt splitter").closest("li");
    expect(own && within(own).getByText("shlok")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button"));
    expect(window.location.hash).toBe("#/artifacts/bundle-size");
  });

  it("reads the folder again when an Agent's artifact_publish streams in, and only then", async () => {
    let shown = folder();
    const read = vi.fn(async () => shown);
    render(<ArtifactsView />, { wrapper: channel({ artifacts: read }) });
    await screen.findByText("Bundle size by route");
    await waitFor(() => expect(stream).toBeDefined());
    const calls = read.mock.calls.length;

    act(() => stream?.(toolCall("Edit", "web/src/pages/users.tsx")));
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(calls);

    shown = { artifacts: [summary("pager-states", 1, { title: "Pager states" }), ...folder().artifacts] };
    act(() => stream?.(toolCall("artifact_publish", "pager-states")));
    expect(await screen.findByText("Pager states")).toBeTruthy();
    // A hook names the same tool as an MCP tool.
    act(() => stream?.(toolCall("mcp__switchboard__artifact_publish", "pager-states")));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(calls + 2));
  });

  it("says what fills it when the Channel has none, with Open HTML file", async () => {
    render(<ArtifactsView />, { wrapper: channel({ artifacts: async () => ({ artifacts: [] }) }) });
    const empty = await screen.findByRole("region", { name: "No artifacts shared yet" });
    expect(within(empty).getByText(/artifact_publish/)).toBeTruthy();
    expect(within(empty).getByText("switchboard artifacts publish page.html")).toBeTruthy();
    expect(within(empty).getByRole("button", { name: "Open HTML file" })).toBeTruthy();
  });

  it("says why the folder could not be read, and Try again reads it", async () => {
    let fail = true;
    render(<ArtifactsView />, {
      wrapper: channel({
        artifacts: async () => {
          if (fail) throw new Error("The Channel's Worker answered 500 to this read.");
          return folder();
        },
      }),
    });
    expect(await screen.findByRole("heading", { name: "Could not read the artifacts" })).toBeTruthy();
    expect(screen.getByText("The Channel's Worker answered 500 to this read.")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Bundle size by route")).toBeTruthy();
  });

  it("says when the Channel's Worker has no artifacts", async () => {
    render(<ArtifactsView />, { wrapper: channel({ artifacts: async () => null }) });
    expect(await screen.findByRole("heading", { name: "Artifacts are not on this Channel yet" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open HTML file" })).toBeNull();
  });
});

describe("Open HTML file", () => {
  it("publishes the file as the Person, named after it, and opens it", async () => {
    const publish = vi.fn(
      async (name: string, _request: PublishArtifactRequest): Promise<PublishArtifactResult> => ({
        ok: true,
        answer: { artifact: summary(name, 1, { title: "Receipt splitter" }), published: true },
      }),
    );
    render(<ArtifactsView />, { wrapper: channel({ artifacts: async () => folder(), publishArtifact: publish }) });
    await screen.findByRole("button", { name: "Open HTML file" });
    const html = "<!doctype html><title>Receipt splitter</title><p>Each pays $25.49</p>";
    pick(new File([html], "Receipt Splitter.html", { type: "text/html" }));
    await waitFor(() => expect(window.location.hash).toBe("#/artifacts/receipt-splitter"));
    expect(publish).toHaveBeenCalledWith("receipt-splitter", { html });
  });

  it("refuses a page that holds a secret, saying why, and publishes nothing", async () => {
    const publish = vi.fn();
    render(<ArtifactsView />, { wrapper: channel({ artifacts: async () => folder(), publishArtifact: publish }) });
    await screen.findByRole("button", { name: "Open HTML file" });
    pick(new File(["<html>\n<script>\nconst token = 'ghp_R8f2kLq9Zt3Xw7Vn1Bc6Hd4Jm0Ps5Yg2Ue8A';\n</script></html>"], "report.html"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/looks like it holds a secret .*line 3.* report was not published/);
    expect(alert.textContent).not.toContain("ghp_");
    expect(publish).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });

  it("shows the Channel's refusal in place", async () => {
    const publish = vi.fn(
      async (): Promise<PublishArtifactResult> => ({ ok: false, reason: "receipt-splitter belongs to maya: only maya or her Agents publish it." }),
    );
    render(<ArtifactsView />, { wrapper: channel({ artifacts: async () => folder(), publishArtifact: publish }) });
    await screen.findByRole("button", { name: "Open HTML file" });
    pick(new File(["<p>mine</p>"], "receipt-splitter.html"));
    expect((await screen.findByRole("alert")).textContent).toContain("belongs to maya");
    expect(window.location.hash).toBe("");
  });
});

describe("an artifact in the small browser", () => {
  it("frames the page of the version shown in the sandbox it is served in, with Reload, a new tab and Download", async () => {
    render(<ArtifactViewer name="bundle-size" />, { wrapper: channel({ artifact: bundleSize }) });
    const frame = await screen.findByTitle(/Bundle size by route/);
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe(ARTIFACT_SANDBOX);
    expect(frame.getAttribute("src")).toBe(pageUrl("bundle-size", 3));
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByRole("heading", { name: "Bundle size by route" })).toBeTruthy();
    expect(screen.getByText(line(/^bundle-size · v3 · 4\.2 KB · maya\/scout · /))).toBeTruthy();

    const tab = screen.getByRole("link", { name: "Open in new tab" });
    expect(tab.getAttribute("href")).toBe(pageUrl("bundle-size", 3));
    expect(tab.getAttribute("target")).toBe("_blank");
    expect(tab.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(pageUrl("bundle-size", 3, true));

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    const again = screen.getByTitle(/Bundle size by route/);
    expect(again).not.toBe(frame);
    expect(again.getAttribute("src")).toBe(pageUrl("bundle-size", 3));
  });

  it("switches to an older version kept", async () => {
    const read = vi.fn(bundleSize);
    const { rerender } = render(<ArtifactViewer name="bundle-size" />, { wrapper: channel({ artifact: read }) });
    fireEvent.click(await screen.findByRole("button", { name: "v1" }));
    expect(window.location.hash).toBe("#/artifacts/bundle-size/1");
    rerender(<ArtifactViewer name="bundle-size" version={1} />);
    await waitFor(() => expect(screen.getByTitle(/Bundle size by route/).getAttribute("src")).toBe(pageUrl("bundle-size", 1)));
    expect(read).toHaveBeenLastCalledWith("bundle-size", 1);
    fireEvent.click(screen.getByRole("button", { name: "v3 latest" }));
    expect(window.location.hash).toBe("#/artifacts/bundle-size");
  });

  it("shows a newer version an Agent publishes while it is open", async () => {
    let latest = 3;
    const read = async (name: string, version?: number): Promise<ArtifactResponse> => ({
      artifact: summary(name, version ?? latest),
      versions: Array.from({ length: latest }, (_, i) => i + 1),
    });
    render(<ArtifactViewer name="bundle-size" />, { wrapper: channel({ artifact: read }) });
    await screen.findByTitle(/Bundle size by route/);
    await waitFor(() => expect(stream).toBeDefined());
    latest = 4;
    act(() => stream?.(toolCall("artifact_publish", "bundle-size")));
    await waitFor(() => expect(screen.getByTitle(/Bundle size by route/).getAttribute("src")).toBe(pageUrl("bundle-size", 4)));
  });

  it("says when there is no such artifact, with the way back", async () => {
    const missing = async (): Promise<ArtifactResponse> => {
      throw new Error("No artifact is named gone on this Channel.");
    };
    render(<ArtifactViewer name="gone" />, { wrapper: channel({ artifact: missing }) });
    expect(await screen.findByRole("heading", { name: "Could not open gone" })).toBeTruthy();
    expect(screen.getByText("No artifact is named gone on this Channel.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "All artifacts" }).getAttribute("href")).toBe("#/artifacts");
  });
});

describe("deleting an artifact", () => {
  const mine = async (name: string, version?: number): Promise<ArtifactResponse> => ({
    artifact: summary(name, version ?? 2, { title: "Receipt splitter", owner: "shlok", publishedBy: { person: "shlok" } }),
    versions: [1, 2],
  });

  it("offers Delete only to the Person who first published it", async () => {
    render(<ArtifactViewer name="bundle-size" />, { wrapper: channel({ artifact: bundleSize }) });
    await screen.findByTitle(/Bundle size by route/);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    cleanup();
    // Owned by shlok, even at a version shlok's Agent published.
    const byAgent = async (name: string): Promise<ArtifactResponse> => ({
      artifact: summary(name, 2, { owner: "shlok", publishedBy: { person: "shlok", agent: "shlok/claude/1a2b" as AgentId } }),
      versions: [1, 2],
    });
    render(<ArtifactViewer name="bundle-size" />, { wrapper: channel({ artifact: byAgent }) });
    expect(await screen.findByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("asks in place, says what goes, and deletes only on the answer, then goes back to the folder", async () => {
    window.location.hash = "#/artifacts/receipt-splitter";
    const remove = vi.fn(async (_name: string): Promise<ActionResult> => ({ ok: true }));
    render(<ArtifactViewer name="receipt-splitter" />, { wrapper: channel({ artifact: mine, deleteArtifact: remove }) });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const question = screen.getByRole("group", { name: "Delete Receipt splitter?" });
    expect(question.textContent).toContain("All 2 of its versions go for everyone on the Channel. This cannot be undone.");
    // Cancel takes the question back and deletes nothing.
    fireEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Delete Receipt splitter?" })).toBeNull();
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete artifact" }));
    await waitFor(() => expect(window.location.hash).toBe("#/artifacts"));
    expect(remove).toHaveBeenCalledWith("receipt-splitter");
  });

  it("shows the Channel's refusal in place and stays on the page", async () => {
    window.location.hash = "#/artifacts/receipt-splitter";
    const remove = async (): Promise<ActionResult> => ({
      ok: false,
      reason: "receipt-splitter belongs to maya, who published it first. Only they delete it.",
    });
    render(<ArtifactViewer name="receipt-splitter" />, { wrapper: channel({ artifact: mine, deleteArtifact: remove }) });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete artifact" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Only they delete it.");
    expect(window.location.hash).toBe("#/artifacts/receipt-splitter");
  });
});
