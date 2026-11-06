// @vitest-environment happy-dom
// The Channel's settings page, used as a Person would (ADR 0044): anyone sees the Langfuse
// project's host, name and the public key's end; only the owner connects it, replaces its keys
// or removes it, and the secret key typed in is sent once and never shown again.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelSnapshot, ConnectLangfuseRequest, LangfuseConnection, LangfuseSettingsResponse } from "@shared/index";
import type { ChannelSource, LangfuseResult } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { SettingsView } from "@/views/SettingsView";

const project: LangfuseConnection = {
  host: "https://cloud.langfuse.com",
  publicKeyEnd: "4f2a",
  project: { id: "cm1", name: "greenroom" },
  connectedBy: "shlok",
  connectedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
};

function channel(source: Partial<ChannelSource>) {
  const full = {
    me: "shlok",
    capabilities: {},
    snapshot: async () =>
      ({ channel: { repo: "shlok1806/greenroom" }, persons: [], agents: [], tasks: [], events: [], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
    hosts: async () => null,
    subscribe: () => () => {},
    ...source,
  } as unknown as ChannelSource;
  const store = new ChannelStore(full);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

const answer = (settings: LangfuseSettingsResponse) => async () => settings;

afterEach(cleanup);

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("the Langfuse setting", () => {
  it("shows a connected project to someone who is not the owner, with no way to change it and no secret key", async () => {
    render(<SettingsView />, { wrapper: channel({ langfuse: answer({ langfuse: project, canManage: false }) }) });
    const details = await screen.findByLabelText("Connected project");
    expect(within(details).getByText("greenroom")).toBeTruthy();
    expect(within(details).getByText("https://cloud.langfuse.com")).toBeTruthy();
    expect(within(details).getByText("4f2a")).toBeTruthy();
    expect(within(details).getByText("kept sealed, never shown")).toBeTruthy();
    expect(screen.getByText("only the Channel's owner changes these")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("tells someone who is not the owner that the owner connects it", async () => {
    render(<SettingsView />, { wrapper: channel({ langfuse: answer({ langfuse: null, canManage: false }) }) });
    expect(await screen.findByText(/The Channel's owner, an admin of the repo on GitHub, connects one here/)).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("lets the owner connect a self-hosted project, saying why Langfuse refused the first keys", async () => {
    const sent: ConnectLangfuseRequest[] = [];
    const connectLangfuse = vi.fn(async (request: ConnectLangfuseRequest): Promise<LangfuseResult> => {
      sent.push(request);
      if (request.secretKey === "sk-lf-wrong") return { ok: false, reason: "Langfuse at https://lf.example.com refused these keys." };
      return { ok: true, settings: { canManage: true, langfuse: { ...project, host: request.host, publicKeyEnd: request.publicKey.slice(-4) } } };
    });
    render(<SettingsView />, { wrapper: channel({ langfuse: answer({ langfuse: null, canManage: true }), connectLangfuse }) });
    const form = await screen.findByRole("form", { name: "Connect Langfuse" });
    fireEvent.change(within(form).getByLabelText("Host"), { target: { value: "self-hosted" } });
    type("Self-hosted Langfuse address", "https://lf.example.com");
    type("Public key", "pk-lf-1234-beef");
    type("Secret key", "sk-lf-wrong");
    fireEvent.submit(form);
    expect((await screen.findByRole("alert")).textContent).toBe("Langfuse at https://lf.example.com refused these keys.");

    type("Secret key", "sk-lf-right");
    fireEvent.submit(form);
    const details = await screen.findByLabelText("Connected project");
    expect(within(details).getByText("https://lf.example.com")).toBeTruthy();
    expect(within(details).getByText("beef")).toBeTruthy();
    expect(sent.at(-1)).toEqual({ host: "https://lf.example.com", publicKey: "pk-lf-1234-beef", secretKey: "sk-lf-right" });
    // The form is gone, and the secret key with it.
    expect(screen.queryByLabelText("Secret key")).toBeNull();
    expect(document.body.innerHTML).not.toContain("sk-lf-right");
  });

  it("lets the owner replace the keys or remove the project, after saying what removing does", async () => {
    const connectLangfuse = vi.fn(async (request: ConnectLangfuseRequest): Promise<LangfuseResult> => ({
      ok: true,
      settings: { canManage: true, langfuse: { ...project, publicKeyEnd: request.publicKey.slice(-4) } },
    }));
    const removeLangfuse = vi.fn(async (): Promise<LangfuseResult> => ({ ok: true, settings: { langfuse: null, canManage: true } }));
    render(<SettingsView />, { wrapper: channel({ langfuse: answer({ langfuse: project, canManage: true }), connectLangfuse, removeLangfuse }) });

    fireEvent.click(await screen.findByRole("button", { name: "Replace keys" }));
    const form = screen.getByRole("form", { name: "Replace the Langfuse keys" });
    expect((within(form).getByLabelText("Host") as HTMLSelectElement).value).toBe("https://cloud.langfuse.com");
    type("Public key", "pk-lf-new-9z9z");
    type("Secret key", "sk-lf-new");
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText("9z9z")).toBeTruthy());
    expect(connectLangfuse).toHaveBeenCalledWith({ host: "https://cloud.langfuse.com", publicKey: "pk-lf-new-9z9z", secretKey: "sk-lf-new" });

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText(/the costs tool stops answering until it is connected again/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(removeLangfuse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("form", { name: "Connect Langfuse" })).toBeTruthy();
    expect(screen.queryByLabelText("Connected project")).toBeNull();
    expect(removeLangfuse).toHaveBeenCalledTimes(1);
  });

  it("says when the settings could not be read, and reads them again", async () => {
    let fail = true;
    const langfuse = vi.fn(async () => {
      if (fail) throw new Error("/api/settings/langfuse: HTTP 500");
      return { langfuse: null, canManage: true };
    });
    render(<SettingsView />, { wrapper: channel({ langfuse }) });
    expect(await screen.findByText("Could not read the Channel's settings")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("form", { name: "Connect Langfuse" })).toBeTruthy();
  });
});
