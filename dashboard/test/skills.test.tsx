// @vitest-environment happy-dom
// The Skills view, used as a Person would: it lists the skills Persons share on the Channel,
// each at its latest version with who published it; a skill opens with every file in full and
// the command that installs it, at the version picked; and a Worker without shared skills says so.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentId, ChannelSnapshot, Skill, SkillResponse, SkillsResponse } from "@shared/index";
import type { ChannelSource } from "@/data/source";
import { ChannelProvider, ChannelStore } from "@/data/store";
import { SkillsView } from "@/views/SkillsView";

const scout = {
  id: "maya/claude/2b8d" as AgentId,
  person: "maya",
  nickname: "scout",
  cli: "claude-code",
  presence: "live",
  lastSeenAt: "2026-10-15T10:00:00.000Z",
  startedAt: "2026-10-15T09:00:00.000Z",
} as unknown as Agent;

function channel(extra: Partial<ChannelSource>) {
  const source = {
    me: "shlok",
    capabilities: {},
    snapshot: async () =>
      ({ channel: { repo: "shlok1806/app" }, persons: [], agents: [scout], tasks: [], events: [], verdicts: [], cursor: 0 }) as unknown as ChannelSnapshot,
    hosts: async () => null,
    subscribe: () => () => {},
    ...extra,
  } as unknown as ChannelSource;
  const store = new ChannelStore(source);
  return ({ children }: { children: ReactNode }) => <ChannelProvider store={store}>{children}</ChannelProvider>;
}

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const ENTRY = "---\nname: release-notes\ndescription: Writes release notes from merged pull requests.\n---\n\nGroup them by label.\n";

const v = (version: number, files: Skill["files"]): Skill => ({
  name: "release-notes",
  version,
  description: "Writes release notes from merged pull requests.",
  publishedBy: { person: "maya", agent: scout.id },
  publishedAt: "2026-10-15T09:30:00.000Z",
  size: 120,
  paths: files.map((f) => f.path),
  digest: `${version}`.repeat(64),
  files,
});

const versions = [v(1, [{ path: "SKILL.md", content: ENTRY.replace("Group them by label.\n", "") }]), v(2, [{ path: "SKILL.md", content: ENTRY }, { path: "templates/notes.md", content: "## {{tag}}\n" }])];

const skills = async (): Promise<SkillsResponse> => {
  const { files: _files, ...latest } = versions[1]!;
  return { skills: [latest] };
};
const skill = async (_name: string, version?: number): Promise<SkillResponse> => ({ skill: versions[(version ?? 2) - 1]!, versions: [1, 2] });

describe("the Skills view", () => {
  it("lists each shared skill at its latest version, with what it does and the Agent that published it", async () => {
    render(<SkillsView />, { wrapper: channel({ skills, skill }) });
    const row = (await screen.findByText("release-notes")).closest("li")!;
    expect(within(row).getByText("v2")).toBeTruthy();
    expect(within(row).getByText("Writes release notes from merged pull requests.")).toBeTruthy();
    expect(within(row).getByText(/2 files/)).toBeTruthy();
    expect(within(row).getByRole("link", { name: "maya/scout" }).getAttribute("href")).toBe(`#/agents/${encodeURIComponent(scout.id)}`);
    fireEvent.click(within(row).getByRole("button"));
    expect(window.location.hash).toBe("#/skills/release-notes");
  });

  it("opens a skill with every file in full and the command that installs the version shown", async () => {
    const read = vi.fn(skill);
    const { rerender } = render(<SkillsView name="release-notes" />, { wrapper: channel({ skills, skill: read }) });
    const inspector = await screen.findByRole("complementary", { name: "release-notes, in the inspector" });
    await waitFor(() => expect(within(inspector).getByText("templates/notes.md")).toBeTruthy());
    expect(within(inspector).getByText(/Group them by label\./)).toBeTruthy();
    expect(within(inspector).getByText("switchboard skills install release-notes")).toBeTruthy();

    // An older version: its own files, and the command names it.
    fireEvent.click(within(inspector).getByRole("button", { name: "v1" }));
    expect(window.location.hash).toBe("#/skills/release-notes/1");
    rerender(<SkillsView name="release-notes" version={1} />);
    await waitFor(() => expect(screen.getByText("switchboard skills install release-notes --version 1")).toBeTruthy());
    expect(screen.queryByText("templates/notes.md")).toBeNull();
    expect(read).toHaveBeenLastCalledWith("release-notes", 1);
  });

  it("says why a skill cannot be read", async () => {
    const missing = async (): Promise<SkillResponse> => {
      throw new Error("No skill is named gone on this Channel.");
    };
    render(<SkillsView name="gone" />, { wrapper: channel({ skills, skill: missing }) });
    expect(await screen.findByText("No skill is named gone on this Channel.")).toBeTruthy();
  });

  it("says when the Channel's Worker has no shared skills", async () => {
    render(<SkillsView />, { wrapper: channel({ skills: async () => null }) });
    expect(await screen.findByRole("heading", { name: "Skills are not on this Channel yet" })).toBeTruthy();
  });
});
